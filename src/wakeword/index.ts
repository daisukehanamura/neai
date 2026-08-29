/**
 * ウェイクワード検出。
 *
 * 待機中は音声を一切ネットワークへ送らない。すべて端末上で完結させる。
 * これが要件11とコスト要件の核心で、これがあって初めて常設運用が成り立つ。
 * （接続しっぱなしは gpt-realtime-2.1 で1時間あたり約170円）
 */
import { PorcupineWorker } from "@picovoice/porcupine-web";
import { FrameSource } from "./downsampler";
import type { WakeWordConfig } from "./config";

export class WakeWordDetector {
  private worker: PorcupineWorker | null = null;
  private frames = new FrameSource();
  private listening = false;

  constructor(
    private config: WakeWordConfig,
    private onDetected: () => void,
    private onLog: (message: string, kind?: "ok" | "ng" | "warn") => void,
  ) {}

  /**
   * @param track 取得済みのマイクトラック。この関数はマイクを取得しない。
   */
  async start(track: MediaStreamTrack): Promise<void> {
    this.worker = await PorcupineWorker.create(
      this.config.accessKey,
      { publicPath: this.config.keywordPath, label: this.config.label },
      () => {
        if (!this.listening) return;
        this.onLog(`「${this.config.label}」を検出`, "ok");
        this.onDetected();
      },
      { publicPath: this.config.modelPath },
    );

    await this.frames.start(track, this.worker.frameLength, (frame) => {
      if (this.listening) this.worker?.process(frame);
    });

    this.listening = true;
    this.onLog(`ウェイクワード待機開始「${this.config.label}」（通信なし）`, "ok");
  }

  /** 会話中は検出を止める。AI の声で誤検出しないようにするため。 */
  pause(): void {
    this.listening = false;
  }

  resume(): void {
    this.listening = true;
  }

  get isListening(): boolean {
    return this.listening;
  }

  async stop(): Promise<void> {
    this.listening = false;
    await this.frames.stop();
    this.worker?.terminate();
    this.worker = null;
  }
}
