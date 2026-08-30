import { useEffect, useState } from "react";
import { remaining, type Timer } from "./tools/timer";

/** WMO の天気コードから絵文字へ。数字のままでは画面に出せないため。 */
function icon(code?: number): string {
  if (code === undefined) return "";
  if (code === 0) return "☀️";
  if (code <= 2) return "🌤️";
  if (code === 3) return "☁️";
  if (code <= 48) return "🌫️";
  if (code <= 57) return "🌦️";
  if (code <= 67) return "🌧️";
  if (code <= 77) return "❄️";
  if (code <= 82) return "🌧️";
  if (code <= 86) return "🌨️";
  return "⛈️";
}

export interface DayForecast {
  日付: string;
  曜日: string;
  天気: string;
  コード?: number;
  最高: number | null;
  最低: number | null;
  降水確率: number | null;
}

export interface Weather {
  場所: string;
  現在?: { 気温: number | null; 天気: string; コード?: number };
  予報: DayForecast[];
}

interface Props {
  weather: Weather | null;
  timers: Timer[];
  ringing: boolean;
  wakeLabel: string;
  /** ウェイクワードが使えないときはタップで始める案内を出す。 */
  tapToStart: boolean;
  onSilence: () => void;
}

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

export default function Ambient({
  weather, timers, ringing, wakeLabel, tapToStart, onSilence,
}: Props) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    // 秒は出さないので、分が変わる頃に更新すれば足りる。
    const id = setInterval(() => setNow(new Date()), 10000);
    return () => clearInterval(id);
  }, []);

  if (ringing) {
    return (
      <div className="ambient">
        <button className="alarm-full" onClick={onSilence}>
          <span className="alarm-title">タイマー終了</span>
          <span className="alarm-sub">タップで止める</span>
        </button>
      </div>
    );
  }

  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const today = weather?.予報?.[0];

  return (
    <div className="ambient">
      <div className="clock">
        <span className="hh">{hh}</span>
        <span className="colon">:</span>
        <span className="mm">{mm}</span>
      </div>
      <div className="date">
        {now.getMonth() + 1}月{now.getDate()}日（{WEEK[now.getDay()]}）
      </div>

      {/* 当日の最高/最低が分かれば足りる。
          現在の気温は取得が1日3回なので古い値になり、かえって誤解を生む。 */}
      {today && (
        <div className="weather">
          <span className="wx-icon">{icon(today.コード)}</span>
          <span className="wx-range">
            <b>{today.最高 != null ? Math.round(today.最高) : "—"}°</b>
            <span className="wx-slash">/</span>
            <span className="wx-low">{today.最低 != null ? Math.round(today.最低) : "—"}°</span>
          </span>
          <span className="wx-note">
            {weather?.場所} {today.天気}
            {today.降水確率 != null && ` 降水${today.降水確率}%`}
          </span>
        </div>
      )}

      {/* 週間予報。7日を並べて「いつ降るか」を形で見せる。
          気温は数字、降水確率は棒の高さ。色分けはしない（離れて見ると効かないため）。 */}
      {weather && weather.予報.length > 1 && (
        <div className="week" role="table" aria-label="週間予報">
          {weather.予報.map((d, i) => (
            <div key={d.日付} className={`day ${i === 0 ? "today" : ""}`}>
              <span className="dow">{i === 0 ? "今日" : d.曜日}</span>
              <span className="wicon">{icon(d.コード)}</span>
              <span className="hi">{d.最高 != null ? Math.round(d.最高) : "—"}</span>
              <span className="lo">{d.最低 != null ? Math.round(d.最低) : "—"}</span>
              <span className="rainbar" title={`降水確率 ${d.降水確率 ?? 0}%`}>
                <i style={{ height: `${Math.max(2, (d.降水確率 ?? 0) * 0.28)}px` }} />
              </span>
              {/* 数字は全部には付けない。傘が要る日だけ出す。 */}
              <span className="rainpct">
                {(d.降水確率 ?? 0) >= 50 ? `${d.降水確率}%` : ""}
              </span>
            </div>
          ))}
        </div>
      )}

      {timers.length > 0 && (
        <div className="ambient-timers">
          {timers.map((t) => (
            <div key={t.id} className="ambient-timer">
              <span>{t.label}</span>
              <b>{remaining(t)}</b>
            </div>
          ))}
        </div>
      )}

      <div className="wake-hint">
        {tapToStart ? "画面をタップして話しかける" : `「${wakeLabel}」と話しかけてください`}
      </div>
    </div>
  );
}
