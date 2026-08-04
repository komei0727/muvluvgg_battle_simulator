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
      stacking: { mode: "STACKABLE", max: null },
      duration: { dispellable: true, linkedEffectGroupId: null },
    },
    requiredCapabilities: [],
    metadata: { tags: [] },
  };
}

/** G-09（M7-002A／Issue #255）: `resource: HP`の上限変更は`MAXIMUM_HP` CombatStatへ合成する。 */
function hpCapacityDefinition(id: string, operation: "ADD" | "SET"): EffectActionDefinition {
  return {
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    kind: "MODIFY_RESOURCE_CAPACITY",
    payload: {
      resource: "HP",
      operation,
      formula: { kind: "CONSTANT", value: 0 },
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
    categories: ["BUFF"],
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

  it("UT-R-STA-04-021: a MAXIMUM_HP RATIO buff recalculates from the unrounded formation-adjusted base (R-NUM-01/R-STA-01) — no double-rounding, and the integer gauge max is derived from the full-precision value", () => {
    // 連鎖: 編成補正で端数が生じた maximumHp（33623 × 1.2 = 40347.6）を基準に、
    // さらに戦闘中 +20% MAXIMUM_HP 比率補正を重ねる（`ACT_KEI_JACKKNIFE_PS1_MAXHP_UP`
    // 相当）。正: trunc(33623 × 1.2 × 1.2) = trunc(48417.12) = 48417。
    // 開始時に丸めると trunc(40347 × 1.2) = 48416 となり1ずれる。
    // computeCombatStats は全精度（48417.12）を保持し、整数化はゲージ境界で行う。
    const def = statModDefinition("ACT_MAXHP_UP", "MAXIMUM_HP", "RATIO");
    const fractionalBase: CombatStats = { ...BASE_COMBAT_STATS, maximumHp: 40347.6 };
    const target = unit({
      combatStats: fractionalBase,
      baseCombatStats: fractionalBase,
      appliedEffects: [statMod(def.effectActionDefinitionId, true, 0.2)],
    });

    const result = computeCombatStats(target, new Map([[def.effectActionDefinitionId, def]]));

    expect(result.combatStats.maximumHp).toBeCloseTo(48417.12);
    // ゲージ最大値（0方向切り捨て）は48417 — 二重丸めの48416ではない。
    expect(Math.trunc(result.combatStats.maximumHp)).toBe(48417);
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

  it("UT-R-STA-04-020 (boundary): removing the only AppliedEffect on a stat resets it to baseCombatStats and reports the change, even though the unit's current combatStats still carries the stale corrected value", () => {
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

  it("UT-R-ACTN-03-008: a MODIFY_RESOURCE_CAPACITY(resource: HP) instance composes onto MAXIMUM_HP after the stat corrections (G-09、M7-002A/Issue #255)", () => {
    // HPの上限は`combatStats.maximumHp`そのものであるため、上限変更は
    // `APPLY_STAT_MOD`の比率・固定値補正を適用した後段へ重ね、差分は既存の
    // `CombatStatChanged`が所有する（`ResourceCapacityChanged`は発行しない）。
    const ratio = statModDefinition("ACT_MAXHP_UP", "MAXIMUM_HP", "RATIO");
    const capacity = hpCapacityDefinition("ACT_MAX_HP_ADD", "ADD");
    const target = unit({
      appliedEffects: [
        statMod(ratio.effectActionDefinitionId, true, 0.2),
        statMod(capacity.effectActionDefinitionId, true, 500),
      ],
    });

    const result = computeCombatStats(
      target,
      new Map([
        [ratio.effectActionDefinitionId, ratio],
        [capacity.effectActionDefinitionId, capacity],
      ]),
    );

    expect(result.combatStats.maximumHp).toBeCloseTo(1700);
    expect(result.changedStats).toContainEqual({
      stat: "MAXIMUM_HP",
      before: 1000,
      after: 1700,
    });
  });

  it("UT-R-ACTN-03-009: a MODIFY_RESOURCE_CAPACITY for a gauge resource never leaks into any CombatStat", () => {
    const capacity: EffectActionDefinition = {
      ...hpCapacityDefinition("ACT_MAX_AP_ADD", "ADD"),
      payload: { ...hpCapacityDefinition("ACT_MAX_AP_ADD", "ADD").payload, resource: "AP" },
    } as EffectActionDefinition;
    const target = unit({
      appliedEffects: [statMod(capacity.effectActionDefinitionId, true, 1)],
    });

    const result = computeCombatStats(
      target,
      new Map([[capacity.effectActionDefinitionId, capacity]]),
    );

    expect(result.combatStats).toEqual(BASE_COMBAT_STATS);
    expect(result.changedStats).toEqual([]);
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

/**
 * G-09（`14_Catalog定義スキーマ.md`「MODIFY_RESOURCE_CAPACITY」、M7-002A／Issue #255）:
 * R-STA-04の再計算フック（`recalculateCombatStats`）が、CombatStatだけでなく
 * AP/PP/EXゲージの上限も同じ契機（付与・失効・解除）で再合成することを固定する。
 * 別関数にすると呼び出し漏れた経路でだけ上限が基準へ戻らず、`createActionPoint`の
 * 不変条件違反として後から実行時例外になるため、単一のフックへ集約している。
 */
describe("recalculateCombatStats — ResourceCapacityChanged配線（G-09）", () => {
  function gaugeCapacityDefinition(
    id: string,
    resource: "AP" | "PP" | "EX_GAUGE",
    operation: "ADD" | "SET",
  ): EffectActionDefinition {
    return {
      ...hpCapacityDefinition(id, operation),
      payload: { ...hpCapacityDefinition(id, operation).payload, resource },
    } as EffectActionDefinition;
  }

  it("UT-R-ACTN-03-010: emits ResourceCapacityChanged owning the maximumAp delta and updates the unit's capacity", () => {
    const def = gaugeCapacityDefinition("ACT_MAX_AP_UP", "AP", "ADD");
    const beforeUnits = [unit()];
    const afterUnits = [unit({ appliedEffects: [statMod(def.effectActionDefinitionId, true, 1)] })];
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
    expect(updated.maximumAp).toBe(4);
    // 基準は動かない — 失効時に3へ戻せることがこの再合成方式の要件。
    expect(updated.baseMaximumAp).toBe(3);
    const events = recorder.getEvents().filter((e) => e.eventType === "ResourceCapacityChanged");
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      battleUnitId: afterUnits[0]!.battleUnitId,
      resource: "AP",
      before: 3,
      after: 4,
      reason: "EFFECT_APPLIED",
    });
    expect(events[0]!.stateDelta?.units?.[afterUnits[0]!.battleUnitId]?.maximumAp).toEqual({
      before: 3,
      after: 4,
    });
  });

  it("UT-R-ACTN-03-011: emits nothing for resources whose capacity did not change", () => {
    const def = gaugeCapacityDefinition("ACT_MAX_AP_UP", "AP", "ADD");
    const afterUnits = [
      unit({ maximumAp: 4, appliedEffects: [statMod(def.effectActionDefinitionId, true, 1)] }),
    ];
    const { recorder, rootEventId } = createRoot();

    recalculateCombatStats(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      afterUnits,
      afterUnits,
      afterUnits[0]!.battleUnitId,
      new Map([[def.effectActionDefinitionId, def]]),
      rootEventId,
      "EFFECT_APPLIED",
    );

    expect(
      recorder.getEvents().filter((e) => e.eventType === "ResourceCapacityChanged"),
    ).toHaveLength(0);
  });

  it("UT-R-ACTN-03-012 (boundary): expiry restores the base capacity and clamps the now-out-of-range current value with a ResourceChanged", () => {
    const def = gaugeCapacityDefinition("ACT_MAX_AP_UP", "AP", "ADD");
    // 上限4・現在値4の状態から、上限変更の効果が失効して`appliedEffects`が空になった直後。
    const raised = unit({ maximumAp: 4, currentAp: 4 });
    const beforeUnits = [
      unit({
        maximumAp: 4,
        currentAp: 4,
        appliedEffects: [statMod(def.effectActionDefinitionId, true, 1)],
      }),
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
      [raised],
      raised.battleUnitId,
      new Map([[def.effectActionDefinitionId, def]]),
      rootEventId,
      "EFFECT_EXPIRED",
    );

    const updated = result.units.find((u) => u.battleUnitId === raised.battleUnitId)!;
    expect(updated.maximumAp).toBe(3);
    expect(updated.currentAp).toBe(3);
    const capacityEvents = recorder
      .getEvents()
      .filter((e) => e.eventType === "ResourceCapacityChanged");
    expect(capacityEvents[0]!.payload).toMatchObject({ resource: "AP", before: 4, after: 3 });
    const resourceEvents = recorder.getEvents().filter((e) => e.eventType === "ResourceChanged");
    expect(resourceEvents).toHaveLength(1);
    expect(resourceEvents[0]!.payload).toMatchObject({
      resource: "AP",
      before: 4,
      after: 3,
      delta: -1,
      baseDelta: -1,
      reason: "EFFECT_ACTION",
    });
    expect(resourceEvents[0]!.stateDelta?.units?.[raised.battleUnitId]?.ap).toEqual({
      before: 4,
      after: 3,
    });
  });

  it("UT-R-ACTN-03-013 (boundary): a current value already inside the reduced capacity is left untouched", () => {
    const def = gaugeCapacityDefinition("ACT_MAX_AP_UP", "AP", "ADD");
    const raised = unit({ maximumAp: 4, currentAp: 2 });
    const { recorder, rootEventId } = createRoot();

    const result = recalculateCombatStats(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [raised],
      [raised],
      raised.battleUnitId,
      new Map([[def.effectActionDefinitionId, def]]),
      rootEventId,
      "EFFECT_EXPIRED",
    );

    expect(result.units[0]!.currentAp).toBe(2);
    expect(recorder.getEvents().filter((e) => e.eventType === "ResourceChanged")).toHaveLength(0);
  });

  it("UT-R-ACTN-03-014 (boundary): a HP capacity drop clamps currentHp through the MAXIMUM_HP CombatStat and reports UnitDefeated at zero", () => {
    const def = hpCapacityDefinition("ACT_MAX_HP_SET", "SET");
    const target = unit({ appliedEffects: [statMod(def.effectActionDefinitionId, true, 0)] });
    const { recorder, rootEventId } = createRoot();

    const result = recalculateCombatStats(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [unit()],
      [target],
      target.battleUnitId,
      new Map([[def.effectActionDefinitionId, def]]),
      rootEventId,
      "EFFECT_APPLIED",
    );

    const updated = result.units[0]!;
    expect(updated.combatStats.maximumHp).toBe(0);
    expect(updated.currentHp).toBe(0);
    // HP上限の差分は`CombatStatChanged`が所有し、`ResourceCapacityChanged`は発行しない。
    expect(
      recorder.getEvents().filter((e) => e.eventType === "ResourceCapacityChanged"),
    ).toHaveLength(0);
    expect(
      recorder
        .getEvents()
        .filter((e) => e.eventType === "CombatStatChanged")
        .map((e) => e.payload),
    ).toContainEqual(expect.objectContaining({ stat: "MAXIMUM_HP", before: 1000, after: 0 }));
    expect(recorder.getEvents().filter((e) => e.eventType === "ResourceChanged")).toHaveLength(1);
    expect(recorder.getEvents().filter((e) => e.eventType === "UnitDefeated")).toHaveLength(1);
  });
});
