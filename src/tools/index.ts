/**
 * AI から呼ばれた機能を実行する。
 *
 * 実行場所は2つに分かれる。
 *   端末内 … 時刻・タイマー・カメラ。実行そのものは外部通信をしないので速い
 *   Worker … 天気。外部APIを叩くものはクライアントから切り離す
 *
 * 注意：ここに来る「呼び出し」自体は OpenAI を通っており課金される。
 * 端末内で持つ利点は実行が無料になることではなく、
 * タイマーのように設定後に接続を維持しなくてよくなること。
 */
import type { Frame } from "../media";
import { describe, remaining, type TimerStore } from "./timer";

export interface ToolResult {
  /** function_call_output として AI に返す値。 */
  output: unknown;
  /** 会話に添付する画像があれば。 */
  imageDataUrl?: string;
}

export interface ToolContext {
  captureFrame: () => Frame | null;
  timers: TimerStore;
  /** 端末で設定した現在地。無ければ Worker の既定地点が使われる。 */
  location: { lat?: number; lon?: number; name?: string };
  deviceKey?: string;
  log: (message: string, kind?: "ok" | "ng" | "warn") => void;
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  switch (name) {
    case "look_at_camera": {
      const frame = ctx.captureFrame();
      if (!frame) {
        return { output: { error: "カメラの映像を取得できませんでした" } };
      }
      ctx.log(
        `撮影 ${frame.width}x${frame.height} / ${Math.round(frame.bytes / 1024)}KB / ${frame.ms}ms`,
        "ok",
      );
      return {
        output: { ok: true, note: "現在のカメラ映像を追加しました" },
        imageDataUrl: frame.dataUrl,
      };
    }

    case "get_current_time": {
      const now = new Date();
      const week = ["日", "月", "火", "水", "木", "金", "土"][now.getDay()];
      return {
        output: {
          日付: `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`,
          曜日: `${week}曜日`,
          時刻: `${now.getHours()}時${now.getMinutes()}分`,
        },
      };
    }

    case "get_weather": {
      const q = new URLSearchParams();
      if (ctx.location.lat != null && ctx.location.lon != null) {
        q.set("lat", String(ctx.location.lat));
        q.set("lon", String(ctx.location.lon));
        if (ctx.location.name) q.set("name", ctx.location.name);
      }
      const res = await fetch(`/api/tools/weather?${q}`, {
        headers: ctx.deviceKey ? { authorization: `Bearer ${ctx.deviceKey}` } : {},
      });
      if (!res.ok) return { output: { error: `天気の取得に失敗しました (${res.status})` } };
      const w = (await res.json()) as {
        場所: string;
        現在?: unknown;
        予報: unknown[];
      };

      // 読み上げるので必要な日だけ渡す。7日分をそのまま渡すと長く喋りすぎる。
      const day = String(args.day ?? "today");
      if (day === "week") {
        return { output: { 場所: w.場所, 週間予報: w.予報 } };
      }
      const index = day === "tomorrow" ? 1 : 0;
      return {
        output: {
          場所: w.場所,
          ...(index === 0 ? { 現在: w.現在 } : {}),
          予報: w.予報[index],
        },
      };
    }

    case "set_timer": {
      const seconds = Math.round(Number(args.seconds));
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return { output: { error: "時間の指定が正しくありません" } };
      }
      if (seconds > 24 * 3600) {
        return { output: { error: "24時間より長いタイマーは設定できません" } };
      }
      const timer = ctx.timers.add(seconds, args.label as string | undefined);
      ctx.log(`タイマー設定 ${timer.label}`, "ok");
      return { output: { ok: true, 設定した長さ: describe(seconds), 名前: timer.label } };
    }

    case "list_timers": {
      const list = ctx.timers.list();
      if (!list.length) return { output: { タイマー: "動いているものはありません" } };
      return {
        output: {
          タイマー: list.map((t) => ({ 名前: t.label, 残り: remaining(t) })),
        },
      };
    }

    case "cancel_timer": {
      const removed = ctx.timers.cancel(args.id as string | undefined);
      ctx.timers.silence();
      ctx.log(`タイマー取消 ${removed.length}件`, "warn");
      return {
        output: removed.length
          ? { ok: true, 取り消した数: removed.length }
          : { ok: true, note: "動いているタイマーはありませんでした。アラームは止めました" },
      };
    }

    default:
      return { output: { error: `未知の機能です: ${name}` } };
  }
}
