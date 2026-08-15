import type {
  EffectActionDefinitionId,
  SkillDefinitionId,
  UnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { MemoryDefinition } from "../../catalog/definitions/memory-definition.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import type { Side } from "../../shared/side.js";
import type { PassiveChainLimits } from "./passive-chain-limits.js";

/**
 * `BattleDefinitionSet` の基本形 (`05_ドメインモデル.md`)。「1回の戦闘で使用する
 * 定義だけを集めた不変オブジェクト。戦闘開始後は同じインスタンスを参照し続ける」
 * のうち、行動解決(`ActionSelectionPolicy`/`SkillResolutionService`)とPS発動
 * (`PassiveTriggerMatcher`、Issue #34)が必要とする部分だけを持つ。
 * MemoryDefinitionはこのIssueのスコープ外(Memory連鎖はM7)
 * のため含まない。
 */
export interface BattleDefinitions {
  /** `UnitDefinition.activeSkillDefinitionIds` を解決済みの `SkillDefinition` へ展開したもの。 */
  readonly activeSkillsByUnit: ReadonlyMap<UnitDefinitionId, readonly SkillDefinition[]>;
  /** `UnitDefinition.extraSkillDefinitionId` を解決済みの `SkillDefinition` へ展開したもの（R-ORD-03のEX予約が使用する）。 */
  readonly exSkillByUnit: ReadonlyMap<UnitDefinitionId, SkillDefinition>;
  readonly effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>;
  /** `detectPassiveCandidates`（`domain/battle/triggering`）がPS所有者の`passiveSkillDefinitionIds`を辿るために使う。 */
  readonly unitDefinitions: ReadonlyMap<UnitDefinitionId, UnitDefinition>;
  /** `detectPassiveCandidates`がPS所有者の`passiveSkillDefinitionIds`から実際の`SkillDefinition`を解決するために使う。 */
  readonly skillDefinitions: ReadonlyMap<SkillDefinitionId, SkillDefinition>;
  /**
   * R-MEM-01/02（M7-006、Issue #179）: `detectMemoryCandidates`が走査する、陣営ごとの
   * Memory定義。**APIリクエストで指定された順序**（`FormationInput.memoryDefinitionIds`
   * の並び）をそのまま保つ配列であり、ここで並べ替えてはならない（R-MEM-02 #1）。
   * Memoryを1件も指定しない戦闘（既存テストの大多数）では省略できる。
   */
  readonly memoriesBySide?: Readonly<Record<Side, readonly MemoryDefinition[]>>;
  /**
   * `11_インフラストラクチャ設計.md`「SimulationExecutionGuard」「上限値は設定から
   * 受け取る」。定義そのものではなく戦闘1回分の実行保護設定だが、`BattleDefinitions`と
   * まったく同じ寿命（戦闘開始から完了まで不変）と配布経路（全解決スコープが
   * `definitions`として参照する）を持つため、ここへ同乗させる。9箇所ある
   * `PassiveActivationRuntime`生成点とその全呼び出し元へ引数を通す代わりに、
   * 既存の唯一の運搬役を使う。省略時は`DEFAULT_PASSIVE_CHAIN_LIMITS`。
   */
  readonly executionLimits?: PassiveChainLimits;
}

/** `memoriesBySide`未指定（Memoryなしの戦闘）の既定値。 */
export const NO_MEMORIES: Readonly<Record<Side, readonly MemoryDefinition[]>> = {
  ALLY: [],
  ENEMY: [],
};
