/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 日本語モデル（tar.gz）の場所。既定は /wakeword/vosk-ja.tar.gz */
  readonly VITE_WAKEWORD_MODEL?: string;
  /** 認識対象の語句。| 区切り。語彙表に存在する語のみ指定できる。 */
  readonly VITE_WAKEWORD_GRAMMAR?: string;
  /** 起動とみなす文字列。カンマ区切りの部分一致。 */
  readonly VITE_WAKEWORD_MATCH?: string;
  /** Vosk へ渡す前の増幅率。届く最小値に調整する。 */
  readonly VITE_WAKEWORD_GAIN?: string;
  readonly VITE_WAKEWORD_LABEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
