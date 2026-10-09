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
  /**
   * キーを保存・再設定するたびに進む世代番号。同じキーを入れ直しても進むため、
   * 要求がどのキー設定の下で送られたかをキー文字列より厳密に区別できる。
   */
  readonly generation: number;
  readonly status: AccessKeyStatus;
  /** 現在のキーが保存されているか。拒否されたキーは保存から消えるため含まない。 */
  readonly keySaved: boolean;
  readonly submit: (key: string) => void;
  readonly reset: () => void;
  /** 401を受けた要求が送信時に持っていた世代番号を渡す。 */
  readonly reportUnauthorized: (sentGeneration: number) => void;
}

interface GateState {
  readonly accessKey: string | undefined;
  readonly generation: number;
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
    generation: 0,
    status: "unknown",
  }));

  const submit = useCallback((key: string) => {
    const trimmed = key.trim();
    writeStoredAccessKey(trimmed);
    setState((current) => ({
      accessKey: trimmed,
      generation: current.generation + 1,
      status: "unknown",
    }));
  }, []);

  const reset = useCallback(() => {
    removeStoredAccessKey();
    setState((current) => ({
      accessKey: undefined,
      generation: current.generation + 1,
      status: "unknown",
    }));
  }, []);

  // 無効なキーは保存から消すが、画面上の`accessKey`は保つ。ここで`undefined`へ
  // 戻すとキーに依存する取得が走り直し、同じ401をもう一度受けるだけになる。
  //
  // 戦闘・統計実行はキーの差し替えで中断されないため、差し替え前に始めた要求の401が
  // 後から届き得る。同じキーを入れ直した場合も含め、送信時の世代が現在と異なる401は
  // 今のキー設定について何も示さないので無視する（保存値も消さない）。
  const reportUnauthorized = useCallback((sentGeneration: number) => {
    setState((current) => {
      if (sentGeneration !== current.generation) {
        return current;
      }
      // 世代の照合には最新のstateが要るため、保存値の削除もupdater内で行う。削除は
      // 冪等なので、StrictModeでupdaterが2回呼ばれても結果は変わらない。
      if (current.accessKey !== undefined) {
        removeStoredAccessKey();
      }
      return {
        ...current,
        status: current.accessKey === undefined ? "required" : "rejected",
      };
    });
  }, []);

  const keySaved = state.accessKey !== undefined && state.status !== "rejected";

  return { ...state, keySaved, submit, reset, reportUnauthorized };
}
