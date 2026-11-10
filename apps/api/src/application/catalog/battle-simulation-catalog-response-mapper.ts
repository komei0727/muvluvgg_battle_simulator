import type { BattleSimulationCatalogResponseBody } from "../contracts/catalog.js";
import type { BattleSimulationCatalogResult } from "./get-battle-simulation-catalog-use-case.js";

const SCHEMA_VERSION = 1;

/**
 * `10_API設計.md`「戦闘シミュレーション用Catalogレスポンス」: domainの
 * branded ID型（`UnitDefinitionId`等）を持つ`BattleSimulationCatalogResult`
 * から、presentation層が触れてよいプレーンなwire形へ変換する
 * （`simulate-battle-response-mapper.ts`と同じ境界の理由）。
 */
export function toBattleSimulationCatalogResponseBody(
  result: BattleSimulationCatalogResult,
): BattleSimulationCatalogResponseBody {
  return {
    schemaVersion: SCHEMA_VERSION,
    catalogRevision: result.catalogRevision,
    units: result.units.map((unit) => ({
      unitDefinitionId: unit.unitDefinitionId,
      displayName: unit.displayName,
      characterName: unit.characterName,
      category: unit.category,
      ...(unit.exerciseActive === undefined ? {} : { exerciseActive: unit.exerciseActive }),
      attribute: unit.attribute,
      unitType: unit.unitType,
      role: unit.role,
      positionAptitudes: unit.positionAptitudes,
    })),
    memories: result.memories.map((memory) => ({
      memoryDefinitionId: memory.memoryDefinitionId,
      displayName: memory.displayName,
    })),
    // R-ENH-04 #3の効果表はパーセントポイントのまま公開する（`gear-effect-catalog.ts`）。
    gearEffects: result.gearEffects.map((effect) => ({
      stat: effect.stat,
      application: effect.application,
      values: effect.values.map((value) => ({
        tier: value.tier,
        grade: value.grade,
        percentagePoints: value.percentagePoints,
      })),
    })),
    // 任意項目は値を持つときだけ載せる（`additionalProperties: false`の公開schemaに
    // `undefined`キーを残さない）。
    skills: result.skills.map((skill) => ({
      skillDefinitionId: skill.skillDefinitionId,
      displayName: skill.displayName,
      skillType: skill.skillType,
      ...(skill.ownerUnitDefinitionId === undefined
        ? {}
        : { ownerUnitDefinitionId: skill.ownerUnitDefinitionId }),
      ...(skill.slotLabel === undefined ? {} : { slotLabel: skill.slotLabel }),
    })),
    effects: result.effects.map((effect) => ({
      effectActionDefinitionId: effect.effectActionDefinitionId,
      kind: effect.kind,
      ...(effect.stat === undefined ? {} : { stat: effect.stat }),
      ...(effect.valueType === undefined ? {} : { valueType: effect.valueType }),
      ...(effect.direction === undefined ? {} : { direction: effect.direction }),
      ...(effect.damageType === undefined ? {} : { damageType: effect.damageType }),
      ...(effect.status === undefined ? {} : { status: effect.status }),
      ...(effect.constantMagnitude === undefined
        ? {}
        : { constantMagnitude: effect.constantMagnitude }),
    })),
  };
}
