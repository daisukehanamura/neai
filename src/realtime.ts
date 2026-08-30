/**
 * OpenAI Realtime との WebRTC 接続。
 *
 * 第0段階の実機検証（2026-08-29 / iPhone XR / iOS 17.5.1）で判明した制約：
 *   iOS は同時に1つのカメラしか掴めない。通話中に getUserMedia を呼び直すと
 *   既存の映像トラックが ended になる。
 *   → メディアは接続前に一度だけ取得し、以後は保持し続ける。取り直さない。
 */

import { addUsage, costUsd, emptyUsage, type Usage } from "./pricing";
import type { ToolResult } from "./tools";
import { apiFetch } from "./auth";

export type Phase = "idle" | "connecting" | "ready" | "listening" | "thinking" | "speaking" | "error";

/**
 * セッションごとの設定。画面から変更できる。
 * 無操作の自動切断は費用対策。接続中はマイク音声を送り続けるため、
 * 放置するとつなぎっぱなしで1時間あたり約170円かかる。
 */
/** 実行中に画面へ出す文言。何が起きているか分かるようにする。 */
function labelOf(name: string): string {
  switch (name) {
    case "look_at_camera": return "カメラを確認しています";
    case "get_weather": return "天気を調べています";
    case "get_current_time": return "時刻を確認しています";
    case "set_timer": return "タイマーを設定しています";
    case "list_timers": return "タイマーを確認しています";
    case "cancel_timer": return "タイマーを止めています";
    default: return "調べています";
  }
}

export interface SessionOptions {
  idleSec: number;
  model: string;
}

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
  /** AI が機能を呼んだときに実行する。 */
  onTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  /**
   * AI が話している内容のテキスト。音声と同時にストリーミングで届く。
   * @param text  ここまでの全文
   * @param done  読み上げが終わったか
   */
  onAnswer: (text: string, done: boolean) => void;
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
  /** AI の発話テキスト。利用者の次の発話開始で区切る。 */
  private answer = "";
  private energyBaseline = 0;
  private pollTimer: number | null = null;

  constructor(
    private cb: Callbacks,
    private opts: SessionOptions,
  ) {
    this.metrics.model = opts.model;
  }

  get mediaStream(): MediaStream | null {
    return this.stream;
  }

  /**
   * @param stream MediaController が保持しているストリーム。ここでは取得も停止もしない。
   */
  async start(stream: MediaStream): Promise<void> {
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

      const res = await apiFetch("/api/session", {
        method: "POST",
        headers: {
          "content-type": "application/sdp",
          // 使うモデルは端末側の設定で選べる。Worker が許可リストで検証する。
          "x-neai-model": this.opts.model,
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
      const idle = (performance.now() - this.lastActivity) / 1000;
      const left = Math.ceil(this.opts.idleSec - idle);
      this.cb.onIdle(Math.max(0, left));
      if (left <= 0) {
        this.cb.onLog(`${this.opts.idleSec}秒間の無操作で自動切断しました（課金停止）`, "warn");
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
        // 新しい問いかけが始まった。前の回答の表示はここで区切る。
        this.answer = "";
        this.cb.onAnswer("", false);
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

      // 読み上げ中のテキストが少しずつ届く。音声と同時に流れてくるので待ち時間はない。
      // カメラを使う流れでは応答が2回に分かれるため、追記していく。
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta": {
        const delta = (event as unknown as { delta?: string }).delta ?? "";
        if (delta) {
          this.answer += delta;
          this.cb.onAnswer(this.answer, false);
        }
        break;
      }

      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        this.cb.onAnswer(this.answer, true);
        break;

      // AI が機能を呼んだ。引数が出揃った時点で実行する。
      case "response.function_call_arguments.done": {
        const call = event as unknown as { name: string; call_id: string; arguments?: string };
        void this.runTool(call.name, call.call_id, call.arguments);
        break;
      }

      case "error": {
        const detail = JSON.stringify(event.error ?? event);
        this.cb.onLog(`Realtime エラー: ${detail}`, "ng");
        break;
      }
    }
  }

  /**
   * 機能を実行し、結果を会話へ返す。
   * 画像が返ってきた場合は、利用者の発言として先に差し込んでから結果を返す。
   */
  private async runTool(name: string, callId: string, rawArgs?: string): Promise<void> {
    this.touch();
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(rawArgs ?? "{}") as Record<string, unknown>;
    } catch {
      /* 引数が壊れていても実行は試みる */
    }
    this.cb.onLog(`機能を呼び出し: ${name} ${rawArgs ?? ""}`, "warn");
    this.cb.onPhase("thinking", labelOf(name));

    let result: ToolResult;
    try {
      result = await this.cb.onTool(name, args);
    } catch (err) {
      result = { output: { error: (err as Error).message } };
    }

    if (result.imageDataUrl) {
      this.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: result.imageDataUrl }],
        },
      });
    }
    this.replyToTool(callId, result.output);
  }

  /** ツールの実行結果を返し、続きの応答を生成させる。 */
  private replyToTool(callId: string, output: unknown): void {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output),
      },
    });
    // 画像を見てからの回答なので、ここから再びレイテンシを測る。
    this.spokeAt = performance.now();
    void this.captureEnergyBaseline();
    this.send({ type: "response.create" });
  }

  /**
   * 話している AI を途中で止める。
   *
   * response.cancel だけだと、すでに送られて再生待ちになっている音が
   * 鳴り切ってしまう。WebRTC では output_audio_buffer.clear で
   * 未再生ぶんも捨てられるので、両方送る。
   */
  interrupt(): void {
    if (this.dc?.readyState !== "open") return;
    this.send({ type: "response.cancel" });
    this.send({ type: "output_audio_buffer.clear" });
    this.send({ type: "input_audio_buffer.clear" });
    this.touch();
    this.cb.onLog("発話を止めました", "warn");
    this.cb.onPhase("ready");
  }

  private send(event: unknown): void {
    if (this.dc?.readyState !== "open") {
      this.cb.onLog("データチャネルが開いていない", "ng");
      return;
    }
    this.dc.send(JSON.stringify(event));
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
