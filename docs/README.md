# ドキュメント

| 文書 | 内容 |
|---|---|
| [architecture.md](architecture.md) | システム構成、データの流れ、主要なシーケンス |
| [code-map.md](code-map.md) | ディレクトリ構成と、ファイルごとの責務 |
| [ios-constraints.md](ios-constraints.md) | iOS 実機で判明した制約。コードの形の理由がここにある |
| [decisions.md](decisions.md) | 何をなぜ選んだか。**捨てた案と反証された仮説も残してある** |
| [cost.md](cost.md) | 料金の考え方と実測値、費用が暴走しないための仕組み |
| [roadmap.md](roadmap.md) | 段階ごとの進捗と、残っていること |
| [requirements-memo.txt](requirements-memo.txt) | 出発点になったメモ。**現状とは食い違う箇所がある**（履歴として保存） |

セットアップと使い方は [ルートの README](../README.md) を参照。
実機検証ページの使い方は [spike/README.md](../spike/README.md)。

## 読む順番

初めてなら **architecture.md → code-map.md → ios-constraints.md** の順が分かりやすい。
コードが素直でない箇所（マイクを取り直さない、映像を WebRTC に載せない等）は
ほぼすべて ios-constraints.md に理由が書いてある。
