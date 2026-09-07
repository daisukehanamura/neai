/**
 * マイクとカメラを、アプリの生存期間中ずっと保持し続ける。
 *
 * 第0段階の実機検証（2026-08-29 / iPhone XR / iOS 17.5.1）で判明した制約：
 *   iOS は同時に1つのカメラしか掴めない。既存の映像トラックが生きている状態で
 *   2本目の getUserMedia を呼ぶと、1本目が ended になる。
 *
 * したがって会話の切断でトラックを止めてはいけない。
 * カメラを切り替えるときだけ、先に映像トラックを止めてから取り直す。
 */

export type Facing = "user" | "environment";

/** 撮影した1枚。第0段階の実測では 576x1024 / 178KB で 328ms かかった。 */
export interface Frame {
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
  /** 撮影にかかった時間(ms)。画像質問のレイテンシ予算に効く。 */
  ms: number;
}

/** 長辺をここまで縮める。大きいほど字が読めるが、エンコードが遅くなる。 */
const MAX_EDGE = 1024;
const JPEG_QUALITY = 0.7;

/**
 * カメラを取り直したあと、最初の絵が出るまで待つ上限。
 * これを超えたら諦めて「取得できなかった」を返す。黙って真っ黒を送らない。
 */
const VIDEO_READY_TIMEOUT_MS = 3000;
/**
 * 絵が出てから、露出が落ち着くまでの待ち。
 * 取得直後の1〜2フレームは暗いままで、そのまま送ると何も写っていない写真になる。
 */
const VIDEO_SETTLE_MS = 250;

export class MediaController {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas = document.createElement("canvas");
  private facing: Facing = "user";

  constructor(facing: Facing = "user") {
    this.facing = facing;
  }

  private constraints(): MediaStreamConstraints {
    return {
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: {
        facingMode: this.facing,
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    };
  }

  /**
   * 取得済みなら同じストリームを返す。二度目の getUserMedia を呼ばない。
   *
   * @param withVideo カメラも最初から掴むか。false のときは音声だけ取り、
   *   映像は必要になった時点で ensureVideo() が取りに行く。720p の
   *   キャプチャを24時間回し続けないぶん、電力と発熱が減る。
   */
  async acquire(withVideo = true): Promise<MediaStream> {
    if (this.stream) return this.stream;
    const c = this.constraints();
    this.stream = await navigator.mediaDevices.getUserMedia(
      withVideo ? c : { audio: c.audio },
    );
    if (withVideo) this.attachVideo(this.stream);
    return this.stream;
  }

  /**
   * 撮影できる状態にする。手放していれば取り直す。
   *
   * 映像だけを取り直すのは switchCamera() と同じ経路で、音声トラックには触らない。
   * iOS で取り直せないのはマイクのほうで、カメラは入れ替えられる
   * （[docs/ios-constraints.md](../docs/ios-constraints.md)）。
   *
   * @returns 絵が出るところまで行けたか。
   */
  async ensureVideo(): Promise<boolean> {
    if (!this.stream) return false;

    const live = this.videoTrack;
    if (!live || live.readyState !== "live") {
      const fresh = await navigator.mediaDevices.getUserMedia({ video: this.constraints().video });
      const track = fresh.getVideoTracks()[0];
      if (!track) return false;
      if (live) this.stream.removeTrack(live);
      this.stream.addTrack(track);
      this.attachVideo(this.stream);
    } else if (this.video && !this.video.srcObject) {
      this.attachVideo(this.stream);
    }

    return await this.waitForFrame();
  }

  /** カメラを手放す。音声は触らない。待機中の消費電力を落とすために使う。 */
  releaseVideo(): void {
    if (!this.stream) return;
    const tracks = this.stream.getVideoTracks();
    if (!tracks.length) return;
    tracks.forEach((t) => {
      t.stop();
      this.stream!.removeTrack(t);
    });
    // 止めたトラックが刺さったままだと、次に取り直したとき絵が戻らないことがある。
    if (this.video) this.video.srcObject = null;
  }

  /** カメラを掴んでいるか。設定と実態がずれていないかの確認に使う。 */
  get videoActive(): boolean {
    return this.videoTrack?.readyState === "live";
  }

  /** 取得直後は videoWidth が 0 で、そのまま撮ると真っ黒な絵になる。 */
  private async waitForFrame(): Promise<boolean> {
    const until = performance.now() + VIDEO_READY_TIMEOUT_MS;
    while (performance.now() < until) {
      if (this.video?.videoWidth) {
        await new Promise((r) => setTimeout(r, VIDEO_SETTLE_MS));
        return !!this.video?.videoWidth;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  /**
   * カメラを内/外で切り替える。映像トラックだけ入れ替え、音声には触らない。
   * 会話中に呼ばないこと（WebRTC の音声は続くが、切り替え中は撮影できない）。
   */
  async switchCamera(): Promise<Facing> {
    this.facing = this.facing === "user" ? "environment" : "user";
    if (!this.stream) return this.facing;
    // 手放している間は向きを覚えるだけでよい。次に ensureVideo() が取るとき効く。
    if (!this.videoActive) return this.facing;

    // 先に止めてから取り直す。同時に2本掴めないため。
    this.stream.getVideoTracks().forEach((t) => {
      t.stop();
      this.stream!.removeTrack(t);
    });

    const fresh = await navigator.mediaDevices.getUserMedia({ video: this.constraints().video });
    const track = fresh.getVideoTracks()[0];
    this.stream.addTrack(track);
    this.attachVideo(this.stream);
    return this.facing;
  }

  private attachVideo(stream: MediaStream): void {
    if (!this.video) {
      const el = document.createElement("video");
      el.muted = true;
      el.setAttribute("playsinline", "");
      el.style.display = "none";
      document.body.appendChild(el);
      this.video = el;
    }
    this.video.srcObject = stream;
    void this.video.play().catch(() => {
      /* 非表示要素の再生は失敗しうるが、フレーム取得には影響しない */
    });
  }

  /**
   * いま映っているものを1枚取り出す。
   * 映像は WebRTC に載せていないので、ここでの取得は帯域も課金も使わない。
   */
  captureFrame(): Frame | null {
    const v = this.video;
    if (!v || !v.videoWidth) return null;

    const t0 = performance.now();
    const scale = Math.min(1, MAX_EDGE / Math.max(v.videoWidth, v.videoHeight));
    this.canvas.width = Math.round(v.videoWidth * scale);
    this.canvas.height = Math.round(v.videoHeight * scale);

    const ctx = this.canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, this.canvas.width, this.canvas.height);

    const dataUrl = this.canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    return {
      dataUrl,
      width: this.canvas.width,
      height: this.canvas.height,
      bytes: Math.round((dataUrl.length * 3) / 4),
      ms: Math.round(performance.now() - t0),
    };
  }

  get currentFacing(): Facing {
    return this.facing;
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

  /** トラックが生きているか。長時間運用の確認に使う。 */
  get healthy(): boolean {
    const a = this.audioTrack;
    return !!a && a.readyState === "live" && !a.muted;
  }

  /** アプリを終了するときだけ呼ぶ。会話の切断では呼んではいけない。 */
  releaseAll(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.video?.remove();
    this.stream = null;
    this.video = null;
  }
}
