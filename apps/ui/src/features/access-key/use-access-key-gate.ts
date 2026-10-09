import { useCallback, useState } from "react";
import {
  readStoredAccessKey,
  removeStoredAccessKey,
  writeStoredAccessKey,
} from "../../shared/api/access-key.js";

/**
 * - `unknown`: キーの要否は未確定（直近の取得で401を受けていない）。入力欄を出さない。
 * - `required`: キーなしで401を受けた。入力を求める。
 * - `rejected`: 送ったキーで401を受けた（誤入力・失効）。入力し直しを求める。
 */
export type AccessKeyStatus = "unknown" | "required" | "rejected";

export interface AccessKeyGate {
  readonly accessKey: string | undefined;
  readonly status: AccessKeyStatus;
  /** 現在のキーが保存されているか。拒否されたキーは保存から消えるため含まない。 */
  readonly keySaved: boolean;
  readonly submit: (key: string) => void;
  readonly reset: () => void;
  /** 401を受けた要求で送ったキー（送らなかったなら`undefined`）を渡す。 */
  readonly reportUnauthorized: (sentAccessKey: string | undefined) => void;
}

interface GateState {
  readonly accessKey: string | undefined;
  readonly status: AccessKeyStatus;
}

/**
 * docs/ui-design/04_コンポーネント・状態管理設計.md §4: アクセスキーはモードに依らない
 * Pageの状態。キーの要否はAPIの401でだけ判断する——API側で認証が無効な配備では
 * 一度も入力欄を出さない。
 */
export function useAccessKeyGate(): AccessKeyGate {
  const [state, setState] = useState<GateState>(() => ({
    accessKey: readStoredAccessKey(),
    status: "unknown",
  }));

  const submit = useCallback((key: string) => {
    const trimmed = key.trim();
    writeStoredAccessKey(trimmed);
    setState({ accessKey: trimmed, status: "unknown" });
  }, []);

  const reset = useCallback(() => {
    removeStoredAccessKey();
    setState({ accessKey: undefined, status: "unknown" });
  }, []);

  // 無効なキーは保存から消すが、画面上の`accessKey`は保つ。ここで`undefined`へ
  // 戻すとキーに依存する取得が走り直し、同じ401をもう一度受けるだけになる。
  //
  // 戦闘・統計実行はキーの差し替えで中断されないため、差し替え前のキーで始めた要求の
  // 401が後から届き得る。送ったキーが現在のキーと異なる401は、新しいキーについて何も
  // 示さないので無視する（新しいキーを消さない）。
  const reportUnauthorized = useCallback((sentAccessKey: string | undefined) => {
    setState((current) => {
      if (sentAccessKey !== current.accessKey) {
        return current;
      }
      return {
        accessKey: current.accessKey,
        status: current.accessKey === undefined ? "required" : "rejected",
      };
    });
    // 保存値も、送ったキーそのものが残っている場合だけ消す。
    if (sentAccessKey !== undefined && readStoredAccessKey() === sentAccessKey) {
      removeStoredAccessKey();
    }
  }, []);

  const keySaved = state.accessKey !== undefined && state.status !== "rejected";

  return { ...state, keySaved, submit, reset, reportUnauthorized };
}
