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
  readonly submit: (key: string) => void;
  readonly reset: () => void;
  readonly reportUnauthorized: () => void;
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
  const reportUnauthorized = useCallback(() => {
    removeStoredAccessKey();
    setState((current) => ({
      accessKey: current.accessKey,
      status: current.accessKey === undefined ? "required" : "rejected",
    }));
  }, []);

  return { ...state, submit, reset, reportUnauthorized };
}
