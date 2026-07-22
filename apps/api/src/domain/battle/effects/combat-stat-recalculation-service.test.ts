import { describe, expect, it } from "vitest";
import { computeCombatStats, recalculateCombatStats } from "./combat-stat-recalculation-service.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { AppliedEffect } from "../model/applied-effect.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import type { CombatStats } from "../model/starting-combat-stats.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import { effectKindKeyFromDefinitionId } from "../model/applied-effect.js";
import type { EffectInstanceId } from "../../shared/event-ids.js";

const BASE_COMBAT_STATS: CombatStats = {
  maximumHp: 1000,
  attack: 100,
  defense: 50,
  criticalRate: 0.1,
  actionSpeed: 10,
  criticalDamageBonus: 0.5,
  affinityBonus: 0.25,
};

function unit(overrides: Partial<BattleUnit> = {}): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId("BU_1"),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate("ALLY", position),
    combatStats: BASE_COMBAT_STATS,
  };
  const base = createBattleUnit(member, "ALLY", {
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 10,
  });
  return { ...base, ...overrides };
}

let instanceCounter = 0;
function instanceId(): EffectInstanceId {
  instanceCounter += 1;
  return `EFFECT_INSTANCE_${instanceCounter}` as EffectInstanceId;
}

function statModDefinition(
  id: string,
  stat: EffectActionDefinition["kind"] extends never ? never : string,
  valueType: "RATIO" | "FIXED",
): EffectActionDefinition {
  return {
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    kind: "APPLY_STAT_MOD",
    payload: {
      // Cast: test fixture only needs `stat`/`valueType` for this pure calculator;
      // formula/stacking/duration are irrelevant since AppliedEffect already
      // carries the resolved magnitude and duplicate flag.
      stat: stat as never,
      valueType,
      formula: { kind: "CONSTANT", value: 0 },
      stacking: { mode: "STACKABLE" },
      duration: { dispellable: true, linkedEffectGroupId: null },
    },
    requiredCapabilities: [],
    metadata: { tags: [] },
  };
}

function statMod(
  definitionId: EffectActionDefinitionId,
  duplicate: boolean,
  magnitude: number,
): AppliedEffect {
  return {
    effectInstanceId: instanceId(),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate,
    sourceId: createBattleUnitId("BU_1"),
    targetId: createBattleUnitId("BU_1"),
    magnitude,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

describe("computeCombatStats — R-STA-02〜04の動的再計算", () => {
  it("UT-R-STA-04-010: with no AppliedEffect, combatStats equals baseCombatStats unchanged", () => {
    const result = computeCombatStats(unit(), new Map());
    expect(result.combatStats).toEqual(BASE_COMBAT_STATS);
    expect(result.changedStats).toEqual([]);
  });

  it("UT-R-STA-04-011: a stackable RATIO APPLY_STAT_MOD multiplies the base value (R-STA-02)", () => {
    const def = statModDefinition("ACT_ATK_UP", "ATTACK", "RATIO");
    const target = unit({ appliedEffects: [statMod(def.effectActionDefinitionId, true, 0.2)] });

    const result = computeCombatStats(target, new Map([[def.effectActionDefinitionId, def]]));

    expect(result.combatStats.attack).toBeCloseTo(120);
    expect(result.changedStats).toContainEqual({ stat: "ATTACK", before: 100, after: 120 });
  });

  it("UT-R-STA-04-012: multiple stackable RATIO effects on the same stat sum together (R-STA-02)", () => {
    const def = statModDefinition("ACT_ATK_UP", "ATTACK", "RATIO");
    const target = unit({
      appliedEffects: [
        statMod(def.effectActionDefinitionId, true, 0.2),
        statMod(def.effectActionDefinitionId, true, 0.1),
      ],
    });

    const result = computeCombatStats(target, new Map([[def.effectActionDefinitionId, def]]));

    expect(result.combatStats.attack).toBeCloseTo(130);
  });

  it("UT-R-STA-04-013: a FIXED valueType APPLY_STAT_MOD adds after the ratio multiplier (R-STA-01)", () => {
    const def = statModDefinition("ACT_ATK_FIXED", "ATTACK", "FIXED");
    const target = unit({ appliedEffects: [statMod(def.effectActionDefinitionId, true, 15)] });

    const result = computeCombatStats(target, new Map([[def.effectActionDefinitionId, def]]));

    expect(result.combatStats.attack).toBeCloseTo(115);
  });

  it("UT-R-STA-04-014: distinct stats recalculate independently", () => {
    const atk = statModDefinition("ACT_ATK_UP", "ATTACK", "RATIO");
    const def = statModDefinition("ACT_DEF_UP", "DEFENSE", "RATIO");
    const target = unit({
      appliedEffects: [
        statMod(atk.effectActionDefinitionId, true, 0.2),
        statMod(def.effectActionDefinitionId, true, -0.1),
      ],
    });

    const result = computeCombatStats(
      target,
      new Map([
        [atk.effectActionDefinitionId, atk],
        [def.effectActionDefinitionId, def],
      ]),
    );

    expect(result.combatStats.attack).toBeCloseTo(120);
    expect(result.combatStats.defense).toBeCloseTo(45);
  });

  it("UT-R-EFF-05-010 / UT-R-STA-04-015: a non-stackable group adopts only the strongest instance (R-STA-03), the rest are held but not counted", () => {
    const def = statModDefinition("ACT_ATK_UP_UNIQUE", "ATTACK", "RATIO");
    const weak = statMod(def.effectActionDefinitionId, false, 0.1);
    const strong = statMod(def.effectActionDefinitionId, false, 0.3);
    const target = unit({ appliedEffects: [weak, strong] });

    const result = computeCombatStats(target, new Map([[def.effectActionDefinitionId, def]]));

    expect(result.combatStats.attack).toBeCloseTo(130);
    expect(result.isEffectiveByInstance.get(strong.effectInstanceId)).toBe(true);
    expect(result.isEffectiveByInstance.get(weak.effectInstanceId)).toBe(false);
  });

  it("UT-R-EFF-05-011: recomputing after the strongest instance is removed from the list promotes the next-strongest (次点繰上げ)", () => {
    const def = statModDefinition("ACT_ATK_UP_UNIQUE", "ATTACK", "RATIO");
    const weak = statMod(def.effectActionDefinitionId, false, 0.1);
    const strong = statMod(def.effectActionDefinitionId, false, 0.3);
    const definitions = new Map([[def.effectActionDefinitionId, def]]);

    const before = computeCombatStats(unit({ appliedEffects: [weak, strong] }), definitions);
    expect(before.combatStats.attack).toBeCloseTo(130);

    const after = computeCombatStats(unit({ appliedEffects: [weak] }), definitions);
    expect(after.combatStats.attack).toBeCloseTo(110);
    expect(after.isEffectiveByInstance.get(weak.effectInstanceId)).toBe(true);
  });

  it("UT-R-STA-04-016: an AppliedEffect whose definition is not APPLY_STAT_MOD is ignored (defensive — currently unreachable via grantEffect)", () => {
    const def: EffectActionDefinition = {
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_MARKER"),
      kind: "APPLY_MARKER",
      payload: {
        markerId: "MARKER_TEST" as never,
        stack: { policy: "ADD", max: null },
        duration: { dispellable: true, linkedEffectGroupId: null },
      },
      requiredCapabilities: [],
      metadata: { tags: [] },
    };
    const target = unit({ appliedEffects: [statMod(def.effectActionDefinitionId, true, 999)] });

    const result = computeCombatStats(target, new Map([[def.effectActionDefinitionId, def]]));

    expect(result.combatStats).toEqual(BASE_COMBAT_STATS);
  });

  it("UT-R-STA-04-020 (boundary, PR #208レビュー[P2]): removing the only AppliedEffect on a stat resets it to baseCombatStats and reports the change, even though the unit's current combatStats still carries the stale corrected value", () => {
    const def = statModDefinition("ACT_ATK_UP", "ATTACK", "RATIO");
    // Simulates the moment right after the effect that produced attack=120 has
    // been removed from appliedEffects (e.g. by a future expiration/removal
    // Issue): `combatStats` still holds the stale corrected value, but
    // `appliedEffects` is already empty.
    const target = unit({ combatStats: { ...BASE_COMBAT_STATS, attack: 120 }, appliedEffects: [] });

    const result = computeCombatStats(target, new Map([[def.effectActionDefinitionId, def]]));

    expect(result.combatStats.attack).toBe(100);
    expect(result.changedStats).toContainEqual({ stat: "ATTACK", before: 120, after: 100 });
  });
});

function createRoot() {
  const recorder = new EventRecorder(createBattleId("B_1"));
  const seed = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber: 1 },
  });
  return { recorder, rootEventId: seed.eventId };
}

describe("recalculateCombatStats — CombatStatChanged/EffectiveEffectChanged配線", () => {
  it("UT-R-STA-04-017: emits CombatStatChanged and updates the unit's combatStats when a stat actually changes", () => {
    const def = statModDefinition("ACT_ATK_UP", "ATTACK", "RATIO");
    const beforeUnits = [unit()];
    const afterUnits = [
      unit({ appliedEffects: [statMod(def.effectActionDefinitionId, true, 0.2)] }),
    ];
    const { recorder, rootEventId } = createRoot();

    const result = recalculateCombatStats(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      beforeUnits,
      afterUnits,
      afterUnits[0]!.battleUnitId,
      new Map([[def.effectActionDefinitionId, def]]),
      rootEventId,
      "EFFECT_APPLIED",
    );

    const updated = result.units.find((u) => u.battleUnitId === afterUnits[0]!.battleUnitId)!;
    expect(updated.combatStats.attack).toBeCloseTo(120);
    const events = recorder.getEvents().filter((e) => e.eventType === "CombatStatChanged");
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      stat: "ATTACK",
      before: 100,
      after: 120,
      reason: "EFFECT_APPLIED",
    });
  });

  it("UT-R-STA-04-018: emits nothing when recalculation produces no change", () => {
    const beforeUnits = [unit()];
    const afterUnits = [unit()];
    const { recorder, rootEventId } = createRoot();

    recalculateCombatStats(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      beforeUnits,
      afterUnits,
      afterUnits[0]!.battleUnitId,
      new Map(),
      rootEventId,
      "EFFECT_APPLIED",
    );

    expect(recorder.getEvents().filter((e) => e.eventType === "CombatStatChanged")).toHaveLength(0);
    expect(
      recorder.getEvents().filter((e) => e.eventType === "EffectiveEffectChanged"),
    ).toHaveLength(0);
  });

  it("UT-R-EFF-05-012: emits EffectiveEffectChanged demoting the previous winner when a newly-granted non-stackable effect is stronger", () => {
    const def = statModDefinition("ACT_ATK_UP_UNIQUE", "ATTACK", "RATIO");
    const existingWinner = statMod(def.effectActionDefinitionId, false, 0.1);
    const beforeUnits = [unit({ appliedEffects: [existingWinner] })];
    const newEffect = statMod(def.effectActionDefinitionId, false, 0.3);
    const afterUnits = [unit({ appliedEffects: [existingWinner, newEffect] })];
    const { recorder, rootEventId } = createRoot();

    recalculateCombatStats(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      beforeUnits,
      afterUnits,
      afterUnits[0]!.battleUnitId,
      new Map([[def.effectActionDefinitionId, def]]),
      rootEventId,
      "EFFECT_APPLIED",
    );

    const events = recorder.getEvents().filter((e) => e.eventType === "EffectiveEffectChanged");
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      kindKey: def.effectActionDefinitionId,
      before: existingWinner.effectInstanceId,
      after: newEffect.effectInstanceId,
    });
    const delta = events[0]!.stateDelta?.units?.[afterUnits[0]!.battleUnitId]?.effects;
    expect(delta?.[existingWinner.effectInstanceId]).toMatchObject({
      before: { isEffective: true },
      after: { isEffective: false },
    });
  });

  it("UT-R-EFF-05-013: emits nothing when a newly-granted non-stackable effect is weaker than the current winner", () => {
    const def = statModDefinition("ACT_ATK_UP_UNIQUE", "ATTACK", "RATIO");
    const existingWinner = statMod(def.effectActionDefinitionId, false, 0.3);
    const beforeUnits = [unit({ appliedEffects: [existingWinner] })];
    const weakerNewEffect = statMod(def.effectActionDefinitionId, false, 0.1);
    const afterUnits = [unit({ appliedEffects: [existingWinner, weakerNewEffect] })];
    const { recorder, rootEventId } = createRoot();

    recalculateCombatStats(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      beforeUnits,
      afterUnits,
      afterUnits[0]!.battleUnitId,
      new Map([[def.effectActionDefinitionId, def]]),
      rootEventId,
      "EFFECT_APPLIED",
    );

    expect(
      recorder.getEvents().filter((e) => e.eventType === "EffectiveEffectChanged"),
    ).toHaveLength(0);
  });
});
