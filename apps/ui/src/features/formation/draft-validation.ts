// Mirrors docs/ui-design/03_API・データ連携設計.md §6 (client validation table)
// and docs/ui-design/04_コンポーネント・状態管理設計.md §9 (UiViolation shape).

import { aptitudeMatches } from "../../lib/aptitude.js";
import type { BattleSimulationCatalogResponse } from "../simulation/api-contract.js";
import { memorySlotKeyOf } from "./types.js";
import type { BattleDraft, FormationSlotInput, Side } from "./types.js";

export type UiViolationSeverity = "error" | "warning";

export interface UiViolation {
  readonly path: string;
  readonly slotKey?: string;
  readonly code: string;
  readonly message: string;
  readonly severity: UiViolationSeverity;
}

const MIN_UNITS_PER_SIDE = 1;
const MAX_UNITS_PER_SIDE = 5;
const MAX_MEMORIES_PER_SIDE = 6;
const MIN_TURN_LIMIT = 1;
const MAX_TURN_LIMIT = 99;

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

function validateUnitSelectability(
  side: Side,
  slots: readonly FormationSlotInput[],
  catalog: BattleSimulationCatalogResponse,
): UiViolation[] {
  const violations: UiViolation[] = [];
  for (const slot of filledSlots(slots)) {
    const definition = catalog.units.find(
      (unit) => unit.unitDefinitionId === slot.unitDefinitionId,
    );
    if (definition === undefined || !definition.selectable) {
      violations.push({
        path: unitsPath(side),
        slotKey: slot.slotKey,
        code: "UNSUPPORTED_DEFINITION",
        message: "未対応の戦闘ルールを必要とする定義は選択できません。",
        severity: "error",
      });
    }
  }
  return violations;
}

function validateMemorySelectability(
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
    if (definition === undefined || !definition.selectable) {
      violations.push({
        path: `${memoriesPath(side)}/${index}`,
        slotKey: memorySlotKeyOf(side, index),
        code: "UNSUPPORTED_DEFINITION",
        message: "未対応の戦闘ルールを必要とする定義は選択できません。",
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
    ...validateUnitSelectability("ally", draft.allySlots, catalog),
    ...validateUnitSelectability("enemy", draft.enemySlots, catalog),
    ...validateMemorySelectability("ally", draft.allyMemoryDefinitionIds, catalog),
    ...validateMemorySelectability("enemy", draft.enemyMemoryDefinitionIds, catalog),
    ...validateAptitudeWarnings("ally", draft.allySlots, catalog),
    ...validateAptitudeWarnings("enemy", draft.enemySlots, catalog),
  ];
}

export function selectCanSubmit(violations: readonly UiViolation[]): boolean {
  return !violations.some((violation) => violation.severity === "error");
}
