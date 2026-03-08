const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8787);
const ROOM_REGEX = /^[A-Za-z0-9]{8}$/;
const TIMEOUT_MS = 60_000;
const MAX_NAME_LENGTH = 20;
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, "data", "state.json");
const AUTH_SECRET = process.env.AUTH_SECRET || "dev-only-change-me";
const TOKEN_TTL_SECONDS = Number(process.env.TOKEN_TTL_SECONDS || 60 * 60 * 24);
const CORS_ALLOWLIST = (process.env.CORS_ALLOWLIST ||
  "https://rokinosun.github.io,http://localhost:5500,http://127.0.0.1:5500")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const rooms = new Map();

function nowTs() {
  return Date.now();
}

function b64urlEncode(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function b64urlDecode(text) {
  return Buffer.from(text, "base64url");
}

function signToken(payload) {
  const header = { alg: "HS256", typ: "JWT" };
  const encHeader = b64urlEncode(Buffer.from(JSON.stringify(header)));
  const encPayload = b64urlEncode(Buffer.from(JSON.stringify(payload)));
  const data = `${encHeader}.${encPayload}`;
  const sig = crypto.createHmac("sha256", AUTH_SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verifyToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    throw new Error("invalid_token_format");
  }
  const [encHeader, encPayload, providedSig] = parts;
  const data = `${encHeader}.${encPayload}`;
  const expectedSig = crypto.createHmac("sha256", AUTH_SECRET).update(data).digest("base64url");
  const a = Buffer.from(expectedSig);
  const b = Buffer.from(providedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("invalid_token_signature");
  }
  const payload = JSON.parse(b64urlDecode(encPayload).toString("utf8"));
  if (!payload || typeof payload !== "object") {
    throw new Error("invalid_token_payload");
  }
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) {
    throw new Error("token_expired");
  }
  return payload;
}

function parseAuthToken(req) {
  const auth = String(req.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) {
    return "";
  }
  return auth.slice("Bearer ".length).trim();
}

function requireAuth(req, role, roomId) {
  const token = parseAuthToken(req);
  if (!token) {
    throw new Error("missing_auth_token");
  }
  const payload = verifyToken(token);
  if (payload.role !== role) {
    throw new Error("forbidden_role");
  }
  if (roomId && payload.roomId !== roomId) {
    throw new Error("forbidden_room");
  }
  return payload;
}

function getOrigin(req) {
  return String(req.headers.origin || "");
}

function isAllowedOrigin(origin) {
  return !!origin && CORS_ALLOWLIST.includes(origin);
}

function corsHeaders(req) {
  const origin = getOrigin(req);
  const allowed = isAllowedOrigin(origin);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  };
  if (allowed) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return { headers, allowed };
}

function sendJson(req, res, status, data) {
  const { headers } = corsHeaders(req);
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("payload_too_large"));
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function ensureStateDir() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.rooms) {
      return;
    }
    for (const roomObj of parsed.rooms) {
      const room = {
        roomId: roomObj.roomId,
        hostSessionId: roomObj.hostSessionId || null,
        hostUserId: roomObj.hostUserId || null,
        updatedAt: roomObj.updatedAt || nowTs(),
        requests: new Map(),
      };
      for (const req of roomObj.requests || []) {
        room.requests.set(req.requestId, req);
      }
      rooms.set(room.roomId, room);
    }
  } catch {
    // ignore broken state and start empty
  }
}

function serializeState() {
  return {
    savedAt: new Date().toISOString(),
    rooms: Array.from(rooms.values()).map((room) => ({
      roomId: room.roomId,
      hostSessionId: room.hostSessionId,
      hostUserId: room.hostUserId,
      updatedAt: room.updatedAt,
      requests: Array.from(room.requests.values()),
    })),
  };
}

function saveStateNow() {
  ensureStateDir();
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(serializeState(), null, 2), "utf8");
  fs.renameSync(tmp, STATE_FILE);
}

function scheduleSave() {
  saveStateNow();
}

function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      roomId,
      hostSessionId: null,
      hostUserId: null,
      updatedAt: nowTs(),
      requests: new Map(),
    };
    rooms.set(roomId, room);
    scheduleSave();
  }
  return room;
}

function applyTimeouts(room) {
  const now = nowTs();
  let changed = false;
  for (const req of room.requests.values()) {
    if (req.status === "pending" && now >= req.deadlineAt) {
      req.status = "timeout";
      req.decidedAt = now;
      room.updatedAt = now;
      changed = true;
    }
  }
  if (changed) {
    scheduleSave();
  }
}

function prune() {
  const now = nowTs();
  const staleMs = 30 * 60 * 1000;
  let changed = false;
  for (const [roomId, room] of rooms.entries()) {
    applyTimeouts(room);
    for (const [requestId, req] of room.requests.entries()) {
      const staleRequest = req.status !== "pending" && now - (req.decidedAt || req.createdAt) > staleMs;
      if (staleRequest) {
        room.requests.delete(requestId);
        changed = true;
      }
    }
    if (now - room.updatedAt > staleMs && room.requests.size === 0) {
      rooms.delete(roomId);
      changed = true;
    }
  }
  if (changed) {
    scheduleSave();
  }
}

function randomId(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

function roomSummary(room) {
  return {
    roomId: room.roomId,
    hostReady: Boolean(room.hostSessionId),
    pendingCount: Array.from(room.requests.values()).filter((r) => r.status === "pending").length,
    updatedAt: room.updatedAt,
  };
}

function publicRequest(req) {
  return {
    requestId: req.requestId,
    roomId: req.roomId,
    userId: req.userId,
    userName: req.userName,
    status: req.status,
    createdAt: req.createdAt,
    deadlineAt: req.deadlineAt,
    decidedAt: req.decidedAt || null,
  };
}

function parsePath(urlPath) {
  const cleaned = urlPath.replace(/^\/+|\/+$/g, "");
  return cleaned ? cleaned.split("/") : [];
}

function issueParticipantToken(userId) {
  const now = Math.floor(Date.now() / 1000);
  return signToken({
    role: "participant",
    userId,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  });
}

function issueHostToken(roomId, userId, hostSessionId) {
  const now = Math.floor(Date.now() / 1000);
  return signToken({
    role: "host",
    roomId,
    userId,
    hostSessionId,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      const { allowed } = corsHeaders(req);
      if (!allowed) {
        sendJson(req, res, 403, { error: "origin_not_allowed" });
      } else {
        sendJson(req, res, 204, {});
      }
      return;
    }

    const origin = getOrigin(req);
    if (origin && !isAllowedOrigin(origin)) {
      sendJson(req, res, 403, { error: "origin_not_allowed" });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const parts = parsePath(url.pathname);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(req, res, 200, { ok: true, ts: new Date().toISOString() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/participant") {
      const body = await parseBody(req);
      const userId = String(body.userId || "").trim();
      if (!userId) {
        sendJson(req, res, 400, { error: "missing_user_id" });
        return;
      }
      sendJson(req, res, 200, { ok: true, token: issueParticipantToken(userId) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/host") {
      const body = await parseBody(req);
      const roomId = String(body.roomId || "").trim();
      const userId = String(body.userId || "").trim();
      const hostSessionId = String(body.hostSessionId || "").trim();
      if (!ROOM_REGEX.test(roomId)) {
        sendJson(req, res, 400, { error: "invalid_room_id" });
        return;
      }
      if (!userId || !hostSessionId) {
        sendJson(req, res, 400, { error: "missing_host_identity" });
        return;
      }
      const room = getOrCreateRoom(roomId);
      if (room.hostSessionId && room.hostSessionId !== hostSessionId) {
        sendJson(req, res, 409, { error: "host_already_exists" });
        return;
      }
      sendJson(req, res, 200, {
        ok: true,
        token: issueHostToken(roomId, userId, hostSessionId),
      });
      return;
    }

    if (parts[0] !== "api" || parts[1] !== "rooms") {
      sendJson(req, res, 404, { error: "not_found" });
      return;
    }

    const roomId = parts[2] || "";
    if (!ROOM_REGEX.test(roomId)) {
      sendJson(req, res, 400, { error: "invalid_room_id" });
      return;
    }
    const room = getOrCreateRoom(roomId);
    applyTimeouts(room);

    if (req.method === "POST" && parts[3] === "host" && parts[4] === "claim" && parts.length === 5) {
      const auth = requireAuth(req, "host", roomId);
      const body = await parseBody(req);
      const hostSessionId = String(body.hostSessionId || "").trim();
      const hostUserId = String(body.hostUserId || "").trim();
      if (!hostSessionId || !hostUserId) {
        sendJson(req, res, 400, { error: "missing_host_identity" });
        return;
      }
      if (auth.userId !== hostUserId || auth.hostSessionId !== hostSessionId) {
        sendJson(req, res, 403, { error: "host_identity_mismatch" });
        return;
      }
      if (room.hostSessionId && room.hostSessionId !== hostSessionId) {
        sendJson(req, res, 409, { error: "host_already_exists" });
        return;
      }
      room.hostSessionId = hostSessionId;
      room.hostUserId = hostUserId;
      room.updatedAt = nowTs();
      scheduleSave();
      sendJson(req, res, 200, { ok: true, room: roomSummary(room) });
      return;
    }

    if (req.method === "GET" && parts[3] === "host" && parts[4] === "requests" && parts.length === 5) {
      const auth = requireAuth(req, "host", roomId);
      if (room.hostSessionId !== auth.hostSessionId) {
        sendJson(req, res, 403, { error: "host_forbidden" });
        return;
      }
      const list = Array.from(room.requests.values()).sort((a, b) => b.createdAt - a.createdAt).map(publicRequest);
      sendJson(req, res, 200, { ok: true, room: roomSummary(room), requests: list });
      return;
    }

    if (req.method === "POST" && parts[3] === "join" && parts.length === 4) {
      const auth = requireAuth(req, "participant");
      const body = await parseBody(req);
      const userId = String(body.userId || "").trim();
      const userName = String(body.userName || "").trim();
      if (!userId || !userName) {
        sendJson(req, res, 400, { error: "missing_user_info" });
        return;
      }
      if (auth.userId !== userId) {
        sendJson(req, res, 403, { error: "participant_identity_mismatch" });
        return;
      }
      if (userName.length > MAX_NAME_LENGTH) {
        sendJson(req, res, 400, { error: "name_too_long" });
        return;
      }
      if (!room.hostSessionId) {
        sendJson(req, res, 409, { error: "host_not_ready" });
        return;
      }
      const createdAt = nowTs();
      const request = {
        requestId: randomId(10),
        roomId,
        userId,
        userName,
        status: "pending",
        createdAt,
        deadlineAt: createdAt + TIMEOUT_MS,
        decidedAt: null,
      };
      room.requests.set(request.requestId, request);
      room.updatedAt = createdAt;
      scheduleSave();
      sendJson(req, res, 201, { ok: true, request: publicRequest(request) });
      return;
    }

    if (req.method === "POST" && parts[3] === "host" && parts[4] === "requests" && parts[6] === "decision" && parts.length === 7) {
      const auth = requireAuth(req, "host", roomId);
      if (room.hostSessionId !== auth.hostSessionId) {
        sendJson(req, res, 403, { error: "host_forbidden" });
        return;
      }
      const requestId = parts[5];
      const body = await parseBody(req);
      const decision = String(body.decision || "").trim();
      if (decision !== "approved" && decision !== "rejected") {
        sendJson(req, res, 400, { error: "invalid_decision" });
        return;
      }
      const target = room.requests.get(requestId);
      if (!target) {
        sendJson(req, res, 404, { error: "request_not_found" });
        return;
      }
      if (target.status !== "pending") {
        sendJson(req, res, 409, { error: "request_already_final", request: publicRequest(target) });
        return;
      }
      target.status = decision;
      target.decidedAt = nowTs();
      room.updatedAt = target.decidedAt;
      scheduleSave();
      sendJson(req, res, 200, { ok: true, request: publicRequest(target) });
      return;
    }

    if (req.method === "GET" && parts[3] === "requests" && parts[5] === "status" && parts.length === 6) {
      const auth = requireAuth(req, "participant");
      const requestId = parts[4];
      const userId = String(url.searchParams.get("userId") || "");
      if (!userId) {
        sendJson(req, res, 400, { error: "missing_user_id" });
        return;
      }
      if (auth.userId !== userId) {
        sendJson(req, res, 403, { error: "participant_identity_mismatch" });
        return;
      }
      const target = room.requests.get(requestId);
      if (!target) {
        sendJson(req, res, 404, { error: "request_not_found" });
        return;
      }
      if (target.userId !== userId) {
        sendJson(req, res, 403, { error: "request_forbidden" });
        return;
      }
      sendJson(req, res, 200, { ok: true, request: publicRequest(target) });
      return;
    }

    sendJson(req, res, 404, { error: "not_found" });
  } catch (err) {
    const message = err && err.message ? err.message : "server_error";
    const code = [
      "missing_auth_token",
      "invalid_token_format",
      "invalid_token_signature",
      "invalid_token_payload",
      "token_expired",
    ].includes(message) ? 401
      : [
        "forbidden_role",
        "forbidden_room",
      ].includes(message) ? 403
        : message === "invalid_json" ? 400 : 500;
    sendJson(req, res, code, { error: message });
  }
});

loadState();
setInterval(prune, 15_000);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`signaling server listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`state file: ${STATE_FILE}`);
  // eslint-disable-next-line no-console
  console.log(`cors allowlist: ${CORS_ALLOWLIST.join(", ")}`);
});
