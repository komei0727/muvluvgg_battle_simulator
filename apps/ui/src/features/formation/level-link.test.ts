import { describe, expect, it } from "vitest";
import { isLevelLinked, isSlotLevelLinked, resolveSlotLevel } from "./level-link.js";
import { createInitialDraft, createInitialUnitEnhancement, slotKeyOf } from "./types.js";
import type { FormationSlotInput, SideEnhancementInput, UnitEnhancementInput } from "./types.js";

function sideEnhancement(overrides: Partial<SideEnhancementInput> = {}): SideEnhancementInput {
  return { ...createInitialDraft().allyEnhancement, enabled: true, ...overrides };
}

function slot(enhancement?: UnitEnhancementInput): FormationSlotInput {
  const base = createInitialDraft().allySlots.find(
    (candidate) => candidate.slotKey === slotKeyOf("ally", "FRONT", 0),
  );
  if (base === undefined) {
    throw new Error("unreachable: the initial draft always has a FRONT 0 ally slot");
  }
  return enhancement === undefined ? base : { ...base, enhancement };
}

describe("resolveSlotLevel (UI-UT-REQ-009〜012)", () => {
  it("uses the slot's own level while the link is off", () => {
    const enhancement = { ...createInitialUnitEnhancement(), level: 180 };

    expect(resolveSlotLevel(slot(enhancement), sideEnhancement())).toBe(180);
  });

  it("uses the link level for a slot that is not excluded", () => {
    const enhancement = { ...createInitialUnitEnhancement(), level: 180 };
    const side = sideEnhancement({ levelLink: { enabled: true, level: 260 } });

    expect(resolveSlotLevel(slot(enhancement), side)).toBe(260);
  });

  it("keeps the slot's own level for an excluded slot", () => {
    const enhancement = { ...createInitialUnitEnhancement(), level: 180, linkExcluded: true };
    const side = sideEnhancement({ levelLink: { enabled: true, level: 260 } });

    expect(resolveSlotLevel(slot(enhancement), side)).toBe(180);
  });

  it("links a slot whose enhancement was never opened (UI-API-024)", () => {
    const side = sideEnhancement({ levelLink: { enabled: true, level: 260 } });

    expect(resolveSlotLevel(slot(), side)).toBe(260);
  });

  it("falls back to the default level for an unopened slot while the link is off", () => {
    expect(resolveSlotLevel(slot(), sideEnhancement())).toBe(200);
  });

  it("ignores the link entirely while the side enhancement toggle is off", () => {
    const enhancement = { ...createInitialUnitEnhancement(), level: 180 };
    const side = sideEnhancement({ enabled: false, levelLink: { enabled: true, level: 260 } });

    expect(resolveSlotLevel(slot(enhancement), side)).toBe(180);
  });

  it.each([["" as const], [0], [1.5], [-1]])(
    "falls back to the slot's own level while the link level is %p",
    (level) => {
      const enhancement = { ...createInitialUnitEnhancement(), level: 180 };
      const side = sideEnhancement({ levelLink: { enabled: true, level } });

      expect(resolveSlotLevel(slot(enhancement), side)).toBe(180);
    },
  );
});

describe("isLevelLinked / isSlotLevelLinked", () => {
  it("reports a linked slot regardless of whether the link level is usable", () => {
    // 免除（UNIT_LEVEL_INVALID）と読み取り専用表示はリンクレベルの妥当性を見ない。
    // 見ると、リンクレベルを打ち直すために消した瞬間に各枠の入力途中の`""`が
    // 一斉に違反として現れる。
    const side = sideEnhancement({ levelLink: { enabled: true, level: "" } });

    expect(isSlotLevelLinked(slot(), side)).toBe(true);
    expect(isLevelLinked(createInitialUnitEnhancement(), side)).toBe(true);
  });

  it("reports an excluded slot as not linked", () => {
    const enhancement = { ...createInitialUnitEnhancement(), linkExcluded: true };
    const side = sideEnhancement({ levelLink: { enabled: true, level: 260 } });

    expect(isSlotLevelLinked(slot(enhancement), side)).toBe(false);
    expect(isLevelLinked(enhancement, side)).toBe(false);
  });

  it("reports not linked while the link or the side toggle is off", () => {
    const linkOff = sideEnhancement();
    const sideOff = sideEnhancement({ enabled: false, levelLink: { enabled: true, level: 260 } });

    expect(isSlotLevelLinked(slot(), linkOff)).toBe(false);
    expect(isSlotLevelLinked(slot(), sideOff)).toBe(false);
    expect(isLevelLinked(undefined, sideOff)).toBe(false);
  });
});
