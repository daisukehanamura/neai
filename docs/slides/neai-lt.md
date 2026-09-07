---
marp: true
theme: default
paginate: true
size: 16:9
header: 'neai — 使っていない iPhone を、家のAI音声端末にする'
style: |
  section {
    background: #0d1117;
    color: #e6edf3;
    font-family: "Hiragino Sans", "Noto Sans JP", "Yu Gothic", sans-serif;
    font-size: 24px;
    padding: 48px 56px;
  }
  header {
    color: #4b5563;
    font-size: 15px;
    left: 56px;
    top: 20px;
  }
  section::after {
    color: #4b5563;
    font-size: 15px;
  }
  h1 {
    color: #7ee787;
    font-size: 40px;
    border-bottom: 2px solid #21262d;
    padding-bottom: 12px;
    margin-bottom: 24px;
  }
  h2 { color: #79c0ff; font-size: 28px; margin-top: 4px; }
  h3 { color: #d2a8ff; font-size: 22px; margin-bottom: 6px; }
  strong { color: #ffa657; }
  a { color: #79c0ff; }
  code {
    background: #161b22;
    color: #a5d6ff;
    padding: 1px 6px;
    border-radius: 4px;
  }
  pre {
    background: #161b22;
    border: 1px solid #21262d;
    border-radius: 8px;
    font-size: 17px;
    line-height: 1.45;
  }
  pre code { background: transparent; color: #c9d1d9; padding: 0; }
  table { font-size: 21px; border-collapse: collapse; }
  table, thead, tbody, tr, th, td { background: transparent; }
  th { background: #161b22 !important; color: #7ee787; }
  td { background: #0d1117 !important; color: #e6edf3; }
  th, td { border: 1px solid #30363d; padding: 6px 12px; }
  .screen {
    border: 1px solid #30363d;
    border-radius: 14px;
    background: #000;
    padding: 18px 20px;
    text-align: center;
    line-height: 1.5;
  }
  .screen .t { font-size: 34px; color: #e6edf3; }
  .screen .d { font-size: 19px; color: #8b949e; }
  .screen .w { font-size: 22px; color: #79c0ff; }
  .screen .bars { font-size: 20px; color: #7ee787; letter-spacing: 3px; }
  .screen .say { font-size: 21px; color: #e6edf3; text-align: left; }
  .screen .tag { font-size: 17px; color: #7ee787; text-align: left; }
  .screen .timer { font-size: 18px; color: #ffa657; text-align: left; }
  blockquote {
    border-left: 4px solid #ffa657;
    background: #161b22;
    color: #c9d1d9;
    padding: 10px 18px;
    font-size: 21px;
  }
  ul, ol { line-height: 1.7; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }
  .small { font-size: 20px; }
  .note { color: #8b949e; font-size: 19px; }
  .big { font-size: 40px; color: #ffa657; font-weight: bold; }
  section.lead { justify-content: center; text-align: center; }
  section.lead h1 { border: none; font-size: 56px; }
  section.lead h2 { color: #e6edf3; font-weight: normal; }
---

<!-- _class: lead -->
<!-- _header: '' -->
<!-- _paginate: false -->

# neai

## 使っていない iPhone を、家のAI音声端末にする

<br>

<span class="note">棚に置いて電源につなぐ。端末に触らず、話しかけて使う。</span>

<!--
5〜10分。目的 → 端末の再利用 → ウェイクワード → Cloudflare → コスト、の順で話す。
-->

---

# 目的：生成AIと「気軽に」会話したい

生成AIは十分に賢い。**でも使うたびに手が要る。**

- アプリを開く → タイプする → 画面を読む
- 料理中・作業中・両手がふさがっているときほど、聞きたいことがある
- 一往復のためにスマホを取りに行く時点で、もう「気軽」ではない

<br>

### 欲しかったのはこれだけ

```
「ねえクラピカ、今日の天気は？」   → 声で返ってくる
「これ何？」                     → カメラを見て答える
「三分測って」                   → そのままタイマーになる
```

<!--
出発点は「賢さが足りない」ではなく「アクセスが面倒」という不満だった、と強調する。
-->

---

# 最新の iPhone ならできる？

<div class="cols">
<div>

### たぶん、できる

- Apple Intelligence と Siri の LLM 連携
- 常時オンの高精度なウェイクワード
- OS に統合されているので摩擦がない

</div>
<div>

### でも手元にあるのは

**iPhone XR**（2018年・iOS 18 が上限）

- Apple Intelligence の対象外
- 買えば解決するが、それは目的ではない

</div>
</div>

<br>

> **問い：新しい端末を買わずに、家にあるもので同じ体験に届くか。**

<!--
「端末を買えば終わる話」を自覚したうえで、あえて手持ちでやる、という枠組みを最初に置く。
-->

---

# 家にあるものの再利用

引き出しの iPhone XR は、**常設AI端末に必要なものを全部持っていた。**

| 必要なもの | iPhone XR が持っているもの |
|---|---|
| 音声入力 | マイク（AEC・ノイズ抑制つき） |
| 音声出力 | スピーカー |
| 表示 | 有機EL・常時点灯できる画面 |
| 電源 | Lightning で給電したまま運用 |
| 通信・実行環境 | Wi-Fi / Safari（WebRTC・WASM・Wake Lock） |

**買い足したものはゼロ。** ネイティブアプリも作らず、全部ブラウザで動かしている。

<!--
「スマートスピーカーを買うより、余っている端末のほうが画面まである」点を言う。
-->

---

# できあがったもの

<div class="cols">
<div>

<div class="screen">
<div class="t">10:50</div>
<div class="d">8月30日(日)</div>
<div class="w">☀ 23° 市川市</div>
<div class="d">月　火　水　木　金　土<br>29　30　31　31　26　23</div>
<div class="bars">▁ ▂ ▂ ▄ ▅ ▆</div>
</div>

**待機中**　話しかけなくても役に立つ

</div>
<div>

<div class="screen">
<div class="tag">● 話しています</div>
<div class="say">これはコーヒー<br>カップです。</div>
<div class="timer">⏱ 3分　残り 2:14</div>
</div>

**会話中**　答えは声と文字の両方で出す

</div>
</div>

<span class="note">常設端末なので画面を遊ばせない。回答は90秒残してから待機画面へ戻り、無操作60秒で接続は切れる。</span>

# 全体の構成

```
                              ┌────────────────────────────────┐
        ┌─── HTTPS ──────────>│  Cloudflare Worker             │
        │                     │  ・SPA の配信                  │
        │                     │  ・POST /api/session（SDP中継）│──> OpenAI
        │                     │  ・GET  /api/tools/*           │──> Open-Meteo / 検索
   iPhone XR                  │  Secrets: OPENAI_API_KEY       │
   (Safari 前面表示)          └────────────────────────────────┘
        │                     
        └─── WebRTC（音声 + データチャネル）──────────> OpenAI Realtime API
             ※ 音声はブラウザと OpenAI が直結。Worker を通らない
```

**Worker はメディア経路に入らない。** 関わるのは「セッション確立の一往復」と
「外部APIを叩くツール」だけ。だからバックエンドが極端に薄い。

<!--
最初のメモでは Cloudflare で音声を中継する構成だったが、それは誤りだった、という話をここで。
-->

---

# 処理は3つの場所に分かれている

| 場所 | 何を | 費用 |
|---|---|---|
| **端末内** | ウェイクワード検出、タイマー、時刻、カメラ撮影 | **ゼロ** |
| **OpenAI 直結** | 音声会話、画像理解、どの機能を呼ぶかの判断 | トークン課金 |
| **Worker** | セッション確立、天気・ウェブ検索 | ほぼゼロ |

<br>

**待機中は端末内だけが動く。** ウェイクワードを検出して初めて OpenAI に繋ぐ。

→ この一線が、あとで出てくる**コストの話の全て**になる。

---

# なぜウェイクワードが要るのか

繋ぎっぱなしにすれば、ウェイクワードは要らない。**が、値段を見ると無理だった。**

| 使い方 | 費用（gpt-realtime-2.1） |
|---|---|
| 1往復の短い会話 | 約 1.5 円 |
| **接続しっぱなし 1時間** | **約 170 円** |
| **24時間つなぎっぱなし 1ヶ月** | **約 12万円** |

<br>

> 待機を端末内で完結させることは、機能ではなく**成立条件**だった。

<!--
「切り忘れが一番危ない」も一言。一晩放置で1400円。
-->

---

# ウェイクワードに Vosk を選んだ

第一候補は Picovoice Porcupine（専用のウェイクワード検出）だったが——

- **無料枠が 2026-06-30 で廃止。** 既存の無料キーも無効化、有料は月額 $899 から
- 付属の音声処理も、iOS ではマイクを取り直せないため結局使えなかった

<br>

### Vosk（Kaldi の WASM ビルド）

| | |
|---|---|
| ライセンス | Apache-2.0 / アカウント不要 |
| 動く場所 | **完全オンデバイス**（iOS Safari で動作確認済み） |
| 日本語モデル | `vosk-model-small-ja-0.22` 約48MB・語彙 20.7万語 |
| おまけ | **全文認識**なので、タイマー等のローカルコマンドに使い回せる |

---

# 作り①：音がテキストになるまで

```
マイクトラック（WebRTC と共有・取り直さない ← iOS 制約）
   │
 ハイパス 100Hz        空調・冷蔵庫の低音を先に落とす
   │
 コンプレッサ          小さい音だけ持ち上げる（遠くの声を拾い、近くで割れない）
   │
 ゲイン ×6            届く最小値にするのがコツ。上げるほど誤検出も増える
   │
 ノイズゲート（任意）    静かな区間は認識に回さない
   ▼
┌──────────────────────────────┐
│ Web Worker：Vosk / WASM Kaldi │  ← ここだけが OSS の担当
└──────────────────────────────┘
   ▼  partial（途中経過） / result（確定）
 自前の判定 → 起動 / ローカルコマンド / 中断
```

`AudioContext({ sampleRate: 16000 })` で 16kHz を直接要求 → **自前のリサンプラが不要。**
デコードは Web Worker なので、常時稼働でも UI が固まらない。

---

# 作り②：文法で候補を閉じる

Vosk は**認識対象の語句リスト（文法）を渡せる。リストの外は出てこない。**

```
["ねえ クラピカ", "クラピカ",
 "タイマー 三 分", "タイマー 止めて", "今 何時", "あと 何分", …,
 "[unk]"]                                   ← これが肝
```

- 候補が数十語まで狭まるので、**精度が上がり CPU も下がる**
- **`[unk]` が無いと、無関係な物音をリスト内の最も近い語に強制的に当てはめてしまう**
- 制約：モデルの語彙表にある語しか書けない（「AI」は語彙に無く「エーアイ」と書く）

<span class="note">Vosk は LLM ではない。音響モデル→発音辞書→言語モデル→探索、の古典的な音声認識。意味は一切見ていない。</span>

---

# 作り③：誤動作をどう抑えているか

| 対象 | 使う結果 | 照合 | 理由 |
|---|---|---|---|
| ウェイクワード | 途中経過も可 | 部分一致 | 反応の速さを優先 |
| ローカルコマンド | **確定のみ** | 前後一致 | 会話中の「十分です」「止めて」を拾わない |
| 中断の合図 | 途中経過も可 | 正規表現 | 止めたいのに待たされるのは本末転倒 |

- **クールダウン 3秒** — 1回の呼びかけで何度も起動しない
- **700ms 待ってから接続** — 「ねえクラピカ、**タイマー三分**」に備える。
  その間にコマンドが確定したら**繋がない＝課金しない**
- **AI の読み上げ中はマイクを止める** — 自分の声や物音で応答が壊れないように

<span class="note">語の選定も設計のうち：「ねえクラピカ」は破裂音が3つ（ク・ピ・カ）あり、日常語と衝突しない。</span>

---

# 課題：ここがアレクサ等に比べて明確に弱い

<div class="cols">
<div>

### 実際に起きること

- **遠くからの声が届きにくい**
  （うるさい場所ではゲイン10倍でやっと入口）
- 取りこぼしと誤検出のトレードオフが厳しい
- ゲインを上げると誤検出が増える

</div>
<div>

### なぜ弱いのか

- 専用ウェイクワードDNN vs **汎用ASRの流用**
- マイクアレイ＋ビームフォーミング＋専用DSP
  vs **単一マイク＋WebAudio**
- ネイティブ常駐 vs **Safari 前面表示のWASM**

</div>
</div>

<br>

> 前処理・文法・`[unk]`・クールダウンで削れるところは削ったが、
> **土俵が違う。ここは今も未解決の課題。**

<!--
正直に「ここが一番弱い」と言い切る。改善案（信頼度スコアの活用、外付けマイク）は口頭で。
-->

---

# Cloudflare Workers：デプロイが楽だった

役割は3つだけ。**薄いから、選択肢としてちょうど良かった。**

- SPA を配信する
- `POST /api/session` — SDP を中継してセッションを張る
- `GET /api/tools/*` — 天気とウェブ検索

<div class="cols">
<div>

### 良かった点

- `npm run deploy` の**1コマンド**
- **1ドメインで完結**（CORS も認証も二重管理にならない）
- **無料枠で費用ゼロ・カード不要**

</div>
<div>

### 動機は正直に言うと

最近よく名前を聞くので、**一度ちゃんと使ってみたかった。**
結果、この用途には過不足がなかった。

</div>
</div>

---

# Worker が薄くて済んでいる理由

```
ブラウザ                   Worker                    OpenAI
   │  SDP offer             │                          │
   ├───────────────────────>│ offer + セッション設定     │
   │                        ├─────────────────────────>│
   │      answer SDP        │<─────────────────────────┤
   │<───────────────────────┤                          │
   └───────── WebRTC 直結（音声・データチャネル）────────>│
```

- 音声が Worker を通らないので、**中継ホップ由来の遅延がゼロ**
- **APIキーも instructions もツール定義もクライアントに渡らない**
  （ephemeral token 方式だと渡ってしまう）
- Durable Objects は不要だった。リアルタイム接続はそこを通らない

<span class="note">48MB の Vosk モデルは静的アセットの上限25MiBを超えるので、20MBずつに分割して配信し、クライアントで繋ぎ直している。</span>

---

# コスト：生成AIは高い

100万トークンあたり（2026-08 時点）

| | gpt-realtime-2.1 | mini |
|---|---|---|
| 音声入力 | $32.00 | $10.00 |
| 音声出力 | $64.00 | $20.00 |

<div class="cols">
<div>

### 実感としての金額

- 1往復の会話：**約 1.5 円**
- ウェブ検索1回：**約 1.7 円**
- 1日20回話しかけて：約 30 円

</div>
<div>

### 危ないのは会話より切り忘れ

- 一晩つなぎっぱなし：**約 1,400 円**
- 1ヶ月放置：**約 12万円**

</div>
</div>

---

# 費用が暴走しないための仕組み

| 仕組み | 効果 |
|---|---|
| 無操作60秒で自動切断 | **切り忘れを塞ぐ**（最大のリスク） |
| ウェイクワードは端末内 | 待機中は音声を送らない。待機の費用はゼロ |
| タイマーの計測は端末内 | 3分でも30分でも**費用は一定**（LLMに待たせると30分で約85円） |
| 実費用を画面に表示 | 推定でなく `response.done` の**実測トークン**から計算 |
| **ローカルコマンド層** | 決まった言い回しは**OpenAI に繋がない＝課金ゼロ** |

```
「タイマー三分」「今何時」「あと何分」  → 端末内で処理し、端末内の音声合成で返事 → 0円
「ねえクラピカ、三分測って」          → AI 経由 → 約1〜2円
```

**最後の砦は OpenAI 側の Usage limits。** 実装の対策はバグで破られうる。

---

# 結論：ローカルLLM無しでは実運用が苦しい

<div class="cols">
<div>

### 今の構造

- 賢さは**お金で買っている**
- 頻度は**設計で抑えている**
  （ウェイクワード・自動切断・ローカルコマンド）
- 動くし、実際に便利

</div>
<div>

### でも「気軽に」と噛み合わない

- 話しかけるたびに数円が頭をよぎる
- 雑談や試し打ちがしにくい
- **設計努力の大半が「使わせない」方向**に向いている

</div>
</div>

<br>

> **本当に気軽にするなら、会話そのものをローカルへ寄せるしかない。**
> ローカルLLMを立てなければ、常設端末としての実運用は苦しい。

---

# まとめ

- **目的**：生成AIと気軽に会話したい。新しい端末は買わずに
- **手段**：引き出しの iPhone XR＝マイク・スピーカー・画面・給電が全部入り
- **待機**：Vosk でオンデバイス検出。文法と `[unk]` で候補を閉じる
  → **ただしアレクサ等には遠く及ばない。ここが最大の課題**
- **基盤**：Cloudflare Workers。1コマンド・1ドメイン・無料枠で足りた
- **費用**：1往復1.5円。切り忘れが本当の敵。**次はローカルLLM**

<br>

<span class="note">ドキュメント： docs/architecture.md ／ docs/wakeword-and-routing.md ／ docs/cost.md</span>

<!--
締めは「作ってみて分かったのは、賢さより“繋がない設計”に時間を使ったこと」。
-->
