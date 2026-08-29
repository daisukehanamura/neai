/**
 * マイクとカメラを、アプリの生存期間中ずっと保持し続ける。
 *
 * 第0段階の実機検証（2026-08-29 / iPhone XR / iOS 17.5.1）で判明した制約：
 *   iOS は同時に1つのカメラしか掴めない。2本目の getUserMedia を呼ぶと
 *   1本目の映像トラックが ended になる。
 *
 * したがって取得は起動時の一度きり。会話の切断でトラックを止めてはいけない。
 * ウェイクワード待機中もマイクは生かしたままにする必要がある。
 */

const CONSTRAINTS = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
} satisfies MediaStreamConstraints;

export class MediaController {
  private stream: MediaStream | null = null;

  /** 取得済みなら同じストリームを返す。二度目の getUserMedia を絶対に呼ばない。 */
  async acquire(): Promise<MediaStream> {
    if (this.stream) return this.stream;
    this.stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
    return this.stream;
  }

  get audioTrack(): MediaStreamTrack | null {
    return this.stream?.getAudioTracks()[0] ?? null;
  }

  get videoTrack(): MediaStreamTrack | null {
    return this.stream?.getVideoTracks()[0] ?? null;
  }

  get current(): MediaStream | null {
    return this.stream;
  }

  /** トラックが生きているか。長時間運用で死んでいないかの確認に使う。 */
  get healthy(): boolean {
    const a = this.audioTrack;
    return !!a && a.readyState === "live" && !a.muted;
  }

  /** アプリを終了するときだけ呼ぶ。会話の切断では呼んではいけない。 */
  releaseAll(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
