import { describe, expect, it } from "vitest";
import { validateExerciseDraft } from "./exercise-draft-validation.js";
import { selectCanSubmit } from "../formation/draft-validation.js";
import { createInitialDraft, slotKeyOf } from "../formation/types.js";
import type { BattleDraft, Side, UiColumn, UiRow } from "../formation/types.js";
import type { BattleSimulationCatalogResponse } from "../simulation/api-contract.js";

const catalog: BattleSimulationCatalogResponse = {
  schemaVersion: 1,
  catalogRevision: "rev-1",
  units: [
    {
      unitDefinitionId: "UNIT_ALLY",
      displayName: "味方",
      characterName: "Ally",
      attribute: "CUTE",
      unitType: "ATTACKER",
      role: "PHYSICAL_ATTACKER",
      positionAptitudes: ["FRONT"],
    },
    {
      unitDefinitionId: "UNIT_ENEMY",
      displayName: "敵",
      characterName: "Enemy",
      attribute: "SMART",
      unitType: "ATTACKER",
      role: "TANK",
      positionAptitudes: ["FRONT"],
    },
  ],
  memories: [{ memoryDefinitionId: "MEM_A", displayName: "メモリーA" }],
};

function withUnit(
  draft: BattleDraft,
  side: Side,
  row: UiRow,
  column: UiColumn,
  unitDefinitionId: string,
): BattleDraft {
  const slotKey = slotKeyOf(side, row, column);
  const map = (slots: BattleDraft["allySlots"]) =>
    slots.map((slot) => (slot.slotKey === slotKey ? { ...slot, unitDefinitionId } : slot));
  return side === "ally"
    ? { ...draft, allySlots: map(draft.allySlots) }
    : { ...draft, enemySlots: map(draft.enemySlots) };
}

function withMemory(draft: BattleDraft, side: Side, index: number, id: string): BattleDraft {
  const replace = (ids: readonly (string | undefined)[]) =>
    ids.map((current, position) => (position === index ? id : current));
  return side === "ally"
    ? { ...draft, allyMemoryDefinitionIds: replace(draft.allyMemoryDefinitionIds) }
    : { ...draft, enemyMemoryDefinitionIds: replace(draft.enemyMemoryDefinitionIds) };
}

function validExerciseDraft(): BattleDraft {
  let draft = createInitialDraft();
  draft = withUnit(draft, "ally", "FRONT", 0, "UNIT_ALLY");
  draft = withUnit(draft, "enemy", "FRONT", 0, "UNIT_ENEMY");
  return draft;
}

function codes(violations: readonly { readonly code: string }[]): readonly string[] {
  return violations.map((violation) => violation.code);
}

// UI-AC-020 / UI-API-014: 送信前検証で敵1体・敵メモリー0件を強制する。
describe("validateExerciseDraft", () => {
  it("accepts one ally and exactly one enemy", () => {
    const violations = validateExerciseDraft(validExerciseDraft(), catalog);

    expect(selectCanSubmit(violations)).toBe(true);
  });

  it("accepts five allies with six ally memories", () => {
    let draft = validExerciseDraft();
    draft = withUnit(draft, "ally", "FRONT", 1, "UNIT_ALLY");
    draft = withUnit(draft, "ally", "FRONT", 2, "UNIT_ALLY");
    draft = withUnit(draft, "ally", "REAR", 0, "UNIT_ALLY");
    draft = withUnit(draft, "ally", "REAR", 1, "UNIT_ALLY");
    for (let index = 0; index < 6; index += 1) {
      draft = withMemory(draft, "ally", index, "MEM_A");
    }

    expect(selectCanSubmit(validateExerciseDraft(draft, catalog))).toBe(true);
  });

  it("rejects a second enemy unit", () => {
    const draft = withUnit(validExerciseDraft(), "enemy", "FRONT", 1, "UNIT_ENEMY");

    const violations = validateExerciseDraft(draft, catalog);

    expect(codes(violations)).toContain("UNIT_COUNT_OUT_OF_RANGE");
    expect(selectCanSubmit(violations)).toBe(false);
  });

  it("rejects an empty enemy formation", () => {
    const draft = withUnit(createInitialDraft(), "ally", "FRONT", 0, "UNIT_ALLY");

    expect(selectCanSubmit(validateExerciseDraft(draft, catalog))).toBe(false);
  });

  it("rejects any enemy memory", () => {
    const draft = withMemory(validExerciseDraft(), "enemy", 0, "MEM_A");

    const violations = validateExerciseDraft(draft, catalog);

    expect(codes(violations)).toContain("MEMORY_COUNT_OUT_OF_RANGE");
    expect(selectCanSubmit(violations)).toBe(false);
  });

  // UI-AC-019: ターン上限は5固定で入力が存在しないため、draftの値を検証しない。
  it("does not validate the turn limit at all", () => {
    const draft = { ...validExerciseDraft(), turnLimit: "" as const };

    const violations = validateExerciseDraft(draft, catalog);

    expect(codes(violations)).not.toContain("TURN_LIMIT_INVALID");
    expect(selectCanSubmit(violations)).toBe(true);
  });

  it("keeps the shared rules: unknown definitions stay errors and off-aptitude stays a warning", () => {
    let draft = validExerciseDraft();
    draft = withUnit(draft, "ally", "REAR", 0, "UNIT_ALLY");
    draft = withUnit(draft, "ally", "REAR", 1, "UNIT_GONE");

    const violations = validateExerciseDraft(draft, catalog);

    expect(codes(violations)).toContain("UNKNOWN_DEFINITION");
    expect(violations.filter((v) => v.code === "APTITUDE_MISMATCH")[0]?.severity).toBe("warning");
  });
});
