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

export interface Weather {
  天気: string;
  コード?: number;
  最高気温?: number;
  最低気温?: number;
  降水確率?: number;
  現在の気温?: number;
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

  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");

  return (
    <div className="ambient">
      {ringing ? (
        <button className="alarm-full" onClick={onSilence}>
          <span className="alarm-title">タイマー終了</span>
          <span className="alarm-sub">タップで止める</span>
        </button>
      ) : (
        <>
          <div className="clock">
            <span className="hh">{hh}</span>
            <span className="colon">:</span>
            <span className="mm">{mm}</span>
          </div>
          <div className="date">
            {now.getMonth() + 1}月{now.getDate()}日（{WEEK[now.getDay()]}）
          </div>

          {weather && (
            <div className="weather">
              <span className="wx-icon">{icon(weather.コード)}</span>
              <span className="wx-temp">
                {weather.現在の気温 != null ? `${Math.round(weather.現在の気温)}°` : ""}
              </span>
              <span className="wx-note">
                {weather.天気}
                {weather.最低気温 != null && weather.最高気温 != null &&
                  ` ${Math.round(weather.最低気温)}/${Math.round(weather.最高気温)}°`}
                {weather.降水確率 != null && ` 降水${weather.降水確率}%`}
              </span>
            </div>
          )}
        </>
      )}

      {timers.length > 0 && !ringing && (
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
