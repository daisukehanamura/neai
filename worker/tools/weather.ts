/**
 * 天気。Open-Meteo を使う。APIキー不要・非商用は無料。
 * https://open-meteo.com/en/docs
 *
 * Worker 側で実行するのは、外部APIの差し替えや将来のキー管理を
 * クライアントから切り離しておくため。
 */

/** WMO の天気コード。音声で読み上げるので短い日本語にする。 */
const WEATHER: Record<number, string> = {
  0: "快晴", 1: "晴れ", 2: "晴れ時々曇り", 3: "曇り",
  45: "霧", 48: "霧",
  51: "小雨", 53: "小雨", 55: "雨",
  56: "冷たい小雨", 57: "冷たい雨",
  61: "小雨", 63: "雨", 65: "強い雨",
  66: "みぞれ", 67: "強いみぞれ",
  71: "小雪", 73: "雪", 75: "大雪", 77: "雪",
  80: "にわか雨", 81: "にわか雨", 82: "激しいにわか雨",
  85: "にわか雪", 86: "強いにわか雪",
  95: "雷雨", 96: "雹を伴う雷雨", 99: "激しい雷雨",
};

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

export interface Place {
  latitude: number;
  longitude: number;
  name: string;
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

export interface WeatherResult {
  場所: string;
  現在?: { 気温: number | null; 天気: string; コード?: number };
  予報: DayForecast[];
}

/** 7日分まとめて返す。呼び出し側が必要な日数に切る。 */
export async function getWeather(place: Place): Promise<WeatherResult | { error: string }> {
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${place.latitude}&longitude=${place.longitude}` +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
    "&current=temperature_2m,weather_code" +
    "&timezone=Asia%2FTokyo&forecast_days=7";

  const res = await fetch(url);
  if (!res.ok) return { error: `天気の取得に失敗しました (${res.status})` };

  const data = (await res.json()) as {
    current?: { temperature_2m?: number; weather_code?: number };
    daily?: {
      time?: string[];
      weather_code?: number[];
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
      precipitation_probability_max?: number[];
    };
  };

  const d = data.daily;
  const days: DayForecast[] = (d?.time ?? []).map((iso, i) => {
    // Worker は UTC で動くため、getDate() などのローカル系メソッドを使うと
    // 日本時間の日付が1日ずれる。UTC 正午として解釈し UTC 系で読み出す。
    const date = new Date(`${iso}T12:00:00Z`);
    const code = d?.weather_code?.[i];
    return {
      日付: `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`,
      曜日: WEEK[date.getUTCDay()],
      天気: code !== undefined ? (WEATHER[code] ?? "不明") : "不明",
      コード: code,
      最高: d?.temperature_2m_max?.[i] ?? null,
      最低: d?.temperature_2m_min?.[i] ?? null,
      降水確率: d?.precipitation_probability_max?.[i] ?? null,
    };
  });

  return {
    場所: place.name,
    現在: {
      気温: data.current?.temperature_2m ?? null,
      天気: data.current?.weather_code !== undefined
        ? (WEATHER[data.current.weather_code] ?? "不明")
        : "不明",
      コード: data.current?.weather_code,
    },
    予報: days,
  };
}
