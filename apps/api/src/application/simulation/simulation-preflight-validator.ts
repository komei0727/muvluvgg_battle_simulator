import { ApplicationError, type Violation } from "../contracts/application-error.js";
import type { FormationInput, FormationPairCommand } from "./simulate-battle-command.js";
import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import type { BattleMode } from "../../domain/battle/model/exercise-runtime.js";
import type { UnitCategory } from "../../domain/catalog/definitions/unit-definition.js";
import {
  DEFAULT_UNIT_LEVEL,
  DEFAULT_UNIT_RANK,
} from "../../domain/battle/model/enhanced-base-stats-calculator.js";
import type { Side } from "../../domain/shared/side.js";

/**
 * 検証対象の編成1つ。違反のパスは`path`を接頭辞にする — 通常戦闘は`allyFormation`、
 * 総力戦は編成の添字を含む`allyFormations[1]`のように、Commandの形をそのまま写す。
 */
interface PreflightFormation {
  readonly path: string;
  readonly side: Side;
  readonly formation: FormationInput;
}

function pairFormations(command: FormationPairCommand): readonly PreflightFormation[] {
  return [
    { path: "allyFormation", side: "ALLY", formation: command.allyFormation },
    { path: "enemyFormation", side: "ENEMY", formation: command.enemyFormation },
  ];
}

function validateReferences(
  formations: readonly PreflightFormation[],
  snapshot: BattleCatalogSnapshot,
): Violation[] {
  const violations: Violation[] = [];

  for (const { path: key, formation } of formations) {
    formation.slots.forEach((slot, index) => {
      if (!snapshot.units.has(slot.unitDefinitionId)) {
        violations.push({
          path: `${key}.slots[${index}].unitDefinitionId`,
          definitionId: slot.unitDefinitionId,
          reason: `references an unknown UnitDefinitionId: "${slot.unitDefinitionId}"`,
        });
      }
    });
    formation.memoryDefinitionIds.forEach((memoryDefinitionId, index) => {
      if (!snapshot.memories.has(memoryDefinitionId)) {
        violations.push({
          path: `${key}.memoryDefinitionIds[${index}]`,
          definitionId: memoryDefinitionId,
          reason: `references an unknown MemoryDefinitionId: "${memoryDefinitionId}"`,
        });
      }
    });
  }

  return violations;
}

/**
 * R-ENH-05 #5: `levelGrowth`を持たないユニットへ200以外の現在レベルを指定した
 * リクエストを拒否する。判定にユニット定義の解決が要るため参照検証と同じ段階で
 * 行うが、クライアントから見れば値の指定ミスなので`INVALID_COMMAND`として返す
 * （`09_アプリケーション設計.md`「Command検証」末尾）。
 */
function validateLevelGrowth(
  formations: readonly PreflightFormation[],
  snapshot: BattleCatalogSnapshot,
): Violation[] {
  const violations: Violation[] = [];

  for (const { path: key, formation } of formations) {
    formation.slots.forEach((slot, index) => {
      const level = slot.enhancement?.level;
      if (level === undefined || level === DEFAULT_UNIT_LEVEL) {
        return;
      }
      const unitDefinition = snapshot.units.get(slot.unitDefinitionId);
      if (unitDefinition?.levelGrowth === undefined) {
        violations.push({
          path: `${key}.slots[${index}].enhancement.level`,
          definitionId: slot.unitDefinitionId,
          reason: `must be ${DEFAULT_UNIT_LEVEL} because "${slot.unitDefinitionId}" declares no levelGrowth, got ${level}`,
        });
      }
    });
  }

  return violations;
}

/**
 * R-ENH-07 #5: `rankGrowth`を持たないユニットへ5以外のユニットランクを指定した
 * リクエストを拒否する。`validateLevelGrowth`（R-ENH-05 #5）と同じ理由・同じ段階で行う。
 */
function validateRankGrowth(
  formations: readonly PreflightFormation[],
  snapshot: BattleCatalogSnapshot,
): Violation[] {
  const violations: Violation[] = [];

  for (const { path: key, formation } of formations) {
    formation.slots.forEach((slot, index) => {
      const rank = slot.enhancement?.rank;
      if (rank === undefined || rank === DEFAULT_UNIT_RANK) {
        return;
      }
      const unitDefinition = snapshot.units.get(slot.unitDefinitionId);
      if (unitDefinition?.rankGrowth === undefined) {
        violations.push({
          path: `${key}.slots[${index}].enhancement.rank`,
          definitionId: slot.unitDefinitionId,
          reason: `must be ${DEFAULT_UNIT_RANK} because "${slot.unitDefinitionId}" declares no rankGrowth, got ${rank}`,
        });
      }
    });
  }

  return violations;
}

/**
 * R-TEX-11・R-TWR-01 #6: 戦闘モードごとの編成プール。通常戦闘と総力戦は両陣営とも
 * `PLAYABLE`のみ、戦術演習は味方`PLAYABLE`・敵`EXERCISE_ENEMY`のみを受理する。`exerciseActive`
 * は表示専用の開催情報であり、ここでは参照しない（開催終了ユニットも受理する）。
 */
const ALLOWED_CATEGORIES: Readonly<Record<BattleMode, Readonly<Record<Side, UnitCategory>>>> = {
  NORMAL: { ALLY: "PLAYABLE", ENEMY: "PLAYABLE" },
  TACTICAL_EXERCISE: { ALLY: "PLAYABLE", ENEMY: "EXERCISE_ENEMY" },
  // R-TWR-01 #6: 総力戦は対人戦のため、両陣営とも`PLAYABLE`のみ。
  TOTAL_WAR: { ALLY: "PLAYABLE", ENEMY: "PLAYABLE" },
};

function validateUnitCategories(
  formations: readonly PreflightFormation[],
  snapshot: BattleCatalogSnapshot,
  mode: BattleMode,
): Violation[] {
  const violations: Violation[] = [];

  for (const { path: key, side, formation } of formations) {
    const allowed = ALLOWED_CATEGORIES[mode][side];
    formation.slots.forEach((slot, index) => {
      const unitDefinition = snapshot.units.get(slot.unitDefinitionId);
      if (unitDefinition !== undefined && unitDefinition.category !== allowed) {
        violations.push({
          path: `${key}.slots[${index}].unitDefinitionId`,
          definitionId: slot.unitDefinitionId,
          ruleId: "R-TEX-11",
          reason: `must reference a ${allowed} unit in ${key} of a ${mode} battle, but "${slot.unitDefinitionId}" is ${unitDefinition.category}`,
        });
      }
    });
  }

  return violations;
}

/**
 * `09_アプリケーション設計.md` の SimulationPreflightValidator: 参照検証を
 * 行う（Command検証はUseCaseが `validateCommandShape` を直接呼ぶため、
 * ここでは扱わない）。
 */
export function runPreflight(
  command: FormationPairCommand,
  snapshot: BattleCatalogSnapshot,
  mode: BattleMode,
): void {
  runFormationsPreflight(pairFormations(command), snapshot, mode);
}

/**
 * `09_アプリケーション設計.md`「SimulateTotalWarCommand」: 総力戦の参照検証は全編成分を
 * まとめて行い、1件でも違反があれば戦闘を開始しない。違反のパスは編成の添字を含める。
 */
export function runTotalWarPreflight(
  command: {
    readonly allyFormations: readonly FormationInput[];
    readonly enemyFormations: readonly FormationInput[];
  },
  snapshot: BattleCatalogSnapshot,
): void {
  const sideFormations = (
    formations: readonly FormationInput[],
    path: string,
    side: Side,
  ): readonly PreflightFormation[] =>
    formations.map((formation, index) => ({ path: `${path}[${index}]`, side, formation }));
  runFormationsPreflight(
    [
      ...sideFormations(command.allyFormations, "allyFormations", "ALLY"),
      ...sideFormations(command.enemyFormations, "enemyFormations", "ENEMY"),
    ],
    snapshot,
    "TOTAL_WAR",
  );
}

function runFormationsPreflight(
  formations: readonly PreflightFormation[],
  snapshot: BattleCatalogSnapshot,
  mode: BattleMode,
): void {
  const referenceViolations = validateReferences(formations, snapshot);
  if (referenceViolations.length > 0) {
    // 未解決の参照を先に返す。`levelGrowth`・`rankGrowth`・カテゴリ検査は解決済み
    // 定義を前提にするため、存在しないユニットについては参照エラーが正しい。
    throw new ApplicationError("DEFINITION_NOT_FOUND", referenceViolations);
  }

  const commandViolations = [
    ...validateLevelGrowth(formations, snapshot),
    ...validateRankGrowth(formations, snapshot),
    ...validateUnitCategories(formations, snapshot, mode),
  ];
  if (commandViolations.length > 0) {
    throw new ApplicationError("INVALID_COMMAND", commandViolations);
  }
}
