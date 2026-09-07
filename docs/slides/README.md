# 発表スライド

| ファイル | 内容 | 長さ |
|---|---|---|
| [neai-lt.md](neai-lt.md) | プロジェクト紹介（目的 → 端末の再利用 → ウェイクワード → Cloudflare → コスト） | 5〜10分 / 19枚 |

[Marp](https://marp.app/) 形式。Markdown のまま読めるが、
スライドとして見るには次のどちらかを使う。

## VS Code で見る

拡張機能 **Marp for VS Code** を入れて、ファイルを開きプレビューを出す。
編集しながら確認できるのでこれが一番早い。

## HTML / PDF に書き出す

```bash
npx @marp-team/marp-cli@latest docs/slides/neai-lt.md -o neai-lt.html
npx @marp-team/marp-cli@latest docs/slides/neai-lt.md --pdf
```

発表者ノート（HTML コメント）はプレゼンタービューと PDF のノートに出る。

## 書くときのメモ

- スライドの区切りは `---`。先頭の `---` で囲まれた部分は Marp のフロントマター
- 配色とレイアウトはフロントマターの `style:` にまとめてある（黒基調。端末の UI に合わせた）
- 図は ASCII のコードブロックで描いている。画像ファイルを持たないので差分が読める
- 2カラムは `<div class="cols">`、補足は `<span class="note">` を使う
