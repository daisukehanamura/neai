import { sessionConfig, type Env } from "./config";
import { getWeather } from "./tools/weather";
import { searchWeb } from "./tools/search";

/** 端末から指定できるモデル。ここに無い値は無視して既定に落とす。 */
const ALLOWED_MODELS = ["gpt-realtime-2.1", "gpt-realtime-2.1-mini"];

/**
 * ブラウザから受け取った SDP offer を、セッション設定と一緒に OpenAI へ中継する。
 * この方式（Unified Interface）なら、APIキーもツール定義もクライアントへ渡らない。
 * 音声そのものはブラウザと OpenAI が WebRTC で直結するため、ここは通らない。
 */
async function createCall(request: Request, env: Env): Promise<Response> {
  const offer = await request.text();
  if (!offer.startsWith("v=")) {
    return json({ error: "SDP offer が不正です。" }, 400);
  }

  if (!env.OPENAI_API_KEY) {
    return json({ error: "OPENAI_API_KEY が設定されていません。.dev.vars を確認してください。" }, 500);
  }

  // 使うモデルは端末側で選べるが、値をそのまま信用はしない。
  const requested = request.headers.get("x-neai-model") ?? "";
  const model = ALLOWED_MODELS.includes(requested) ? requested : env.REALTIME_MODEL;

  const form = new FormData();
  form.set("sdp", offer);
  form.set("session", JSON.stringify(sessionConfig(env, model)));

  const started = Date.now();
  const upstream = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
  });

  if (!upstream.ok) {
    const detail = await upstream.text();
    console.error("OpenAI からエラー", upstream.status, detail);
    return json(
      { error: explain(upstream.status, detail), status: upstream.status, detail },
      502,
    );
  }

  const answer = await upstream.text();
  console.log(`セッション確立 ${Date.now() - started}ms / model=${model}`);
  return new Response(answer, {
    headers: {
      "content-type": "application/sdp",
      "cache-control": "no-store",
      // クライアントが料金表を引くために使う。秘密ではない。
      "x-neai-model": model,
    },
  });
}

/** OpenAI のエラーを、原因と対処が分かる日本語にする。 */
function explain(status: number, detail: string): string {
  if (detail.includes("insufficient_quota")) {
    return "OpenAI の残高が不足しています。Billing でクレジットを購入してください（API は前払い式です）。";
  }
  if (status === 401) {
    return "APIキーが無効です。.dev.vars の OPENAI_API_KEY を確認してください。";
  }
  if (detail.includes("model_not_found") || detail.includes("does not exist")) {
    return "モデル名が違います。wrangler.jsonc の REALTIME_MODEL を確認してください。";
  }
  if (status === 429) {
    return "レート制限に達しました。しばらく待つか、利用ティアを確認してください。";
  }
  return "OpenAI がセッションを拒否しました。";
}

/**
 * 手元からの接続かどうか。localhost と RFC1918 の私設アドレスを手元とみなす。
 * 開発用の HTTPS プロキシは LAN の IP で待ち受けるため、そこも含める。
 */
function isLocal(url: URL): boolean {
  const h = url.hostname;
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;

  // ホスト名の全体が IPv4 であることを確かめる。前方一致だけで判定すると
  // 172.20.10.3.example.com のような名前を手元とみなしてしまう。
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((n) => Number(n) > 255)) return false;

  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  return a === 172 && b >= 16 && b <= 31;
}

/**
 * 認証。
 *
 * DEVICE_KEY があれば Bearer を検証する。
 * 無い場合は手元からの接続だけを許し、**公開環境では閉じる**。
 * 鍵を設定し忘れたまま公開しても、誰でも使える状態にはならない。
 */
function authorized(request: Request, env: Env, url: URL): boolean {
  if (!env.DEVICE_KEY) return isLocal(url);
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  return timingSafeEqual(given, env.DEVICE_KEY);
}

/** 長さと内容の両方を、比較時間が入力に依存しない形で確認する。 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      if (!authorized(request, env, url)) {
        return json(
          {
            error: env.DEVICE_KEY
              ? "デバイスキーが必要です。初回は #k=キー 付きの URL で開いてください。"
              : "DEVICE_KEY が未設定です。npx wrangler secret put DEVICE_KEY で設定してください。",
          },
          401,
        );
      }

      if (url.pathname === "/api/session" && request.method === "POST") {
        return createCall(request, env);
      }

      // 外部APIを叩くツールはここで実行する。クライアントには鍵も宛先も持たせない。
      if (url.pathname === "/api/tools/weather") {
        const q = url.searchParams;
        const place = {
          latitude: Number(env.HOME_LAT ?? 35.73413),
          longitude: Number(env.HOME_LON ?? 139.9065),
          name: env.HOME_NAME ?? "市川市",
        };
        // 端末側で現在地を設定していれば、そちらを優先する。
        if (q.get("lat") && q.get("lon")) {
          place.latitude = Number(q.get("lat"));
          place.longitude = Number(q.get("lon"));
          place.name = q.get("name") || "現在地";
        }
        try {
          return json(await getWeather(place));
        } catch (err) {
          return json({ error: `天気の取得に失敗しました: ${(err as Error).message}` });
        }
      }

      if (url.pathname === "/api/tools/search") {
        const q = url.searchParams.get("q") ?? "";
        if (!q.trim()) return json({ error: "検索する内容がありません" }, 400);
        if (!env.OPENAI_API_KEY) return json({ error: "OPENAI_API_KEY が未設定です" }, 500);
        try {
          return json(await searchWeb(q, env.OPENAI_API_KEY));
        } catch (err) {
          return json({ error: `検索に失敗しました: ${(err as Error).message}` });
        }
      }

      return json({ error: "not found" }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
