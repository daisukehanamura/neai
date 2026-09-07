# ウェイクワード検出と、判断の割り振り

コードを読んで分かった実装を、2つの問いに答える形でまとめたもの。

1. **音声からウェイクワードをどう検出し、どうやって AI に繋いでいるか**（OSS の担当範囲を含む）
2. **「検索が必要か」を誰がどう判断し、どこへ割り振っているか**

概要は [architecture.md](architecture.md)、ファイルの索引は [code-map.md](code-map.md)。
ここはその2点だけを、行番号まで降りて追いかける。

---

# 第1部 ウェイクワード検出

## 1. 使っている OSS と、その担当範囲

| もの | 版 / ライセンス | 何を担っているか |
|---|---|---|
| **vosk-browser** | 0.0.8 / Apache-2.0 | Vosk（Kaldi）の WASM ビルドとその薄い JS ラッパ。`createModel()` でモデル tar.gz を展開し、`KaldiRecognizer` を **Web Worker の中で**動かす。音響モデル・言語モデル・デコード（＝音を単語列にする処理そのもの）は全部ここ |
| **Vosk 日本語モデル** | `vosk-model-small-ja-0.22` / Apache-2.0 / 約48MB | 語彙表（約20.7万語）と音響モデルの実体。`scripts/fetch-vosk-model.sh` が alphacephei.com から取得する |
| **Web Audio API / Web Speech API** | ブラウザ標準 | 音響前処理（ハイパス・コンプレッサ・ゲイン）と、ローカルコマンドの返事の音声合成 |
| ~~@picovoice/porcupine-web~~ | — | **未使用。** `package.json` に残っているだけの残骸。無料枠廃止で不採用（[decisions.md](decisions.md)） |

**OSS がやらないこと＝自前で書いた部分**は次の4つ。ここが `src/wakeword/index.ts` の中身。

- マイクの取得と共有（vosk-browser は `getUserMedia` を呼ばない。iOS ではマイクを取り直せないので、これは**むしろ好都合**だった。[ios-constraints.md](ios-constraints.md)）
- 音響前処理と、認識に回すかどうかのノイズゲート
- 48MB のモデルを分割配信して繋ぎ直す仕組み
- **認識結果テキストを「起動」「コマンド」「中断」のどれかに振り分ける判定**（後述の第5節）

つまり vosk-browser は **「音 → 文字」だけ**を担い、
**「その文字をどう扱うか」は 1バイトも持っていない。**

## 2. モデルをどう届けているか

`src/wakeword/config.ts`

Cloudflare Workers の静的アセットは **1ファイル 25MiB が上限**で、48MB のモデルはそのまま置けない。
`scripts/fetch-vosk-model.sh` が 20MB ずつに分割し、`manifest.json` に一覧を書く。

```
public/wakeword/
  manifest.json                 { "bytes": 総バイト数, "parts": [...] }
  vosk-ja.tar.gz.partaa         20MB
  vosk-ja.tar.gz.partab         20MB
  vosk-ja.tar.gz.partac          8MB
```

クライアント側 `loadModelUrl()` の流れ。

```
manifest.json を取得
  ├─ ある  → parts を順に fetch → Uint8Array を連結 → バイト数を照合 → Blob URL を作る
  └─ 無い  → 単体ファイル /wakeword/vosk-ja.tar.gz にフォールバック
                ↓
         Vosk.createModel(url)  ← ここから先は OSS の担当
                ↓
         Blob URL は即 revoke（48MB を抱え続けない）
```

バイト数が合わなければ例外を投げて止める。壊れたモデルで黙って精度だけ落ちる、という状態を作らない。
進捗は 25% 刻みで画面のログに出す（`src/wakeword/index.ts:88` 付近）。

`modelAvailable()` がモデルの有無を見て、**無ければウェイクワードを諦めて「タップ待ち」に落とす**
（`src/App.tsx` の `boot()`）。モデルが無くてもアプリは動く。

## 3. 音がテキストになるまで

`src/wakeword/index.ts` の `start()`（81行〜）が組む信号経路。

```
MediaController が保持するマイクトラック（WebRTC と共有・取り直さない）
        │
   MediaStreamSource
        │
   ハイパス 100Hz          ← 空調・冷蔵庫・床鳴りを先に落とす
        │                    （コンプレッサが低音に反応しないように、順序が先）
   DynamicsCompressor      ← threshold -45dB / knee 20 / ratio 8 / attack 3ms / release 150ms
        │                    小さい音だけ持ち上げる。遠くの声を拾いつつ近くで割れない
   Gain ×6                 ← 設定で変えられる。届く最小値にするのが良い
        │
   ScriptProcessor(4096,1,1)
        │  ├─ listening が false なら捨てる          ← 会話中は何もしない
        │  └─ ノイズゲート: RMS < gateDb なら「静か」← 既定 ON / -55dB
        │
   Silero VAD（512サンプル=32msごと）  ← 既定 ON。src/wakeword/vad.ts
        │  声が出ている区間だけを通す。第6節
        │
   recognizer.acceptWaveformFloat(Float32Array, 16000)
        │  vosk-browser が getChannelData(0) と sampleRate を取り出し、
        │  Web Worker へ postMessage する
        ▼
   ┌─────────────────────────────────┐
   │ Web Worker（vosk-browser / WASM Kaldi） │  ← ここだけが OSS
   │  文法で絞ったデコード                    │
   └─────────────────────────────────┘
        │  partialresult（途中経過） / result（確定）
        ▼
   check(text, isFinal)  ← 自前の判定。第5節
```

出力は**無音のゲイン経由で destination へ落としている**（`gain.connect(node).connect(mute).connect(ctx.destination)`）。
出力に繋がないと `onaudioprocess` が回らないブラウザがあるため。音は出ない。

`AudioContext({ sampleRate: 16000 })` で **16kHz を直接要求する**のが要点。
Vosk が要求するレートをブラウザに作らせているので、自前のダウンサンプラが要らない
（Porcupine 用に書いていた AudioWorklet は、この理由で削除されている）。
16kHz が通らなかった場合は警告ログを出すだけで、動作は続ける。

**デコードは Web Worker で走る**ので、メインスレッドは音響チェーンと postMessage しかしない。
常時稼働でも UI が固まらないのはこのため。

| つまみ | 既定 | 何のため |
|---|---|---|
| `gain` | 6 | 遠くの声を届かせる。**届く最小値**にするのが良い（上げるほど誤検出も増える） |
| `compressor` | ON | ゲインと違い、小さい音だけを持ち上げる |
| `highpass` | ON | 低域の定常ノイズを切る |
| `gate` / `gateDb` | ON / -55dB | 静かな区間を認識に回さない。誤検出と CPU が減るが、小声を落とす |
| `vad` | ON | 人の声が出ている区間だけ認識に回す。第6節 |

すべて設定画面から変更でき、`localStorage` に保存される（`src/settings.ts`）。

## 4. 文法（grammar）で認識対象を絞る

```ts
new this.model.KaldiRecognizer(16000, JSON.stringify(this.config.grammar));
```

Vosk は認識対象の語句リストを渡せる。**リストの外は出てこない。**
語彙が数語まで狭まるので、精度が上がり CPU も下がる。

リストは `src/App.tsx:246` で組み立てる。

```
ウェイクワードの語（settings.ts の WAKE_PRESETS）
   例: ["ねえ クラピカ", "クラピカ"]
        ＋
ローカルコマンドの語（tools/commands.ts の commandGrammar()）  ← localCommands が ON のときだけ
   "タイマー 三 分" … 分/秒/時間 × 数詞の全組み合わせ、
   "タイマー 止めて" "今 何時" "あと 何分"、STOP_PHRASES
        ＋
"[unk]"                                              ← 必ず最後に入れる
```

**`[unk]` が肝。** これが無いと、Vosk は無関係な物音や会話を
**リスト内の最も近い語句に強制的に当てはめてしまう**。
`[unk]` があることで「どれでもない」を返せるようになる。

制約が2つある。

- **モデルの語彙表に存在する語しか書けない。** 「AI」「エイアイ」は語彙に無く、「エーアイ」と書く必要がある
- ローカルコマンドを ON にすると語彙が増え、**ウェイクワードの精度に影響しうる**。だから設定で切れるようにしてある

## 5. 「合致した」の判定と、AI に繋ぐまで

判定は `check(text, isFinal)`（`src/wakeword/index.ts:172`）に全部入っている。
検出器は**3つの聴取モード**を持ち、モードごとに見るものが違う。

| モード | いつ | 何を見るか | 途中経過を使うか |
|---|---|---|---|
| `off` | 会話中（AI が喋っていないとき） | 何も | — |
| `wake` | 待機中 | ウェイクワード＋ローカルコマンド | ウェイクワードのみ使う |
| `stop` | AI の読み上げ中 | 中断の合図だけ | 使う |

判定の使い分けが3種類ある。**これが誤動作対策の中心。**

| 対象 | 使う結果 | 照合 | 理由 |
|---|---|---|---|
| ウェイクワード | 途中経過も可 | **部分一致** `text.includes(match)` | 反応の速さを優先。前後に語が付いても拾いたい |
| ローカルコマンド | **確定のみ** | **前後一致** `/^タイマー…$/` | 途中経過は文字列が揺れる。部分一致だと会話中の「十分です」「止めて」を拾う |
| 中断の合図 | 途中経過も可 | 正規表現 | 止めたいときに待たされるのは本末転倒 |

さらに2つのタイマーが挟まる。

- **`COOLDOWN_MS = 3000`** — 一度当たったら3秒は再検出しない。1回の呼びかけで何度も起動しないため。中断の合図には**適用しない**（`stop` モードは cooldown 判定より手前で return する）
- **`WAKE_HOLD_MS = 700`** — ウェイクワードを聞いても**すぐには会話を開かない**。「ねえクラピカ、**タイマー三分**」のように後ろにコマンドが続く場合に、先に OpenAI へ繋いで課金してしまわないため。700ms 以内にコマンドが確定したら `cancelPendingWake()` で予約を取り消す。ローカルコマンドが OFF のときは待つ理由がないので即座に開く

> **要検証：700ms は短すぎる可能性がある。**
> タイマーが動き出すのは**ウェイクワードが途中経過で当たった瞬間**（`src/wakeword/index.ts:207`）で、
> `if (this.pendingWake !== null) return;` により後続の途中経過では延長されない。
> 一方、続く「タイマー三分」は発話に1秒以上かかり、そのうえ Vosk が `result`（確定）を出すには
> 無音区間が要る。**確定が届く前に 700ms が満了して会話が開いてしまう**計算になる。
>
> さらに `matchCommand()` の正規表現は `^…$` の前後一致で、照合前に消すのは空白だけ。
> ひと息で「ねえクラピカ、タイマー三分」と言うと確定テキストは
> `ねえクラピカタイマー三分` になり、**どのパターンにも一致しない**。
> 分けて言った場合（＝Vosk が2つの確定を出す場合）にしか成立しない設計になっている。
>
> 直すなら方向は2つ。
> (a) 固定時間で待つのをやめ、**発話が途切れた（確定が出た）ことを合図に判断する**。
>     待ち時間を延ばすと通常の起動レイテンシがそのまま悪化するので、固定値の延長は割に合わない
> (b) `matchCommand()` の手前で**先頭のウェイクワードを剥がす**（例: `text.replace(/^.*クラピカ/, "")`）
>
> どちらも実機で測ってから決める話で、現状は**未計測**。

`wake` モードでの分岐を上から順に書くとこうなる。

```
check(text, isFinal)
  ├ cooldown 中？ → 何もしない
  ├ isFinal かつ onCommand(text) が true
  │     → 端末内で処理して終わり。**OpenAI に繋がない＝課金ゼロ**
  ├ match に含まれない → 何もしない（[unk] の出番）
  └ 含まれる → 700ms 後に onDetected()
```

### 検出から AI 読み込みまでのコード経路

```
onDetected()                                  wakeword/index.ts
   ↓
App.tsx openConversation()                    App.tsx:127
   ├ detector.pause()                         ← AI 自身の声で誤検出しないよう検出を止める
   ├ mediaRef.current.current（取得済みのストリーム）を使う ← 取り直さない（iOS 制約）
   ↓
new RealtimeSession(callbacks, {idleSec, model})
   ↓ session.start(stream)
   ├ RTCPeerConnection を作り、音声トラックだけ addTrack（映像は載せない）
   ├ createDataChannel("oai-events")
   ├ createOffer / setLocalDescription
   ↓
POST /api/session  (Authorization: Bearer <デバイスキー>, x-neai-model: 選択モデル)
   ↓                                          worker/index.ts createCall()
Worker が SDP offer ＋ sessionConfig(instructions/tools/VAD) を multipart で
POST https://api.openai.com/v1/realtime/calls
   ↓ answer SDP が返る
setRemoteDescription → **ブラウザと OpenAI が WebRTC で直結**
   ↓
startEnergyPolling() / startIdleWatch()
```

**ウェイクワードの検出結果そのものは OpenAI へ送らない。**
送るのは「接続する」という事実だけで、聞き取ったテキストは端末内で捨てられる。
待機中は音声が一切ネットワークに出ない、というのはここで成立している。

### 会話中の聴取（読み上げ中の「ストップ」）

```
AI が喋り始める（transcript.delta の初回）
   → realtime.ts が WebRTC のマイクを止める（track.enabled = false）
   → onSpeaking(true) → detector.listenForStop(() => session.interrupt())
        ↓ 「ストップ / やめて / 止めて / ちょっと待って」
   session.interrupt()
        → response.cancel ＋ output_audio_buffer.clear ＋ input_audio_buffer.clear
          （cancel だけだと再生待ちの音が鳴り切ってしまう）
```

読み上げ中にマイクを止めるのは、**物音や自分の声で応答が中断・作り直しになるのを防ぐ**ため。
サーバ側の自動中断も `interrupt_response: false` で切ってあり（`worker/config.ts:220`）、
**中断の権限は端末側に一本化されている。**

> **要検証の懸念**：`setMicEnabled(false)` は `MediaStreamTrack.enabled = false` であり、
> このトラックは Vosk の `MediaStreamSource` と**同じトラック**。仕様上、`enabled = false` の
> トラックはすべての受け手に無音を流すため、読み上げ中は Vosk にも無音しか届かない可能性がある。
> その場合、声での中断は成立しない（画面の「止める」ボタンは効く）。実機での確認が必要。
> 直すなら、WebRTC の `RTCRtpSender.replaceTrack(null)` で送信側だけ止める、
> あるいは検出用に別トラック（`track.clone()`）を持つ方向になる。

## 6. Vosk の文字起こしは何をしていて、何をしていないか

「日本語を理解して整形している」わけではない。**Kaldi の古典的な音声認識**であって、LLM ではない。

```
音（16kHz PCM）
  → 音響モデル      どの音素らしいかの確率
  → 発音辞書        音素列 ↔ 表記のひも付け
  → 言語モデル      **どの単語列がありそうか**（ここだけが「日本語らしさ」）
  → WFST 上の探索   一番もっともらしい単語列を1つ選ぶ
  → テキスト
```

「意味」は一切見ていない。効いているのは**単語の並びやすさという統計**だけ。
しかも本プロジェクトは文法（第4節）を渡しているので、言語モデルは
**渡したフレーズ＋`[unk]` だけの極端に小さいもの**に差し替わっている。
待機中は自由な文字起こしすらしておらず、**閉じた候補からの選択**をしている。

やっていないこと。

| やらないこと | 影響 |
|---|---|
| 句読点の付与 | 出力に「、」「。」は出ない |
| 数字の正規化（ITN） | 「3分」にはならない。**「三分」のまま**出る。だから `commands.ts` の `NUMBERS` は漢数字をキーにしている |
| 語彙外の語の生成 | 辞書に無い語は出せない。「AI」「エイアイ」は語彙に無く「エーアイ」と書く必要がある（[decisions.md](decisions.md)） |
| 表記の選択 | 漢字/カナは**辞書の見出し表記のまま**。アプリ側で整形していない |

出力は**単語が空白区切り**で返る（`result` は `{conf, start, end, word}[]` と `text` を持つ）。
日本語に空白は無いので、`matchCommand()` と `isStop()` は照合の前に
`text.replace(/\s+/g, "")` で空白を落としている。文法を `"タイマー 三 分"` と
空白入りで書いているのも同じ理由。

**単語ごとの信頼度 `conf` は返ってきているが、コードは使っていない。**
判定は文字列一致だけで、閾値を持っていない。誤検出を締めたくなったときの手札として残っている。

### 会話の文字起こしは Vosk ではない

紛らわしいので明記しておく。**このシステムには独立した音声認識が2つある。**

| | 誰が | 対象 | 用途 |
|---|---|---|---|
| 端末内 | Vosk | 待機中と読み上げ中の音 | 起動・ローカルコマンド・中断の判定 |
| OpenAI 側 | Realtime モデル | WebRTC で送った生の音声 | 会話そのもの |

会話中の聞き取りに Vosk は**関与しない**。Vosk の文字起こし結果が
OpenAI へ送られることも無い。画面に出る発話テキストは
`response.output_audio_transcript.delta`、つまり **AI 側が喋っている内容**であって、
利用者の発話の文字起こしではない。

---

# 第2部 「検索が必要か」は誰が判断しているか

## 判断者は3層ある

発話1つが通る道は、判断者の違いで3段に分かれる。**上の層で片が付けば下には行かない。**

| 層 | 判断者 | 判断の材料 | 判断すること | 費用 |
|---|---|---|---|---|
| **1. 端末（規則）** | `tools/commands.ts` の正規表現 | Vosk の確定テキスト | 起動するか / ローカルで処理するか | ゼロ |
| **2. Realtime モデル** | `gpt-realtime-2.1`(または mini) | 音声・画像・`instructions`・ツール定義 | **どのツールを呼ぶか（search_web を含む）** | トークン課金 |
| **3. 検索モデル** | `gpt-5.6-luna`（Worker 内） | クエリ文字列・`web_search` ツール | 実際に何を検索し、どう2文に要約するか | $0.01＋トークン |

`src/tools/index.ts` の `runTool()` も分岐しているが、**あれは判断ではない。**
名前で実行場所（端末内 / Worker）へ振り分けるだけの静的な switch で、
「呼ぶかどうか」は一切決めていない。

## 全体のフロー

```
発話
 │
 ▼ Vosk（端末内・常時）
 ├─ 正規表現に前後一致 ────→ 端末内で実行 → SpeechSynthesis で返事      【層1・課金ゼロ】
 │                             タイマー設定/取消、残り時間、時刻
 ├─ どれでもない（[unk]） ──→ 何もしない
 │
 └─ ウェイクワードに部分一致 → 700ms 待つ → WebRTC 接続
                                   │
                                   ▼ OpenAI Realtime                    【層2】
                                 音声を聞いて semantic_vad で切れ目を判定
                                   │
                                   ├─ 自分で答えられる → そのまま音声で回答
                                   │
                                   └─ ツールが要る → response.function_call_arguments.done
                                          { name, call_id, arguments }
                                          │
                                          ▼ src/tools/index.ts runTool()（静的な振り分け）
                                          ├ look_at_camera        端末内（カメラ1枚）
                                          ├ get_current_time      端末内
                                          ├ set/list/cancel_timer 端末内
                                          ├ get_weather           Worker → Open-Meteo
                                          └ search_web ───────┐
                                                              ▼
                                       GET /api/tools/search?q=…（Bearer 認証）
                                                              ▼ worker/tools/search.ts  【層3】
                                       POST /v1/responses
                                         model: gpt-5.6-luna
                                         tools: [{ type: "web_search",
                                                   search_context_size: "low" }]
                                                              ▼
                                       このモデルが**自分で検索を実行**し、2文に要約して返す
                                                              ▼
                                       forSpeech() で URL・記号・引用を削る
                                                              ▼
                                       { 結果: "…", _費用ドル: 0.0102 }
                                                              ▼
                                       クライアントが _費用ドル を抜いて集計へ回す
                                       （AI に渡すと読み上げてしまうため）
                                                              ▼
                                       function_call_output → response.create
                                                              ▼
                                                        音声で回答
```

## そもそも、なぜ AI が「ツールを呼べる」のか

**OpenAI が Worker の API を叩いているわけではない。** ここは向きを間違えやすい。

モデルができるのは「**このツールを、この引数で呼びたい**」と**言うこと**だけで、
実行するのは常に端末側。仕組みは3ステップしかない。

```
① セッション確立時（1回だけ）
   Worker が sessionConfig() の tools[] を OpenAI へ渡す
   ＝「あなたが要求できる関数は、この7つ。引数の形はこれ」という宣言
   （worker/config.ts の TOOLS。名前・説明・JSON Schema）

② 会話中
   モデルが必要と判断すると、音声の代わりに**イベントを1つ吐く**
   WebRTC のデータチャネル "oai-events" 経由で:
     { type: "response.function_call_arguments.done",
       name: "search_web", call_id: "call_abc",
       arguments: "{\"query\":\"バスケ日本代表の直近の試合予定\"}" }
   → **この時点では何も実行されていない。ただの構造化された要求。**

③ 端末が実行して、結果を会話に戻す
   src/realtime.ts:338 が受けて runTool() を呼ぶ
   → 端末内で処理、または端末から Worker を叩く
   → conversation.item.create { function_call_output, call_id, output }
   → response.create   ← 「続きを喋って」
   → モデルが結果を読んで音声で回答
```

つまり **コールバックではなく、モデルからの要求を端末がポーリング的に受けて代行している**形。
`call_id` が要求と結果を紐付ける唯一の鍵で、これを付けて返さないと会話が繋がらない。

通信の向きを整理すると、**OpenAI から自分たちのサーバへ入ってくる線は1本も無い。**

```
OpenAI ──(データチャネルで「呼びたい」)──> iPhone ──(HTTPS)──> Worker ──> 外部API
   ▲                                        │
   └────────(実行結果を返す)─────────────────┘

OpenAI → Worker の矢印は存在しない。Worker に受け口も無い（/api/* は端末専用）
```

だから Worker 側に webhook も公開エンドポイントも要らず、`/api/*` は
デバイスキーで閉じたままにできる。ツールが増えても、公開面は増えない。

なお、この方式の代償が**画像のときだけ発生する**：`look_at_camera` は結果に画像を伴うため、
`function_call_output` の前に `conversation.item.create { input_image }` を差し込んでいる
（`src/realtime.ts:375` 付近）。ツール結果に画像を直接入れられないための回り道。

## 層2：Realtime モデルは何を根拠に search_web を呼ぶか

**クライアントに文言判定は一切ない。** 判断材料は Worker が組む `sessionConfig` の中の2つだけで、
どちらも `worker/config.ts` にある。この2箇所が「検索の呼ばれ方」を決める全てで、
書き換えれば再デプロイだけで挙動が変わる（クライアントの変更は要らない）。

**(a) instructions の該当セクション**（`worker/config.ts:75`）

```
# 最新の情報
- あなたの知識には期限があります。最近の出来事、試合日程、ニュース、
  店の営業時間、価格などを問われたら search_web を呼んでください。
- 歴史や一般常識のように変わらないことでは呼ばないでください。
- 検索には数秒かかります。呼ぶ前に「調べますね」と一言だけ言ってください。
- 検索結果は事実として扱い、そこに無いことを補わないでください。
```

**(b) ツール定義の description**（`worker/config.ts:146`）

```
ウェブを検索して最新の情報を調べる。あなたの知識には期限があるため、
最近の出来事、試合日程、ニュース、店の営業時間、価格、人物の近況など
「今どうなっているか」を問われたら呼ぶこと。
歴史や一般常識のように変わらないことでは呼ばない。結果が返るまで数秒かかる。
```

`query` 引数の description で「利用者の言葉のままではなく、**検索に適した形にすること**」と
指示している。**クエリの言い換えもモデルの仕事**で、端末側は文字列をそのまま Worker へ渡す。

判断の設計は `look_at_camera` と同じ形をしている（[decisions.md](decisions.md) の「カメラは
モデルに呼ばせる」）。違いは既定の向きで、カメラは**既定「呼ばない」**に倒し呼ぶ例／
呼んではいけない例を列挙しているのに対し、検索は**必要なら呼ぶ**方向に書いてある。
カメラは呼ばれすぎる問題が実際に起きたので既定を反転した経緯があり、
検索が呼ばれすぎるようなら同じ手当てをすることになる。

## 層3：Worker 側の検索の中身

`worker/tools/search.ts`

Realtime API には組み込みの `web_search` が使えない。そこで **Worker から Responses API を
呼び、その中の `web_search` ツールを使う。**同じ APIキーで済み、追加のアカウントも鍵も要らない。

| 項目 | 値 | なぜ |
|---|---|---|
| モデル | `gpt-5.6-luna` | 要約するだけなので安く速いものでよい。読み上げるのは Realtime 側 |
| `search_context_size` | `low` | 短い答えが欲しいだけ。速さと費用を優先 |
| instructions | 「2文以内」「URL・引用・記号を書かない」など | **音声で読み上げられる**前提の制約 |
| 後処理 | `forSpeech()` | 指示だけでは引用が混ざるので、Markdown リンク・URL・記号を機械的に削る |
| 費用 | `$0.01` ＋ トークン | `_費用ドル` として返し、端末側の累計に加える |

失敗時は例外にせず `{ error: "…" }` を返す。**モデルには「検索できなかった」が伝わり、
会話は続く。**

## 待たせている間の扱い

検索は7〜8秒かかるため、待ち時間の扱いがコードに埋め込まれている。

```
runTool 開始
  ├ toolRunning = true / マイクを止める   ← 端末の読み上げや物音を発話として拾わないため
  ├ onPhase("thinking", labelOf(name))   ← 「ウェブを調べています」を画面に出す
  ├ speakWhileWaiting("調べています")     ← 端末内の音声合成。無料
  ↓ …数秒…
  ├ input_audio_buffer.clear             ← 溜まった音は捨てる
  ├ toolRunning = false / マイクを戻す
  └ function_call_output → response.create
```

画面側（`App.tsx`）は待ち秒数と「マイクは止めています」を出す。
無言のまま数秒固まると、話しかけ直されて状況が悪化するため。

## 会話モデルの割り振り（通常 / mini）は自動ではない

「検索が必要なモデル」を系が選ぶ仕組みは**無い。** 会話モデルは**人が設定で選ぶ**。

```
設定画面（MODELS: 通常 / mini）
  → settings.model（localStorage）
  → RealtimeSession に渡す
  → POST /api/session の x-neai-model ヘッダ
  → Worker: ALLOWED_MODELS.includes(requested) ? requested : env.REALTIME_MODEL
                                    ↑ 端末の申告をそのまま信用しない
  → sessionConfig(env, model)
  → 応答ヘッダ x-neai-model で確定値を返す
  → クライアントは pricing.ts の料金表を引くのにこれを使う
```

対して**検索モデル（`gpt-5.6-luna`）は Worker のコード定数**で、端末からは選べない。
安く速いことが要件で、選ばせる意味がないため。

## 変えたいときに触る場所

| 変えたいこと | 触る場所 |
|---|---|
| ウェイクワードの語 | `src/settings.ts` の `WAKE_PRESETS`（語彙表に存在する語のみ） |
| 端末内で処理する言い回し | `src/tools/commands.ts` の `commandGrammar()` と `matchCommand()`（**両方**。文法に無い語は認識されない） |
| 検出の感度 | 設定画面（gain / compressor / highpass / gate） |
| 検索を呼ぶ／呼ばない基準 | `worker/config.ts` の instructions と `search_web` の description |
| 検索の質・費用 | `worker/tools/search.ts` の `MODEL` と `search_context_size` |
| 会話モデルの選択肢 | `src/settings.ts` の `MODELS` と `worker/index.ts` の `ALLOWED_MODELS`（**両方**） |
| 中断の合図 | `src/wakeword/index.ts` の `isStop()` と `src/tools/commands.ts` の `STOP_PHRASES`（**両方**） |

---

# 第3部 デプロイ：何が、どこに載るのか

## Workers は「関数」だけではない

Cloudflare Workers は確かにサーバーレス関数だが、**Workers Static Assets** という
静的ファイル配信が同居しており、`wrangler deploy` 1回で両方が上がる。
React の SPA はこちらに載っている。**Pages も R2 も別デプロイも要らない。**

```
                 https://neai.<account>.workers.dev
                              │
                     ┌────────┴────────┐
                     │  Worker script   │  worker/index.ts をバンドルした index.js（約18KB）
                     │  fetch(request)  │
                     └────────┬────────┘
                              │
              /api/* か？ ────┴──── それ以外
                  │                     │
        認証 → 中継/ツール実行     env.ASSETS.fetch(request)
        （OpenAI / Open-Meteo）          │
                                  ┌──────┴──────┐
                                  │ 静的アセット  │  index.html, JS/CSS,
                                  │ (Cloudflare) │  Vosk WASM, モデル48MB
                                  └─────────────┘
```

コード上は `worker/index.ts` の最終行、たった1行がこれ。

```ts
return env.ASSETS.fetch(request);
```

`ASSETS` は `wrangler.jsonc` の `assets.binding` で結びつけられたバインディング。
`not_found_handling: "single-page-application"` により、未知のパスは
`index.html` にフォールバックする（SPA なのでルーティングはブラウザ側）。

**リクエストは必ず Worker を通る。** 静的ファイルであっても、まず関数が動いてから
アセットへ委譲される（この構成では `/api/` 以外は素通し）。

## デプロイの手順

```bash
npm run deploy
```

の中身は `package.json` のとおり3段。

```
tsc --noEmit          型検査。通らなければここで止まる（成果物は作らない）
vite build            ビルド
wrangler deploy       アップロード
```

`vite build` は `@cloudflare/vite-plugin` が入っているため、**出力が2つに分かれる**。

```
dist/
├ client/                    ← 静的アセットとして上がる方
│  ├ index.html
│  ├ assets/
│  │   ├ index-*.js           React 本体＋アプリ  約237KB
│  │   ├ index-*.css          約11KB
│  │   └ vosk-*.js            **約5.8MB**（vosk-browser。動的 import なので別チャンク）
│  ├ wakeword/                public/ がそのままコピーされる
│  │   ├ manifest.json
│  │   └ vosk-ja.tar.gz.parta{a,b,c}   **約48MB**
│  └ .assetsignore
└ neai/
   ├ index.js                ← Worker として上がる方。約18KB
   └ wrangler.json           生成された実効設定（assets.directory: "../client" が入る）
```

前提として、初回は次が済んでいること（[deploy.md](deploy.md)）。

```bash
npx wrangler login
npm run model                        # 48MB のモデルを取得して20MBずつに分割
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put DEVICE_KEY    # 未設定で公開すると誰でも自分の課金で使える
```

## 上がるもの / 上がらないもの

| | 中身 |
|---|---|
| **上がる** | `dist/client/**`（HTML・JS・CSS・Vosk の WASM・**モデル48MB**）と `dist/neai/index.js` |
| **上がらない** | `src/` `worker/` の **TypeScript ソース**、`docs/`、`spike/`、`scripts/`、`node_modules/`、`.dev.vars`、`README` 類 |

- ソースは**バンドルされた成果物として**上がる。`.ts` そのものは配置されない
  （ソースマップも既定では出していない）
- **`instructions`・ツール定義・APIキーはブラウザに一切降りてこない。**
  これらは `dist/neai/index.js`（＝サーバ側で実行されるコード）にしか無く、
  静的アセットとしては配信されない。Unified Interface を選んだ理由がここで効いている
- Secrets（`OPENAI_API_KEY` / `DEVICE_KEY`）は**コードにもアセットにも入らない**。
  `wrangler secret put` で別管理され、Worker の実行時にだけ `env` に現れる
- `wrangler.jsonc` の `vars`（`REALTIME_MODEL`、既定地点）は**平文で Worker に埋まる**。
  秘密ではないものだけを置いている
- モデル48MB は Git には入れず（`.gitignore`）、`npm run model` で毎回取り直す。
  **クローンしただけではデプロイできない**のはこのため

## サイズと無料枠

| 制限 | 実際 |
|---|---|
| 静的アセット 1ファイル 25MiB | 最大20MB（分割済み）。**分割前のファイルが `public/` に残っているとデプロイが失敗する**ので、スクリプトが毎回消している |
| 静的アセット 2万ファイル | 10個程度 |
| Worker 圧縮後 3MB | 約18KB |
| リクエスト 10万/日 | 静的配信は計上対象外 |

初回アクセスで**約54MB**（Vosk 5.8MB ＋ モデル48MB）落ちるが、
2回目以降はブラウザキャッシュから読まれる。常設端末なので実質1回きりの負担。

## ローカル開発との違い

**経路は同じ。** `npm run dev` でも `@cloudflare/vite-plugin` が Worker を
同じプロセスで動かすので、`/api/*` も分割モデルの取得も本番と同じコードを通る。
違うのは HTTPS の終端（開発は `scripts/dev-proxy.mjs` の自己署名証明書）と、
`.dev.vars` に `DEVICE_KEY` を書かなければ認証が要求されないことだけ。

---

## 気づいた点

- **中断の合図の判定が2箇所にある。** `wakeword/index.ts` の `isStop()`（前後一致でない正規表現）と
  `tools/commands.ts` の `isStopCommand()`（前後一致）で条件が違い、後者は現在どこからも呼ばれていない。
  文法用の `STOP_PHRASES` も別に定義されている。語を足すときに片方だけ直す事故が起きやすい
- **読み上げ中の Vosk が実際に音を受け取れているか**は要検証（第1部末尾の懸念）
- **検索は LLM を2つ直列に通る。** Realtime が呼ぶ判断をして、Responses API 側のモデルが
  検索と要約をする。7〜8秒の内訳はほぼ層3。速くしたいならここを短くするしかない
- **層3の要約が誤っても、層2は「事実として扱う」と指示されている。** 検索結果の正しさは
  `gpt-5.6-luna` と `web_search` に全面的に依存している
- **`WAKE_HOLD_MS = 700` は狙いどおり働いていない可能性が高い**（第1部第5節の囲み）。
  「ねえクラピカ、タイマー三分」をひと息で言うと、確定テキストにウェイクワードが残って
  前後一致に落ち、分けて言っても確定が届く前に 700ms が満了する計算になる。
  課金ゼロで済むはずの経路が、実際には会話を開いている恐れがある。**実機で要計測**
- **`conf`（単語ごとの信頼度）を使っていない。** 誤検出を締めるつまみとして未使用のまま残っている


---

# 第6節 声の判定（Silero VAD）

`src/wakeword/vad.ts` と `src/wakeword/index.ts` の `pump()` 以下。

## なぜ入れたか

待機中は Vosk が**常時**動いている。給電した常設端末なので電池は減らないが、
熱は出続け、給電しながら熱を持つのは電池の劣化に直結する。
人が喋っていない時間は一日のほとんどなので、そこを止めれば丸ごと減る。

音量だけを見るノイズゲートとの違いは、**食器・ドア・足音を弾けること**。
これらは -55dB を軽く超えるので、ゲートだけでは全部 Vosk に届いていた。

推論は 512サンプル（32ms）ごとに1回で、1フレーム 1ms 未満。
Vosk の音響モデルより2桁軽いので、挟むほうが差し引きで安い。

## 判定の作り

| つまみ | 値 | 何のため |
|---|---|---|
| `VAD_ON` / `VAD_OFF` | 0.5 / 0.35 | 入口と出口でしきい値を変える。同じ値だと境目で発話が寸断される |
| `PREROLL_FRAMES` | 12（約380ms） | VAD が反応するのは声が出た**後**。手前を控えておかないと「クラピカ」が「ラピカ」になる |
| `HANGOVER_FRAMES` | 20（約640ms） | 声が途切れてもここまでは続きとみなす。短いと「ねえクラピカ、（間）タイマー三分」で切れる |
| `MAX_SPEECH_FRAMES` | 312（約10秒） | テレビ等で VAD が張り付いたときに一度区切る |

推論が非同期なので `onaudioprocess` から直接は呼べない。
複製して積み、`pump()` が順に食べる。追いつかないときは古いものを捨てて警告を出す。

## 落とし穴：確定結果が出なくなる

**VAD で無音を捨てると、Vosk に無音が届かなくなる。**
Vosk は無音区間で発話の終わりを判断しているので、放っておくと
`result`（確定）がいつまでも出ない。ローカルコマンドは確定でしか判定しないため、
これをやると「タイマー三分」が動かなくなる。

そこで発話の終わりを検出したら `retrieveFinalResult()` を呼び、
Vosk 側に区切りを教えている（`endSpeech()`）。
**端点の判断を Vosk から VAD に移した**、というのが実際に起きていること。

## VAD に渡す前に増幅を戻す

音響チェーンはゲイン6倍を通った後なので、そのまま渡すと何もかも振り切る。
Silero は普通の録音レベルで学習されているため、`forVad()` で `gain` で割り、
±1 に丸めてから渡している。

## 無ければ動かないのか

動く。`vadAvailable()` がモデルの有無を見て、無ければ警告を出して
**従来どおりノイズゲートだけで**待機する（`./scripts/fetch-vad-model.sh` を案内する）。
実行中に推論が失敗した場合も、素通しに落として聞き続ける。
聞こえなくなるより動き続けるほうを取っている。
