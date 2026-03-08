const http = require("http");
const { randomBytes } = require("crypto");

const PORT = Number(process.env.PORT || 8787);
const ROOM_REGEX = /^[A-Za-z0-9]{8}$/;
const TIMEOUT_MS = 60_000;
const MAX_NAME_LENGTH = 20;

const rooms = new Map();

function nowTs() {
  return Date.now();
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  });
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
      } catch (err) {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
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
  }
  return room;
}

function applyTimeouts(room) {
  const now = nowTs();
  for (const req of room.requests.values()) {
    if (req.status === "pending" && now >= req.deadlineAt) {
      req.status = "timeout";
      req.decidedAt = now;
      room.updatedAt = now;
    }
  }
}

function prune() {
  const now = nowTs();
  const staleRoomMs = 30 * 60 * 1000;
  for (const [roomId, room] of rooms.entries()) {
    applyTimeouts(room);
    for (const [requestId, req] of room.requests.entries()) {
      const staleRequest = req.status !== "pending" && now - (req.decidedAt || req.createdAt) > staleRoomMs;
      if (staleRequest) {
        room.requests.delete(requestId);
      }
    }
    if (now - room.updatedAt > staleRoomMs && room.requests.size === 0) {
      rooms.delete(roomId);
    }
  }
}

function randomId(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(length);
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

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const parts = parsePath(url.pathname);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, ts: new Date().toISOString() });
      return;
    }

    if (parts[0] !== "api" || parts[1] !== "rooms") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const roomId = parts[2] || "";
    if (!ROOM_REGEX.test(roomId)) {
      sendJson(res, 400, { error: "invalid_room_id" });
      return;
    }
    const room = getOrCreateRoom(roomId);
    applyTimeouts(room);

    if (req.method === "POST" && parts[3] === "host" && parts[4] === "claim" && parts.length === 5) {
      const body = await parseBody(req);
      const hostSessionId = String(body.hostSessionId || "").trim();
      const hostUserId = String(body.hostUserId || "").trim();
      if (!hostSessionId || !hostUserId) {
        sendJson(res, 400, { error: "missing_host_identity" });
        return;
      }
      if (room.hostSessionId && room.hostSessionId !== hostSessionId) {
        sendJson(res, 409, { error: "host_already_exists" });
        return;
      }
      room.hostSessionId = hostSessionId;
      room.hostUserId = hostUserId;
      room.updatedAt = nowTs();
      sendJson(res, 200, { ok: true, room: roomSummary(room) });
      return;
    }

    if (req.method === "GET" && parts[3] === "host" && parts[4] === "requests" && parts.length === 5) {
      const hostSessionId = String(url.searchParams.get("hostSessionId") || "");
      if (!hostSessionId || room.hostSessionId !== hostSessionId) {
        sendJson(res, 403, { error: "host_forbidden" });
        return;
      }
      const list = Array.from(room.requests.values())
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(publicRequest);
      sendJson(res, 200, { ok: true, room: roomSummary(room), requests: list });
      return;
    }

    if (req.method === "POST" && parts[3] === "join" && parts.length === 4) {
      const body = await parseBody(req);
      const userId = String(body.userId || "").trim();
      const userName = String(body.userName || "").trim();
      if (!userId || !userName) {
        sendJson(res, 400, { error: "missing_user_info" });
        return;
      }
      if (userName.length > MAX_NAME_LENGTH) {
        sendJson(res, 400, { error: "name_too_long" });
        return;
      }
      if (!room.hostSessionId) {
        sendJson(res, 409, { error: "host_not_ready" });
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
      sendJson(res, 201, { ok: true, request: publicRequest(request) });
      return;
    }

    if (req.method === "POST" && parts[3] === "host" && parts[4] === "requests" && parts[6] === "decision" && parts.length === 7) {
      const requestId = parts[5];
      const body = await parseBody(req);
      const hostSessionId = String(body.hostSessionId || "").trim();
      const decision = String(body.decision || "").trim();
      if (!hostSessionId || room.hostSessionId !== hostSessionId) {
        sendJson(res, 403, { error: "host_forbidden" });
        return;
      }
      if (decision !== "approved" && decision !== "rejected") {
        sendJson(res, 400, { error: "invalid_decision" });
        return;
      }
      const target = room.requests.get(requestId);
      if (!target) {
        sendJson(res, 404, { error: "request_not_found" });
        return;
      }
      if (target.status !== "pending") {
        sendJson(res, 409, { error: "request_already_final", request: publicRequest(target) });
        return;
      }
      target.status = decision;
      target.decidedAt = nowTs();
      room.updatedAt = target.decidedAt;
      sendJson(res, 200, { ok: true, request: publicRequest(target) });
      return;
    }

    if (req.method === "GET" && parts[3] === "requests" && parts[5] === "status" && parts.length === 6) {
      const requestId = parts[4];
      const userId = String(url.searchParams.get("userId") || "");
      if (!userId) {
        sendJson(res, 400, { error: "missing_user_id" });
        return;
      }
      const target = room.requests.get(requestId);
      if (!target) {
        sendJson(res, 404, { error: "request_not_found" });
        return;
      }
      if (target.userId !== userId) {
        sendJson(res, 403, { error: "request_forbidden" });
        return;
      }
      sendJson(res, 200, { ok: true, request: publicRequest(target) });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (err) {
    const code = err && err.message === "invalid_json" ? 400 : 500;
    sendJson(res, code, { error: err && err.message ? err.message : "server_error" });
  }
});

setInterval(prune, 15_000);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`signaling server listening on http://localhost:${PORT}`);
});
