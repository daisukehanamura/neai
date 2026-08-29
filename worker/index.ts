import { sessionConfig, type Env } from "./config";

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

  const form = new FormData();
  form.set("sdp", offer);
  form.set("session", JSON.stringify(sessionConfig(env)));

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
  console.log(`セッション確立 ${Date.now() - started}ms / model=${env.REALTIME_MODEL}`);
  return new Response(answer, {
    headers: {
      "content-type": "application/sdp",
      "cache-control": "no-store",
      // クライアントが料金表を引くために使う。秘密ではない。
      "x-neai-model": env.REALTIME_MODEL,
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

/** DEVICE_KEY が設定されているときだけ Bearer 認証を要求する。 */
function authorized(request: Request, env: Env): boolean {
  if (!env.DEVICE_KEY) return true;
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
      if (!authorized(request, env)) return json({ error: "認証が必要です" }, 401);

      if (url.pathname === "/api/session" && request.method === "POST") {
        return createCall(request, env);
      }
      return json({ error: "not found" }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
