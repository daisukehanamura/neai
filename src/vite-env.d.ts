/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Picovoice の AccessKey。未設定ならウェイクワードは無効になる。 */
  readonly VITE_PICOVOICE_ACCESS_KEY?: string;
  readonly VITE_WAKEWORD_PPN?: string;
  readonly VITE_WAKEWORD_MODEL?: string;
  readonly VITE_WAKEWORD_LABEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
