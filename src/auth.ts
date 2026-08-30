/**
 * デバイスキー。公開した端末を自分だけが使える状態にするためのもの。
 *
 * Worker 側は DEVICE_KEY が設定されているときだけ検証する。
 * つまり**ローカル開発では何も設定しなくてよく、今までどおり動く。**
 * 本番でだけ有効になる。
 *
 * 受け渡しは初回に URL の断片で行い、以後は localStorage から読む。
 * 常設端末なので、期限切れで再入力を求められる方式は使えない。
 */

const KEY = "neai_device_key";

/**
 * URL に #k=... が付いていれば取り込む。
 * 取り込んだらアドレスから消す。履歴やスクリーンショットに残さないため。
 */
export function pickUpKeyFromUrl(): boolean {
  const hash = location.hash;
  const m = /[#&]k=([^&]+)/.exec(hash);
  if (!m) return false;
  try {
    localStorage.setItem(KEY, decodeURIComponent(m[1]));
  } catch {
    return false;
  }
  history.replaceState(null, "", location.pathname + location.search);
  return true;
}

export function getDeviceKey(): string | undefined {
  try {
    return localStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function setDeviceKey(key: string): void {
  try {
    if (key) localStorage.setItem(KEY, key);
    else localStorage.removeItem(KEY);
  } catch {
    /* 保存できなければ次回また入力してもらう */
  }
}

export function hasDeviceKey(): boolean {
  return !!getDeviceKey();
}

/** 画面に出すための伏せ字。全部は出さない。 */
export function maskedKey(): string {
  const k = getDeviceKey();
  if (!k) return "未設定";
  return k.length <= 8 ? "設定済み" : `${k.slice(0, 4)}…${k.slice(-4)}（${k.length}文字）`;
}

/**
 * /api/* を叩くときは必ずこれを使う。
 * 鍵の付け忘れを防ぐため、個別に fetch を書かない。
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const key = getDeviceKey();
  return fetch(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
  });
}
