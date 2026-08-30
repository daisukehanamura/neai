/**
 * 使った額の記録。
 *
 * OpenAI には残高を取る API が無く（2026年時点で未提供）、
 * 使用額の API は組織全体を読める別のキーを要求する。
 * 公開している端末にその権限を置きたくないので、自前で積み上げる。
 *
 * 元にするのは推定値ではなく、response.done が返す実測トークン数。
 * この端末が使った分しか数えないが、キーが専用なら実質それが全部になる。
 */

const KEY = "neai.spend.v1";

export interface Spend {
  /** 記録している日と月。日付が変わったら自動で繰り越す。 */
  day: string;
  month: string;
  todayUsd: number;
  monthUsd: number;
  totalUsd: number;
  /** 最後に記録した時刻。 */
  updatedAt: number;
}

const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => new Date().toISOString().slice(0, 7);

const empty = (): Spend => ({
  day: today(),
  month: thisMonth(),
  todayUsd: 0,
  monthUsd: 0,
  totalUsd: 0,
  updatedAt: 0,
});

export function readSpend(): Spend {
  let s: Spend;
  try {
    s = { ...empty(), ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Spend>) };
  } catch {
    return empty();
  }
  // 日や月が変わっていたら、その分だけ 0 に戻す。累計は残す。
  if (s.day !== today()) {
    s.day = today();
    s.todayUsd = 0;
  }
  if (s.month !== thisMonth()) {
    s.month = thisMonth();
    s.monthUsd = 0;
  }
  return s;
}

/** 使った額を足す。負の値や異常値は無視する。 */
export function addSpend(usd: number): Spend {
  if (!Number.isFinite(usd) || usd <= 0) return readSpend();
  const s = readSpend();
  s.todayUsd += usd;
  s.monthUsd += usd;
  s.totalUsd += usd;
  s.updatedAt = Date.now();
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 保存できなくても表示は続く */
  }
  return s;
}

export function resetSpend(): Spend {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
  return empty();
}
