// Realtime セッションの設定。モデルや instructions の変更はここ一箇所で行う。
// 仕様は 2026-08-29 時点の OpenAI 公式ドキュメントに合わせている。

export interface Env {
  OPENAI_API_KEY: string;
  REALTIME_MODEL: string;
  /** 設定されている場合のみ Bearer 認証を要求する。第5段階で必須にする。 */
  DEVICE_KEY?: string;
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

# 知らないことへの対応
- 現在の日時、天気、利用者の予定など、あなたが知り得ない情報は推測しないでください。
- 「わかりません」と正直に答えてください。`;

export function sessionConfig(env: Env) {
  return {
    type: "realtime",
    model: env.REALTIME_MODEL,
    output_modalities: ["audio"],
    instructions: INSTRUCTIONS,
    audio: {
      // WebRTC では音声コーデックを WebRTC 側が決めるため format は指定しない。
      input: {
        // semantic_vad は発話の意味的な切れ目で応答を開始する。低レイテンシ重視。
        turn_detection: { type: "semantic_vad" },
      },
      output: { voice: "marin" },
    },
  };
}
