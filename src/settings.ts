/**
 * 端末ごとの設定。localStorage に保存し、画面から変更できる。
 *
 * 常設端末なので、設定を変えるたびに .env を編集して再起動、では使い物にならない。
 * 環境変数は「初期値」としてのみ使い、実際の値はここが持つ。
 */

export interface WakePreset {
  id: string;
  label: string;
  /** Vosk の認識対象。| 区切り。語彙表に存在する語しか指定できない。 */
  grammar: string;
  /** 認識結果にこれが含まれたら起動とみなす。 */
  match: string;
  /** なぜこの語が良い/悪いのか。画面に出して選ぶ手がかりにする。 */
  note: string;
}

/**
 * ウェイクワードの候補。すべて日本語モデルの語彙表に存在することを確認済み。
 * 認識しやすさは「長い・子音が立っている・日常会話に出てこない」で決まる。
 */
export const WAKE_PRESETS: WakePreset[] = [
  {
    id: "kurapika",
    label: "ねえクラピカ",
    grammar: "ねえ クラピカ|クラピカ",
    match: "クラピカ",
    note: "破裂音が3つ。日常語と衝突しない",
  },
  {
    id: "hxh",
    label: "ハンターハンター",
    grammar: "ハンター ハンター|ハンター",
    match: "ハンター",
    note: "8モーラと長く、判断材料が多い",
  },
  {
    id: "ryodan",
    label: "幻影旅団",
    grammar: "幻影 旅団|旅団",
    match: "旅団",
    note: "長く、まず言わない語",
  },
  {
    id: "chimera",
    label: "キメラアント",
    grammar: "キメラ アント|キメラ",
    match: "キメラ",
    note: "6モーラ。子音が明瞭",
  },
  {
    id: "jarvis",
    label: "ねえジャービス",
    grammar: "ねえ ジャービス|ジャービス",
    match: "ジャービス",
    note: "濁音と破裂音が立つ",
  },
  {
    id: "ai",
    label: "ねえAI",
    grammar: "ねえ エーアイ|ねー エーアイ|エーアイ",
    match: "エーアイ",
    note: "母音中心で弱い。テレビ等で誤検出しやすい",
  },
];

export const MODELS = [
  { id: "gpt-realtime-2.1", label: "通常", note: "賢いが3倍高い" },
  { id: "gpt-realtime-2.1-mini", label: "mini", note: "約3分の1の料金" },
] as const;

export interface Settings {
  wakePreset: string;
  /** プリセットが custom のときだけ使う。 */
  customGrammar: string;
  customMatch: string;
  customLabel: string;

  /** Vosk へ渡す前の増幅率。届く最小値にするのが良い。 */
  gain: number;
  /** 小さい音だけ持ち上げる。ゲインと違い近くで喋っても割れない。 */
  compressor: boolean;
  /** 空調や冷蔵庫の低音を切る。 */
  highpass: boolean;
  /** 静かなときは認識に回さない。誤検出とCPUが減る。 */
  gate: boolean;
  gateDb: number;

  /** 無操作で自動切断するまでの秒数。接続中は課金が続くため。 */
  idleSec: number;
  /** 回答を画面に残す秒数。 */
  keepSec: number;
  model: string;
  /** 天気に使う地点。未設定なら Worker の既定地点になる。 */
  location: { lat?: number; lon?: number; name?: string };
}

const KEY = "neai.settings.v1";

export const DEFAULTS: Settings = {
  wakePreset: "kurapika",
  customGrammar: "",
  customMatch: "",
  customLabel: "",
  gain: 6,
  compressor: true,
  highpass: true,
  gate: false,
  gateDb: -55,
  idleSec: 60,
  keepSec: 90,
  model: "gpt-realtime-2.1",
  location: {},
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    // 項目が増えても壊れないよう、既定値に上書きする形で読む。
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 保存できなくても動作は続ける */
  }
}

/** 設定から、検出器に渡す形へ変換する。 */
export function wakeWordOf(s: Settings): { grammar: string[]; match: string[]; label: string } {
  const preset = WAKE_PRESETS.find((p) => p.id === s.wakePreset);
  const grammar = preset ? preset.grammar : s.customGrammar;
  const match = preset ? preset.match : s.customMatch;
  const label = preset ? preset.label : s.customLabel || "ウェイクワード";
  return {
    // [unk] が無いと無関係な音まで最も近い語句に強制的に当てはめてしまう。
    grammar: grammar.split("|").map((g) => g.trim()).filter(Boolean).concat("[unk]"),
    match: match.split(",").map((m) => m.trim()).filter(Boolean),
    label,
  };
}
