/**
 * タイマー。設定した後は LLM もネットワークも通らない。
 * （設定する会話そのものは OpenAI を通り課金される。docs/cost.md を参照）
 *
 * 終了時刻を「絶対時刻」で保存するのが肝。相対秒数だと再読み込みで狂う。
 * これなら復帰時に残り時間を計算し直せる。
 *
 * 長時間のアラーム（翌朝など）は画面が生きている前提になるため、
 * 本当に落ちてほしくない用途には Durable Objects の Alarms が要る。
 * まずは数分〜数十分のキッチンタイマーを対象にする。
 */

export interface Timer {
  id: string;
  label: string;
  /** 終了時刻（epoch ms）。相対値で持たないこと。 */
  endsAt: number;
  seconds: number;
}

const KEY = "neai.timers.v1";

/** アラームを鳴らし続ける時間。止め忘れても延々鳴らない。 */
const ALARM_MS = 30000;

export class TimerStore {
  private timers: Timer[] = [];
  private ctx: AudioContext | null = null;
  private alarmStop: (() => void) | null = null;

  constructor(
    private onChange: (timers: Timer[]) => void,
    private onFired: (timer: Timer) => void,
  ) {
    this.timers = this.read().filter((t) => t.endsAt > Date.now());
    this.write();
    setInterval(() => this.tick(), 500);
  }

  private read(): Timer[] {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? "[]") as Timer[];
    } catch {
      return [];
    }
  }

  private write(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.timers));
    } catch {
      /* 保存できなくても動作は続ける */
    }
    this.onChange([...this.timers]);
  }

  private tick(): void {
    const now = Date.now();
    const done = this.timers.filter((t) => t.endsAt <= now);
    if (!done.length) return;
    this.timers = this.timers.filter((t) => t.endsAt > now);
    this.write();
    for (const t of done) {
      this.onFired(t);
      this.ring();
    }
  }

  add(seconds: number, label?: string): Timer {
    const timer: Timer = {
      id: Math.random().toString(36).slice(2, 9),
      label: label || describe(seconds),
      endsAt: Date.now() + seconds * 1000,
      seconds,
    };
    this.timers = [...this.timers, timer].sort((a, b) => a.endsAt - b.endsAt);
    this.write();
    return timer;
  }

  cancel(id?: string): Timer[] {
    const removed = id ? this.timers.filter((t) => t.id === id) : [...this.timers];
    this.timers = id ? this.timers.filter((t) => t.id !== id) : [];
    this.write();
    this.silence();
    return removed;
  }

  list(): Timer[] {
    return [...this.timers];
  }

  /** 鳴っているアラームを止める。 */
  silence(): void {
    this.alarmStop?.();
    this.alarmStop = null;
  }

  get ringing(): boolean {
    return this.alarmStop !== null;
  }

  /**
   * アラーム音。音源ファイルを持たずに合成する。
   * iOS のマナースイッチで消音される可能性があるので、実機で要確認。
   */
  private ring(): void {
    this.silence();
    if (!this.ctx) this.ctx = new AudioContext();
    const ctx = this.ctx;
    void ctx.resume();

    let stopped = false;
    let count = 0;
    const beep = () => {
      if (stopped) return;
      const t = ctx.currentTime;
      // 高い音と低い音を交互に。単調な音より気づきやすい。
      [880, 660].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        osc.type = "square";
        const at = t + i * 0.22;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(0.35, at + 0.01);
        gain.gain.linearRampToValueAtTime(0, at + 0.2);
        osc.connect(gain).connect(ctx.destination);
        osc.start(at);
        osc.stop(at + 0.22);
      });
      count++;
      if (count * 900 < ALARM_MS) setTimeout(beep, 900);
      else stopped = true;
    };
    beep();
    this.alarmStop = () => {
      stopped = true;
    };
  }
}

/** 秒数を日本語にする。読み上げにも画面表示にも使う。 */
export function describe(seconds: number): string {
  if (seconds % 3600 === 0 && seconds >= 3600) return `${seconds / 3600}時間`;
  if (seconds % 60 === 0) return `${seconds / 60}分`;
  if (seconds < 60) return `${seconds}秒`;
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}

/** 残り時間を mm:ss で返す。 */
export function remaining(timer: Timer): string {
  const left = Math.max(0, Math.ceil((timer.endsAt - Date.now()) / 1000));
  const h = Math.floor(left / 3600);
  const m = Math.floor(left / 60) % 60;
  const s = left % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
