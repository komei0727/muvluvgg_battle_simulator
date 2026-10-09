export interface SplitDisplayName {
  readonly epithet?: string;
  readonly name: string;
}

const EPITHET_OPEN = "【";
const EPITHET_CLOSE = "】";

// 01_UI要求・画面設計.md §9: 画像フォールバックを【二つ名】と名前の2段で出す。
// 二つ名・名前のどちらかが空になる分け方は表示が崩れるため、全体を名前として扱う。
export function splitDisplayName(displayName: string): SplitDisplayName {
  const trimmed = displayName.trim();
  if (!trimmed.startsWith(EPITHET_OPEN)) {
    return { name: trimmed };
  }
  const closeIndex = trimmed.indexOf(EPITHET_CLOSE, EPITHET_OPEN.length);
  if (closeIndex < 0) {
    return { name: trimmed };
  }
  const inner = trimmed.slice(EPITHET_OPEN.length, closeIndex).trim();
  const name = trimmed.slice(closeIndex + EPITHET_CLOSE.length).trim();
  if (inner.length === 0 || name.length === 0) {
    return { name: trimmed };
  }
  return { epithet: trimmed.slice(0, closeIndex + EPITHET_CLOSE.length), name };
}
