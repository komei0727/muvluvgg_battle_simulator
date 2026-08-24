import { describe, expect, it } from "vitest";
import { withPlayerEnhancement } from "./effective-draft.js";
import { createEmptyPlayerData } from "./persistence.js";
import { createInitialDraft, createInitialUnitEnhancement, slotKeyOf } from "./types.js";
import type { PlayerEnhancementState } from "./player-enhancement-reducer.js";

function withAllyUnit(unitDefinitionId: string) {
  const base = createInitialDraft();
  const slotKey = slotKeyOf("ally", "FRONT", 0);
  return {
    ...base,
    allySlots: base.allySlots.map((slot) =>
      slot.slotKey === slotKey ? { ...slot, unitDefinitionId } : slot,
    ),
  };
}

describe("withPlayerEnhancement", () => {
  it("overlays the ally academy levels and level link onto the draft", () => {
    const draft = createInitialDraft();
    const playerEnhancement: PlayerEnhancementState = {
      ...createEmptyPlayerData(),
      academyLevels: {
        unitTypes: { PHYSICAL: 5, ENERGY: 6, AGILE: 7 },
        attributes: { AGGRESSIVE: 1, SHY: 2, CUTE: 3, SMART: 4, COMICAL: 5, CLEVER: 6 },
      },
      levelLink: { enabled: true, level: 250 },
    };

    const effective = withPlayerEnhancement(draft, playerEnhancement);

    expect(effective.allyEnhancement.academyLevels).toStrictEqual(playerEnhancement.academyLevels);
    expect(effective.allyEnhancement.levelLink).toStrictEqual({ enabled: true, level: 250 });
  });

  it("keeps the draft's own ally enhancement toggle (UI-AC-030: not mode-independent)", () => {
    const base = createInitialDraft();
    const draft = { ...base, allyEnhancement: { ...base.allyEnhancement, enabled: true } };

    const effective = withPlayerEnhancement(draft, createEmptyPlayerData());

    expect(effective.allyEnhancement.enabled).toBe(true);
  });

  it("resolves an ally slot's unit enhancement by unitDefinitionId", () => {
    const draft = withAllyUnit("UNIT_A");
    const enhancement = { ...createInitialUnitEnhancement(), level: 220 };
    const playerEnhancement: PlayerEnhancementState = {
      ...createEmptyPlayerData(),
      units: { UNIT_A: enhancement },
    };

    const effective = withPlayerEnhancement(draft, playerEnhancement);

    const slot = effective.allySlots.find((s) => s.slotKey === slotKeyOf("ally", "FRONT", 0));
    expect(slot?.enhancement).toStrictEqual(enhancement);
  });

  it("leaves an ally slot's enhancement undefined when the unit has no recorded growth data", () => {
    const draft = withAllyUnit("UNIT_UNRECORDED");

    const effective = withPlayerEnhancement(draft, createEmptyPlayerData());

    const slot = effective.allySlots.find((s) => s.slotKey === slotKeyOf("ally", "FRONT", 0));
    expect(slot?.enhancement).toBeUndefined();
  });

  // レビュー指摘の回帰テスト: REF-058以前に保存されたdraft（味方slotが
  // `enhancement`を直接持つ形式）を復元し、かつ手持ちデータが空（＝「保存した
  // 育成データをクリア」直後、または移行前にそもそも記録が無い場合）でも、
  // モード別draftに残った旧値が実効編成へ漏れてはならない。
  it("strips a stale enhancement left on the ally slot by a pre-REF-058 saved draft once the shared slice has no record", () => {
    const draft = withAllyUnit("UNIT_A");
    const slotKey = slotKeyOf("ally", "FRONT", 0);
    const staleDraft = {
      ...draft,
      allySlots: draft.allySlots.map((slot) =>
        slot.slotKey === slotKey
          ? { ...slot, enhancement: { ...createInitialUnitEnhancement(), level: 999 } }
          : slot,
      ),
    };

    const effective = withPlayerEnhancement(staleDraft, createEmptyPlayerData());

    const slot = effective.allySlots.find((s) => s.slotKey === slotKey);
    expect(slot?.enhancement).toBeUndefined();
  });

  it("shows the same recorded enhancement on every ally slot holding the same unit", () => {
    const base = createInitialDraft();
    const firstSlotKey = slotKeyOf("ally", "FRONT", 0);
    const secondSlotKey = slotKeyOf("ally", "REAR", 2);
    const draft = {
      ...base,
      allySlots: base.allySlots.map((slot) =>
        slot.slotKey === firstSlotKey || slot.slotKey === secondSlotKey
          ? { ...slot, unitDefinitionId: "UNIT_A" }
          : slot,
      ),
    };
    const enhancement = { ...createInitialUnitEnhancement(), level: 220 };
    const playerEnhancement: PlayerEnhancementState = {
      ...createEmptyPlayerData(),
      units: { UNIT_A: enhancement },
    };

    const effective = withPlayerEnhancement(draft, playerEnhancement);

    expect(effective.allySlots.find((s) => s.slotKey === firstSlotKey)?.enhancement).toStrictEqual(
      enhancement,
    );
    expect(effective.allySlots.find((s) => s.slotKey === secondSlotKey)?.enhancement).toStrictEqual(
      enhancement,
    );
  });

  it("leaves an empty ally slot and every enemy slot untouched", () => {
    const base = withAllyUnit("UNIT_A");
    const enemySlotKey = base.enemySlots[0]!.slotKey;
    const draft = {
      ...base,
      enemySlots: base.enemySlots.map((slot) =>
        slot.slotKey === enemySlotKey
          ? { ...slot, unitDefinitionId: "UNIT_E", enhancement: createInitialUnitEnhancement() }
          : slot,
      ),
    };
    const playerEnhancement: PlayerEnhancementState = {
      ...createEmptyPlayerData(),
      units: {
        UNIT_A: { ...createInitialUnitEnhancement(), level: 220 },
        UNIT_E: { ...createInitialUnitEnhancement(), level: 999 },
      },
    };

    const effective = withPlayerEnhancement(draft, playerEnhancement);

    const emptySlot = effective.allySlots.find((s) => s.slotKey === slotKeyOf("ally", "FRONT", 1));
    expect(emptySlot?.enhancement).toBeUndefined();
    const enemySlot = effective.enemySlots.find((s) => s.slotKey === enemySlotKey);
    expect(enemySlot?.enhancement?.level).toBe(200);
  });
});
