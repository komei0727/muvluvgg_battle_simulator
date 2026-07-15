import { describe, expect, it } from "vitest";
import { createInitialDraft, memorySlotsForSide, slotKeyOf, slotsForSide } from "./types.js";

describe("slotKeyOf", () => {
  it("builds a stable key from side, row, and column", () => {
    expect(slotKeyOf("ally", "FRONT", 0)).toBe("ally:FRONT:0");
    expect(slotKeyOf("enemy", "REAR", 2)).toBe("enemy:REAR:2");
  });
});

describe("createInitialDraft", () => {
  it("creates exactly 6 distinct slots per side covering FRONT/REAR x column 0-2", () => {
    const draft = createInitialDraft();

    expect(draft.allySlots).toHaveLength(6);
    expect(draft.enemySlots).toHaveLength(6);
    expect(new Set(draft.allySlots.map((slot) => slot.slotKey)).size).toBe(6);
    expect(draft.allySlots.every((slot) => slot.unitDefinitionId === undefined)).toBe(true);
  });

  it("creates 6 empty memory slots per side", () => {
    const draft = createInitialDraft();

    expect(draft.allyMemoryDefinitionIds).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(draft.enemyMemoryDefinitionIds).toHaveLength(6);
  });

  it("defaults turnLimit to 10 and logLevel to DETAILED", () => {
    const draft = createInitialDraft();

    expect(draft.turnLimit).toBe(10);
    expect(draft.logLevel).toBe("DETAILED");
  });
});

describe("slotsForSide / memorySlotsForSide", () => {
  it("selects the slots and memory ids matching the requested side", () => {
    const draft = createInitialDraft();

    expect(slotsForSide(draft, "ally")).toBe(draft.allySlots);
    expect(slotsForSide(draft, "enemy")).toBe(draft.enemySlots);
    expect(memorySlotsForSide(draft, "ally")).toBe(draft.allyMemoryDefinitionIds);
    expect(memorySlotsForSide(draft, "enemy")).toBe(draft.enemyMemoryDefinitionIds);
  });
});
