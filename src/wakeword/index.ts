/**
 * ウェイクワード検出（Vosk / Kaldi の WASM 版）。
 *
 * 待機中はネットワークへ音声を一切送らない。すべて端末上で完結する。
 * 端末に触らず話しかけて操作する、というこのプロジェクトの核心要件がこれで成り立つ。
 *
 * Picovoice Porcupine は無料枠が2026年6月30日に廃止されたため採用できなかった。
 * Vosk は Apache-2.0、アカウント不要、日本語モデルあり。
 * iOS Safari で動作することを 2026-08-30 に実機で確認済み。
 *
 * Vosk は全文認識なので、将来ローカルコマンド層（タイマー等）にも使い回せる。
 */
import { loadModelUrl, type WakeWordConfig } from "./config";

type Recognizer = {
  on: (event: string, handler: (m: { result: { text?: string; partial?: string } }) => void) => void;
  acceptWaveform: (buffer: AudioBuffer) => void;
  remove?: () => void;
};
type VoskModel = {
  KaldiRecognizer: new (sampleRate: number, grammar?: string) => Recognizer;
  terminate?: () => void;
};

/** 検出後にこの時間は再検出しない。1回の呼びかけで何度も起動しないため。 */
const COOLDOWN_MS = 3000;

/**
 * ウェイクワードを聞いてから会話を開くまでの猶予。
 * 「ねえクラピカ、タイマー三分」と続けて言われたときに、
 * 先に会話を開いて課金してしまわないための待ち時間。
 * ローカルコマンドが有効なときだけ使う。
 */
const WAKE_HOLD_MS = 700;

/** バッファの音量(dBFS)。ノイズゲートの判定に使う。 */
function rms(buffer: AudioBuffer): number {
  const ch = buffer.getChannelData(0);
  let sum = 0;
  for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
  return 20 * Math.log10(Math.sqrt(sum / ch.length) || 1e-7);
}

export class WakeWordDetector {
  private model: VoskModel | null = null;
  private recognizer: Recognizer | null = null;
  private ctx: AudioContext | null = null;
  private node: ScriptProcessorNode | null = null;
  private listening = false;
  private lastHit = 0;
  /**
   * 起動の予約。ローカルコマンドが有効なときは少し待ってから会話を開く。
   * 「ねえクラピカ、タイマー三分」のように続けて言われた場合に、
   * 先に会話を開いてしまわないため。
   */
  private pendingWake: number | null = null;

  constructor(
    private config: WakeWordConfig,
    private onDetected: () => void,
    private onLog: (message: string, kind?: "ok" | "ng" | "warn") => void,
    /**
     * 認識結果をローカルコマンドとして処理できたら true を返す。
     * true のときは会話を開かない（＝OpenAI に繋がず課金も発生しない）。
     */
    private onCommand?: (text: string) => boolean,
  ) {}

  /**
   * @param track 取得済みのマイクトラック。この関数はマイクを取得しない。
   *              iOS では取り直せないため、MediaController が持つものを共有する。
   */
  async start(track: MediaStreamTrack): Promise<void> {
    const Vosk = await import("vosk-browser");

    this.onLog("ウェイクワードのモデルを読み込み中（初回のみ48MB）…");
    const t0 = performance.now();
    // 25MiB 上限のため分割して置いてある。取得して連結してから渡す。
    let lastShown = 0;
    const url = await loadModelUrl((ratio) => {
      const pct = Math.round(ratio * 100);
      if (pct - lastShown >= 25) {
        lastShown = pct;
        this.onLog(`モデル取得 ${pct}%`);
      }
    });
    this.model = (await Vosk.createModel(url)) as unknown as VoskModel;
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    this.onLog(`モデル読み込み完了 ${Math.round(performance.now() - t0)}ms`, "ok");

    // 認識対象を絞ると精度が上がり、CPU も下がる。
    this.recognizer = new this.model.KaldiRecognizer(16000, JSON.stringify(this.config.grammar));
    this.recognizer.on("partialresult", (m) => this.check(m.result.partial ?? ""));
    this.recognizer.on("result", (m) => this.check(m.result.text ?? ""));

    // 16kHz を直接要求する。実機ではこれが通ることを確認済み。
    const ctx = new AudioContext({ sampleRate: 16000 });
    if (ctx.state === "suspended") await ctx.resume();
    this.ctx = ctx;
    if (ctx.sampleRate !== 16000) {
      this.onLog(`AudioContext が ${ctx.sampleRate}Hz になった。認識精度が落ちる恐れ`, "warn");
    }

    // 音響チェーン。順序は ハイパス → コンプレッサ → ゲイン。
    // 低音を先に落としておくと、コンプレッサが声に反応しやすい。
    let chain: AudioNode = ctx.createMediaStreamSource(new MediaStream([track]));
    const applied: string[] = [];

    if (this.config.highpass) {
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 100; // 空調・冷蔵庫・床鳴りの帯域
      chain.connect(hp);
      chain = hp;
      applied.push("ハイパス100Hz");
    }

    if (this.config.compressor) {
      // ゲインと違い、小さい音だけを持ち上げる。
      // 遠くの声を拾いつつ、近くで喋っても割れない。
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -45;
      comp.knee.value = 20;
      comp.ratio.value = 8;
      comp.attack.value = 0.003;
      comp.release.value = 0.15;
      chain.connect(comp);
      chain = comp;
      applied.push("コンプレッサ");
    }

    const gain = ctx.createGain();
    gain.gain.value = this.config.gain;
    chain.connect(gain);
    applied.push(`ゲイン${this.config.gain}倍`);

    const node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => {
      if (!this.listening) return;
      // 静かな区間は認識に回さない。誤検出とCPUの両方が減る。
      if (this.config.gate && rms(e.inputBuffer) < this.config.gateDb) return;
      try {
        this.recognizer?.acceptWaveform(e.inputBuffer);
      } catch (err) {
        this.onLog(`認識に失敗: ${(err as Error).message}`, "ng");
      }
    };
    this.node = node;
    if (this.config.gate) applied.push(`ゲート${this.config.gateDb}dB`);

    // 出力を繋がないと process が回らないブラウザがあるため、
    // 無音のゲインを通して destination へ落とす。音は出ない。
    const mute = ctx.createGain();
    mute.gain.value = 0;
    gain.connect(node).connect(mute).connect(ctx.destination);

    this.listening = true;
    this.onLog(`音響チェーン: ${applied.join(" → ")}`);
    this.onLog(`ウェイクワード待機開始「${this.config.label}」（通信なし）`, "ok");
  }

  private check(text: string): void {
    if (!this.listening || !text) return;
    if (performance.now() - this.lastHit < COOLDOWN_MS) return;

    // ローカルコマンドを先に見る。処理できたら会話は開かない。
    if (this.onCommand?.(text)) {
      this.cancelPendingWake();
      this.lastHit = performance.now();
      return;
    }

    if (!this.config.match.some((m) => text.includes(m))) return;

    if (!this.onCommand) {
      // コマンド層が無いなら待つ理由がない。すぐ開く。
      this.lastHit = performance.now();
      this.onLog(`ウェイクワード検出「${text}」`, "ok");
      this.onDetected();
      return;
    }

    // 少し待って、後ろにコマンドが続かないか見る。
    if (this.pendingWake !== null) return;
    this.pendingWake = window.setTimeout(() => {
      this.pendingWake = null;
      this.lastHit = performance.now();
      this.onLog(`ウェイクワード検出「${text}」`, "ok");
      this.onDetected();
    }, WAKE_HOLD_MS);
  }

  private cancelPendingWake(): void {
    if (this.pendingWake === null) return;
    clearTimeout(this.pendingWake);
    this.pendingWake = null;
  }

  /** 会話中は検出を止める。AI 自身の声で誤検出しないようにするため。 */
  pause(): void {
    this.listening = false;
    this.cancelPendingWake();
  }

  resume(): void {
    this.lastHit = performance.now(); // 直後の残響で再検出しないよう間を置く
    this.listening = true;
  }

  get isListening(): boolean {
    return this.listening;
  }

  async stop(): Promise<void> {
    this.listening = false;
    this.cancelPendingWake();
    if (this.node) this.node.onaudioprocess = null;
    this.node?.disconnect();
    await this.ctx?.close();
    this.recognizer?.remove?.();
    this.model?.terminate?.();
    this.node = null;
    this.ctx = null;
    this.recognizer = null;
    this.model = null;
  }
}
