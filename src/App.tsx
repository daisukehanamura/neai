import { useCallback, useEffect, useRef, useState } from "react";
import { IDLE_LIMIT_SEC, RealtimeSession, type Metrics, type Phase } from "./realtime";
import { MediaController } from "./media";
import { loadConfig, type WakeWordConfig } from "./wakeword/config";
// 型だけの参照。verbatimModuleSyntax によりビルド時に消えるため、
// Porcupine 本体は初期バンドルに入らない。
import type { WakeWordDetector } from "./wakeword";
import { emptyUsage } from "./pricing";

/** 費用の目安を円で見せるための換算レート。正確な請求額ではない。 */
const USD_TO_JPY = 150;

/** アプリ全体の状態。会話中かどうかと、待機の仕方を表す。 */
type Mode = "停止中" | "起動中" | "ウェイクワード待機" | "タップ待ち" | "会話中";

const PHASE_LABEL: Record<Phase, string> = {
  idle: "待機中",
  connecting: "接続中",
  ready: "どうぞ",
  listening: "聞いています",
  thinking: "考えています",
  speaking: "話しています",
  error: "エラー",
};

interface Entry {
  time: string;
  message: string;
  kind?: "ok" | "ng" | "warn";
}

export default function App() {
  const [mode, setMode] = useState<Mode>("停止中");
  const [phase, setPhase] = useState<Phase>("idle");
  const [detail, setDetail] = useState("");
  const [metrics, setMetrics] = useState<Metrics>({
    replyMs: null, connectMs: null,
    usage: emptyUsage(), costUsd: 0, model: "",
  });
  const [idleLeft, setIdleLeft] = useState(IDLE_LIMIT_SEC);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [wakeConfig] = useState<WakeWordConfig | null>(() => loadConfig());

  const mediaRef = useRef(new MediaController());
  const sessionRef = useRef<RealtimeSession | null>(null);
  const detectorRef = useRef<WakeWordDetector | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  const log = useCallback((message: string, kind?: Entry["kind"]) => {
    const time = new Date().toTimeString().slice(0, 8);
    setEntries((prev) => [...prev.slice(-80), { time, message, kind }]);
  }, []);

  // 第0段階で確認済み：画面が hidden になると Wake Lock は解放される。
  const acquireWakeLock = useCallback(async () => {
    if (!("wakeLock" in navigator)) return;
    try {
      wakeLockRef.current = await navigator.wakeLock.request("screen");
    } catch (err) {
      log(`Wake Lock 取得失敗: ${(err as Error).message}`, "warn");
    }
  }, [log]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && mode !== "停止中") void acquireWakeLock();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [acquireWakeLock, mode]);

  /** 会話を開始する。マイクは既に取得済みのものを使い、取り直さない。 */
  const openConversation = useCallback(async () => {
    const stream = mediaRef.current.current;
    if (!stream) return;

    detectorRef.current?.pause();
    setMode("会話中");
    setIdleLeft(IDLE_LIMIT_SEC);

    const session = new RealtimeSession({
      onPhase: (p, d) => {
        setPhase(p);
        setDetail(d ?? "");
        if (p === "idle") {
          // 自動切断された。ウェイクワード待機へ戻す。
          sessionRef.current = null;
          if (detectorRef.current) {
            detectorRef.current.resume();
            setMode("ウェイクワード待機");
          } else {
            setMode("タップ待ち");
          }
        }
      },
      onMetrics: setMetrics,
      onIdle: setIdleLeft,
      onLog: log,
    });
    sessionRef.current = session;
    await session.start(stream, localStorage.getItem("neai_device_key") ?? undefined);
  }, [log]);

  /** 常設待機を始める。ここで一度だけマイクとカメラを取得する。 */
  const boot = async () => {
    setMode("起動中");
    await acquireWakeLock();
    try {
      const stream = await mediaRef.current.acquire();
      const audio = stream.getAudioTracks()[0];
      const video = stream.getVideoTracks()[0];
      log(`メディア取得 音声=${audio?.readyState} 映像=${video?.readyState ?? "なし"}`, "ok");
    } catch (err) {
      log(`マイクとカメラの取得に失敗: ${(err as Error).message}`, "ng");
      setMode("停止中");
      return;
    }

    if (!wakeConfig) {
      log("ウェイクワード未設定のためタップ開始で動きます（README を参照）", "warn");
      setMode("タップ待ち");
      return;
    }

    try {
      log("ウェイクワード検出器を読み込み中…");
      // Porcupine は WASM 込みで 3MB 超。待機を始めるときだけ読み込む。
      const { WakeWordDetector } = await import("./wakeword");
      const detector = new WakeWordDetector(wakeConfig, () => void openConversation(), log);
      await detector.start(mediaRef.current.audioTrack!);
      detectorRef.current = detector;
      setMode("ウェイクワード待機");
    } catch (err) {
      log(`ウェイクワードの初期化に失敗: ${(err as Error).message}`, "ng");
      log("タップ開始に切り替えます", "warn");
      setMode("タップ待ち");
    }
  };

  const shutdown = async () => {
    sessionRef.current?.stop();
    sessionRef.current = null;
    await detectorRef.current?.stop();
    detectorRef.current = null;
    mediaRef.current.releaseAll();
    void wakeLockRef.current?.release();
    wakeLockRef.current = null;
    setMode("停止中");
    setPhase("idle");
    log("停止しました", "warn");
  };

  const talking = mode === "会話中";
  const statusText = talking ? PHASE_LABEL[phase] : mode;

  return (
    <main className={`app phase-${talking ? phase : "idle"}`}>
      <div className="stage">
        <div className="orb" aria-hidden="true" />
        <h1>{statusText}</h1>
        {mode === "ウェイクワード待機" && (
          <p className="detail">「{wakeConfig?.label}」と話しかけてください（通信していません）</p>
        )}
        {talking && detail && <p className="detail">{detail}</p>}
      </div>

      <dl className="metrics">
        <div>
          <dt>回答開始まで</dt>
          <dd className={metrics.replyMs !== null && metrics.replyMs <= 1200 ? "good" : undefined}>
            {metrics.replyMs === null ? "—" : `${metrics.replyMs} ms`}
          </dd>
        </div>
        <div>
          <dt>累計費用</dt>
          <dd className={metrics.costUsd > 0.1 ? "warn" : undefined}>
            {metrics.costUsd === 0 ? "—" : `¥${(metrics.costUsd * USD_TO_JPY).toFixed(1)}`}
          </dd>
        </div>
      </dl>

      {talking && (
        <p className="idle">
          無操作あと <b>{idleLeft}</b> 秒で自動切断
          {metrics.model && <span className="model"> / {metrics.model}</span>}
        </p>
      )}

      {mode === "停止中" && (
        <button className="action" onClick={boot}>常設待機を開始</button>
      )}
      {mode === "タップ待ち" && (
        <button className="action" onClick={() => void openConversation()}>話しかける</button>
      )}
      {(mode === "ウェイクワード待機" || talking) && (
        <button className="action secondary" onClick={() => void shutdown()}>停止</button>
      )}

      <section className="log" aria-label="ログ">
        {entries.map((e, i) => (
          <div key={i} className={e.kind}>
            <span className="t">{e.time}</span> {e.message}
          </div>
        ))}
      </section>
    </main>
  );
}
