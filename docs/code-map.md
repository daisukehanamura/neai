# コードマップ

どのファイルが何を担っているか。**変更するときにどこを触ればいいか**の索引。

## ディレクトリ構成

```
neai/
├ index.html            SPA の入口
├ vite.config.ts        Vite + Cloudflare プラグイン
├ wrangler.jsonc        Worker の設定。モデル名や既定地点はここ
├ tsconfig.json
│
├ src/                  ブラウザ側
│  ├ main.tsx           エントリ
│  ├ App.tsx            状態機械と画面の組み立て
│  ├ Ambient.tsx      待機中の画面（時計・天気・タイマー）
│  ├ SettingsPanel.tsx  設定画面
│  ├ settings.ts        設定の型・既定値・localStorage・ウェイクワード候補
│  ├ realtime.ts        WebRTC 接続とイベント処理
│  ├ media.ts           マイクとカメラの保持、フレーム取得
│  ├ pricing.ts         料金表と費用計算
│  ├ styles.css
│  ├ tools/
│  │  ├ index.ts        AI から呼ばれた機能の振り分け
│  │  ├ commands.ts     ローカルコマンドの照合と音声合成
│  │  └ timer.ts        タイマーの保存・カウント・アラーム音
│  └ wakeword/
│     ├ index.ts        Vosk による検出器
│     └ config.ts       モデルの場所と設定の型
│
├ worker/               Cloudflare Worker 側
│  ├ index.ts           ルーティング・認証・SDP中継・ツールの実行
│  ├ config.ts          instructions とツール定義、セッション設定
│  └ tools/
│     └ weather.ts      Open-Meteo
│
├ public/wakeword/      Vosk の日本語モデル（48MB / Git には入れない）
├ scripts/
│  ├ dev-proxy.mjs      開発用の HTTPS 終端
│  └ fetch-vosk-model.sh モデルの取得と変換
├ spike/                実機検証ページ。本番には含まれない
└ docs/                 この文書群
```

## ブラウザ側

### `App.tsx`
状態機械と画面の組み立て。状態は **停止中 / 起動中 / ウェイクワード待機 / タップ待ち / 会話中**。

- 起動時に `MediaController.acquire()` を一度だけ呼ぶ
- ウェイクワードのモデルがあれば検出器を起動、無ければタップ開始にフォールバック
- 検出または「話しかける」で `openConversation()` → `RealtimeSession` を作る
- Wake Lock の取得と、画面復帰時の取り直し
- タイマーの表示と、鳴っているアラームの停止

### `Ambient.tsx`
待機中の画面。**常設端末なので、何も出ていない画面は画面を遊ばせているのと同じ。**
時計・日付・天気・週間予報・動いているタイマーを、離れた場所から読める大きさで出す。

週間予報は7日を並べた小さな一覧。**気温は数字、降水確率は棒の高さで表す。**
色で塗り分けないのは、離れて見ると色の差が効かないため。
降水確率の数字は50%以上の日だけに付ける（全部に付けると読めない）。

天気の取得契機は3つ。**会話の開始や終了では取り直さない。**

| 契機 | 条件 |
|---|---|
| 常設待機を開始したとき | 毎回 |
| 8時間ごと（1日3回） | 画面が動いている間 |
| 画面に戻ったとき | 前回の取得から8時間以上経っていれば |

主な用途が週間予報で、日単位の予報はそう頻繁に変わらないため回数を抑えている。
**その代わり、待機画面の「現在の気温」は最大8時間古い値になる。**

3つ目があるのは、**iOS が画面を離れると JS を止めて `setInterval` も止まる**ため。
これが無いと、戻ってきたときに古い天気が残り続ける。

AI が `get_weather` を呼ぶときは、この保存分とは別に毎回取りに行く。

アラームが鳴っているときは画面いっぱいの停止ボタンになる。
どこを触っても止まるようにするため。

iPhone XR は LCD なので焼き付きの心配はなく、常時表示に向いている。

### `realtime.ts`
OpenAI との WebRTC 接続そのもの。**このファイルはマイクを取得しないし、止めもしない。**

- `start(stream)` … 渡されたストリームで PeerConnection を張る
- データチャネル `oai-events` のイベント処理
  - `input_audio_buffer.speech_started/stopped` … 状態遷移とレイテンシ計測の起点
  - `response.output_audio_transcript.delta` … 画面に出す本文
  - `response.function_call_arguments.done` … 機能の呼び出し
  - `response.done` … 実測トークン数を集計
- 無操作の自動切断
- レイテンシ計測（後述）
- `stop()` は PeerConnection を閉じるだけで、**トラックには触らない**

### `media.ts` — `MediaController`
マイクとカメラを**アプリの生存期間中ずっと保持する**。

- `acquire()` … 取得済みなら同じストリームを返す。二度目の `getUserMedia` を呼ばない
- `captureFrame()` … 隠し `<video>` から canvas 経由で1枚。長辺1024px / JPEG 0.7
- `switchCamera()` … 内/外の切り替え。**先に映像トラックを止めてから取り直す**
- `releaseAll()` … アプリ終了時のみ。会話の切断では呼んではいけない

理由は [ios-constraints.md](ios-constraints.md)。

### `tools/index.ts` — `runTool()`
AI から呼ばれた機能の振り分け。**機能を追加するときはここと `worker/config.ts` の2箇所。**

| 機能 | 実行場所 |
|---|---|
| `look_at_camera` | 端末内（`MediaController.captureFrame`） |
| `get_current_time` | 端末内 |
| `set_timer` / `list_timers` / `cancel_timer` | 端末内（`tools/timer.ts`） |
| `get_weather` | Worker（`/api/tools/weather`） |

戻り値の `imageDataUrl` に値があると、`realtime.ts` が画像を会話に差し込む。

### `tools/timer.ts` — `TimerStore`
タイマー。**LLM もネットワークも通らない。**

- 終了時刻を**絶対時刻**で localStorage に保存する。相対秒数だと再読み込みで狂う
- 0.5秒ごとに確認し、終わったらアラームを鳴らす
- アラーム音は合成（880Hz / 660Hz の交互ビープ、30秒）。音源ファイルを持たない

### `tools/commands.ts`
**OpenAI に繋がずに処理する言い回しの定義。**

- `commandGrammar()` … Vosk に渡す語句。**語彙表に存在する語だけで構成する。**
  ここに列挙した組み合わせだけが端末内で処理できる。現在52語句。

| 単位 | 言える値 |
|---|---|
| 秒 | 10, 15, 20, 30, 40, 45, 50 |
| 分 | 1〜10, 15, 20, 25, 30, 35, 40, 45, 50 |
| 時間 | 1, 2, 3 |

一覧に無い値（「7秒」など）は端末内では拾えない。AI に渡って処理される。
- `matchCommand()` … 認識結果からコマンドを取り出す。該当しなければ null
- `speak()` … 端末内の音声合成で返事をする。iOS の日本語音声を使うので無料

**判定はすべて前後一致。** 部分一致にしていた頃は「十分です」「三時間かかる」
のような普通の会話でタイマーが入っていた。迷ったら何もしない側に倒し、
曖昧なものは AI に任せる。

裸の「止めて」は**アラームが鳴っているときだけ**受け付ける。
会話の中の「止めて」で誤ってタイマーを消さないため。

**コマンドの判定は確定した文だけで行う。** 認識の途中経過は文字列が揺れるので、
言い終わる前の断片で誤動作する。ウェイクワードだけは反応の速さを優先して
途中経過でも見る。

### `wakeword/index.ts` — `WakeWordDetector`
Vosk による検出。**待機中は音声を一切ネットワークへ送らない。**

- モデルは動的 import。WASM 込みで5MB超あるため初期表示に含めない
- 文法を数語句に限定する。全文認識より当たりやすく、CPU も下がる
- 音響チェーン: **ハイパス(100Hz) → コンプレッサ → ゲイン → ノイズゲート**
  - コンプレッサはゲインと違い「小さい音だけ持ち上げる」ので、遠くの声に効く
- `pause()` / `resume()` … 会話中は止める。AI 自身の声での誤検出を防ぐ
- 検出後3秒はクールダウン。1回の呼びかけで多重起動しない
- **ローカルコマンドを先に照合する。** 一致したら会話を開かない
- コマンド層が有効なときは、ウェイクワードから会話開始まで 700ms 待つ。
  「ねえクラピカ、タイマー三分」で先に会話を開いてしまわないため

### `settings.ts`
設定の型・既定値・localStorage への保存と、**ウェイクワードの候補**。

候補はすべて日本語モデルの語彙表に存在することを確認済み。
認識しやすさは「長い・子音が立っている・日常会話に出てこない」で決まる。

### `pricing.ts`
料金表と費用計算。**推定ではなく `response.done` の実測トークン数**を使う。
モデルを増やしたら料金表も更新すること。

## Worker 側

### `worker/index.ts`
- `POST /api/session` … SDP をセッション設定と一緒に OpenAI へ中継
- `GET /api/tools/weather` … Open-Meteo を叩く
- それ以外 … 静的アセット
- `DEVICE_KEY` が設定されているときだけ Bearer 認証を要求する
- モデル指定は許可リストで検証する。端末から任意の値は通せない
- OpenAI のエラーを、原因と対処が分かる日本語に変換する

### `worker/config.ts`
**instructions とツール定義。AI の振る舞いを変えたいときはここ。**

instructions は公式の推奨に沿ってラベル付きセクションで書いてある
（役割と目的 / 言語 / 応答の長さ / 話し方 / カメラ / 時刻・天気・タイマー / 知らないことへの対応）。

カメラの節が長いのは、**既定で呼ばれすぎた反省**から。
「呼ぶ例」と「呼んではいけない例」を明示している。

## レイテンシの測り方

「回答開始まで」は実測値で、要件の最重要指標そのもの。

```
input_audio_buffer.speech_stopped を起点
   ↓
pc.getStats() の inbound-rtp / totalAudioEnergy が上がった時刻
```

**つまり「実際に音が鳴り始めるまで」を測っている。**
Safari では WebRTC の受信ストリームを WebAudio に繋ぐと無音になることがあるため、
`getStats()` を使っている。

## 機能を1つ増やす手順

1. `worker/config.ts` の `TOOLS` に定義を足す（description は呼ぶ条件を具体的に）
2. `src/tools/index.ts` の `runTool` に case を足す
3. 外部APIを叩くなら `worker/tools/` に置き、`worker/index.ts` にルートを足す
4. instructions の該当セクションに一行足す
