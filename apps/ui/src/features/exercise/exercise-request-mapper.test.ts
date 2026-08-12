import { describe, expect, it } from "vitest";
import { buildTacticalExerciseRequest } from "./exercise-request-mapper.js";
import { createInitialDraft, memorySlotKeyOf, slotKeyOf } from "../formation/types.js";
import type { BattleDraft, Side, UiColumn, UiRow } from "../formation/types.js";

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

function exerciseDraft(): BattleDraft {
  let draft = createInitialDraft();
  draft = withUnit(draft, "ally", "FRONT", 0, "UNIT_ALLY");
  draft = withUnit(draft, "enemy", "FRONT", 0, "UNIT_ENEMY");
  return draft;
}

// UI-CT-029 / UI-API-014: 演習リクエストは`turnLimit`を持たず、敵1体・敵メモリー
// 0件のペイロードを生成する。
describe("buildTacticalExerciseRequest", () => {
  it("builds a payload with no turnLimit property at all", () => {
    const result = buildTacticalExerciseRequest(exerciseDraft());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request).not.toHaveProperty("turnLimit");
    expect(Object.keys(result.request).toSorted()).toEqual([
      "allyFormation",
      "enemyFormation",
      "options",
    ]);
  });

  it("sends exactly one enemy unit and an empty enemy memory array", () => {
    const result = buildTacticalExerciseRequest(exerciseDraft());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.enemyFormation).toEqual({
      units: [{ unitDefinitionId: "UNIT_ENEMY", position: { column: 0, row: "FRONT" } }],
      memoryDefinitionIds: [],
    });
  });

  it("carries the ally formation and memories through unchanged", () => {
    let draft = exerciseDraft();
    draft = withUnit(draft, "ally", "REAR", 2, "UNIT_ALLY_2");
    draft = withMemory(draft, "ally", 1, "MEM_A");

    const result = buildTacticalExerciseRequest(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.allyFormation.units).toEqual([
      { unitDefinitionId: "UNIT_ALLY", position: { column: 0, row: "FRONT" } },
      { unitDefinitionId: "UNIT_ALLY_2", position: { column: 2, row: "REAR" } },
    ]);
    expect(result.request.allyFormation.memoryDefinitionIds).toEqual(["MEM_A"]);
    expect(result.allyMemorySlotKeys).toEqual([memorySlotKeyOf("ally", 1)]);
  });

  it("keeps the log level from the draft", () => {
    const result = buildTacticalExerciseRequest({ ...exerciseDraft(), logLevel: "SUMMARY" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.options).toEqual({ logLevel: "SUMMARY" });
  });

  it("ignores the draft turnLimit even when it is blank", () => {
    const result = buildTacticalExerciseRequest({ ...exerciseDraft(), turnLimit: "" });

    expect(result.ok).toBe(true);
  });

  it("refuses to build a payload with two enemy units", () => {
    const draft = withUnit(exerciseDraft(), "enemy", "FRONT", 1, "UNIT_ENEMY_2");

    expect(buildTacticalExerciseRequest(draft).ok).toBe(false);
  });

  it("refuses to build a payload with no enemy unit", () => {
    const draft = createInitialDraft();

    expect(buildTacticalExerciseRequest(withUnit(draft, "ally", "FRONT", 0, "UNIT_ALLY")).ok).toBe(
      false,
    );
  });

  it("refuses to build a payload carrying an enemy memory", () => {
    const draft = withMemory(exerciseDraft(), "enemy", 0, "MEM_E");

    expect(buildTacticalExerciseRequest(draft).ok).toBe(false);
  });
});
