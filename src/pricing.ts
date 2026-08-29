/**
 * Realtime API の課金は接続時間ではなくトークン単位。
 * 100万トークンあたりのドル価格。2026-08-29 時点の
 * https://developers.openai.com/api/docs/pricing の値。
 *
 * モデルを変えたらここも更新すること。価格は変わる。
 */
export const PRICE_PER_MTOK = {
  "gpt-realtime-2.1": {
    audioIn: 32.0, audioInCached: 0.4, audioOut: 64.0,
    textIn: 4.0, textInCached: 0.4, textOut: 24.0, imageIn: 5.0,
  },
  "gpt-realtime-2.1-mini": {
    audioIn: 10.0, audioInCached: 0.3, audioOut: 20.0,
    textIn: 0.6, textInCached: 0.06, textOut: 2.4, imageIn: 0.8,
  },
} as const;

export type ModelName = keyof typeof PRICE_PER_MTOK;

/** OpenAI が response.done で返す実測のトークン数。推定値ではない。 */
export interface Usage {
  audioIn: number;
  audioInCached: number;
  audioOut: number;
  textIn: number;
  textInCached: number;
  textOut: number;
  imageIn: number;
}

export const emptyUsage = (): Usage => ({
  audioIn: 0, audioInCached: 0, audioOut: 0,
  textIn: 0, textInCached: 0, textOut: 0, imageIn: 0,
});

/** response.done の usage を読み取って加算する。キー名の揺れに備えて防御的に読む。 */
export function addUsage(total: Usage, raw: unknown): Usage {
  const u = raw as {
    input_token_details?: {
      audio_tokens?: number; text_tokens?: number; image_tokens?: number;
      cached_tokens_details?: { audio_tokens?: number; text_tokens?: number };
    };
    output_token_details?: { audio_tokens?: number; text_tokens?: number };
  } | undefined;
  if (!u) return total;

  const inDetail = u.input_token_details ?? {};
  const cached = inDetail.cached_tokens_details ?? {};
  const cachedAudio = cached.audio_tokens ?? 0;
  const cachedText = cached.text_tokens ?? 0;

  return {
    // キャッシュ分は入力トークン数に含まれるため、二重に数えないよう差し引く。
    audioIn: total.audioIn + Math.max(0, (inDetail.audio_tokens ?? 0) - cachedAudio),
    audioInCached: total.audioInCached + cachedAudio,
    textIn: total.textIn + Math.max(0, (inDetail.text_tokens ?? 0) - cachedText),
    textInCached: total.textInCached + cachedText,
    imageIn: total.imageIn + (inDetail.image_tokens ?? 0),
    audioOut: total.audioOut + (u.output_token_details?.audio_tokens ?? 0),
    textOut: total.textOut + (u.output_token_details?.text_tokens ?? 0),
  };
}

export function costUsd(usage: Usage, model: string): number {
  const p = PRICE_PER_MTOK[model as ModelName] ?? PRICE_PER_MTOK["gpt-realtime-2.1"];
  return (
    (usage.audioIn * p.audioIn +
      usage.audioInCached * p.audioInCached +
      usage.audioOut * p.audioOut +
      usage.textIn * p.textIn +
      usage.textInCached * p.textInCached +
      usage.textOut * p.textOut +
      usage.imageIn * p.imageIn) / 1_000_000
  );
}
