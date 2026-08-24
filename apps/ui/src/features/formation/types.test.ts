import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXERCISE_RUN_COUNT,
  canOpenUnitEnhancementDialog,
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

  // Issue #539: 演習の実行モードは既定で単一実行。統計実行のパラメータは既定値を
  // 持ったまま眠り、モードを切り替えるまで送信にもボタンの活性にも効かない。
  it("starts the exercise execution in the single-run mode with the default run count", () => {
    const draft = createInitialDraft();

    expect(draft.exerciseExecution).toEqual({
      mode: "SINGLE",
      runCount: DEFAULT_EXERCISE_RUN_COUNT,
      seed: "",
    });
    expect(DEFAULT_EXERCISE_RUN_COUNT).toBe(100);
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

describe("createInitialDraft — レベルリンク (UI-AC-035)", () => {
  it("defaults the level link to off at level 200 on both sides", () => {
    const draft = createInitialDraft();

    expect(draft.allyEnhancement.levelLink).toEqual({ enabled: false, level: 200 });
    expect(draft.enemyEnhancement.levelLink).toEqual({ enabled: false, level: 200 });
  });
});

describe("enhancementForSide / createInitialUnitEnhancement", () => {
  it("selects the enhancement input matching the requested side", () => {
    const draft = createInitialDraft();

    expect(enhancementForSide(draft, "ally")).toBe(draft.allyEnhancement);
    expect(enhancementForSide(draft, "enemy")).toBe(draft.enemyEnhancement);
  });

  it("UI-AC-025: starts a unit enhancement at level 200 with nine empty gear slots", () => {
    const enhancement = createInitialUnitEnhancement();

    expect(enhancement.level).toBe(200);
    expect(enhancement.gears).toHaveLength(9);
    expect(enhancement.gears.every((gear) => gear === undefined)).toBe(true);
    // リンクからの除外は既定でOFF（置いただけの枠もリンク対象。UI-AC-035）。
    expect(enhancement.linkExcluded).toBe(false);
  });
});

describe("canOpenUnitEnhancementDialog", () => {
  it("allows opening the dialog once that side's enhancement toggle is on", () => {
    const base = createInitialDraft();
    const draft = { ...base, allyEnhancement: { ...base.allyEnhancement, enabled: true } };

    expect(canOpenUnitEnhancementDialog(draft, slotKeyOf("ally", "FRONT", 0))).toBe(true);
  });

  it("UI-CMP-015: refuses to open the dialog while that side's enhancement toggle is off", () => {
    const draft = createInitialDraft();

    expect(canOpenUnitEnhancementDialog(draft, slotKeyOf("ally", "FRONT", 0))).toBe(false);
  });

  it("checks the toggle of the slot's own side, not the other side", () => {
    const base = createInitialDraft();
    const draft = { ...base, allyEnhancement: { ...base.allyEnhancement, enabled: true } };

    expect(canOpenUnitEnhancementDialog(draft, slotKeyOf("enemy", "FRONT", 0))).toBe(false);
  });

  it("refuses an unknown slotKey", () => {
    const draft = createInitialDraft();

    expect(canOpenUnitEnhancementDialog(draft, "ally:FRONT:9")).toBe(false);
  });
});
