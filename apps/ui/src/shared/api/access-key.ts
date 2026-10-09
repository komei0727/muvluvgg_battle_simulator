import { createContext, useContext } from "react";
import { readJsonItem, removeJsonItem, writeJsonItem } from "../../lib/storage.js";

// docs/ui-design/03_API・データ連携設計.md §2.4: GitHub Pagesは秘密を持てないため、
// アクセスキーは利用者本人が入力し、このブラウザのlocalStorageにだけ保存する。
export const ACCESS_KEY_STORAGE_KEY = "mlgg:access-key";

/** 保存済みのキー。未保存・壊れた値・空文字は「キーなし」として扱う。 */
export function readStoredAccessKey(): string | undefined {
  const stored = readJsonItem(ACCESS_KEY_STORAGE_KEY);
  if (typeof stored !== "string" || stored.trim() === "") {
    return undefined;
  }
  return stored;
}

export function writeStoredAccessKey(key: string): void {
  writeJsonItem(ACCESS_KEY_STORAGE_KEY, key);
}

export function removeStoredAccessKey(): void {
  removeJsonItem(ACCESS_KEY_STORAGE_KEY);
}

/**
 * API呼び出しを持つfeature hookへ、現在のキーと401の通知先を配る。Providerの外
 * （単体テスト・キーを使わない配備）ではキーなし・通知なしとして振る舞う。
 */
export interface ApiAccess {
  readonly accessKey: string | undefined;
  /** 401を受けたhookが呼ぶ。キー入力画面への誘導はPageが担う。 */
  readonly onUnauthorized: () => void;
}

const NO_ACCESS_KEY: ApiAccess = {
  accessKey: undefined,
  onUnauthorized: () => {},
};

export const ApiAccessContext = createContext<ApiAccess>(NO_ACCESS_KEY);

export function useApiAccess(): ApiAccess {
  return useContext(ApiAccessContext);
}
