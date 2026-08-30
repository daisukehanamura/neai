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

export interface WeatherArgs {
  /** "today" | "tomorrow"。省略時は today。 */
  day?: string;
  latitude?: number;
  longitude?: number;
}

export async function getWeather(
  args: WeatherArgs,
  fallback: { latitude: number; longitude: number; name: string },
): Promise<unknown> {
  const lat = args.latitude ?? fallback.latitude;
  const lon = args.longitude ?? fallback.longitude;
  const index = args.day === "tomorrow" ? 1 : 0;

  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lat}&longitude=${lon}` +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
    "&current=temperature_2m,weather_code" +
    "&timezone=Asia%2FTokyo&forecast_days=2";

  const res = await fetch(url);
  if (!res.ok) {
    return { error: `天気の取得に失敗しました (${res.status})` };
  }

  const data = (await res.json()) as {
    current?: { temperature_2m?: number; weather_code?: number };
    daily?: {
      weather_code?: number[];
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
      precipitation_probability_max?: number[];
    };
  };

  const d = data.daily;
  const code = d?.weather_code?.[index];

  return {
    場所: fallback.name,
    いつ: index === 1 ? "明日" : "今日",
    天気: code !== undefined ? (WEATHER[code] ?? "不明") : "不明",
    最高気温: d?.temperature_2m_max?.[index],
    最低気温: d?.temperature_2m_min?.[index],
    降水確率: d?.precipitation_probability_max?.[index],
    // 「今」を聞かれたときのために現在値も渡す。
    現在の気温: index === 0 ? data.current?.temperature_2m : undefined,
  };
}
