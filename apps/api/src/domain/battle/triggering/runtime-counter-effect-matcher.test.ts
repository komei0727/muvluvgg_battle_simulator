import { describe, expect, it } from "vitest";
import {
  detectEffectRuntimeCounterUpdates,
  matchEffectRuntimeCounterUpdates,
} from "./runtime-counter-effect-matcher.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createRuntimeCounterId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import type { RuntimeCounterUpdateDefinitionInput } from "../../catalog/definitions/runtime-counter-update-definition.js";
import { createRuntimeCounterUpdateDefinition } from "../../catalog/definitions/runtime-counter-update-definition.js";
import { DomainValidationError } from "../../shared/errors.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function unit(id: string, side: Side = "ALLY", overrides: Partial<BattleUnit> = {}): BattleUnit {
  const position = { row: "FRONT", column: "LEFT" } as const;
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
  return { ...createBattleUnit(member, side, LIMITS), ...overrides };
}

const EFFECT_ACTION_DEFINITION_ID = createEffectActionDefinitionId("ACT_CURSE");
const HIT_COUNTER = createRuntimeCounterId("RUNTIME_COUNTER_HIT_COUNT");

function incomingHitTrigger(): RuntimeCounterUpdateDefinitionInput["trigger"] {
  return {
    eventType: "HitPointReduced",
    category: "FACT",
    sourceSelector: "ENEMY",
    targetSelector: "SELF",
  };
}

function effectWithCounterUpdates(
  id: string,
  holder: BattleUnit,
  counterUpdates: readonly RuntimeCounterUpdateDefinitionInput[],
  initialCounters: AppliedEffect["duration"]["counters"] = {},
): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: EFFECT_ACTION_DEFINITION_ID,
    kindKey: effectKindKeyFromDefinitionId(EFFECT_ACTION_DEFINITION_ID),
    duplicate: true,
    sourceId: holder.battleUnitId,
    targetId: holder.battleUnitId,
    magnitude: 10,
    duration: {
      definition: {
        dispellable: true,
        linkedEffectGroupId: null,
        counterUpdates: counterUpdates.map((c, i) =>
          createRuntimeCounterUpdateDefinition(c, `counterUpdates[${i}]`),
        ),
      },
      counters: initialCounters,
    },
    appliedTurnNumber: 1,
  };
}

function hitEvent(sourceUnitId: BattleUnit["battleUnitId"]): TriggerCandidateEvent {
  return {
    eventType: "HitPointReduced",
    category: "FACT",
    sourceUnitId,
    payload: {},
  };
}

describe("matchEffectRuntimeCounterUpdates", () => {
  it("UT-RCOUNTER-EFF-001 (EFF-005 Issue #162): matches an effect instance's own counterUpdates when its trigger matches", () => {
    const enemy = unit("enemy-1", "ENEMY");
    const holder = unit("holder-1", "ALLY");
    const effect = effectWithCounterUpdates("effect-1", holder, [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_HIT_COUNT",
        scope: "APPLIED_EFFECT",
        trigger: incomingHitTrigger(),
        amount: 1,
      },
    ]);
    const withEffect = { ...holder, appliedEffects: [effect] };

    const matched = matchEffectRuntimeCounterUpdates(
      [enemy, withEffect],
      hitEvent(enemy.battleUnitId),
    );

    expect(matched).toEqual([
      {
        battleUnitId: holder.battleUnitId,
        effectInstanceId: effect.effectInstanceId,
        update: effect.duration.definition.counterUpdates![0],
      },
    ]);
  });

  it("UT-RCOUNTER-EFF-002: does not match instances without counterUpdates", () => {
    const enemy = unit("enemy-1", "ENEMY");
    const holder = unit("holder-1", "ALLY");
    const effect = effectWithCounterUpdates("effect-1", holder, []);
    const withEffect = { ...holder, appliedEffects: [effect] };

    const matched = matchEffectRuntimeCounterUpdates(
      [enemy, withEffect],
      hitEvent(enemy.battleUnitId),
    );

    expect(matched).toHaveLength(0);
  });

  it("UT-RCOUNTER-EFF-003: skips defeated holders", () => {
    const enemy = unit("enemy-1", "ENEMY");
    const holder = { ...unit("holder-1", "ALLY"), currentHp: 0 };
    const effect = effectWithCounterUpdates("effect-1", holder, [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_HIT_COUNT",
        scope: "APPLIED_EFFECT",
        trigger: incomingHitTrigger(),
        amount: 1,
      },
    ]);
    const withEffect = { ...holder, appliedEffects: [effect] };

    const matched = matchEffectRuntimeCounterUpdates(
      [enemy, withEffect],
      hitEvent(enemy.battleUnitId),
    );

    expect(matched).toHaveLength(0);
  });

  it("UT-RCOUNTER-EFF-004: each effect instance is matched independently, even when owned by the same unit", () => {
    const enemy = unit("enemy-1", "ENEMY");
    const holder = unit("holder-1", "ALLY");
    const effectA = effectWithCounterUpdates("effect-a", holder, [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_HIT_COUNT",
        scope: "APPLIED_EFFECT",
        trigger: incomingHitTrigger(),
        amount: 1,
      },
    ]);
    const effectB = effectWithCounterUpdates("effect-b", holder, [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_HIT_COUNT",
        scope: "APPLIED_EFFECT",
        trigger: incomingHitTrigger(),
        amount: 1,
      },
    ]);
    const withEffects = { ...holder, appliedEffects: [effectA, effectB] };

    const matched = matchEffectRuntimeCounterUpdates(
      [enemy, withEffects],
      hitEvent(enemy.battleUnitId),
    );

    expect(matched.map((m) => m.effectInstanceId)).toEqual([
      effectA.effectInstanceId,
      effectB.effectInstanceId,
    ]);
  });
});

describe("detectEffectRuntimeCounterUpdates", () => {
  it("UT-RCOUNTER-EFF-005: increments the matched effect instance's own counter and reports the change", () => {
    const enemy = unit("enemy-1", "ENEMY");
    const holder = unit("holder-1", "ALLY");
    const effect = effectWithCounterUpdates("effect-1", holder, [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_HIT_COUNT",
        scope: "APPLIED_EFFECT",
        trigger: incomingHitTrigger(),
        amount: 1,
      },
    ]);
    const withEffect = { ...holder, appliedEffects: [effect] };

    const result = detectEffectRuntimeCounterUpdates(
      [enemy, withEffect],
      hitEvent(enemy.battleUnitId),
    );

    expect(result.changes).toEqual([
      {
        battleUnitId: holder.battleUnitId,
        effectInstanceId: effect.effectInstanceId,
        counter: HIT_COUNTER,
        before: 0,
        after: 1,
        carry: 0,
        carryBefore: 0,
        valueChanged: true,
      },
    ]);
    const updatedHolder = result.units.find((u) => u.battleUnitId === holder.battleUnitId)!;
    expect(updatedHolder.appliedEffects[0]!.duration.counters).toEqual({
      [HIT_COUNTER]: { value: 1, carry: 0 },
    });
  });

  it("UT-RCOUNTER-EFF-006: leaves other effect instances and units untouched", () => {
    const enemy = unit("enemy-1", "ENEMY");
    const holder = unit("holder-1", "ALLY");
    const untouched = effectWithCounterUpdates("effect-untouched", holder, []);
    const matching = effectWithCounterUpdates("effect-matching", holder, [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_HIT_COUNT",
        scope: "APPLIED_EFFECT",
        trigger: incomingHitTrigger(),
        amount: 1,
      },
    ]);
    const withEffects = { ...holder, appliedEffects: [untouched, matching] };

    const result = detectEffectRuntimeCounterUpdates(
      [enemy, withEffects],
      hitEvent(enemy.battleUnitId),
    );

    const updatedHolder = result.units.find((u) => u.battleUnitId === holder.battleUnitId)!;
    expect(updatedHolder.appliedEffects[0]!.duration.counters).toEqual({});
    expect(updatedHolder.appliedEffects[1]!.duration.counters).toEqual({
      [HIT_COUNTER]: { value: 1, carry: 0 },
    });
  });

  it("UT-RCOUNTER-EFF-007 (CUMULATIVE_DAMAGE_THRESHOLD_TRIGGER): accumulates damage as a max-HP-ratio threshold count against the holder's own maximumHp", () => {
    const enemy = unit("enemy-1", "ENEMY");
    const holder = unit("holder-1", "ALLY");
    const effect = effectWithCounterUpdates("effect-1", holder, [
      {
        kind: "CUMULATIVE_DAMAGE_THRESHOLD",
        counter: "RUNTIME_COUNTER_HIT_COUNT",
        scope: "APPLIED_EFFECT",
        trigger: { ...incomingHitTrigger(), eventType: "HitPointReduced" },
        maxHpRatio: 0.4,
      },
    ]);
    const withEffect = { ...holder, appliedEffects: [effect] };
    const event: TriggerCandidateEvent = {
      ...hitEvent(enemy.battleUnitId),
      payload: { hitPointDamage: 40 },
    };

    const result = detectEffectRuntimeCounterUpdates([enemy, withEffect], event);

    expect(result.changes).toEqual([
      {
        battleUnitId: holder.battleUnitId,
        effectInstanceId: effect.effectInstanceId,
        counter: HIT_COUNTER,
        before: 0,
        after: 1,
        carry: 0,
        carryBefore: 0,
        valueChanged: true,
      },
    ]);
  });

  it("UT-RCOUNTER-EFF-008 (review-style carry tracking): reports a change when only the internal carry moved, even though the public value did not", () => {
    const enemy = unit("enemy-1", "ENEMY");
    const holder = unit("holder-1", "ALLY");
    const effect = effectWithCounterUpdates("effect-1", holder, [
      {
        kind: "CUMULATIVE_DAMAGE_THRESHOLD",
        counter: "RUNTIME_COUNTER_HIT_COUNT",
        scope: "APPLIED_EFFECT",
        trigger: incomingHitTrigger(),
        maxHpRatio: 0.4,
      },
    ]);
    const withEffect = { ...holder, appliedEffects: [effect] };
    const event: TriggerCandidateEvent = {
      ...hitEvent(enemy.battleUnitId),
      payload: { hitPointDamage: 10 },
    };

    const result = detectEffectRuntimeCounterUpdates([enemy, withEffect], event);

    expect(result.changes).toEqual([
      {
        battleUnitId: holder.battleUnitId,
        effectInstanceId: effect.effectInstanceId,
        counter: HIT_COUNTER,
        before: 0,
        after: 0,
        carry: 10,
        carryBefore: 0,
        valueChanged: false,
      },
    ]);
  });

  it("UT-RCOUNTER-EFF-009: reports no change at all when the event does not match (0 damage, no matching trigger)", () => {
    const enemy = unit("enemy-1", "ENEMY");
    const holder = unit("holder-1", "ALLY");
    const effect = effectWithCounterUpdates("effect-1", holder, [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_HIT_COUNT",
        scope: "APPLIED_EFFECT",
        trigger: incomingHitTrigger(),
        amount: 1,
      },
    ]);
    const withEffect = { ...holder, appliedEffects: [effect] };

    const result = detectEffectRuntimeCounterUpdates([enemy, withEffect], {
      eventType: "SomeOtherEvent",
      category: "FACT",
      sourceUnitId: enemy.battleUnitId,
      payload: {},
    });

    expect(result.changes).toHaveLength(0);
  });

  it("UT-RCOUNTER-EFF-010 (defensive scope guard): rejects a non-APPLIED_EFFECT scoped counterUpdates entry reaching this matcher (Catalog validation already rejects this before it can reach here)", () => {
    const enemy = unit("enemy-1", "ENEMY");
    const holder = unit("holder-1", "ALLY");
    const effect = effectWithCounterUpdates("effect-1", holder, []);
    const tampered: AppliedEffect = {
      ...effect,
      duration: {
        ...effect.duration,
        definition: {
          ...effect.duration.definition,
          counterUpdates: [
            {
              kind: "INCREMENT",
              counter: HIT_COUNTER,
              scope: "SKILL_RUNTIME",
              trigger: createRuntimeCounterUpdateDefinition(
                {
                  kind: "INCREMENT",
                  counter: "RUNTIME_COUNTER_HIT_COUNT",
                  scope: "SKILL_RUNTIME",
                  trigger: incomingHitTrigger(),
                  amount: 1,
                },
                "counterUpdate",
              ).trigger,
              amount: 1,
            },
          ],
        },
      },
    };
    const withEffect = { ...holder, appliedEffects: [tampered] };

    expect(() =>
      matchEffectRuntimeCounterUpdates([enemy, withEffect], hitEvent(enemy.battleUnitId)),
    ).toThrow(DomainValidationError);
  });
});
