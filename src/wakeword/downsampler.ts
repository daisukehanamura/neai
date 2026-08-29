/**
 * 既存の MediaStreamTrack から、ウェイクワード検出器が要求する
 * 16kHz / モノラル / 16bit PCM のフレームを切り出す。
 *
 * Porcupine 付属の WebVoiceProcessor は自分で getUserMedia を呼ぶため使えない。
 * iOS ではマイクを取り直せないので（第0段階で確認済み）、
 * 既に持っているトラックから作る必要がある。
 */

const TARGET_RATE = 16000;

/** AudioWorklet の中身。バンドラの設定に依存しないよう Blob URL で読み込む。 */
const WORKLET_SOURCE = `
class Downsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ratio = sampleRate / ${TARGET_RATE};
    this.frameLength = options.processorOptions.frameLength;
    this.buffer = new Int16Array(this.frameLength);
    this.filled = 0;
    this.position = 0;
    this.tail = 0;
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;

    // 線形補間で 16kHz へ落とす。ウェイクワード検出にはこの品質で足りる。
    while (this.position < input.length) {
      const index = Math.floor(this.position);
      const frac = this.position - index;
      const a = index === 0 ? this.tail : input[index - 1];
      const b = input[index];
      const sample = a + (b - a) * frac;

      this.buffer[this.filled++] =
        Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
      if (this.filled === this.frameLength) {
        this.port.postMessage(this.buffer.slice());
        this.filled = 0;
      }
      this.position += this.ratio;
    }
    this.tail = input[input.length - 1];
    this.position -= input.length;
    return true;
  }
}
registerProcessor("neai-downsampler", Downsampler);
`;

export class FrameSource {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;

  /**
   * @param track       取得済みのマイクトラック。ここで取り直さない。
   * @param frameLength 検出器が要求するフレーム長（Porcupine は 512）。
   * @param onFrame     16kHz / 16bit のフレームが1つ揃うたびに呼ばれる。
   */
  async start(
    track: MediaStreamTrack,
    frameLength: number,
    onFrame: (frame: Int16Array) => void,
  ): Promise<void> {
    const ctx = new AudioContext();
    if (ctx.state === "suspended") await ctx.resume();
    this.ctx = ctx;

    const url = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
    );
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    const node = new AudioWorkletNode(ctx, "neai-downsampler", {
      processorOptions: { frameLength },
    });
    node.port.onmessage = (e) => onFrame(e.data as Int16Array);
    this.node = node;

    ctx.createMediaStreamSource(new MediaStream([track])).connect(node);

    // 出力を繋がないと、ブラウザによっては process() が呼ばれない。
    // 無音のゲインを通して destination へ落とし、確実に動かす。
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(ctx.destination);
  }

  async stop(): Promise<void> {
    this.node?.disconnect();
    await this.ctx?.close();
    this.node = null;
    this.ctx = null;
  }
}
