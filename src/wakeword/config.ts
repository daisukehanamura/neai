export interface WakeWordConfig {
  /** Picovoice Console で取得する。https://console.picovoice.ai/ */
  accessKey: string;
  /** 学習させたウェイクワード（.ppn）の公開パス。 */
  keywordPath: string;
  /** 日本語モデル（porcupine_params_ja.pv）の公開パス。 */
  modelPath: string;
  /** 画面に出すラベル。 */
  label: string;
}

/** 設定が揃っているかどうか。揃っていなければタップ開始にフォールバックする。 */
export function loadConfig(): WakeWordConfig | null {
  const accessKey = import.meta.env.VITE_PICOVOICE_ACCESS_KEY;
  if (!accessKey) return null;
  return {
    accessKey,
    keywordPath: import.meta.env.VITE_WAKEWORD_PPN ?? "/wakeword/neai.ppn",
    modelPath: import.meta.env.VITE_WAKEWORD_MODEL ?? "/wakeword/porcupine_params_ja.pv",
    label: import.meta.env.VITE_WAKEWORD_LABEL ?? "ねえAI",
  };
}
