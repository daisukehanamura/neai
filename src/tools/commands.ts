/**
 * ローカルコマンド層。
 *
 * Vosk はウェイクワードのために常時動いている全文認識器なので、
 * その結果をそのままコマンド照合に使える。**追加コストはゼロ。**
 *
 * ここで処理できた発話は OpenAI に一切送らないため、課金が発生しない。
 * 返事も端末内の音声合成で返す。
 *
 * 対象は「言い回しが決まっていて、AI に考えさせる必要がないもの」だけ。
 * 曖昧なものは AI に任せる（照合できなければ何もしない）。
 */

/** 認識結果に出てくる数の表記。文法に入れた語だけを対象にする。 */
const NUMBERS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  十五: 15, 二十: 20, 二十五: 25, 三十: 30, 三十五: 35, 四十: 40,
  四十五: 45, 五十: 50,
  // 「三分」のように一語で出てくる場合もある
  一分: 1, 二分: 2, 三分: 3, 四分: 4, 五分: 5, 六分: 6, 七分: 7,
  八分: 8, 九分: 9, 十分: 10,
};

const NUMBER_WORDS = Object.keys(NUMBERS).sort((a, b) => b.length - a.length);

/**
 * Vosk に渡す認識対象。
 * **語彙表に存在する語しか書けない**（2026-08-30 に確認済みの語だけを使っている）。
 * 言える組み合わせをここに列挙した分だけが端末内で処理できる。
 */
export function commandGrammar(): string[] {
  const minutes = [
    "一", "二", "三", "四", "五", "六", "七", "八", "九", "十",
    "十五", "二十", "二十五", "三十", "三十五", "四十", "四十五", "五十",
  ];
  const seconds = ["十", "十五", "二十", "三十", "四十", "四十五", "五十"];
  const hours = ["一", "二", "三"];

  const phrases: string[] = [];
  for (const n of minutes) {
    phrases.push(`タイマー ${n} 分`);
    phrases.push(`${n} 分 タイマー`);
  }
  for (const n of seconds) phrases.push(`タイマー ${n} 秒`);
  for (const n of hours) phrases.push(`タイマー ${n} 時間`);

  phrases.push("タイマー 止めて", "タイマー 消して", "アラーム 止めて");
  phrases.push("止めて", "今 何時", "あと 何分");
  return phrases;
}

export interface MatchedCommand {
  /** 既存の runTool にそのまま渡す。実行の中身を二重に持たない。 */
  tool: string;
  args: Record<string, unknown>;
  /** 端末内の音声合成で読み上げる返事。 */
  speech: string;
}

export interface CommandContext {
  /** アラームが鳴っているか。裸の「止めて」はこのときだけ受け付ける。 */
  ringing: boolean;
  /** 動いているタイマーの残り時間の文字列。 */
  timers: { label: string; left: string }[];
}

/**
 * 認識結果からコマンドを取り出す。該当しなければ null。
 *
 * 判定はすべて前後一致にしてある。部分一致だと、普通の会話の中の
 * 「十分です」「三時間かかる」「止めて」を拾って誤動作するため。
 * 迷ったら何もしない側に倒し、曖昧なものは AI に任せる。
 */
export function matchCommand(text: string, ctx: CommandContext): MatchedCommand | null {
  const t = text.replace(/\s+/g, "");

  // アラームを止める。裸の「止めて」は鳴っているときだけ。
  // 会話の中の「止めて」で誤ってタイマーを消さないための歯止め。
  if (/^(タイマー|アラーム)(止めて|消して)$/.test(t) || (ctx.ringing && /^止めて$/.test(t))) {
    return { tool: "cancel_timer", args: {}, speech: ctx.ringing ? "止めました" : "タイマーを取り消しました" };
  }

  // タイマーの設定。「タイマー」という語を必ず要求する。
  // 数と単位だけで判定すると「十分です」「三時間かかる」のような
  // 普通の会話で誤ってタイマーが入る。
  if (/^タイマー[一二三四五六七八九十]+(分|秒|時間)$|^[一二三四五六七八九十]+分タイマー$/.test(t)) {
    const seconds = parseDuration(t);
    if (seconds) {
      return {
        tool: "set_timer",
        args: { seconds },
        speech: `${describeShort(seconds)}ですね`,
      };
    }
  }

  // 残り時間。前後に余計な語が付いた発話は拾わない。
  if (/^あと何分$|^タイマー(あと何分|残り)$/.test(t)) {
    if (!ctx.timers.length) {
      return { tool: "noop", args: {}, speech: "動いているタイマーはありません" };
    }
    const said = ctx.timers.map((x) => `${x.label}が残り${x.left}`).join("、");
    return { tool: "noop", args: {}, speech: said };
  }

  // 時刻
  if (/^今何時$/.test(t)) {
    const now = new Date();
    return {
      tool: "noop",
      args: {},
      speech: `${now.getHours()}時${now.getMinutes()}分です`,
    };
  }

  return null;
}

/** 「タイマー三分」から秒数を取り出す。 */
function parseDuration(t: string): number | null {
  const unit = /時間/.test(t) ? 3600 : /秒/.test(t) ? 1 : /分/.test(t) ? 60 : 0;
  if (!unit) return null;
  for (const word of NUMBER_WORDS) {
    if (t.includes(word)) {
      const n = NUMBERS[word];
      // 「三分」のような一語表記は既に分を含むので単位を掛けない
      const seconds = word.endsWith("分") ? n * 60 : n * unit;
      return seconds > 0 && seconds <= 24 * 3600 ? seconds : null;
    }
  }
  return null;
}

function describeShort(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}時間`;
  if (seconds % 60 === 0) return `${seconds / 60}分`;
  return `${seconds}秒`;
}

/**
 * 端末内の音声合成で返事をする。iOS には日本語の音声が入っているため無料。
 * 使えない場合は画面表示だけで済ませる。
 */
export function speak(text: string): boolean {
  try {
    if (!("speechSynthesis" in window)) return false;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP";
    u.rate = 1.05;
    speechSynthesis.speak(u);
    return true;
  } catch {
    return false;
  }
}
