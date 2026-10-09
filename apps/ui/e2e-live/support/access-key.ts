import type { Page } from "@playwright/test";

// 本番APIはアクセスキーを要求する（10_API設計.md「認証」）。CIは
// `secrets.API_ACCESS_KEY`を`LIVE_API_ACCESS_KEY`で渡す。未設定なら認証無効の
// 配備として扱い、何も足さない。
export const LIVE_API_ACCESS_KEY = process.env["LIVE_API_ACCESS_KEY"] || undefined;

// UIの`shared/api/access-key.ts`の`ACCESS_KEY_STORAGE_KEY`と同じキー・同じ形式
// （`lib/storage.ts`はJSONで保存する）。e2e-liveはUIのsrcをimportしないため複製する。
const ACCESS_KEY_STORAGE_KEY = "mlgg:access-key";

/** ページ内スクリプトより先にキーを保存し、UIが最初の要求からキーを送るようにする。 */
export async function seedLiveAccessKey(page: Page): Promise<void> {
  if (LIVE_API_ACCESS_KEY === undefined) {
    return;
  }
  await page.addInitScript(
    ({ storageKey, accessKey }) => {
      window.localStorage.setItem(storageKey, JSON.stringify(accessKey));
    },
    { storageKey: ACCESS_KEY_STORAGE_KEY, accessKey: LIVE_API_ACCESS_KEY },
  );
}

/** ページ内`fetch`でAPIを直接呼ぶテスト向けの`Authorization`ヘッダー。 */
export function liveAuthorizationHeaders(): Record<string, string> {
  return LIVE_API_ACCESS_KEY === undefined
    ? {}
    : { Authorization: `Bearer ${LIVE_API_ACCESS_KEY}` };
}
