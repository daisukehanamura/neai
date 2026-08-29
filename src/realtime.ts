/**
 * OpenAI Realtime との WebRTC 接続。
 *
 * 第0段階の実機検証（2026-08-29 / iPhone XR / iOS 17.5.1）で判明した制約：
 *   iOS は同時に1つのカメラしか掴めない。通話中に getUserMedia を呼び直すと
 *   既存の映像トラックが ended になる。
 *   → メディアは接続前に一度だけ取得し、以後は保持し続ける。取り直さない。
 */

import { addUsage, costUsd, emptyUsage, type Usage } from "./pricing";

export type Phase = "idle" | "connecting" | "ready" | "listening" | "thinking" | "speaking" | "error";

/**
 * 無操作でこの秒数が過ぎたら自動で切断する。
 * 接続中はマイク音声を送り続けるため、放置すると課金が積み上がる。
 * つなぎっぱなしは 1 時間あたり約 $1.15（gpt-realtime-2.1）。
 */
export const IDLE_LIMIT_SEC = 60;

export interface Metrics {
  /** 発話終了から回答音声が鳴り始めるまで(ms)。要件の最重要指標。 */
  replyMs: number | null;
  /** セッション確立にかかった時間(ms)。 */
  connectMs: number | null;
  /** OpenAI が response.done で返した実測トークン数。推定値ではない。 */
  usage: Usage;
  /** 上記トークン数から計算した概算費用(USD)。 */
  costUsd: number;
  /** 使用中のモデル名。Worker がヘッダで返す。 */
  model: string;
}

export interface Callbacks {
  onPhase: (phase: Phase, detail?: string) => void;
  onMetrics: (metrics: Metrics) => void;
  onIdle: (secondsLeft: number) => void;
  onLog: (message: string, kind?: "ok" | "ng" | "warn") => void;
}

export class RealtimeSession {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private metrics: Metrics = {
    replyMs: null, connectMs: null,
    usage: emptyUsage(), costUsd: 0, model: "gpt-realtime-2.1",
  };

  /** 最後に会話があった時刻。無操作の判定に使う。 */
  private lastActivity = 0;
  private idleTimer: number | null = null;

  /** 発話終了の時刻。ここから最初の音が出るまでを測る。 */
  private spokeAt = 0;
  private energyBaseline = 0;
  private pollTimer: number | null = null;

  constructor(private cb: Callbacks) {}

  get mediaStream(): MediaStream | null {
    return this.stream;
  }

  /**
   * @param stream MediaController が保持しているストリーム。ここでは取得も停止もしない。
   */
  async start(stream: MediaStream, deviceKey?: string): Promise<void> {
    try {
      this.stream = stream;
      const audio = stream.getAudioTracks()[0];
      if (!audio || audio.readyState !== "live") {
        throw new Error("マイクが利用できません。ページを再読み込みしてください。");
      }

      this.cb.onPhase("connecting", "OpenAI へ接続中");
      const startedAt = performance.now();

      const pc = new RTCPeerConnection();
      this.pc = pc;

      // 受信音声は audio 要素で再生する。第0段階でスピーカーから鳴ることを確認済み。
      const el = document.createElement("audio");
      el.autoplay = true;
      el.setAttribute("playsinline", "");
      document.body.appendChild(el);
      this.audioEl = el;
      pc.ontrack = (e) => {
        el.srcObject = e.streams[0];
        void el.play().catch((err) => this.cb.onLog(`再生開始に失敗: ${err.message}`, "warn"));
      };

      // 音声だけを送る。映像はローカル保持のみで、帯域とコストを使わない。
      pc.addTrack(audio, this.stream);

      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.onmessage = (e) => this.handleEvent(JSON.parse(e.data));
      dc.onopen = () => {
        this.metrics.connectMs = Math.round(performance.now() - startedAt);
        this.cb.onMetrics({ ...this.metrics });
        this.cb.onLog(`データチャネル確立 ${this.metrics.connectMs}ms`, "ok");
        this.cb.onPhase("ready");
      };

      pc.onconnectionstatechange = () => {
        this.cb.onLog(`接続状態: ${pc.connectionState}`);
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          this.cb.onPhase("error", "接続が切れました");
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const res = await fetch("/api/session", {
        method: "POST",
        headers: {
          "content-type": "application/sdp",
          ...(deviceKey ? { authorization: `Bearer ${deviceKey}` } : {}),
        },
        body: offer.sdp,
      });

      if (!res.ok) {
        const body = await res.text();
        let message = `セッション作成に失敗 (${res.status})`;
        try {
          const parsed = JSON.parse(body) as { error?: string };
          if (parsed.error) message = parsed.error;
        } catch {
          message += `: ${body.slice(0, 200)}`;
        }
        throw new Error(message);
      }

      this.metrics.model = res.headers.get("x-neai-model") ?? this.metrics.model;
      await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
      this.startEnergyPolling();
      this.startIdleWatch();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.cb.onLog(message, "ng");
      this.cb.onPhase("error", message);
      this.stop();
    }
  }

  /**
   * 回答音声が実際に鳴り始めた瞬間を、受信 RTP の累積音声エネルギーで検出する。
   * Safari では WebRTC の受信ストリームを WebAudio に繋ぐと無音になることがあるため、
   * getStats を使う。これが「聞こえ始めるまで」の実測値になる。
   */
  private startEnergyPolling(): void {
    this.pollTimer = window.setInterval(async () => {
      if (!this.pc || !this.spokeAt) return;
      const stats = await this.pc.getStats();
      let energy = 0;
      stats.forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === "audio") {
          energy = (report as { totalAudioEnergy?: number }).totalAudioEnergy ?? 0;
        }
      });
      if (energy - this.energyBaseline > 1e-5) {
        this.metrics.replyMs = Math.round(performance.now() - this.spokeAt);
        this.spokeAt = 0;
        this.cb.onMetrics({ ...this.metrics });
        this.cb.onLog(`回答音声の開始まで ${this.metrics.replyMs}ms`, "ok");
        this.cb.onPhase("speaking");
      }
    }, 40);
  }

  /**
   * 無操作が続いたら自動で切る。課金は接続時間ではなくトークン単位だが、
   * 接続中はマイク音声を送り続けるため、放置ぶんがそのまま費用になる。
   */
  private startIdleWatch(): void {
    this.lastActivity = performance.now();
    this.idleTimer = window.setInterval(() => {
      const idleSec = (performance.now() - this.lastActivity) / 1000;
      const left = Math.ceil(IDLE_LIMIT_SEC - idleSec);
      this.cb.onIdle(Math.max(0, left));
      if (left <= 0) {
        this.cb.onLog(`${IDLE_LIMIT_SEC}秒間の無操作で自動切断しました（課金停止）`, "warn");
        this.stop();
      }
    }, 1000);
  }

  private touch(): void {
    this.lastActivity = performance.now();
  }

  private async captureEnergyBaseline(): Promise<void> {
    if (!this.pc) return;
    const stats = await this.pc.getStats();
    stats.forEach((report) => {
      if (report.type === "inbound-rtp" && report.kind === "audio") {
        this.energyBaseline = (report as { totalAudioEnergy?: number }).totalAudioEnergy ?? 0;
      }
    });
  }

  private handleEvent(event: { type: string; [k: string]: unknown }): void {
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        this.touch();
        this.cb.onPhase("listening");
        break;

      case "input_audio_buffer.speech_stopped":
        this.touch();
        this.spokeAt = performance.now();
        void this.captureEnergyBaseline();
        this.cb.onPhase("thinking");
        break;

      case "response.done": {
        this.touch();
        const usage = (event.response as { usage?: unknown } | undefined)?.usage;
        this.metrics.usage = addUsage(this.metrics.usage, usage);
        this.metrics.costUsd = costUsd(this.metrics.usage, this.metrics.model);
        this.cb.onMetrics({ ...this.metrics });
        this.cb.onPhase("ready");
        break;
      }

      case "error": {
        const detail = JSON.stringify(event.error ?? event);
        this.cb.onLog(`Realtime エラー: ${detail}`, "ng");
        break;
      }
    }
  }

  stop(): void {
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    if (this.idleTimer !== null) window.clearInterval(this.idleTimer);
    this.pollTimer = this.idleTimer = null;
    this.dc?.close();
    this.pc?.close();
    this.audioEl?.remove();
    // トラックは止めない。MediaController が保持し続け、
    // ウェイクワード待機と次の会話でそのまま使い回す（iOS は取り直せない）。
    this.dc = this.pc = this.stream = this.audioEl = null;
    this.cb.onPhase("idle");
  }
}
