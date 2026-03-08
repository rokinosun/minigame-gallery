# minigame-gallery

GitHub Pages で公開する静的サイト（MVP）です。

## TASK-006 追加内容（端末間シグナリングMVP）

- フロント: `index.html`
- シグナリングAPI: `signaling-server/server.js`（Node.js標準HTTP / メモリ実装）
- 仕様維持:
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

## ローカル開発手順（2プロセス）

1. シグナリングAPI起動（ターミナルA）
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

## デプロイ前提

- フロント: GitHub Pages（main / root）
- シグナリングAPI: 別ホスティング（Render/Fly.io/Railway/Cloud Run 等）に `signaling-server/server.js` を配置して常駐
- フロント画面の「シグナリングURL」にデプロイ先APIのベースURLを指定

## 既知制約・セキュリティ注意

- このMVPは認証なし・メモリ保持のみで、再起動時に申請状態が消えます。
- CORSは `*` のため、本番では許可オリジン制限が必要です。
- HTTPS環境ではシグナリングもHTTPS推奨（Mixed Content回避）。
- 不正な承認操作対策（認証/署名）は未実装です。

## 補足

- このリポジトリは静的ファイルのみで構成しています（ビルド不要）
- Branch deploy 運用のため、Actions workflow（`pages.yml`）は作成していません
