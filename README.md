# neai

使っていない iPhone XR を、家庭に常設する自分専用のAI音声端末にする。
棚に置いて電源につなぎ、**端末に触らず話しかけて使う。**

```
「ねえクラピカ、今日の天気は？」      → 音声で回答
「これ何？」                        → カメラを見て回答
「三分測って」                      → 端末内でタイマー
```

- **ドキュメントは [docs/](docs/) にある。** 構成・コード・制約・決定の経緯はそちら
- 実機検証ページの使い方は [spike/README.md](spike/README.md)

## 構成

```
iPhone ──HTTPS──> Cloudflare Worker ──> OpenAI / Open-Meteo
   │                (APIキーを保持)
   └──── WebRTC 音声 ────> OpenAI     ← Worker は経路に入らない
```

詳しくは [docs/architecture.md](docs/architecture.md)。

## セットアップ

```bash
npm install
cp .dev.vars.example .dev.vars     # OPENAI_API_KEY を記入
./scripts/fetch-vosk-model.sh      # ウェイクワード用モデル（約48MB）
```

APIキーは https://platform.openai.com/api-keys で発行する。
**使い始める前に Usage limits で月額上限を必ず設定すること。**
料金の目安は [docs/cost.md](docs/cost.md)。

## 開発（iPhone から使う）

ターミナルを2つ使う。

```bash
npm run dev     # Vite + Worker を :5173 で起動
npm run proxy   # HTTPS 終端を :8444 で起動
```

`npm run proxy` が表示する URL を **iPhone の Safari** で開く。
Mac と iPhone が同じ Wi-Fi にいること。自己署名証明書なので警告が出るので、
「詳細を表示」→「この Web サイトを閲覧」と進む。

HTTPS が要るのは、**iOS Safari が `getUserMedia` と Wake Lock を
保護されたコンテキストでしか許可しない**ため。`http://` では動かない。

### 使い方

1. 「常設待機を開始」をタップ（マイクとカメラの権限を許可する）
2. 「ねえクラピカ」と話しかける（モデル未取得ならタップ開始になる）
3. 60秒無操作で自動的に切断し、また待機に戻る

画面右上の「設定」から、ウェイクワード・マイクの効き・モデル・動作を
**端末上で**変更できる。`.env` の編集も再起動も要らない。

## 環境変数

| 名前 | 置き場所 | 必須 | 用途 |
|---|---|---|---|
| `OPENAI_API_KEY` | `.dev.vars` / Worker Secret | ○ | Realtime セッションの確立 |
| `DEVICE_KEY` | `.dev.vars` / Worker Secret | 公開時は○ | 全 `/api/*` に Bearer 認証を要求する |
| `REALTIME_MODEL` | `wrangler.jsonc` | ○（既定あり） | 使用するモデル |
| `HOME_LAT` / `HOME_LON` / `HOME_NAME` | `wrangler.jsonc` | — | 天気の既定地点（現在は市川市）。端末の設定が優先 |
| `VITE_WAKEWORD_MODEL` | `.env` | — | Vosk モデルの場所 |

`.dev.vars` と `.env` は `.gitignore` 済み。**APIキーを絶対にコミットしないこと。**

## デプロイ

手順は [docs/deploy.md](docs/deploy.md)。要点だけ。

```bash
npx wrangler login
npm run model                            # モデルを25MiB未満に分割
npm run newkey                           # デバイスキーを作る
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put DEVICE_KEY
npm run deploy
```

**`DEVICE_KEY` を設定せずに公開しないこと。** 誰でもあなたの課金で AI と会話できてしまう。

初回だけ iPhone で `https://<host>/#k=<キー>` を開けば端末に保存される。

**Cloudflare の費用はゼロ**（無料プラン、カード不要）。
ローカル開発の手順は変わらない。

## 常設運用のメモ

- 画面スリープは Wake Lock で防いでいる。**画面が隠れると解放されるため、
  復帰時に取り直す処理が入っている**（iOS の仕様）
- 給電したまま画面を点けっぱなしにするとバッテリーが劣化する。UI は黒基調にしてある
- 完全なバックグラウンド待機は iOS の制約でできない。前面表示のまま使う
