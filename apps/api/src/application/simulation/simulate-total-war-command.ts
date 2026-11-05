import type { Violation } from "../contracts/application-error.js";
import {
  validateFormationShape,
  validateLogLevel,
  type FormationInput,
  type LogLevel,
} from "./simulate-battle-command.js";
import { TOTAL_WAR_TURN_LIMIT } from "../../domain/battle/model/total-war-formations.js";
import type {
  MemoryDefinitionId,
  UnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";

/**
 * R-TWR-01 #5: 総力戦の規定ターン数はリクエストで指定できず、常にこの定数を使う。値の正本は
 * 集約の生成時不変条件（`createTotalWarBattle`）が参照するDomain側に置く。
 */
export { TOTAL_WAR_TURN_LIMIT };

/**
 * `09_アプリケーション設計.md`「SimulateTotalWarCommand」。各陣営の編成を出撃順に持つ。
 * 規定ターン数は固定のため`turnLimit`を持たない。
 */
export interface SimulateTotalWarCommand {
  readonly allyFormations: readonly FormationInput[];
  readonly enemyFormations: readonly FormationInput[];
  readonly logLevel: LogLevel;
}

const MIN_FORMATIONS = 1;
const MAX_FORMATIONS = 3;

/**
 * `09_アプリケーション設計.md`「SimulateTotalWarCommand」のCommand検証。各編成へ通常戦闘と
 * 同じ編成検証（R-FRM-01～05、R-ENH-01）を適用し、編成数（R-TWR-01 #1）と1編成内の重複
 * （同 #3・#4）を加える。違反はまとめて返し、Catalogへはアクセスしない。
 *
 * Domainの`validateTotalWarFormations`は最初の違反で例外を投げ、メモリーIDの存在確認に
 * Catalogを要するため、ここでは同じ規則を違反の収集として持つ。Domain側の検証は
 * 集約の生成直前に不変条件として改めて通す。
 */
export function validateTotalWarCommandShape(command: SimulateTotalWarCommand): Violation[] {
  const violations: Violation[] = [
    ...validateSideFormations(command.allyFormations, "allyFormations"),
    ...validateSideFormations(command.enemyFormations, "enemyFormations"),
  ];

  validateLogLevel(command.logLevel, violations);

  return violations;
}

function validateSideFormations(formations: readonly FormationInput[], path: string): Violation[] {
  const violations: Violation[] = [];
  if (formations.length < MIN_FORMATIONS || formations.length > MAX_FORMATIONS) {
    violations.push({
      path,
      reason: `must contain between ${MIN_FORMATIONS} and ${MAX_FORMATIONS} formations, got ${formations.length}`,
    });
  }

  formations.forEach((formation, formationIndex) => {
    const formationPath = `${path}[${formationIndex}]`;
    violations.push(...validateFormationShape(formation, formationPath));
    violations.push(...findDuplicateUnits(formation, formationPath));
    violations.push(...findDuplicateMemories(formation, formationPath));
  });

  return violations;
}

/** R-TWR-01 #3: 同じキャラクターの衣装違いは別の`UnitDefinitionId`なので重複に数えない。 */
function findDuplicateUnits(formation: FormationInput, path: string): Violation[] {
  const seen = new Set<UnitDefinitionId>();
  const violations: Violation[] = [];
  formation.slots.forEach((slot, slotIndex) => {
    if (seen.has(slot.unitDefinitionId)) {
      violations.push({
        path: `${path}.slots[${slotIndex}].unitDefinitionId`,
        definitionId: slot.unitDefinitionId,
        ruleId: "R-TWR-01",
        reason: `duplicates a UnitDefinitionId already placed in this formation: "${slot.unitDefinitionId}"`,
      });
    }
    seen.add(slot.unitDefinitionId);
  });
  return violations;
}

/** R-TWR-01 #4 */
function findDuplicateMemories(formation: FormationInput, path: string): Violation[] {
  const seen = new Set<MemoryDefinitionId>();
  const violations: Violation[] = [];
  formation.memoryDefinitionIds.forEach((memoryDefinitionId, memoryIndex) => {
    if (seen.has(memoryDefinitionId)) {
      violations.push({
        path: `${path}.memoryDefinitionIds[${memoryIndex}]`,
        definitionId: memoryDefinitionId,
        ruleId: "R-TWR-01",
        reason: `duplicates a MemoryDefinitionId already assigned to this formation: "${memoryDefinitionId}"`,
      });
    }
    seen.add(memoryDefinitionId);
  });
  return violations;
}
