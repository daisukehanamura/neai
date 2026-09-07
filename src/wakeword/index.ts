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
import { SileroVad, VAD_FRAME, vadAvailable } from "./vad";

type Recognizer = {
  on: (event: string, handler: (m: { result: { text?: string; partial?: string } }) => void) => void;
  acceptWaveform: (buffer: AudioBuffer) => void;
  acceptWaveformFloat: (buffer: Float32Array, sampleRate: number) => void;
  /** 途中までの認識を打ち切って確定結果を出させる。VAD で区切るときに使う。 */
  retrieveFinalResult: () => void;
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

/**
 * VAD の判定。入り口と出口でしきい値を変えてある（ヒステリシス）。
 * 同じ値にすると境目で細かく on/off を繰り返し、発話が寸断される。
 */
const VAD_ON = 0.5;
const VAD_OFF = 0.35;
/**
 * 発話の手前をこの数だけ覚えておき、声だと分かった時点でまとめて流す。
 * VAD が反応するのは声が出た後なので、これが無いと語頭が削れて
 * 「クラピカ」が「ラピカ」になる。12フレーム＝約380ms。
 */
const PREROLL_FRAMES = 12;
/**
 * 声が途切れてから、ここまでは発話が続いているとみなす。
 * 20フレーム＝約640ms。短いと「ねえクラピカ、（間）タイマー三分」で切れる。
 */
const HANGOVER_FRAMES = 20;
/**
 * 声が続いていても、この長さで一度区切る。
 * テレビ等で VAD が張り付いたままだと確定結果がいつまでも出ない。
 * 312フレーム＝約10秒。
 */
const MAX_SPEECH_FRAMES = 312;
/** Vosk へまとめて送る単位。1フレームずつ送ると postMessage が増えすぎる。 */
const FEED_SAMPLES = 4096;
/** 推論が追いつかないときに溜めておける上限（約8秒）。 */
const MAX_QUEUE = 32;

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
  /**
   * 何を聞いているか。
   *   off  … 何もしない（会話中で、AI がまだ喋っていないとき）
   *   wake … ウェイクワードとローカルコマンド（待機中）
   *   stop … 中断の合図だけ（AI の読み上げ中）
   */
  private mode: "off" | "wake" | "stop" = "off";
  private onStop: (() => void) | null = null;
  private listening = false;
  private lastHit = 0;
  /**
   * 起動の予約。ローカルコマンドが有効なときは少し待ってから会話を開く。
   * 「ねえクラピカ、タイマー三分」のように続けて言われた場合に、
   * 先に会話を開いてしまわないため。
   */
  private pendingWake: number | null = null;

  /**
   * 声の判定。無い場合（モデル未配置・設定で OFF）は素通しで従来どおり動く。
   * 推論が非同期なので、onaudioprocess からは直接呼べない。
   */
  private vad: SileroVad | null = null;
  /** onaudioprocess が積み、pump() が順に食べる。loud はノイズゲートの結果。 */
  private queue: { samples: Float32Array; loud: boolean }[] = [];
  private pumping = false;
  private queueWarned = false;
  /** いま発話中とみなしているか。 */
  private speech = false;
  /** 声が途切れてから経過したフレーム数。 */
  private quiet = 0;
  /** 発話が始まってからのフレーム数。長すぎるときに区切るために持つ。 */
  private spoken = 0;
  /** 発話手前の控え。声だと分かった時点でまとめて Vosk に流す。 */
  private preroll: Float32Array[] = [];
  /** Vosk へまとめて送るための組み立て先。 */
  private feedBuf = new Float32Array(FEED_SAMPLES);
  private feedLen = 0;
  /** VAD へ渡す前に正規化した値を置く場所。毎フレーム確保しない。 */
  private vadFrame = new Float32Array(VAD_FRAME);

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
    // 途中経過は文字列が揺れるので、コマンドの判定には使わない。
    // ウェイクワードだけは反応の速さを優先して途中経過でも見る。
    this.recognizer.on("partialresult", (m) => this.check(m.result.partial ?? "", false));
    this.recognizer.on("result", (m) => this.check(m.result.text ?? "", true));

    // 声が出ていない間は Vosk を回さない。常設端末の消費電力と発熱に効く。
    // モデルが置かれていなければ諦めて従来どおり動く（アプリは止めない）。
    if (this.config.vad) {
      if (await vadAvailable()) {
        const v0 = performance.now();
        const vad = new SileroVad();
        await vad.load();
        this.vad = vad;
        this.onLog(`声の判定(Silero VAD)を読み込みました ${Math.round(performance.now() - v0)}ms`, "ok");
      } else {
        this.onLog("VAD のモデルが無いので声の判定なしで動きます（./scripts/fetch-vad-model.sh）", "warn");
      }
    }

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
      const loud = !this.config.gate || rms(e.inputBuffer) >= this.config.gateDb;

      if (!this.vad) {
        if (!loud) return;
        try {
          this.recognizer?.acceptWaveform(e.inputBuffer);
        } catch (err) {
          this.onLog(`認識に失敗: ${(err as Error).message}`, "ng");
        }
        return;
      }

      // VAD の推論は非同期なので、ここでは複製して積むだけにする。
      // inputBuffer は次の呼び出しで中身が入れ替わるため、参照は持ち越せない。
      this.queue.push({ samples: new Float32Array(e.inputBuffer.getChannelData(0)), loud });
      if (this.queue.length > MAX_QUEUE) {
        this.queue.shift();
        if (!this.queueWarned) {
          this.queueWarned = true;
          this.onLog("声の判定が追いついていません。音を一部捨てています", "warn");
        }
      }
      void this.pump();
    };
    this.node = node;
    if (this.config.gate) applied.push(`ゲート${this.config.gateDb}dB`);
    if (this.vad) applied.push("声の判定(VAD)");

    // 出力を繋がないと process が回らないブラウザがあるため、
    // 無音のゲインを通して destination へ落とす。音は出ない。
    const mute = ctx.createGain();
    mute.gain.value = 0;
    gain.connect(node).connect(mute).connect(ctx.destination);

    this.listening = true;
    this.onLog(`音響チェーン: ${applied.join(" → ")}`);
    this.onLog(`ウェイクワード待機開始「${this.config.label}」（通信なし）`, "ok");
  }

  /**
   * 積まれた音を順に VAD へ通す。多重に走らないよう pumping で守る。
   * 途中で VAD が壊れたら素通しに落とし、聞こえなくなるより動き続ける方を取る。
   */
  private async pump(): Promise<void> {
    if (this.pumping || !this.vad) return;
    this.pumping = true;
    try {
      while (this.queue.length && this.vad) {
        const item = this.queue.shift()!;
        for (let i = 0; i + VAD_FRAME <= item.samples.length; i += VAD_FRAME) {
          const frame = item.samples.subarray(i, i + VAD_FRAME);
          // ゲートで落ちた区間は推論もしない。無音として扱う。
          const prob = item.loud ? await this.vad.process(this.forVad(frame)) : 0;
          this.onFrame(frame, prob);
        }
      }
    } catch (err) {
      this.onLog(`声の判定が止まりました: ${(err as Error).message}。判定なしで続けます`, "ng");
      this.vad = null;
      this.endSpeech();
      this.queue = [];
    } finally {
      this.pumping = false;
    }
  }

  /**
   * VAD に渡す前に、増幅したぶんを戻して ±1 に収める。
   * Silero は普通の録音レベルで学習されているので、ゲイン6倍のまま渡すと
   * 何もかも振り切って判定にならない。
   */
  private forVad(frame: Float32Array): Float32Array {
    const g = this.config.gain || 1;
    const out = this.vadFrame;
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i] / g;
      out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
    }
    return out;
  }

  /** 1フレーム分の判定結果を受けて、発話の始まりと終わりを決める。 */
  private onFrame(frame: Float32Array, prob: number): void {
    if (!this.speech) {
      // 語頭が削れないよう、声だと分かる前の少しを控えておく。
      this.preroll.push(new Float32Array(frame));
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
      if (prob < VAD_ON) return;

      this.speech = true;
      this.quiet = 0;
      this.spoken = 0;
      // いま来たフレームも控えの末尾に入っているので、ここで一緒に流れる。
      for (const f of this.preroll) this.feed(f);
      this.preroll.length = 0;
      return;
    }

    this.feed(frame);
    this.spoken++;
    if (this.spoken >= MAX_SPEECH_FRAMES) {
      this.endSpeech();
      return;
    }
    if (prob >= VAD_OFF) {
      this.quiet = 0;
      return;
    }
    if (++this.quiet >= HANGOVER_FRAMES) this.endSpeech();
  }

  /** Vosk へ送る音をまとめる。1フレームずつ送ると postMessage が増えすぎる。 */
  private feed(frame: Float32Array): void {
    this.feedBuf.set(frame, this.feedLen);
    this.feedLen += frame.length;
    if (this.feedLen >= this.feedBuf.length) this.flushFeed();
  }

  private flushFeed(): void {
    if (!this.feedLen) return;
    const chunk = this.feedBuf.slice(0, this.feedLen);
    this.feedLen = 0;
    try {
      this.recognizer?.acceptWaveformFloat(chunk, 16000);
    } catch (err) {
      this.onLog(`認識に失敗: ${(err as Error).message}`, "ng");
    }
  }

  /**
   * 発話の終わりを Vosk に伝える。
   * VAD で切ると Vosk には無音が届かなくなり、放っておくと確定結果(result)が
   * いつまでも出ない。ローカルコマンドは確定でしか判定しないので、
   * ここを呼ばないと「タイマー三分」が動かなくなる。
   */
  private endSpeech(): void {
    const wasSpeaking = this.speech;
    this.speech = false;
    this.quiet = 0;
    this.spoken = 0;
    this.preroll.length = 0;
    this.flushFeed();
    if (!wasSpeaking) return;
    try {
      this.recognizer?.retrieveFinalResult();
    } catch {
      /* 次の発話で拾い直せるので、ここでは止めない */
    }
    // 次の発話へ余韻を持ち越さない。
    this.vad?.reset();
  }

  /** 聞くのをやめる/再開するときに、途中の状態を捨てる。 */
  private resetAudioState(): void {
    this.queue = [];
    this.speech = false;
    this.quiet = 0;
    this.spoken = 0;
    this.preroll.length = 0;
    this.feedLen = 0;
    this.vad?.reset();
  }

  private check(text: string, isFinal: boolean): void {
    if (!this.listening || !text) return;

    // 読み上げ中は中断の合図だけを見る。
    // 途中経過でも拾う。止めたいときに待たされるのは本末転倒なので。
    if (this.mode === "stop") {
      if (this.isStop(text)) {
        this.onLog(`中断の合図「${text}」`, "warn");
        this.onStop?.();
      }
      return;
    }

    if (performance.now() - this.lastHit < COOLDOWN_MS) return;

    // ローカルコマンドは確定した文だけで判定する。
    // 途中経過で判定すると、言い終わる前の断片で誤動作する。
    if (isFinal && this.onCommand?.(text)) {
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

  /** 中断の合図かどうか。判定そのものは commands 側に置いてある。 */
  private isStop(text: string): boolean {
    const t = text.replace(/\s+/g, "");
    return /(ストップ|やめて|止めて|ちょっと待って)/.test(t);
  }

  private cancelPendingWake(): void {
    if (this.pendingWake === null) return;
    clearTimeout(this.pendingWake);
    this.pendingWake = null;
  }

  /** 会話中は検出を止める。AI 自身の声で誤検出しないようにするため。 */
  pause(): void {
    this.listening = false;
    this.mode = "off";
    this.onStop = null;
    this.cancelPendingWake();
    this.resetAudioState();
  }

  resume(): void {
    this.lastHit = performance.now(); // 直後の残響で再検出しないよう間を置く
    this.mode = "wake";
    this.resetAudioState();
    this.listening = true;
  }

  /**
   * AI の読み上げ中だけ、中断の合図を聞く。
   * WebRTC のマイクは止めているので OpenAI には何も届かないが、
   * 端末内の認識は生きているので「ストップ」で止められる。
   */
  listenForStop(onStop: () => void): void {
    this.onStop = onStop;
    this.mode = "stop";
    this.lastHit = 0;
    this.resetAudioState();
    this.listening = true;
  }

  get isListening(): boolean {
    return this.listening;
  }

  async stop(): Promise<void> {
    this.listening = false;
    this.cancelPendingWake();
    this.resetAudioState();
    if (this.node) this.node.onaudioprocess = null;
    this.node?.disconnect();
    await this.ctx?.close();
    this.recognizer?.remove?.();
    this.model?.terminate?.();
    await this.vad?.close();
    this.vad = null;
    this.node = null;
    this.ctx = null;
    this.recognizer = null;
    this.model = null;
  }
}
