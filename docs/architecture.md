# アーキテクチャ

使っていない iPhone XR を、家庭に常設する自分専用のAI音声端末にする。
棚に置いて電源につなぎ、**端末に触らず話しかけて使う**ことが核心要件。

## 全体像

```
                            ┌──────────────────────────────┐
                            │  Cloudflare Worker           │
      ┌─── HTTPS ──────────>│  ・SPA の配信                 │
      │                     │  ・POST /api/session（SDP中継）│──> OpenAI
      │                     │  ・GET  /api/tools/weather    │──> Open-Meteo
 iPhone XR                  │  Secrets: OPENAI_API_KEY 他   │
 (Safari 前面表示)           └──────────────────────────────┘
      │
      └─── WebRTC（音声 + データチャネル "oai-events"）───> OpenAI Realtime
           ※ 音声はブラウザと OpenAI が直結し、Worker を通らない
```

**Worker はメディア経路に入らない。** これが低レイテンシの前提になっている。
Worker が関わるのは「セッション確立の一往復」と「外部APIを叩くツール」だけ。

## 3つの実行場所

処理は置き場所で3つに分かれる。どこで動くかがコストと速度を決める。

| 場所 | 何を | 通信 | 費用 |
|---|---|---|---|
| **端末内** | ウェイクワード検出、タイマーの計測とアラーム、時刻、カメラ撮影 | なし | ゼロ |
| **OpenAI 直結** | 音声会話、画像理解、**どの機能を呼ぶかの判断** | WebRTC | トークン課金 |
| **Worker** | セッション確立、天気などの外部API | HTTPS | ほぼゼロ |

待機中は**端末内だけ**が動く。ウェイクワードを検出して初めて OpenAI に繋がる。

### 誤解しやすい点：機能の「呼び出し」は課金される

「タイマーは端末内」と書いているが、**呼び出す会話そのものは OpenAI を通り、課金される。**

```
「三分測って」→ 音声入力（課金）→ set_timer を呼ぶ判断（課金）
             → 結果を返す（課金）→「三分ですね」の音声（課金）
             ────── ここまでで普通の1往復と同じ、約1〜2円 ──────
             → 以降のカウントと発音は端末内。ゼロ
```

端末内で持つ意味は「呼び出しが無料になる」ことではなく、
**設定した後に接続を維持しなくてよい**こと。LLM に3分待たせる方式なら
3分間つなぎっぱなしで約10円かかる（30分なら約85円）。詳細は [cost.md](cost.md)。

## 状態遷移

```
  停止中
    │ 「常設待機を開始」をタップ
    ▼
  起動中 ── マイクとカメラを一度だけ取得（以後、取り直さない）
    │
    ├─ モデルあり ──> ウェイクワード待機 ←──────────┐
    │                    │ 「ねえクラピカ」を検出      │
    │                    ▼                          │
    └─ モデル無し ──> 会話中（WebRTC 接続）───────────┘
                         　  無操作60秒で自動切断
```

会話が切れても**マイクは止めない**。ウェイクワード待機に生きたトラックが要るため
（[ios-constraints.md](ios-constraints.md) を参照）。

## セッション確立

OpenAI は2方式を用意しているが、本プロジェクトは **Unified Interface** を採用した。

```
ブラウザ                     Worker                      OpenAI
   │  SDP offer               │                            │
   ├─────────────────────────>│  offer + session config    │
   │                          ├───────────────────────────>│ POST /v1/realtime/calls
   │                          │            answer SDP      │
   │       answer SDP         │<───────────────────────────┤
   │<─────────────────────────┤                            │
   │                                                       │
   └────────── WebRTC 直結（音声・データチャネル）──────────>│
```

この方式なら **APIキーも instructions もツール定義もクライアントに渡らない。**
ephemeral token 方式だと短命キーとセッション設定が渡ってしまう。
確立時の一往復だけなので、通話中の遅延には影響しない。

## シーケンス

### 通常の音声会話

目標は「発話終了から回答音声の開始まで1秒前後」。

```
（起動時に1回）タップ → getUserMedia({audio, video}) → Wake Lock 取得
      ↓
ウェイクワードを端末内で検出（通信なし）
      ↓
WebRTC 確立 → 発話 → OpenAI へ直送
      ↓  server VAD が発話終了を検出
音声ストリームが WebRTC で返る → 即再生
同時に response.output_audio_transcript.delta で本文が届き、画面にも出る
```

### 機能の呼び出し

カメラも天気もタイマーも、**同じ経路**を通る。

```
発話
  ↓  WebRTC データチャネル
OpenAI → response.function_call_arguments.done { name, call_id, arguments }
  ↓
src/tools/index.ts の runTool が実行場所を振り分ける
  ├─ look_at_camera  → 端末内で1フレーム撮影
  ├─ get_current_time → 端末内で即答
  ├─ set/list/cancel_timer → 端末内のタイマー
  └─ get_weather     → Worker 経由で Open-Meteo
  ↓
（画像がある場合）conversation.item.create { input_image }
conversation.item.create { function_call_output, call_id }
response.create
  ↓
音声で回答
```

**「画像が必要か」はモデルが判断する。** クライアント側に文言判定を持たない。
これにより想定外の言い回しにも追従する。

### タイマー

**設定した後は OpenAI もネットワークも通らない。**

```
「三分測って」→ set_timer(180) → 端末内に終了時刻を保存（localStorage）
                                        ↓
                  60秒無操作で WebRTC は切断される（課金停止）
                                        ↓
                          タイマーは動き続け、端末が音を鳴らす
```

終了時刻を**絶対時刻**で持つのが肝。相対秒数だと再読み込みで狂う。

## 認証とコスト制御

```
初回のみ:  デバイスキーを localStorage に保存
毎リクエスト: Authorization: Bearer <キー>
Worker:    定数時間比較で検証（DEVICE_KEY が設定されているときだけ）
```

- OpenAI APIキーは Worker Secrets のみに存在。クライアントJSにも Git にも入れない
- 無操作60秒で WebRTC を自動切断する。接続中はマイク音声を送り続けるため
- 使うモデルは端末から選べるが、Worker 側の許可リストで検証している
- 詳細は [cost.md](cost.md)

## 技術選定の要点

| 領域 | 採用 | 理由 |
|---|---|---|
| 会話 | OpenAI Realtime API（WebRTC） | 音声・画像・ツールを1経路で扱える。ブラウザ直結で最速 |
| バックエンド | Cloudflare Workers | メディア経路に入らないので薄くて済む。Durable Objects は現状不要 |
| フロント | Vite + React SPA | 単一画面のキオスクに SSR の利点がない。1ドメイン・1デプロイ |
| ウェイクワード | Vosk（Kaldi WASM） | オンデバイス・日本語対応・Apache-2.0・アカウント不要 |
| 天気 | Open-Meteo | APIキー不要 |

選定の経緯と捨てた案は [decisions.md](decisions.md)。
