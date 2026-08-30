/**
 * ウェブ検索。
 *
 * Realtime のモデルには知識のカットオフがあり、ウェブを見る手段がない。
 * 「直近の試合予定」のような最新情報はそのままでは答えられない。
 *
 * Realtime API に組み込みの web_search は使えないため、
 * Worker から Responses API を呼んで結果の要約だけを返す。
 * 同じ APIキーで済み、追加のアカウントも鍵も要らない。
 *
 * 費用は1回あたり検索$0.01（約1.5円）＋トークン代。会話1往復と同程度。
 */

/** 要約に使うモデル。安く速いものでよい。読み上げるのは Realtime 側。 */
const MODEL = "gpt-5.6-luna";

/** 費用の見積もりに使う単価。2026-08-30 時点。モデルを変えたらここも直す。 */
const PRICE = { searchCall: 0.01, inPerMtok: 0.2, outPerMtok: 1.2 };

const INSTRUCTIONS = [
  "日本語で、事実だけを簡潔に答えてください。",
  "音声で読み上げられるので、次を必ず守ってください。",
  "・2文以内にする",
  "・出典のURLや括弧書きの引用を書かない",
  "・箇条書き、記号、絵文字を使わない",
  "・日付や時刻は声に出して自然な言い方にする",
  "分からなかった場合は「分かりませんでした」とだけ答えてください。",
].join("\n");

/**
 * 読み上げに邪魔なものを落とす。
 * 指示だけでは引用が混ざることがあるので、最後にここで確実に取り除く。
 */
function forSpeech(text: string): string {
  return text
    // ([表示](URL)) と [表示](URL) の両方を消す
    .replace(/\(?\[[^\]]*\]\([^)]*\)\)?/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_#`]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export async function searchWeb(query: string, apiKey: string): Promise<unknown> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      // 取り込む量を絞る。短い答えが欲しいだけなので、速さと費用を優先する。
      tools: [{ type: "web_search", search_context_size: "low" }],
      instructions: INSTRUCTIONS,
      input: query,
    }),
  });

  if (!res.ok) {
    return { error: `検索に失敗しました (${res.status})` };
  }

  const data = (await res.json()) as {
    output?: { type: string; content?: { type: string; text?: string }[] }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const text = (data.output ?? [])
    .filter((o) => o.type === "message")
    .flatMap((o) => o.content ?? [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text ?? "")
    .join(" ");

  if (!text) return { error: "検索結果を読み取れませんでした" };

  const inTok = data.usage?.input_tokens ?? 0;
  const outTok = data.usage?.output_tokens ?? 0;
  return {
    結果: forSpeech(text),
    // 端末側で使用額を積み上げるために返す。読み上げには使わせない。
    _費用ドル:
      PRICE.searchCall +
      (inTok * PRICE.inPerMtok + outTok * PRICE.outPerMtok) / 1_000_000,
  };
}
