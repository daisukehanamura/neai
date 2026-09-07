/**
 * Silero VAD（人の声かどうかの判定）。
 *
 * ウェイクワード検出は待機中ずっと Vosk を回しており、それが常設端末の
 * 消費電力と発熱の主因のひとつになっている。声が出ていない時間（＝ほとんど）は
 * デコードそのものを止めてしまえば、その分が丸ごと消える。
 *
 * ノイズゲート（音量だけを見る）との違いは、食器やドアの音を弾けること。
 * 音量ゲートを通す生活音は多く、それが全部 Vosk に届いていた。
 *
 * 推論は 512サンプル（32ms）ごとに1回、1フレームあたり 1ms 未満。
 * Vosk の音響モデルより2桁軽いので、これを挟むほうが差し引きで安くなる。
 *
 * モデルと ONNX Runtime は scripts/fetch-vad-model.sh で public/vad/ に置く。
 * 無ければ vadAvailable() が false を返し、呼び出し側は VAD 無しで動く。
 *
 * ONNX Runtime をバンドルに含めず、置いた URL から実行時に読むのは意図的。
 * バンドルさせると Vite が dev では WASM の場所を解決できず（本番だけ動く）、
 * さらに 11MB の WASM が使われないまま dist にもう1部入る。
 * Vosk のモデルと同じで、大きいものは配信物として1か所に置き、
 * dev でも本番でも同じ URL を通す。
 */
import type { InferenceSession, Tensor as OrtTensor } from "onnxruntime-web";

/** 実行時に読み込む ONNX Runtime。型だけを npm の依存から借りる。 */
type OrtModule = typeof import("onnxruntime-web");

export const VAD_DIR = import.meta.env.VITE_VAD_DIR ?? "/vad";
export const VAD_MODEL_URL = `${VAD_DIR}/silero_vad.onnx`;
/** ONNX Runtime。WASM 本体はこの mjs が同じ場所から読む。 */
const ORT_URL = `${VAD_DIR}/ort.wasm.bundle.min.mjs`;

/** Silero v5 の入力長。16kHz では 512 固定で、他の長さは受け付けない。 */
export const VAD_FRAME = 512;

/** モデルと実行環境が置かれているか。片方だけでは動かない。 */
export async function vadAvailable(): Promise<boolean> {
  try {
    const [model, runtime] = await Promise.all([
      fetch(VAD_MODEL_URL, { method: "HEAD" }),
      fetch(ORT_URL, { method: "HEAD" }),
    ]);
    return model.ok && runtime.ok;
  } catch {
    return false;
  }
}

export class SileroVad {
  private session: InferenceSession | null = null;
  /** ort.Tensor のコンストラクタ。動的 import したものを持ち回る。 */
  private Tensor: typeof OrtTensor | null = null;
  /** LSTM の内部状態。フレームをまたいで持ち越すので、これが判定の連続性を作る。 */
  private state: OrtTensor | null = null;
  private sampleRate: OrtTensor | null = null;

  async load(): Promise<void> {
    // @vite-ignore で、この import はバンドラに触らせない（上のコメントの理由）。
    // WASM 本体は mjs 自身が import.meta.url から引くので、指定しなくてよい。
    const ort = (await import(/* @vite-ignore */ ORT_URL)) as unknown as OrtModule;

    // スレッドを使うと SharedArrayBuffer が要り、COOP/COEP ヘッダが必要になる。
    // 32ms ごとに 1ms の推論を1回するだけなので、1スレッドで足りる。
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = "error";

    this.session = await ort.InferenceSession.create(VAD_MODEL_URL, {
      executionProviders: ["wasm"],
    });
    this.Tensor = ort.Tensor;
    this.sampleRate = new ort.Tensor("int64", new BigInt64Array([16000n]), [1]);
    this.reset();
  }

  /** 発話の区切りで内部状態を捨てる。前の発話の余韻を持ち越さないため。 */
  reset(): void {
    if (!this.Tensor) return;
    this.state = new this.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
  }

  /**
   * 1フレーム（512サンプル / 32ms）を判定する。
   * @returns 人の声である確率 0〜1
   */
  async process(frame: Float32Array): Promise<number> {
    if (!this.session || !this.Tensor || !this.state || !this.sampleRate) return 0;
    const out = await this.session.run({
      input: new this.Tensor("float32", frame, [1, frame.length]),
      state: this.state,
      sr: this.sampleRate,
    });
    // 次のフレームへ状態を引き継ぐ。ここを忘れると毎回まっさらな判定になる。
    this.state = out.stateN as OrtTensor;
    return (out.output.data as Float32Array)[0];
  }

  async close(): Promise<void> {
    await this.session?.release();
    this.session = null;
    this.state = null;
    this.sampleRate = null;
    this.Tensor = null;
  }
}
