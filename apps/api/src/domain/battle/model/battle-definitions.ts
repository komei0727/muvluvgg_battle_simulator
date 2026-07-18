import type {
  EffectActionDefinitionId,
  SkillDefinitionId,
  UnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";

/**
 * `BattleDefinitionSet` の基本形 (`05_ドメインモデル.md`)。「1回の戦闘で使用する
 * 定義だけを集めた不変オブジェクト。戦闘開始後は同じインスタンスを参照し続ける」
 * のうち、行動解決(`ActionSelectionPolicy`/`SkillResolutionService`)とPS発動
 * (`PassiveTriggerMatcher`、Issue #34)が必要とする部分だけを持つ。
 * MemoryDefinition/CapabilityDefinitionはこのIssueのスコープ外(Memory連鎖はM7)
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
}
