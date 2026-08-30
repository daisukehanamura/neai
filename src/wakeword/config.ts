/** 日本語モデル（tar.gz / 約48MB）の場所。 */
export const MODEL_URL = import.meta.env.VITE_WAKEWORD_MODEL ?? "/wakeword/vosk-ja.tar.gz";

/** 検出器に渡す設定。値そのものは src/settings.ts が持つ。 */
export interface WakeWordConfig {
  modelUrl: string;
  /** ウェイクワードとローカルコマンドを合わせた認識対象。 */
  grammar: string[];
  match: string[];
  label: string;
  gain: number;
  compressor: boolean;
  highpass: boolean;
  gate: boolean;
  gateDb: number;
}

/** モデルが配置されているか。無ければタップ開始で動かす。 */
export async function modelAvailable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}
