import { useCallback, useEffect, useRef, useState } from "react";
import { RealtimeSession, type Metrics, type Phase } from "./realtime";
import { MediaController, type Facing, type Frame } from "./media";
import { MODEL_URL, modelAvailable } from "./wakeword/config";
import SettingsPanel from "./SettingsPanel";
import { loadSettings, saveSettings, wakeWordOf, type Settings } from "./settings";
import { apiFetch, pickUpKeyFromUrl } from "./auth";
import { addSpend, readSpend, resetSpend, type Spend } from "./usage";
// 型だけの参照。verbatimModuleSyntax によりビルド時に消えるため、
// Porcupine 本体は初期バンドルに入らない。
import type { WakeWordDetector } from "./wakeword";
import { emptyUsage } from "./pricing";
import { runTool } from "./tools";
import { TimerStore, remaining, type Timer } from "./tools/timer";
import { commandGrammar, matchCommand, speak } from "./tools/commands";
import Ambient, { type Weather } from "./Ambient";

/**
 * 待機画面の天気を取り直す間隔。1日3回。
 * 週間予報が主な用途で、日単位の予報はそう頻繁には変わらない。
 */
const WEATHER_INTERVAL_MS = 8 * 60 * 60 * 1000;
/** 画面に戻ったとき、これより古ければ取り直す。 */
const WEATHER_STALE_MS = 8 * 60 * 60 * 1000;


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
  const [idleLeft, setIdleLeft] = useState(0);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  const wake = wakeWordOf(settings);
  // コールバックの中から常に最新の設定を読むための控え。
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // 棚に立てて画面をこちらに向けて使うため、既定は内カメラ。
  const mediaRef = useRef(new MediaController("user"));
  const timersRef = useRef<TimerStore | null>(null);
  const [facing, setFacing] = useState<Facing>("user");
  const [lastFrame, setLastFrame] = useState<Frame | null>(null);
  const [timers, setTimers] = useState<Timer[]>([]);
  const [ringing, setRinging] = useState(false);
  const [, forceTick] = useState(0);
  const [weather, setWeather] = useState<Weather | null>(null);
  /** 天気を最後に取得した時刻。復帰時に取り直すか判断するのに使う。 */
  const weatherAtRef = useRef(0);
  const [showLog, setShowLog] = useState(false);
  const [spend, setSpend] = useState<Spend>(() => readSpend());
  /** 直前に見た会話費用。差分だけを積み上げるために持つ。 */
  const prevCostRef = useRef(0);
  const [answer, setAnswer] = useState("");
  const [answerDone, setAnswerDone] = useState(false);
  /** 待たせている間に出す文言と、待ち始めた時刻。 */
  const [busy, setBusy] = useState<{ label: string; since: number } | null>(null);
  const [busySec, setBusySec] = useState(0);
  const [keepLeft, setKeepLeft] = useState(0);
  const answerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<RealtimeSession | null>(null);
  const detectorRef = useRef<WakeWordDetector | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // 初回に #k=... で渡されたキーを取り込む。取り込んだら URL からは消す。
  useEffect(() => {
    if (pickUpKeyFromUrl()) {
      // log はこの時点でまだ使えないので、状態にだけ反映する。
      setEntries((prev) => [
        ...prev,
        { time: new Date().toTimeString().slice(0, 8), message: "デバイスキーを保存しました", kind: "ok" },
      ]);
    }
  }, []);

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
    setIdleLeft(settingsRef.current.idleSec);
    prevCostRef.current = 0;

    const session = new RealtimeSession({
      onPhase: (p, d) => {
        setPhase(p);
        setDetail(d ?? "");
        // 待たせている間は、何をしているかを主役の領域に出す。
        // 検索は7〜8秒かかるので、無言のままだと固まったように見える。
        if (p === "thinking" || p === "connecting") {
          setBusy((prev) =>
            // 新しい文言が来たら差し替え、無ければ今の表示を保つ。
            d ? { label: d, since: Date.now() } : prev ?? { label: "考えています", since: Date.now() },
          );
        } else {
          setBusy(null);
        }
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
      onMetrics: (m) => {
        setMetrics(m);
        // 会話の費用は積み上がった値で来る。前回との差だけを記録する。
        // 新しいセッションでは 0 に戻るので、その場合は全額を差分とみなす。
        const delta = m.costUsd >= prevCostRef.current
          ? m.costUsd - prevCostRef.current
          : m.costUsd;
        prevCostRef.current = m.costUsd;
        if (delta > 0) setSpend(addSpend(delta));
      },
      onIdle: setIdleLeft,
      onLog: log,
      onTool: (name, args) =>
        runTool(name, args, {
          captureFrame: () => {
            const frame = mediaRef.current.captureFrame();
            setLastFrame(frame);
            return frame;
          },
          timers: timersRef.current!,
          location: settingsRef.current.location,
          log,
          speakWhileWaiting: (t) => speak(t),
          onSpend: (usd) => setSpend(addSpend(usd)),
        }),
      // 読み上げ中は WebRTC のマイクを止め、端末内の認識だけで中断を受け付ける。
      // 「ストップ」と言えば止まるが、物音では止まらない。
      onSpeaking: (active) => {
        const d = detectorRef.current;
        if (!d) return;
        if (active) d.listenForStop(() => sessionRef.current?.interrupt());
        else d.pause();
      },
      onAnswer: (text, done) => {
        // 読み上げが始まったら待ちの表示は用済み。
        if (text) setBusy(null);
        // 空文字は新しい問いかけの合図。前の回答を消す。
        if (text) {
          setAnswer(text);
          setAnswerDone(done);
          if (done) setKeepLeft(settingsRef.current.keepSec);
        } else {
          setAnswer("");
          setAnswerDone(false);
          setKeepLeft(0);
          setLastFrame(null);
        }
      },
    }, {
      idleSec: settingsRef.current.idleSec,
      model: settingsRef.current.model,
    });
    sessionRef.current = session;
    await session.start(stream);
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

    if (!(await modelAvailable())) {
      log("ウェイクワードのモデルが無いのでタップ開始で動きます", "warn");
      log("有効にするには ./scripts/fetch-vosk-model.sh を実行してください");
      setMode("タップ待ち");
      return;
    }

    try {
      // Vosk は WASM 込みで 5MB 超。待機を始めるときだけ読み込む。
      const { WakeWordDetector } = await import("./wakeword");
      const s = settingsRef.current;
      const w = wakeWordOf(s);
      // ローカルコマンドを有効にすると認識対象が増える。
      // その代わり「タイマー三分」等を OpenAI に繋がず処理できる。
      const grammar = s.localCommands
        ? [...w.grammar.filter((g) => g !== "[unk]"), ...commandGrammar(), "[unk]"]
        : w.grammar;
      const detector = new WakeWordDetector(
        {
          modelUrl: MODEL_URL,
          grammar,
          match: w.match,
          label: w.label,
          gain: s.gain,
          compressor: s.compressor,
          highpass: s.highpass,
          gate: s.gate,
          gateDb: s.gateDb,
        },
        () => void openConversation(),
        log,
        s.localCommands ? handleLocalCommand : undefined,
      );
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

  /**
   * ウェイクワード用に常時動いている認識結果を、コマンドとしても照合する。
   * 処理できたら true を返し、会話を開かない。**OpenAI に繋がないので課金ゼロ。**
   * 返事も端末内の音声合成で返す。
   */
  const handleLocalCommand = useCallback((text: string): boolean => {
    const store = timersRef.current;
    if (!store) return false;

    const cmd = matchCommand(text, {
      ringing: store.ringing,
      timers: store.list().map((t) => ({ label: t.label, left: remaining(t) })),
    });
    if (!cmd) return false;

    log(`ローカル処理「${text}」→ ${cmd.tool}（通信なし・課金ゼロ）`, "ok");

    if (cmd.tool === "set_timer") {
      store.add(Number(cmd.args.seconds));
    } else if (cmd.tool === "cancel_timer") {
      store.cancel();
      setRinging(false);
    }


    setAnswer(cmd.speech);
    setAnswerDone(true);
    setKeepLeft(settingsRef.current.keepSec);

    // 自分の声で再検出しないよう、読み上げ中は検出を止める。
    detectorRef.current?.pause();
    if (!speak(cmd.speech)) log("音声合成が使えないため画面表示のみ", "warn");
    setTimeout(() => detectorRef.current?.resume(), 2500);
    return true;
  }, [log]);

  // 待機画面に出す天気。
  // Open-Meteo は無料だが、会話のたびに取り直すのは無駄なので稼働中かどうかだけを見る。
  const running = mode !== "停止中";
  useEffect(() => {
    if (!running) return;
    let alive = true;

    const fetchWeather = async () => {
      try {
        const loc = settingsRef.current.location;
        const q = new URLSearchParams();
        if (loc.lat != null && loc.lon != null) {
          q.set("lat", String(loc.lat));
          q.set("lon", String(loc.lon));
          if (loc.name) q.set("name", loc.name);
        }
        const res = await apiFetch(`/api/tools/weather?${q}`);
        if (!alive) return;
        if (!res.ok) {
          // 黙って消えると原因が分からないので必ず残す。
          log(
            res.status === 401
              ? "天気を取得できません。デバイスキーが未設定です（設定画面で確認）"
              : `天気の取得に失敗しました (${res.status})`,
            "warn",
          );
          return;
        }
        setWeather((await res.json()) as Weather);
        weatherAtRef.current = Date.now();
      } catch (err) {
        log(`天気の取得に失敗しました: ${(err as Error).message}`, "warn");
      }
    };

    void fetchWeather();
    const id = setInterval(fetchWeather, WEATHER_INTERVAL_MS);

    // iOS は画面を離れると JS を止めるため setInterval も止まる。
    // 戻ってきたときに古いままにならないよう、経過を見て取り直す。
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - weatherAtRef.current > WEATHER_STALE_MS) void fetchWeather();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [running, log]);

  // タイマーは会話とは独立して動く。LLM もネットワークも通さない。
  useEffect(() => {
    if (timersRef.current) return;
    timersRef.current = new TimerStore(
      (list) => setTimers(list),
      (t) => {
        log(`タイマー終了「${t.label}」`, "ok");
        setRinging(true);
      },
    );
    setTimers(timersRef.current.list());
  }, [log]);

  // 残り時間の表示を毎秒書き換える。
  useEffect(() => {
    if (!timers.length) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [timers.length]);

  // 待っている間は秒数を出す。数字が動いていれば止まっていないと分かる。
  useEffect(() => {
    if (!busy) { setBusySec(0); return; }
    const tick = () => setBusySec(Math.floor((Date.now() - busy.since) / 1000));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [busy]);

  // 読み上げ中は末尾を追いかける。長い回答でも今読まれている所が見える。
  useEffect(() => {
    if (!answerDone && answerRef.current) {
      answerRef.current.scrollTop = answerRef.current.scrollHeight;
    }
  }, [answer, answerDone]);

  // 読み終えてから一定時間で消す。残り続けると何の回答か分からなくなるため。
  useEffect(() => {
    if (keepLeft <= 0) return;
    const id = setTimeout(() => setKeepLeft((n) => n - 1), 1000);
    if (keepLeft === 1) {
      setAnswer("");
      setAnswerDone(false);
      setLastFrame(null);
    }
    return () => clearTimeout(id);
  }, [keepLeft]);

  const switchCamera = async () => {
    try {
      const next = await mediaRef.current.switchCamera();
      setFacing(next);
      log(`カメラを${next === "user" ? "内" : "外"}に切り替えた`, "ok");
    } catch (err) {
      log(`カメラの切り替えに失敗: ${(err as Error).message}`, "ng");
    }
  };

  const applySettings = (next: Settings) => {
    setSettings(next);
    saveSettings(next);
  };

  /**
   * 時計の画面へ戻す。
   * 会話中なら会話も終える。「ホーム」と言われたら全部畳んで戻るのが素直。
   */
  const goHome = () => {
    if (sessionRef.current) {
      sessionRef.current.stop();
      sessionRef.current = null;
    }
    setAnswer("");
    setAnswerDone(false);
    setKeepLeft(0);
    setLastFrame(null);
    setBusy(null);
    setShowLog(false);
  };

  /**
   * アラームを止めたあとの後始末。
   * 用が済んだ画面を残さず、時計の画面へ戻す。
   * 会話中なら会話は続ける（アラームを消したいだけで、話を切りたいわけではない）。
   */
  const dismissAlarm = (cancelId?: string) => {
    if (cancelId) timersRef.current?.cancel(cancelId);
    else timersRef.current?.silence();
    setRinging(false);
    setAnswer("");
    setAnswerDone(false);
    setKeepLeft(0);
    setLastFrame(null);
  };

  /**
   * 会話だけ終える。待機は続ける。
   * 手で終えたときは読み返す必要がないので、回答も消して待機画面へ戻す。
   * （無操作での自動切断は、聞き逃したとき用に回答をしばらく残す）
   */
  const endConversation = () => {
    sessionRef.current?.stop();
    sessionRef.current = null;
    setAnswer("");
    setAnswerDone(false);
    setKeepLeft(0);
    setLastFrame(null);
  };

  const restartStandby = async () => {
    setShowSettings(false);
    await shutdown();
    await boot();
  };

  const talking = mode === "会話中";
  const statusText = talking ? PHASE_LABEL[phase] : mode;

  // 待機中で見せるものが無いときは、時計の画面にする。
  // 常設端末なので、何も出ていない画面は画面を遊ばせているのと同じ。
  const ambient = !talking && mode !== "停止中" && mode !== "起動中" && !answer;

  return (
    <main className={`app phase-${talking ? phase : "idle"} ${ambient ? "is-ambient" : ""}`}>
      <header className="bar">
        <div className="orb" aria-hidden="true" />
        <div>
          <div className="status">{statusText}</div>
          {talking && detail && <div className="detail">{detail}</div>}
        </div>
        {/* 時計の画面に居ないときだけ出す。居るときは押す意味がない。 */}
        {!ambient && mode !== "停止中" && (
          <button className="gear home" onClick={goHome}>ホーム</button>
        )}
        <button className="gear" onClick={() => setShowLog((v) => !v)}>
          {showLog ? "ログ×" : "ログ"}
        </button>
        <button className="gear" onClick={() => setShowSettings(true)}>設定</button>
      </header>

      {ambient ? (
        <Ambient
          weather={weather}
          timers={timers}
          ringing={ringing}
          wakeLabel={wake.label}
          tapToStart={mode === "タップ待ち"}
          onSilence={() => dismissAlarm()}
        />
      ) : (
        <>
          <section
            className={`answer ${answerDone && answer ? "tappable" : ""}`}
            ref={answerRef}
            aria-live="polite"
            onClick={answerDone && answer ? goHome : undefined}
          >
            {busy ? (
              <div className="busy">
                <span className="busy-dots" aria-hidden="true">
                  <i /><i /><i />
                </span>
                <span className="busy-label">{busy.label}</span>
                {busySec >= 2 && <span className="busy-sec">{busySec}秒</span>}
                {/* 聞いていないことを明示する。話しかけても届かないため。 */}
                <span className="busy-mic">マイクは止めています</span>
              </div>
            ) : answer ? (
              <>
                <p className={answerDone ? "" : "streaming"}>{answer}</p>
                {answerDone && keepLeft > 0 && (
                  <div className="keep" aria-hidden="true">
                    <i style={{ width: `${(keepLeft / settings.keepSec) * 100}%` }} />
                  </div>
                )}
              </>
            ) : (
              <p className="empty">
                {mode === "停止中" ? "「常設待機を開始」を押してください" : "話しかけてください"}
              </p>
            )}
          </section>

          {(timers.length > 0 || ringing) && (
            <section className={`timers ${ringing ? "ringing" : ""}`}>
              {ringing && (
                <button
                  className="stop-alarm"
                  onClick={() => dismissAlarm()}
                >
                  アラームを止める
                </button>
              )}
              {timers.map((t) => (
                <div key={t.id} className="timer">
                  <span className="timer-label">{t.label}</span>
                  <span className="timer-left">{remaining(t)}</span>
                  <button
                    onClick={() => dismissAlarm(t.id)}
                    aria-label="取り消し"
                  >
                    ×
                  </button>
                </div>
              ))}
            </section>
          )}

          {lastFrame && (
            <section className="shot">
              <div className="shot-head">
                <span>AI に送った画像</span>
                <span>
                  {lastFrame.width}x{lastFrame.height} / {Math.round(lastFrame.bytes / 1024)}KB /{" "}
                  {lastFrame.ms}ms
                </span>
              </div>
              <img src={lastFrame.dataUrl} alt="直前に送信した映像" />
            </section>
          )}

          {/* 読み上げ中はマイクを止めている。声で止められることを知らせる。 */}
          {talking && phase === "speaking" && (
            <p className="speak-hint">
              読み上げ中はマイクを止めています。<b>「ストップ」</b>と言えば止まります
            </p>
          )}

          {talking && (
            <p className="idle">
              無操作あと <b>{idleLeft}</b> 秒で自動切断
              {metrics.model && <span className="model"> / {metrics.model}</span>}
            </p>
          )}
        </>
      )}

      {mode === "停止中" && (
        <button className="action" onClick={boot}>常設待機を開始</button>
      )}
      {mode === "タップ待ち" && !talking && (
        <button className="action" onClick={() => void openConversation()}>話しかける</button>
      )}

      {/* 会話中はいつでも手で止められるようにする。
          待つしかない状態にしないため、ログの表示に関係なく常に出す。 */}
      {talking && (
        <div className="row">
          <button
            className="action danger"
            onClick={() => sessionRef.current?.interrupt()}
            disabled={phase !== "speaking" && phase !== "thinking"}
          >
            止める
          </button>
          <button className="action secondary" onClick={endConversation}>
            会話を終える
          </button>
        </div>
      )}

      {showLog && (
        <>
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

          {(metrics.usage.audioOut > 0 || metrics.usage.textOut > 0) && (
            <p className="tokens">
              音声 入{metrics.usage.audioIn} / 出{metrics.usage.audioOut}
              {" ・ "}テキスト 入{metrics.usage.textIn} / 出{metrics.usage.textOut}
              {metrics.usage.imageIn > 0 && ` ・ 画像 ${metrics.usage.imageIn}`}
              {metrics.usage.audioInCached > 0 && ` ・ キャッシュ ${metrics.usage.audioInCached}`}
            </p>
          )}

          <div className="row">
            <button className="action secondary" onClick={() => void switchCamera()} disabled={talking}>
              カメラ: {facing === "user" ? "内" : "外"}
            </button>
            <button className="action secondary" onClick={() => void shutdown()}>停止</button>
          </div>

          <section className="log" aria-label="ログ">
            {entries.map((e, i) => (
              <div key={i} className={e.kind}>
                <span className="t">{e.time}</span> {e.message}
              </div>
            ))}
          </section>
        </>
      )}

      {showSettings && (
        <SettingsPanel
          spend={spend}
          onResetSpend={() => setSpend(resetSpend())}
          value={settings}
          onChange={applySettings}
          onClose={() => setShowSettings(false)}
          onRestartNeeded={() => void restartStandby()}
        />
      )}

    </main>
  );
}
