# minigame-gallery

GitHub Pages で公開する静的サイト（MVP）です。

## TASK-010 追加内容（Godot Reversi統合）

- Godot Web出力物を `games/reversi/` に配置
- ギャラリー `index.html` に `./games/reversi/reversi.html` への起動導線を追加
- Branch deploy（main / root）でそのまま配信可能な相対パス構成

## TASK-007 追加内容（security hardening）

- フロント: `index.html`
- シグナリングAPI: `signaling-server/server.js`（Node.js標準HTTP）
- 強化点:
  - 認証/認可: Bearer token（host / participant ロール分離）
  - 永続化: `signaling-server/data/state.json` へ room/request 状態を保存
  - CORS: allowlist 方式（wildcard廃止）
- TASK-005/006 仕様維持:
  - room ID: `^[A-Za-z0-9]{8}$`（8文字固定、大小区別）
  - `mgg_user_id` を LocalStorage 保存
  - 参加申請タイムアウト60秒
  - 同名ユーザー名許可
  - 再参加時も毎回再承認

## Pages設定（Branch deploy）

1. GitHub の対象リポジトリを開く
2. `Settings` -> `Pages` を開く
3. `Build and deployment` の `Source` で `Deploy from a branch` を選ぶ
4. `Branch` で `main` を選ぶ
5. フォルダは `/(root)` を選ぶ
6. 保存後、公開URLが表示されるまで待つ

## 更新フロー

1. このリポジトリの `main` ブランチに変更を反映する
2. 反映後、GitHub Pages が自動で再デプロイされる
3. 数十秒から数分後に公開ページへ更新が反映される

## Reversi再エクスポート手順

前提:
- Godot 4.6 の Web export templates が `C:\Users\rocky\AppData\Roaming\Godot\export_templates\4.6.stable` に配置済みであること

1. Godotプロジェクト（`workspaces/godot/reversi`）で `export_presets.cfg` を用意
2. Godot 4.6 で Web をエクスポート（出力先を本リポジトリへ指定）
3. 生成物を `games/reversi/` に上書き
4. ギャラリーの `index.html` から `./games/reversi/reversi.html` が開けることを確認

実行コマンド例（Builder実施）:

```powershell
& 'C:\Users\rocky\Dropbox\software\Godot_v4.6-stable_win64.exe\Godot_v4.6-stable_win64_console.exe' --headless --path 'C:\Users\rocky\Dropbox\service\browser_game_gallery2\workspaces\godot\reversi' --export-release 'Web' 'C:\Users\rocky\Dropbox\service\browser_game_gallery2\workspaces\web\minigame-gallery\games\reversi\reversi.html'
```

## Reversi運用ルール（再発防止）

- basename固定: `reversi` を固定し、`reversi.html / reversi.js / reversi.wasm / reversi.pck` を同時更新する
- クリーン置換: 新規出力時は `games/reversi/` 直下を新しい basename 一式に揃え、旧 basename は公開導線から外す
- 公開後確認URL:
  - ギャラリー: `https://rokinosun.github.io/minigame-gallery/`
  - Reversi本体: `https://rokinosun.github.io/minigame-gallery/games/reversi/reversi.html`

## ローカル開発手順（2プロセス）

1. シグナリングAPI起動（ターミナルA）
   - 必須環境変数（本番で要変更）:
     - `AUTH_SECRET`: トークン署名秘密鍵
   - 推奨環境変数:
     - `CORS_ALLOWLIST`: 許可Originをカンマ区切り（例: `https://rokinosun.github.io,http://localhost:5500`)
     - `STATE_FILE`: 永続化先JSONファイルパス
     - `TOKEN_TTL_SECONDS`: トークン有効期限（秒）
   - `npm run signaling`
   - デフォルト: `http://localhost:8787`
2. フロント静的配信（ターミナルB、リポジトリ直下）
   - `python -m http.server 5500`
3. ブラウザで `http://localhost:5500/index.html` を開く
4. 画面上の「シグナリングURL」に `http://localhost:8787` を設定

## 端末間確認手順

1. 端末A（ホスト）で `room IDを生成してホスト開始`
2. 共有URLをコピーして端末Bへ送る
3. 端末B（参加）でユーザー名入力し申請送信
4. 端末Aで申請一覧から承認または拒否
5. 端末Bで結果表示を確認（approved/rejected）
6. タイムアウト確認: 端末Aで放置し、端末Bで60秒後に `timeout` 表示を確認

## セキュリティ確認手順

1. 未認証拒否:
   - `Authorization` なしで `/api/rooms/:id/join` を呼ぶと `401 missing_auth_token`
2. 権限外拒否:
   - participant token で `/host/requests/.../decision` を呼ぶと `403 forbidden_role`
3. 不正トークン拒否:
   - 改ざんトークンで呼ぶと `401 invalid_token_signature`
4. CORS allowlist:
   - allowlist外の `Origin` で `OPTIONS/POST` を呼ぶと `403 origin_not_allowed`
5. 永続化:
   - 申請作成後にサーバー再起動しても `STATE_FILE` から状態復元されることを確認

## デプロイ前提

- フロント: GitHub Pages（main / root）
- シグナリングAPI: 別ホスティング（Render/Fly.io/Railway/Cloud Run 等）に `signaling-server/server.js` を配置して常駐
- フロント画面の「シグナリングURL」にデプロイ先APIのベースURLを指定

## 既知制約・セキュリティ注意

- Bearer tokenは最小実装のため、失効リストやrefresh tokenは未実装です。
- 永続化はJSONファイルのため、大規模同時接続には不向きです（DB移行が必要）。
- HTTPS環境ではシグナリングもHTTPS推奨（Mixed Content回避）。
- レート制限・WAF・監査ログは未実装です。

## 補足

- このリポジトリは静的ファイルのみで構成しています（ビルド不要）
- Branch deploy 運用のため、Actions workflow（`pages.yml`）は作成していません
