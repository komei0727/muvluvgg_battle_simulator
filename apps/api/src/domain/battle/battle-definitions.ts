import type { EffectActionDefinitionId, UnitDefinitionId } from "../catalog/catalog-ids.js";
import type { EffectActionDefinition } from "../catalog/effect-action-definition.js";
import type { SkillDefinition } from "../catalog/skill-definition.js";

/**
 * `BattleDefinitionSet` の基本形 (`05_ドメインモデル.md`)。「1回の戦闘で使用する
 * 定義だけを集めた不変オブジェクト。戦闘開始後は同じインスタンスを参照し続ける」
 * のうち、行動解決(`ActionSelectionPolicy`/`SkillResolutionService`)が必要とする
 * 部分だけを持つ。MemoryDefinition/CapabilityDefinitionはこのIssueのスコープ外
 * (PS/Memory連鎖はM6/M7)のため含まない。
 */
export interface BattleDefinitions {
  /** `UnitDefinition.activeSkillDefinitionIds` を解決済みの `SkillDefinition` へ展開したもの。 */
  readonly activeSkillsByUnit: ReadonlyMap<UnitDefinitionId, readonly SkillDefinition[]>;
  readonly effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>;
}
