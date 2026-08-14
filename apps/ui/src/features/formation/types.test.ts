import { describe, expect, it } from "vitest";
import {
  createInitialDraft,
  createInitialUnitEnhancement,
  enhancementForSide,
  memorySlotsForSide,
  slotKeyOf,
  slotsForSide,
} from "./types.js";

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

  // ログ方針刷新2/3（Issue #464）: 既定は編成比較のための通常実行。詳細ログは
  // 効果発動を追うときだけ明示的に選ぶ。
  it("defaults turnLimit to 10 and logLevel to SUMMARY", () => {
    const draft = createInitialDraft();

    expect(draft.turnLimit).toBe(10);
    expect(draft.logLevel).toBe("SUMMARY");
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

describe("createInitialDraft — 強化入力 (M11, UI-AC-023)", () => {
  it("defaults both sides' enhancement toggle to off with every academy level at 1", () => {
    const draft = createInitialDraft();

    expect(draft.allyEnhancement.enabled).toBe(false);
    expect(draft.enemyEnhancement.enabled).toBe(false);
    expect(draft.allyEnhancement.academyLevels.unitTypes).toEqual({
      PHYSICAL: 1,
      ENERGY: 1,
      AGILE: 1,
    });
    expect(draft.allyEnhancement.academyLevels.attributes).toEqual({
      AGGRESSIVE: 1,
      SHY: 1,
      CUTE: 1,
      SMART: 1,
      COMICAL: 1,
      CLEVER: 1,
    });
  });

  it("leaves every unit slot without a unit enhancement until it is edited", () => {
    const draft = createInitialDraft();

    expect(draft.allySlots.every((slot) => slot.enhancement === undefined)).toBe(true);
  });
});

describe("enhancementForSide / createInitialUnitEnhancement", () => {
  it("selects the enhancement input matching the requested side", () => {
    const draft = createInitialDraft();

    expect(enhancementForSide(draft, "ally")).toBe(draft.allyEnhancement);
    expect(enhancementForSide(draft, "enemy")).toBe(draft.enemyEnhancement);
  });

  it("starts a unit enhancement at level 200 with nine empty gear slots (UI-AC-025)", () => {
    const enhancement = createInitialUnitEnhancement();

    expect(enhancement.level).toBe(200);
    expect(enhancement.gears).toHaveLength(9);
    expect(enhancement.gears.every((gear) => gear === undefined)).toBe(true);
  });
});
