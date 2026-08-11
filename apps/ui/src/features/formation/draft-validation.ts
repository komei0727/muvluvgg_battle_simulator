// Mirrors docs/ui-design/03_API・データ連携設計.md §6 (client validation table)
// and docs/ui-design/04_コンポーネント・状態管理設計.md §9 (UiViolation shape).

import { aptitudeMatches } from "../../lib/aptitude.js";
import type { BattleSimulationCatalogResponse } from "../simulation/api-contract.js";
import { enhancementForSide, memorySlotKeyOf } from "./types.js";
import type { BattleDraft, FormationSlotInput, Side, SideEnhancementInput } from "./types.js";

export type UiViolationSeverity = "error" | "warning";

export interface UiViolation {
  readonly path: string;
  readonly slotKey?: string;
  /**
   * M11: ギア違反が指すUIのギア枠index（03_API・データ連携設計.md §13）。
   * 送信配列は空枠を除外するため、サーバーの`gears[m]`をそのまま枠番号として
   * 使えない。`slotKey`と対で、ユニット強化ダイアログの該当selectへ表示する。
   */
  readonly gearIndex?: number;
  readonly code: string;
  readonly message: string;
  readonly severity: UiViolationSeverity;
}

const MIN_UNITS_PER_SIDE = 1;
const MAX_UNITS_PER_SIDE = 5;
const MAX_MEMORIES_PER_SIDE = 6;
const MIN_TURN_LIMIT = 1;
const MAX_TURN_LIMIT = 99;
const MAX_GEARS_PER_UNIT = 9;

function unitsPath(side: Side): string {
  return side === "ally" ? "/allyFormation/units" : "/enemyFormation/units";
}

function memoriesPath(side: Side): string {
  return side === "ally"
    ? "/allyFormation/memoryDefinitionIds"
    : "/enemyFormation/memoryDefinitionIds";
}

function filledSlots(
  slots: readonly FormationSlotInput[],
): readonly (FormationSlotInput & { readonly unitDefinitionId: string })[] {
  return slots.filter(
    (slot): slot is FormationSlotInput & { unitDefinitionId: string } =>
      slot.unitDefinitionId !== undefined,
  );
}

function validateUnitCount(side: Side, slots: readonly FormationSlotInput[]): UiViolation[] {
  const count = filledSlots(slots).length;
  if (count >= MIN_UNITS_PER_SIDE && count <= MAX_UNITS_PER_SIDE) {
    return [];
  }
  const message =
    side === "ally"
      ? "味方ユニットを1～5体設定してください。"
      : "敵ユニットを1～5体設定してください。";
  return [{ path: unitsPath(side), code: "UNIT_COUNT_OUT_OF_RANGE", message, severity: "error" }];
}

function validateDuplicatePositions(
  side: Side,
  slots: readonly FormationSlotInput[],
): UiViolation[] {
  const seenCoordinates = new Set<string>();
  const violations: UiViolation[] = [];
  for (const slot of filledSlots(slots)) {
    const coordinateKey = `${slot.row}:${slot.column}`;
    if (seenCoordinates.has(coordinateKey)) {
      violations.push({
        path: unitsPath(side),
        slotKey: slot.slotKey,
        code: "DUPLICATE_POSITION",
        message: "同じ配置枠に複数のユニットは設定できません。",
        severity: "error",
      });
    } else {
      seenCoordinates.add(coordinateKey);
    }
  }
  return violations;
}

function validateMemoryCount(side: Side, ids: readonly (string | undefined)[]): UiViolation[] {
  const count = ids.filter((id) => id !== undefined).length;
  if (count <= MAX_MEMORIES_PER_SIDE) {
    return [];
  }
  return [
    {
      path: memoriesPath(side),
      code: "MEMORY_COUNT_OUT_OF_RANGE",
      message: "メモリーは6件まで設定できます。",
      severity: "error",
    },
  ];
}

function validateTurnLimit(turnLimit: BattleDraft["turnLimit"]): UiViolation[] {
  const message = "ターン上限は1～99の整数で入力してください。";
  const isValid =
    turnLimit !== "" &&
    Number.isInteger(turnLimit) &&
    turnLimit >= MIN_TURN_LIMIT &&
    turnLimit <= MAX_TURN_LIMIT;
  if (isValid) {
    return [];
  }
  return [{ path: "/turnLimit", code: "TURN_LIMIT_INVALID", message, severity: "error" }];
}

function validateUnitExistence(
  side: Side,
  slots: readonly FormationSlotInput[],
  catalog: BattleSimulationCatalogResponse,
): UiViolation[] {
  const violations: UiViolation[] = [];
  for (const slot of filledSlots(slots)) {
    const definition = catalog.units.find(
      (unit) => unit.unitDefinitionId === slot.unitDefinitionId,
    );
    if (definition === undefined) {
      violations.push({
        path: unitsPath(side),
        slotKey: slot.slotKey,
        code: "UNKNOWN_DEFINITION",
        message: "Catalogに存在しない定義です。選択し直してください。",
        severity: "error",
      });
    }
  }
  return violations;
}

function validateMemoryExistence(
  side: Side,
  ids: readonly (string | undefined)[],
  catalog: BattleSimulationCatalogResponse,
): UiViolation[] {
  const violations: UiViolation[] = [];
  ids.forEach((memoryDefinitionId, index) => {
    if (memoryDefinitionId === undefined) {
      return;
    }
    const definition = catalog.memories.find(
      (memory) => memory.memoryDefinitionId === memoryDefinitionId,
    );
    if (definition === undefined) {
      violations.push({
        path: `${memoriesPath(side)}/${index}`,
        slotKey: memorySlotKeyOf(side, index),
        code: "UNKNOWN_DEFINITION",
        message: "Catalogに存在しない定義です。選択し直してください。",
        severity: "error",
      });
    }
  });
  return violations;
}

function validateAptitudeWarnings(
  side: Side,
  slots: readonly FormationSlotInput[],
  catalog: BattleSimulationCatalogResponse,
): UiViolation[] {
  const violations: UiViolation[] = [];
  for (const slot of filledSlots(slots)) {
    const definition = catalog.units.find(
      (unit) => unit.unitDefinitionId === slot.unitDefinitionId,
    );
    if (definition === undefined) {
      continue;
    }
    if (!aptitudeMatches(slot.row, definition.positionAptitudes)) {
      violations.push({
        path: unitsPath(side),
        slotKey: slot.slotKey,
        code: "APTITUDE_MISMATCH",
        message: "適性外の配置です。サーバーが適性補正を適用します。",
        severity: "warning",
      });
    }
  }
  return violations;
}

function formationPath(side: Side): string {
  return side === "ally" ? "/allyFormation" : "/enemyFormation";
}

function isPositiveInteger(value: number | ""): boolean {
  return value !== "" && Number.isInteger(value) && value >= 1;
}

/**
 * UI-AC-024: 学園レベル9項目は1以上の整数。トグルOFFの陣営は送信対象から
 * 外れる（値は保持する）ため検証しない。
 */
function validateAcademyLevels(side: Side, enhancement: SideEnhancementInput): UiViolation[] {
  if (!enhancement.enabled) {
    return [];
  }
  const violations: UiViolation[] = [];
  for (const group of ["unitTypes", "attributes"] as const) {
    for (const [key, level] of Object.entries(enhancement.academyLevels[group])) {
      if (!isPositiveInteger(level)) {
        violations.push({
          path: `${formationPath(side)}/enhancement/academyLevels/${group}/${key}`,
          code: "ACADEMY_LEVEL_INVALID",
          message: "学園レベルは1以上の整数で入力してください。",
          severity: "error",
        });
      }
    }
  }
  return violations;
}

/**
 * ユニット強化の違反はslotKeyで枠を特定する。pathは送信DTOのindexを持たない
 * 固定文字列にし、ダイアログ側はslotKeyとpathの末尾で入力を対応づける
 * （サーバー違反のpathは`units/{n}/...`のindex付きになるため、
 * 表示側はどちらでも一致するsuffix照合を使う）。
 *
 * UI-CMP-014: トグルOFFの陣営は検証しない。OFFでも入力値をdraftへ保持するのが
 * 要件であり、`request-mapper.ts`がOFF側のユニット強化を出力しない以上、
 * 保持しているだけの値は送信内容に影響しない。ここで検証すると「編集後にOFFへ
 * 戻した」だけで送信が止まる。R-ENH-01 #3の「陣営指定なしのユニット指定」は
 * リクエスト生成側の構造で保証する（`03_API・データ連携設計.md`§6）。
 */
function validateUnitEnhancements(
  side: Side,
  slots: readonly FormationSlotInput[],
  enhancement: SideEnhancementInput,
): UiViolation[] {
  if (!enhancement.enabled) {
    return [];
  }
  const violations: UiViolation[] = [];
  for (const slot of slots) {
    const unitEnhancement = slot.enhancement;
    if (unitEnhancement === undefined) {
      continue;
    }
    if (!isPositiveInteger(unitEnhancement.level)) {
      violations.push({
        path: `${formationPath(side)}/units/enhancement/level`,
        slotKey: slot.slotKey,
        code: "UNIT_LEVEL_INVALID",
        message: "ユニットレベルは1以上の整数で入力してください。",
        severity: "error",
      });
    }
    const gearCount = unitEnhancement.gears.filter((gear) => gear !== undefined).length;
    if (gearCount > MAX_GEARS_PER_UNIT) {
      violations.push({
        path: `${formationPath(side)}/units/enhancement/gears`,
        slotKey: slot.slotKey,
        code: "GEAR_COUNT_OUT_OF_RANGE",
        message: "ギアは9枠まで設定できます。",
        severity: "error",
      });
    }
  }
  return violations;
}

export function validateDraft(
  draft: BattleDraft,
  catalog: BattleSimulationCatalogResponse,
): readonly UiViolation[] {
  return [
    ...validateUnitCount("ally", draft.allySlots),
    ...validateUnitCount("enemy", draft.enemySlots),
    ...validateDuplicatePositions("ally", draft.allySlots),
    ...validateDuplicatePositions("enemy", draft.enemySlots),
    ...validateMemoryCount("ally", draft.allyMemoryDefinitionIds),
    ...validateMemoryCount("enemy", draft.enemyMemoryDefinitionIds),
    ...validateTurnLimit(draft.turnLimit),
    ...validateUnitExistence("ally", draft.allySlots, catalog),
    ...validateUnitExistence("enemy", draft.enemySlots, catalog),
    ...validateMemoryExistence("ally", draft.allyMemoryDefinitionIds, catalog),
    ...validateMemoryExistence("enemy", draft.enemyMemoryDefinitionIds, catalog),
    ...validateAptitudeWarnings("ally", draft.allySlots, catalog),
    ...validateAptitudeWarnings("enemy", draft.enemySlots, catalog),
    ...validateAcademyLevels("ally", enhancementForSide(draft, "ally")),
    ...validateAcademyLevels("enemy", enhancementForSide(draft, "enemy")),
    ...validateUnitEnhancements("ally", draft.allySlots, enhancementForSide(draft, "ally")),
    ...validateUnitEnhancements("enemy", draft.enemySlots, enhancementForSide(draft, "enemy")),
  ];
}

export function selectCanSubmit(violations: readonly UiViolation[]): boolean {
  return !violations.some((violation) => violation.severity === "error");
}
