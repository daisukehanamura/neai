/**
 * 日本語モデル（tar.gz / 約48MB）の置き場。
 *
 * Cloudflare Workers の静的アセットは1ファイル 25MiB が上限なので分割して置く。
 * manifest.json に分割の一覧があり、クライアントが順に取得して連結する。
 * ローカルでも本番でも同じ経路を通るので、片方だけ動かないということが起きない。
 */
export const MODEL_DIR = import.meta.env.VITE_WAKEWORD_DIR ?? "/wakeword";

/** 分割前のファイルを直接指したいときに使う。分割が無い環境向けの逃げ道。 */
export const MODEL_URL = import.meta.env.VITE_WAKEWORD_MODEL ?? `${MODEL_DIR}/vosk-ja.tar.gz`;

interface Manifest {
  bytes: number;
  parts: string[];
}

/**
 * モデルを取得して Blob の URL にして返す。
 * 分割があればそれを順に取り、無ければ単体ファイルに落ちる。
 *
 * @param onProgress 0〜1 の進捗。48MB あるので進み具合を見せる必要がある。
 */
export async function loadModelUrl(onProgress?: (ratio: number) => void): Promise<string> {
  const manifest = await fetchManifest();

  if (!manifest) {
    // 分割が無い環境（古い取得結果など）。単体ファイルをそのまま渡す。
    return MODEL_URL;
  }

  const chunks: Uint8Array[] = [];
  let got = 0;
  for (const part of manifest.parts) {
    const res = await fetch(`${MODEL_DIR}/${part}`);
    if (!res.ok) throw new Error(`モデルの取得に失敗しました: ${part} (${res.status})`);
    const buf = new Uint8Array(await res.arrayBuffer());
    chunks.push(buf);
    got += buf.length;
    onProgress?.(Math.min(1, got / manifest.bytes));
  }

  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (manifest.bytes && total !== manifest.bytes) {
    throw new Error(`モデルのサイズが合いません（${total} / ${manifest.bytes}）`);
  }
  return URL.createObjectURL(new Blob(chunks as BlobPart[]));
}

async function fetchManifest(): Promise<Manifest | null> {
  try {
    const res = await fetch(`${MODEL_DIR}/manifest.json`);
    if (!res.ok) return null;
    const m = (await res.json()) as Manifest;
    return Array.isArray(m.parts) && m.parts.length > 0 ? m : null;
  } catch {
    return null;
  }
}

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
export async function modelAvailable(): Promise<boolean> {
  try {
    if (await fetchManifest()) return true;
    // 分割が無ければ単体ファイルを見る。
    const res = await fetch(MODEL_URL, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}
