import { describe, expect, it } from "vitest";
import {
  buildBattleSimulationRequest,
  buildFormationStatPreviewRequest,
} from "./request-mapper.js";
import type { BattleDraft, GearInput, UnitEnhancementInput } from "../../entities/battle-draft.js";
import { createInitialDraft, enhancementForSide, memorySlotKeyOf, slotKeyOf } from "./types.js";

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
    const draft: BattleDraft = { ...baseDraft(), turnLimit: 42, logLevel: "DETAILED" };

    const result = buildBattleSimulationRequest(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.turnLimit).toBe(42);
    expect(result.request.options).toEqual({ logLevel: "DETAILED" });
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

function unitEnhancement(
  level: number | "",
  gears: readonly (GearInput | undefined)[],
  linkExcluded = false,
): UnitEnhancementInput {
  return { level, linkExcluded, gears };
}

/** 陣営強化トグルONに加えてレベルリンクをONにする。 */
function linkedSide(draft: BattleDraft, side: "ally" | "enemy", level: number | ""): BattleDraft {
  const enabled = enabledSide(draft, side);
  const enhancement = {
    ...enhancementForSide(enabled, side),
    levelLink: { enabled: true, level },
  };
  return side === "ally"
    ? { ...enabled, allyEnhancement: enhancement }
    : { ...enabled, enemyEnhancement: enhancement };
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
      linkExcluded: false,
      gears: [{ stat: "ATTACK", tier: "III", grade: "S" }, ...Array<undefined>(8).fill(undefined)],
    });
    draft = {
      ...draft,
      allyEnhancement: {
        enabled: false,
        levelLink: { enabled: false, level: 200 },
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

  it("UI-API-032: drops empty gear slots and keeps the remaining gears in slot order", () => {
    let draft = enabledSide(baseDraft(), "ally");
    draft = withSlotEnhancement(draft, "ally", "FRONT", 0, {
      level: 220,
      linkExcluded: false,
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
      linkExcluded: false,
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
      unitEnhancement("", Array(9).fill(undefined)),
    );
    expect(buildBattleSimulationRequest(blankUnitLevel).ok).toBe(false);
  });
});

describe("buildBattleSimulationRequest — レベルリンク (UI-UT-REQ-009〜012)", () => {
  const gear = { stat: "ATTACK", tier: "III", grade: "S" } as const;

  /** 味方2体。2体目は強化入力を一度も開いていない枠として使う。 */
  function twoAllies(): BattleDraft {
    return withUnit(baseDraft(), "ally", "FRONT", 1, "UNIT_ALLY_2");
  }

  // UI-UT-REQ-009
  it("resolves every slot to the link level, including one whose enhancement was never opened", () => {
    let draft = linkedSide(twoAllies(), "ally", 260);
    draft = withSlotEnhancement(
      draft,
      "ally",
      "FRONT",
      0,
      unitEnhancement(180, Array(9).fill(gear).fill(undefined, 1)),
    );

    const result = buildBattleSimulationRequest(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [first, second] = result.request.allyFormation.units;
    expect(first?.enhancement).toEqual({ level: 260, gears: [gear] });
    // 強化入力を一度も開いていない枠もリンク対象（UI-API-024）。
    expect(second?.enhancement).toEqual({ level: 260, gears: [] });
    expect(result.allyGearSlotIndices).toEqual([[0], []]);
  });

  // UI-UT-REQ-010
  it("keeps the slot's own level for an excluded slot while the others follow the link", () => {
    let draft = linkedSide(twoAllies(), "ally", 260);
    draft = withSlotEnhancement(
      draft,
      "ally",
      "FRONT",
      0,
      unitEnhancement(180, Array(9).fill(undefined), true),
    );

    const result = buildBattleSimulationRequest(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [first, second] = result.request.allyFormation.units;
    expect(first?.enhancement).toEqual({ level: 180, gears: [] });
    expect(second?.enhancement).toEqual({ level: 260, gears: [] });
  });

  // UI-UT-REQ-011
  it("never emits levelLink or linkExcluded, and keeps the link-off payload identical", () => {
    let linkOff = enabledSide(baseDraft(), "ally");
    linkOff = withSlotEnhancement(
      linkOff,
      "ally",
      "FRONT",
      0,
      unitEnhancement(180, Array(9).fill(undefined)),
    );
    const linkOn = linkedSide(linkOff, "ally", 180);

    const off = buildBattleSimulationRequest(linkOff);
    const on = buildBattleSimulationRequest(linkOn);

    expect(off.ok && on.ok).toBe(true);
    if (!off.ok || !on.ok) return;
    expect(JSON.stringify(off.request)).not.toContain("levelLink");
    expect(JSON.stringify(off.request)).not.toContain("linkExcluded");
    expect(JSON.stringify(on.request)).not.toContain("levelLink");
    // 同じ実効レベルなら送信内容も同じになる（リンクは送信DTOを変えない）。
    expect(on.request.allyFormation.units[0]).toEqual(off.request.allyFormation.units[0]);
  });

  it("omits the enhancement of a linked slot resolved to level 200 with no gears", () => {
    const draft = linkedSide(twoAllies(), "ally", 200);

    const result = buildBattleSimulationRequest(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.allyFormation.units[0]).not.toHaveProperty("enhancement");
    expect(result.request.allyFormation).toHaveProperty("enhancement");
  });

  it("ignores the link while the side enhancement toggle is off", () => {
    const linked = linkedSide(twoAllies(), "ally", 260);
    const draft = {
      ...linked,
      allyEnhancement: { ...linked.allyEnhancement, enabled: false },
    };

    const result = buildBattleSimulationRequest(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.allyFormation).not.toHaveProperty("enhancement");
    expect(result.request.allyFormation.units[0]).not.toHaveProperty("enhancement");
  });

  // UI-UT-REQ-012
  it("falls back to each slot's own level while the link level is unusable", () => {
    let draft = linkedSide(twoAllies(), "ally", "");
    draft = withSlotEnhancement(
      draft,
      "ally",
      "FRONT",
      0,
      unitEnhancement(180, Array(9).fill(undefined)),
    );

    const result = buildBattleSimulationRequest(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [first, second] = result.request.allyFormation.units;
    expect(first?.enhancement).toEqual({ level: 180, gears: [] });
    // 未編集の枠は既定200のままなので、既定と同値の強化は出力しない。
    expect(second).not.toHaveProperty("enhancement");
  });
});

describe("buildFormationStatPreviewRequest (UI-UT-REQ-008)", () => {
  it("sends the same formations and enhancement as the battle request, without turnLimit or options", () => {
    const draft = enabledSide(baseDraft(), "ally");
    const battle = buildBattleSimulationRequest(draft);
    const preview = buildFormationStatPreviewRequest(draft);

    expect(battle.ok).toBe(true);
    expect(preview.ok).toBe(true);
    if (!battle.ok || !preview.ok) return;
    expect(preview.request).toEqual({
      allyFormation: battle.request.allyFormation,
      enemyFormation: battle.request.enemyFormation,
    });
  });

  // R-TEX-11 #5: プレビューも編成プール検証を受けるため、演習では戦闘モードを
  // 明示する。省略時の`NORMAL`は送らない（サーバー既定と同じ意味になる）。
  it("carries the tactical exercise mode and omits it for a normal battle", () => {
    const draft = baseDraft();

    const normal = buildFormationStatPreviewRequest(draft);
    const exercise = buildFormationStatPreviewRequest(draft, "TACTICAL_EXERCISE");

    expect(normal.ok).toBe(true);
    expect(exercise.ok).toBe(true);
    if (!normal.ok || !exercise.ok) return;
    expect(normal.request).not.toHaveProperty("mode");
    expect(exercise.request.mode).toBe("TACTICAL_EXERCISE");
  });

  it("keeps the per-side slot key tables so response entries can be mapped back to slots", () => {
    let draft = baseDraft();
    draft = withUnit(draft, "ally", "REAR", 2, "UNIT_ALLY_2");

    const preview = buildFormationStatPreviewRequest(draft);

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.allyUnitSlotKeys).toEqual([
      slotKeyOf("ally", "FRONT", 0),
      slotKeyOf("ally", "REAR", 2),
    ]);
    expect(preview.enemyUnitSlotKeys).toEqual([slotKeyOf("enemy", "FRONT", 0)]);
  });

  it("builds even when the turn limit is blank, because the preview does not run a battle", () => {
    const preview = buildFormationStatPreviewRequest({ ...baseDraft(), turnLimit: "" });

    expect(preview.ok).toBe(true);
  });

  it("refuses to build when no unit is placed, so an empty formation is not sent to the server", () => {
    expect(buildFormationStatPreviewRequest(createInitialDraft()).ok).toBe(false);
  });
});

describe("buildFormationStatPreviewRequest — 片側だけの編成 (UI-UT-REQ-008)", () => {
  it("sends the side that is filled while the other one is still empty, which is the state the screen is in mid-edit", () => {
    let draft = createInitialDraft();
    draft = withUnit(draft, "ally", "FRONT", 0, "UNIT_ALLY");

    const preview = buildFormationStatPreviewRequest(draft);

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.request.allyFormation.units).toHaveLength(1);
    expect(preview.request.enemyFormation.units).toEqual([]);
    expect(preview.enemyUnitSlotKeys).toEqual([]);
  });
});
