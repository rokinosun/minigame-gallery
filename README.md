# minigame-gallery

GitHub Pages で公開する静的サイト（MVP）です。

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

## 補足

- このリポジトリは静的ファイルのみで構成しています（ビルド不要）
- Branch deploy 運用のため、Actions workflow（`pages.yml`）は作成していません
