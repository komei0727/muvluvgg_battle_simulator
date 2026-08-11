// docs/ui-design/04_コンポーネント・状態管理設計.md §4「永続化」: localStorageへの
// アクセスをこの1箇所へ閉じる。localStorageは「存在しない」「参照しただけでthrowする」
// 「書き込みが容量超過でthrowする」のいずれも起こり得るため、呼び出し側が毎回
// try/catchを書かずに済むよう、失敗を握り潰して縮退した結果を返す。保存できない
// ことはアプリの機能ではないので、error表示やviolationへ昇格させない。

function storage(): Storage | undefined {
  try {
    // 参照そのものがthrowし得る（プライバシー設定・sandboxed iframe）。
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** 保存値を`unknown`として返す。未保存・読めない・JSONとして壊れている場合は`undefined`。 */
export function readJsonItem(key: string): unknown {
  const raw = (() => {
    try {
      return storage()?.getItem(key) ?? undefined;
    } catch {
      return undefined;
    }
  })();
  if (raw === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** 保存を試みる。失敗（容量超過・直列化不能・storage無効）は黙って捨てる。 */
export function writeJsonItem(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // 保存できないだけで、画面の入力と実行は続行できる。
  }
}

export function removeJsonItem(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // 同上。
  }
}
