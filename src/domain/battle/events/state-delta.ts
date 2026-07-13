import type { BattleStatus } from "../battle-status.js";
import type { VictoryResult } from "../victory-policy.js";
import type { BattleUnitId } from "../../shared/ids.js";

export interface ValueChange<T> {
  readonly before: T;
  readonly after: T;
}

/** `Battle.result`と同じ形。`battle.js`からの循環importを避けるため独立に定義する。 */
export type BattleResultSnapshot = VictoryResult & { readonly completedTurn: number };

/** `08_ドメインイベント.md`「StateDelta」: 変更した項目だけを持つ。M3ではHP/AP/PP/EXだけが変化しうる。 */
export interface UnitStateDelta {
  readonly hp?: ValueChange<number>;
  readonly ap?: ValueChange<number>;
  readonly pp?: ValueChange<number>;
  readonly extraGauge?: ValueChange<number>;
}

/**
 * `08_ドメインイベント.md`「StateDelta」: 変更した戦闘ユニットIDや状態区分だけを
 * キーとして記録する。配列位置に依存するJSON Patchではなく、安定したドメインID
 * で差分対象を識別する。
 */
export interface StateDelta {
  readonly units?: Readonly<Record<BattleUnitId, UnitStateDelta>>;
  readonly turnNumber?: ValueChange<number>;
  readonly battleStatus?: ValueChange<BattleStatus>;
  /** 勝敗確定（`BattleCompleted`）のみが持つ。`before`は常に`undefined`（未確定）。 */
  readonly result?: ValueChange<BattleResultSnapshot | undefined>;
}
