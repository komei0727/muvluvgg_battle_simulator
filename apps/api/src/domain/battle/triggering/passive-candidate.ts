import type { TriggerDefinition } from "../../catalog/definitions/trigger-definition.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { BattleUnit } from "../model/battle-unit.js";

/**
 * `05_ドメインモデル.md`「PassiveCandidateStack」が保持する候補1件分。
 * `unit`/`skillDefinition`は発動処理（#21以降）がそのまま使えるよう、IDではなく
 * 解決済みの参照を持つ。`trigger`は`skillDefinition.triggers`のうち実際に
 * マッチした1件（R-PS-04の再確認が同じ条件を再評価できるようにするため）。
 * `definitionIndex`はR-PS-02 #5「同じユニットではPS定義順」の比較キー
 * （`UnitDefinition.passiveSkillDefinitionIds`内の位置）。
 */
export interface PassiveCandidate {
  readonly unit: BattleUnit;
  readonly skillDefinition: SkillDefinition;
  readonly trigger: TriggerDefinition;
  readonly definitionIndex: number;
}

/** R-PS-01 #4「条件を満たしたPSを同じイベントの候補グループにする」の結果。 */
export type PassiveCandidateGroup = readonly PassiveCandidate[];
