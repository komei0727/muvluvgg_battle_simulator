import { describe, expect, it } from "vitest";
import { buildBattleSimulationRequest } from "./request-mapper.js";
import { createInitialDraft, enhancementForSide, memorySlotKeyOf, slotKeyOf } from "./types.js";
import type { UnitEnhancementInput } from "./types.js";
import type { BattleDraft } from "./types.js";

function withUnit(
  draft: BattleDraft,
  side: "ally" | "enemy",
  row: "FRONT" | "REAR",
  column: 0 | 1 | 2,
  unitDefinitionId: string,
): BattleDraft {
  const slotKey = slotKeyOf(side, row, column);
  if (side === "ally") {
    return {
      ...draft,
      allySlots: draft.allySlots.map((slot) =>
        slot.slotKey === slotKey ? { ...slot, unitDefinitionId } : slot,
      ),
    };
  }
  return {
    ...draft,
    enemySlots: draft.enemySlots.map((slot) =>
      slot.slotKey === slotKey ? { ...slot, unitDefinitionId } : slot,
    ),
  };
}

function baseDraft(): BattleDraft {
  // Minimal valid draft: one ally unit, one enemy unit, so the mapper's
  // formation-level output can be asserted without unrelated noise.
  let draft = createInitialDraft();
  draft = withUnit(draft, "ally", "FRONT", 0, "UNIT_ALLY");
  draft = withUnit(draft, "enemy", "FRONT", 0, "UNIT_ENEMY");
  return draft;
}

describe("buildBattleSimulationRequest — position mapping (UI-UT-REQ-001)", () => {
  it("maps FRONT/REAR and column 0-2 directly onto the API position", () => {
    const result = buildBattleSimulationRequest(baseDraft());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.allyFormation.units).toEqual([
      { unitDefinitionId: "UNIT_ALLY", position: { column: 0, row: "FRONT" } },
    ]);
  });
});

describe("buildBattleSimulationRequest — REAR is never confused with BACK (UI-UT-REQ-002)", () => {
  it("sends row REAR (not the catalog aptitude label BACK) for a rear slot", () => {
    let draft = createInitialDraft();
    draft = withUnit(draft, "ally", "REAR", 1, "UNIT_ALLY");
    draft = withUnit(draft, "enemy", "FRONT", 0, "UNIT_ENEMY");

    const result = buildBattleSimulationRequest(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [unit] = result.request.allyFormation.units;
    expect(unit?.position.row).toBe("REAR");
  });
});

describe("buildBattleSimulationRequest — empty slots excluded (UI-UT-REQ-003)", () => {
  it("omits slots without a unitDefinitionId", () => {
    const result = buildBattleSimulationRequest(baseDraft());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.allyFormation.units).toHaveLength(1);
    expect(result.request.enemyFormation.units).toHaveLength(1);
  });
});

describe("buildBattleSimulationRequest — repeated definition id (UI-UT-REQ-004)", () => {
  it("outputs the same unitDefinitionId for multiple slots", () => {
    let draft = createInitialDraft();
    draft = withUnit(draft, "ally", "FRONT", 0, "UNIT_A");
    draft = withUnit(draft, "ally", "FRONT", 1, "UNIT_A");
    draft = withUnit(draft, "enemy", "FRONT", 0, "UNIT_ENEMY");

    const result = buildBattleSimulationRequest(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.allyFormation.units.map((u) => u.unitDefinitionId)).toEqual([
      "UNIT_A",
      "UNIT_A",
    ]);
  });
});

describe("buildBattleSimulationRequest — stable ordering (UI-UT-REQ-005)", () => {
  it("orders units FRONT column-ascending then REAR column-ascending regardless of input order", () => {
    let draft = createInitialDraft();
    draft = withUnit(draft, "ally", "REAR", 2, "UNIT_REAR_2");
    draft = withUnit(draft, "ally", "FRONT", 1, "UNIT_FRONT_1");
    draft = withUnit(draft, "ally", "REAR", 0, "UNIT_REAR_0");
    draft = withUnit(draft, "ally", "FRONT", 0, "UNIT_FRONT_0");
    draft = withUnit(draft, "enemy", "FRONT", 0, "UNIT_ENEMY");

    const result = buildBattleSimulationRequest(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.allyFormation.units.map((u) => u.unitDefinitionId)).toEqual([
      "UNIT_FRONT_0",
      "UNIT_FRONT_1",
      "UNIT_REAR_0",
      "UNIT_REAR_2",
    ]);
  });
});

describe("buildBattleSimulationRequest — no UI-only fields (UI-UT-REQ-006)", () => {
  it("only outputs the contract fields for units, formations, and the request root", () => {
    const result = buildBattleSimulationRequest(baseDraft());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.request).toSorted()).toEqual(
      ["allyFormation", "enemyFormation", "options", "turnLimit"].toSorted(),
    );
    expect(Object.keys(result.request.allyFormation).toSorted()).toEqual(
      ["memoryDefinitionIds", "units"].toSorted(),
    );
    const [unit] = result.request.allyFormation.units;
    expect(Object.keys(unit!).toSorted()).toEqual(["position", "unitDefinitionId"].toSorted());
    expect(Object.keys(unit!.position).toSorted()).toEqual(["column", "row"].toSorted());
  });

  it("sends turnLimit as a number and always includes options.logLevel", () => {
    const draft: BattleDraft = { ...baseDraft(), turnLimit: 42, logLevel: "DIAGNOSTIC" };

    const result = buildBattleSimulationRequest(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.turnLimit).toBe(42);
    expect(result.request.options).toEqual({ logLevel: "DIAGNOSTIC" });
  });
});

describe("buildBattleSimulationRequest — slot key backreference (UI-UT-REQ-007)", () => {
  it("returns ally/enemy slot keys index-aligned with the output units array", () => {
    let draft = createInitialDraft();
    draft = withUnit(draft, "ally", "REAR", 0, "UNIT_REAR_0");
    draft = withUnit(draft, "ally", "FRONT", 2, "UNIT_FRONT_2");
    draft = withUnit(draft, "enemy", "FRONT", 1, "UNIT_ENEMY");

    const result = buildBattleSimulationRequest(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.allyUnitSlotKeys).toEqual([
      slotKeyOf("ally", "FRONT", 2),
      slotKeyOf("ally", "REAR", 0),
    ]);
    expect(result.enemyUnitSlotKeys).toEqual([slotKeyOf("enemy", "FRONT", 1)]);
  });
});

describe("buildBattleSimulationRequest — memories", () => {
  it("filters undefined memory slots without reordering the remaining ids", () => {
    const draft: BattleDraft = {
      ...baseDraft(),
      allyMemoryDefinitionIds: [undefined, "MEM_B", undefined, "MEM_A", undefined, undefined],
    };

    const result = buildBattleSimulationRequest(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.allyFormation.memoryDefinitionIds).toEqual(["MEM_B", "MEM_A"]);
  });
});

describe("buildBattleSimulationRequest — memory slot key backreference (UI-UT-REQ-008)", () => {
  it("index-aligns memorySlotKeys with the compressed memoryDefinitionIds array, not the original UI index", () => {
    const draft: BattleDraft = {
      ...baseDraft(),
      // Only UI memory slot index 2 is filled: the API array compresses this
      // to memoryDefinitionIds[0], so the backreference must point at index 2
      // (memorySlotKeyOf("ally", 2)), not memorySlotKeyOf("ally", 0).
      allyMemoryDefinitionIds: [
        undefined,
        undefined,
        "MEM_SPARSE",
        undefined,
        undefined,
        undefined,
      ],
    };

    const result = buildBattleSimulationRequest(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.allyFormation.memoryDefinitionIds).toEqual(["MEM_SPARSE"]);
    expect(result.allyMemorySlotKeys).toEqual([memorySlotKeyOf("ally", 2)]);
  });

  it("index-aligns memorySlotKeys for multiple sparse memory slots on both sides", () => {
    const draft: BattleDraft = {
      ...baseDraft(),
      allyMemoryDefinitionIds: [undefined, "MEM_B", undefined, "MEM_A", undefined, undefined],
      enemyMemoryDefinitionIds: [undefined, undefined, undefined, undefined, undefined, "MEM_E"],
    };

    const result = buildBattleSimulationRequest(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.allyMemorySlotKeys).toEqual([
      memorySlotKeyOf("ally", 1),
      memorySlotKeyOf("ally", 3),
    ]);
    expect(result.enemyMemorySlotKeys).toEqual([memorySlotKeyOf("enemy", 5)]);
  });
});

describe("buildBattleSimulationRequest — invalid turnLimit", () => {
  it("returns ok:false when turnLimit is the empty-input sentinel", () => {
    const draft: BattleDraft = { ...baseDraft(), turnLimit: "" };

    const result = buildBattleSimulationRequest(draft);

    expect(result.ok).toBe(false);
  });
});

function withSlotEnhancement(
  draft: BattleDraft,
  side: "ally" | "enemy",
  row: "FRONT" | "REAR",
  column: 0 | 1 | 2,
  enhancement: UnitEnhancementInput,
): BattleDraft {
  const slotKey = slotKeyOf(side, row, column);
  const replace = (slots: BattleDraft["allySlots"]) =>
    slots.map((slot) => (slot.slotKey === slotKey ? { ...slot, enhancement } : slot));
  return side === "ally"
    ? { ...draft, allySlots: replace(draft.allySlots) }
    : { ...draft, enemySlots: replace(draft.enemySlots) };
}

function enabledSide(draft: BattleDraft, side: "ally" | "enemy"): BattleDraft {
  const enhancement = { ...enhancementForSide(draft, side), enabled: true };
  return side === "ally"
    ? { ...draft, allyEnhancement: enhancement }
    : { ...draft, enemyEnhancement: enhancement };
}

describe("buildBattleSimulationRequest — 強化指定 (UI-API-017/018)", () => {
  it("UI-API-017: emits no enhancement property at all while both toggles are off, even after the inputs were edited", () => {
    let draft = baseDraft();
    draft = withSlotEnhancement(draft, "ally", "FRONT", 0, {
      level: 220,
      gears: [{ stat: "ATTACK", tier: "III", grade: "S" }, ...Array<undefined>(8).fill(undefined)],
    });
    draft = {
      ...draft,
      allyEnhancement: {
        enabled: false,
        academyLevels: {
          ...draft.allyEnhancement.academyLevels,
          unitTypes: { ...draft.allyEnhancement.academyLevels.unitTypes, PHYSICAL: 50 },
        },
      },
    };

    const result = buildBattleSimulationRequest(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.allyFormation).not.toHaveProperty("enhancement");
    expect(result.request.allyFormation.units[0]).not.toHaveProperty("enhancement");
    expect(result.request.enemyFormation).not.toHaveProperty("enhancement");
  });

  it("UI-API-018: emits all nine academy levels, including the ones still at the default", () => {
    const draft = enabledSide(baseDraft(), "ally");

    const result = buildBattleSimulationRequest(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.allyFormation.enhancement).toEqual({
      academyLevels: {
        unitTypes: { PHYSICAL: 1, ENERGY: 1, AGILE: 1 },
        attributes: { AGGRESSIVE: 1, SHY: 1, CUTE: 1, SMART: 1, COMICAL: 1, CLEVER: 1 },
      },
    });
    // 敵陣営はトグルOFFのままなので独立して従来どおり。
    expect(result.request.enemyFormation).not.toHaveProperty("enhancement");
  });

  it("UI-API-018: drops empty gear slots and keeps the remaining gears in slot order", () => {
    let draft = enabledSide(baseDraft(), "ally");
    draft = withSlotEnhancement(draft, "ally", "FRONT", 0, {
      level: 220,
      gears: [
        undefined,
        { stat: "ATTACK", tier: "III", grade: "S" },
        undefined,
        { stat: "MAXIMUM_HP", tier: "II", grade: "D" },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ],
    });

    const result = buildBattleSimulationRequest(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.allyFormation.units[0]?.enhancement).toEqual({
      level: 220,
      gears: [
        { stat: "ATTACK", tier: "III", grade: "S" },
        { stat: "MAXIMUM_HP", tier: "II", grade: "D" },
      ],
    });
    // §13: 送信配列のgears[m]から元のギア枠indexを逆引きできる表を保持する。
    expect(result.allyGearSlotIndices).toEqual([[1, 3]]);
  });

  it("omits a unit enhancement that is level 200 with no gears, since it equals the default", () => {
    let draft = enabledSide(baseDraft(), "ally");
    draft = withSlotEnhancement(draft, "ally", "FRONT", 0, {
      level: 200,
      gears: Array(9).fill(undefined),
    });

    const result = buildBattleSimulationRequest(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.allyFormation.units[0]).not.toHaveProperty("enhancement");
    expect(result.request.allyFormation).toHaveProperty("enhancement");
    expect(result.allyGearSlotIndices).toEqual([[]]);
  });

  it("refuses to build while an enabled side has a blank academy level or unit level", () => {
    const blankAcademyLevel = {
      ...enabledSide(baseDraft(), "ally"),
    };
    expect(
      buildBattleSimulationRequest({
        ...blankAcademyLevel,
        allyEnhancement: {
          ...blankAcademyLevel.allyEnhancement,
          academyLevels: {
            ...blankAcademyLevel.allyEnhancement.academyLevels,
            unitTypes: { ...blankAcademyLevel.allyEnhancement.academyLevels.unitTypes, AGILE: "" },
          },
        },
      }).ok,
    ).toBe(false);

    const blankUnitLevel = withSlotEnhancement(
      enabledSide(baseDraft(), "ally"),
      "ally",
      "FRONT",
      0,
      {
        level: "",
        gears: Array(9).fill(undefined),
      },
    );
    expect(buildBattleSimulationRequest(blankUnitLevel).ok).toBe(false);
  });
});
