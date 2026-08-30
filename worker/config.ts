// Realtime セッションの設定。モデルや instructions の変更はここ一箇所で行う。
// 仕様は 2026-08-29 時点の OpenAI 公式ドキュメントに合わせている。

export interface Env {
  OPENAI_API_KEY: string;
  REALTIME_MODEL: string;
  /** 設定されている場合のみ Bearer 認証を要求する。第5段階で必須にする。 */
  DEVICE_KEY?: string;
  /** 天気の既定地点。端末側で現在地を設定すればそちらが優先される。 */
  HOME_LAT?: string;
  HOME_LON?: string;
  HOME_NAME?: string;
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

// 公式のプロンプト設計指針に沿って、短いラベル付きセクションで書く。
// https://developers.openai.com/api/docs/guides/realtime-models-prompting
// 口調や回答の長さの調整は、このテキストを直すだけでよい。再デプロイ不要。
const INSTRUCTIONS = `# 役割と目的
あなたは家庭に常設された音声アシスタントです。
利用者は画面を見ておらず、部屋の中から話しかけてきます。

# 言語
- 常に日本語で話してください。これは最優先の指示です。
- 利用者が英語や他の言語で話しかけてきた場合も、日本語で返答してください。
- 英語の固有名詞や専門用語は、日本語話者が聞き取れる読み方で発音してください。
- 利用者から明示的に「英語で話して」と頼まれたときだけ、他の言語を使ってください。

# 応答の長さ
- 原則2文以内。事実を答えたらそこで止めてください。
- 聞かれていないことを補足しないでください。
- 前置き（「はい、お答えします」など）を付けないでください。

# 話し方
- 箇条書き、記号、URL、絵文字は使わないでください。音声で読み上げられます。
- 数字や単位は、声に出したときに自然な読み方で言ってください。

# 聞き取れなかったとき
- 音声が不明瞭なときは、推測で答えないでください。
- 日本語で短く聞き返してください。

# カメラ
カメラはほとんどの場合使いません。既定は「呼ばない」です。

呼ぶのは、発言の中に目の前の物を指す言葉が実際に含まれているときだけです。
「これ」「この」「それ」「ここに写っている」など、指し示す言葉が無ければ呼びません。

呼ぶ例：
- 「これ何？」「この文字なんて書いてある？」「この画面のエラーは？」
- 「これ賞味期限いつ？」「この料理どうやって作るの？」

呼ばない例（これらで呼んではいけません）：
- 「今日の天気は？」「今何時？」← 目の前の物と無関係
- 「富士山の高さは？」「英語でありがとうは？」← 一般的な知識
- 「おはよう」「元気？」← 雑談
- 「もう一度言って」「さっき何て言った？」← 会話について
- 直前に画像を見て回答した直後の追加質問 ← 同じ画像の話が続いているだけなので撮り直さない

迷ったら呼ばないでください。不要な撮影は利用者の迷惑になります。
必要かどうか判断できないときは、カメラを使わずに答えるか、聞き返してください。

呼ぶときは黙って呼んでください。「見てみますね」などの前置きは不要です。
画像が不鮮明で判断できないときは、そう伝えて置き直すよう頼んでください。

# 時刻・天気・タイマー
- 現在時刻を聞かれたら get_current_time を呼んでください。あなたは時刻を知りません。
- 天気を聞かれたら get_weather を呼んでください。あなたは天気を知りません。
- 週間予報を渡されたときは、全部読み上げず、傘が要る日や気温が大きく変わる日など
  要点だけを2文以内で伝えてください。
- 「三分測って」のように言われたら set_timer を呼んでください。秒に直して渡します。
- 「あと何分」と聞かれたら list_timers を呼んでください。
- タイマーが鳴っていて「止めて」と言われたら cancel_timer を呼んでください。
- タイマーを設定したら「三分ですね」と短く確認するだけにしてください。

# 最新の情報
- あなたの知識には期限があります。最近の出来事、試合日程、ニュース、
  店の営業時間、価格などを問われたら search_web を呼んでください。
- 歴史や一般常識のように変わらないことでは呼ばないでください。
- 検索には数秒かかります。呼ぶ前に「調べますね」と一言だけ言ってください。
- 検索結果は事実として扱い、そこに無いことを補わないでください。

# 知らないことへの対応
- 上記の道具で調べられないことは推測しないでください。
- 「わかりません」と正直に答えてください。カメラで代用しようとしないでください。`;

/**
 * AI から呼べる機能。
 * 実行場所は2種類ある。
 *   クライアント側 … 時刻・タイマー・カメラ。端末内で完結し、外部通信をしない
 *   Worker 側     … 天気。外部APIを叩くものはこちらに置く
 */
const TOOLS = [
  {
    type: "function",
    name: "look_at_camera",
    description:
      "端末のカメラで今映っているものを1枚撮影して会話に追加する。" +
      "利用者の発言に『これ』『この』『それ』など目の前の物を指す言葉が" +
      "実際に含まれている場合にだけ呼ぶこと。" +
      "天気・時刻・一般知識・雑談では絶対に呼ばない。" +
      "直前に画像を見て回答した続きの質問でも呼び直さない。" +
      "判断に迷う場合は呼ばないこと。",
    // 何を見るのかを明示させる。書かせることで安易な呼び出しを減らす狙い。
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description:
            "利用者が何について尋ねているか。例:「手に持っている飲み物の名前」" +
            "「画面に出ているエラー文」「パッケージの賞味期限」",
        },
      },
      required: ["target"],
    },
  },
  {
    type: "function",
    name: "get_current_time",
    description:
      "現在の日付と時刻を取得する。あなたは現在時刻を知らないので、" +
      "「今何時」「今日は何日」「何曜日」と聞かれたら必ずこれを呼ぶこと。推測しない。",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "get_weather",
    description:
      "天気予報を取得する。あなたは天気を知らないので、" +
      "天気を聞かれたら必ずこれを呼ぶこと。推測しない。",
    parameters: {
      type: "object",
      properties: {
        day: {
          type: "string",
          enum: ["today", "tomorrow", "week"],
          description:
            "今日なら today、明日なら tomorrow、「今週」「これから一週間」なら week。省略時は today。",
        },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "search_web",
    description:
      "ウェブを検索して最新の情報を調べる。あなたの知識には期限があるため、" +
      "最近の出来事、試合日程、ニュース、店の営業時間、価格、人物の近況など" +
      "「今どうなっているか」を問われたら呼ぶこと。" +
      "歴史や一般常識のように変わらないことでは呼ばない。" +
      "結果が返るまで数秒かかる。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "検索する内容。利用者の言葉のままではなく、検索に適した形にすること。" +
            "例:「バスケ日本代表の直近の試合予定」",
        },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "set_timer",
    description:
      "タイマーを設定する。「3分測って」「10分後に教えて」などで呼ぶ。" +
      "設定すると端末が時間を数え、終わると音で知らせる。",
    parameters: {
      type: "object",
      properties: {
        seconds: { type: "number", description: "何秒後か。3分なら180。" },
        label: { type: "string", description: "何のタイマーか。例:「パスタ」" },
      },
      required: ["seconds"],
    },
  },
  {
    type: "function",
    name: "list_timers",
    description:
      "動いているタイマーの残り時間を調べる。「あと何分」「タイマーどうなってる」などで呼ぶ。",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "cancel_timer",
    description:
      "タイマーを取り消す、または鳴っているアラームを止める。" +
      "「タイマー止めて」「うるさい」「止めて」などで呼ぶ。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "取り消す対象。省略すると全部止める。" },
      },
      required: [],
    },
  },
];

export function sessionConfig(env: Env, model = env.REALTIME_MODEL) {
  return {
    type: "realtime",
    model,
    output_modalities: ["audio"],
    instructions: INSTRUCTIONS,
    tools: TOOLS,
    audio: {
      // WebRTC では音声コーデックを WebRTC 側が決めるため format は指定しない。
      input: {
        // semantic_vad は発話の意味的な切れ目で応答を開始する。低レイテンシ重視。
        turn_detection: {
          type: "semantic_vad",
          // 読み上げ中に音を拾っても応答を中断させない。
          // 物音や自分の声で回答が作り直されるのを防ぐ。
          // 意図的な中断は端末側が「ストップ」を聞いて response.cancel を送る。
          interrupt_response: false,
        },
      },
      output: { voice: "marin" },
    },
  };
}
