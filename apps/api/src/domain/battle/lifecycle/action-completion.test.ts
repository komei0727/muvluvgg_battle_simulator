import { describe, expect, it } from "vitest";
import { recordActionCompletion } from "./action-completion.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import { createActionId, createEffectInstanceId } from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";

function actorWithExpiringCooldown(): BattleUnit {
  const position = { column: "LEFT", row: "FRONT" } as const;
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId("U1"),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate("ALLY", position),
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  const built = createBattleUnit(member, "ALLY", {
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 10,
  });
  return {
    ...built,
    cooldowns: {
      // Set by a DIFFERENT action than the one completing below, so
      // `decrementActionCooldowns` reduces it (R-SKL-04 COMPLETING #3) and,
      // since `remaining` reaches 0, also emits `CooldownCompleted`.
      [createSkillDefinitionId("SKL_OTHER")]: {
        unit: "ACTION",
        remaining: 1,
        setActionId: createActionId("B_1:action:0"),
      },
    },
  };
}

function plainUnit(id: string): BattleUnit {
  const position = { column: "LEFT", row: "FRONT" } as const;
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate("ALLY", position),
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  return createBattleUnit(member, "ALLY", { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 10 });
}

const STAT_MOD_DEFINITION_ID = createEffectActionDefinitionId("ACT_ATK_UP");

function statModDefinition(): EffectActionDefinition {
  return {
    effectActionDefinitionId: STAT_MOD_DEFINITION_ID,
    kind: "APPLY_STAT_MOD",
    payload: {
      stat: "ATTACK",
      valueType: "RATIO",
      formula: { kind: "CONSTANT", value: 0 },
      stacking: { mode: "STACKABLE", max: null },
      duration: { dispellable: true, linkedEffectGroupId: null },
    },
    requiredCapabilities: [],
    metadata: { tags: [] },
  };
}

function actionEffect(
  id: string,
  sourceId: ReturnType<typeof createBattleUnitId>,
  targetId: ReturnType<typeof createBattleUnitId>,
  timeLimitRemaining: number,
  owner?: "EFFECT_TARGET" | "EFFECT_SOURCE" | "BATTLE",
  grantedActionId?: ReturnType<typeof createActionId>,
): AppliedEffect {
  const definition: DurationDefinition = {
    timeLimit: {
      unit: "ACTION",
      count: timeLimitRemaining,
      ...(owner !== undefined ? { owner } : {}),
    },
    dispellable: true,
    linkedEffectGroupId: null,
  };
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: STAT_MOD_DEFINITION_ID,
    kindKey: effectKindKeyFromDefinitionId(STAT_MOD_DEFINITION_ID),
    duplicate: true,
    sourceId,
    targetId,
    magnitude: 0.2,
    categories: ["BUFF"],
    duration: {
      definition,
      timeLimitRemaining,
      ...(grantedActionId !== undefined ? { grantedActionId } : {}),
    },
    appliedTurnNumber: 1,
  };
}

describe("recordActionCompletion", () => {
  it("UT-ACT-COMPLETION-001: threads ActionCompleting/CooldownReduced/CooldownCompleted/ActionCompleted through the optional onFactEventForPassiveChain hook, in event order, and returns the hook's own final units (not just the internally batch-decremented ones)", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));
    const seed = recorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { turnNumber: 1 },
    });
    const initialActor = actorWithExpiringCooldown();
    const notifiedEventTypes: string[] = [];
    // Simulates a PS that increases HP by 1 every time it is invoked, so the
    // test can prove `recordActionCompletion`'s returned `units` are the
    // hook's own returned units, threaded across all 4 calls.
    const onFactEventForPassiveChain = (
      event: BattleDomainEvent,
      units: readonly BattleUnit[],
    ): readonly BattleUnit[] => {
      notifiedEventTypes.push(event.eventType);
      return units.map((u) =>
        u.battleUnitId === initialActor.battleUnitId ? { ...u, currentHp: u.currentHp + 1 } : u,
      );
    };

    const result = recordActionCompletion(
      recorder,
      {
        actionId: createActionId("B_1:action:1"),
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId: seed.eventId,
        turnNumber: 1,
        cycleNumber: 1,
        actorId: initialActor.battleUnitId,
        effectActions: new Map(),
        onFactEventForPassiveChain,
      },
      "AS",
      seed.eventId,
      [initialActor],
    );

    expect(notifiedEventTypes).toEqual([
      "ActionCompleting",
      "CooldownReduced",
      "CooldownCompleted",
      "ActionCompleted",
    ]);
    expect(result.units[0]?.currentHp).toBe(initialActor.currentHp + notifiedEventTypes.length);
  });

  it("UT-ACT-COMPLETION-002: omitting onFactEventForPassiveChain behaves exactly as before (no hook calls, the batch-decremented units are returned as-is)", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));
    const seed = recorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { turnNumber: 1 },
    });
    const initialActor = actorWithExpiringCooldown();

    const result = recordActionCompletion(
      recorder,
      {
        actionId: createActionId("B_1:action:1"),
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId: seed.eventId,
        turnNumber: 1,
        cycleNumber: 1,
        actorId: initialActor.battleUnitId,
        effectActions: new Map(),
      },
      "AS",
      seed.eventId,
      [initialActor],
    );

    expect(result.units[0]?.currentHp).toBe(initialActor.currentHp);
    expect(result.units[0]?.cooldowns[createSkillDefinitionId("SKL_OTHER")]?.remaining).toBe(0);
  });

  it("UT-R-EFF-04-015 (R-EFF-04 #3/#6 06_戦闘状態遷移.md COMPLETING#6): decrements an ACTION-unit effect targeting the actor after CooldownCompleted and before ActionCompleted, without expiring it", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));
    const seed = recorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { turnNumber: 1 },
    });
    const actor = plainUnit("U1");
    const effect = actionEffect(
      "effect-1",
      actor.battleUnitId,
      actor.battleUnitId,
      2,
      "EFFECT_TARGET",
      createActionId("B_1:action:0"),
    );
    const actorWithEffect = { ...actor, appliedEffects: [effect] };

    const result = recordActionCompletion(
      recorder,
      {
        actionId: createActionId("B_1:action:1"),
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId: seed.eventId,
        turnNumber: 1,
        cycleNumber: 1,
        actorId: actor.battleUnitId,
        effectActions: new Map([[STAT_MOD_DEFINITION_ID, statModDefinition()]]),
      },
      "AS",
      seed.eventId,
      [actorWithEffect],
    );

    const updated = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(updated.appliedEffects).toHaveLength(1);
    expect(updated.appliedEffects[0]!.duration.timeLimitRemaining).toBe(1);

    const types = recorder.getEvents().map((e) => e.eventType);
    expect(types).toEqual([
      "TurnStarted",
      "ActionCompleting",
      "EffectDurationReduced",
      "ActionCompleted",
    ]);
    expect(
      recorder.getEvents().find((e) => e.eventType === "EffectDurationReduced")!.payload,
    ).toMatchObject({ effectInstanceId: effect.effectInstanceId, before: 2, after: 1 });
  });

  it("UT-R-EFF-04-016 (R-EFF-04 #5/#6): expires an ACTION-unit effect at 0 remaining, emitting EffectExpired and CombatStatChanged, and removes it", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));
    const seed = recorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { turnNumber: 1 },
    });
    const actor = plainUnit("U1");
    const effect = actionEffect(
      "effect-1",
      actor.battleUnitId,
      actor.battleUnitId,
      1,
      "EFFECT_TARGET",
      createActionId("B_1:action:0"),
    );
    const actorWithEffect = {
      ...actor,
      appliedEffects: [effect],
      combatStats: { ...actor.combatStats, attack: 12 },
    };

    const result = recordActionCompletion(
      recorder,
      {
        actionId: createActionId("B_1:action:1"),
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId: seed.eventId,
        turnNumber: 1,
        cycleNumber: 1,
        actorId: actor.battleUnitId,
        effectActions: new Map([[STAT_MOD_DEFINITION_ID, statModDefinition()]]),
      },
      "AS",
      seed.eventId,
      [actorWithEffect],
    );

    const updated = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(updated.appliedEffects).toHaveLength(0);
    expect(updated.combatStats.attack).toBe(10);

    const types = recorder.getEvents().map((e) => e.eventType);
    expect(types).toEqual([
      "TurnStarted",
      "ActionCompleting",
      "EffectDurationReduced",
      "EffectExpired",
      "CombatStatChanged",
      "ActionCompleted",
    ]);
  });

  it("UT-R-EFF-04-017 (R-EFF-04 owner=EFFECT_SOURCE): decrements an effect held by ANOTHER unit when the completing actor is its source", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));
    const seed = recorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { turnNumber: 1 },
    });
    const source = plainUnit("U1");
    const ally = plainUnit("U2");
    const effect = actionEffect(
      "effect-1",
      source.battleUnitId,
      ally.battleUnitId,
      1,
      "EFFECT_SOURCE",
      createActionId("B_1:action:0"),
    );
    const allyWithEffect = { ...ally, appliedEffects: [effect] };

    const result = recordActionCompletion(
      recorder,
      {
        actionId: createActionId("B_1:action:1"),
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId: seed.eventId,
        turnNumber: 1,
        cycleNumber: 1,
        actorId: source.battleUnitId,
        effectActions: new Map([[STAT_MOD_DEFINITION_ID, statModDefinition()]]),
      },
      "AS",
      seed.eventId,
      [source, allyWithEffect],
    );

    const updatedAlly = result.units.find((u) => u.battleUnitId === ally.battleUnitId)!;
    expect(updatedAlly.appliedEffects).toHaveLength(0);
    expect(recorder.getEvents().some((e) => e.eventType === "EffectExpired")).toBe(true);
  });

  // R-EFF-08 (expiration.conditions) wiring moved to
  // `PassiveActivationRuntime.onFactEvent` so it
  // applies to every FACT/TIMING event, not just `ActionCompleted` — see
  // `passive-activation-service.test.ts`'s `onFactEvent` describe block for
  // the equivalent coverage.
});

describe("shield decay ordering at COMPLETING (DMG-004, Issue #194)", () => {
  const DECAY = { unit: "ACTION" as const, ratio: 0.5 };

  function shieldOn(
    holderId: string,
    id: string,
    amount: number,
    shieldType: "PHYSICAL" | "EN" | null,
  ): AppliedEffect {
    const definitionId = createEffectActionDefinitionId(`ACT_SHIELD_${id}`);
    return {
      effectInstanceId: createEffectInstanceId(id),
      effectActionDefinitionId: definitionId,
      kindKey: effectKindKeyFromDefinitionId(definitionId),
      duplicate: true,
      targetId: createBattleUnitId(holderId),
      magnitude: amount,
      categories: ["SHIELD"],
      shield: { shieldType, remaining: amount, decay: DECAY },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
  }

  function holderWith(shields: readonly AppliedEffect[]): BattleUnit {
    return { ...plainUnit("U1"), appliedEffects: shields };
  }

  function seededRecorder() {
    const recorder = new EventRecorder(createBattleId("B_1"));
    const seed = recorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { turnNumber: 1 },
    });
    return { recorder, seed };
  }

  it("UT-R-SHD-01-016: the first pool's ShieldConsumed observes the holder's later pools still untouched", () => {
    const { recorder, seed } = seededRecorder();
    const holder = holderWith([
      shieldOn("U1", "SHIELD_EN", 80, "EN"),
      shieldOn("U1", "SHIELD_UNTYPED", 40, null),
    ]);

    const observed: { readonly shieldType: unknown; readonly remaining: readonly number[] }[] = [];
    recordActionCompletion(
      recorder,
      {
        actionId: createActionId("B_1:action:1"),
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId: seed.eventId,
        turnNumber: 1,
        cycleNumber: 1,
        actorId: holder.battleUnitId,
        effectActions: new Map(),
        onFactEventForPassiveChain: (event, units) => {
          if (event.eventType === "ShieldConsumed") {
            observed.push({
              shieldType: (event.payload as { shieldType: unknown }).shieldType,
              remaining: units[0]!.appliedEffects.map((effect) => effect.shield!.remaining),
            });
          }
          return units;
        },
      },
      "AS",
      seed.eventId,
      [holder],
    );

    // R-SHD-02の適用順と同じ並び（タイプあり→タイプなし）で1プールずつ解決する。
    expect(observed.map((entry) => entry.shieldType)).toEqual(["EN", null]);
    // ENプールの通知時点では、タイプなしプール（40）はまだ手つかず。
    expect(observed[0]!.remaining).toEqual([40, 40]);
    expect(observed[1]!.remaining).toEqual([40, 20]);
  });

  it("UT-R-SHD-01-017: a chain reacting to the first pool's ShieldConsumed still sees its own change applied to the later pool", () => {
    const { recorder, seed } = seededRecorder();
    const holder = holderWith([
      shieldOn("U1", "SHIELD_EN", 80, "EN"),
      shieldOn("U1", "SHIELD_UNTYPED", 40, null),
    ]);

    // ENプールの`ShieldConsumed`に反応して、後続のタイプなしシールドを解除する
    // PSを模す。後続プールの解決はこの変更後の状態から行われる必要がある。
    const result = recordActionCompletion(
      recorder,
      {
        actionId: createActionId("B_1:action:1"),
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId: seed.eventId,
        turnNumber: 1,
        cycleNumber: 1,
        actorId: holder.battleUnitId,
        effectActions: new Map(),
        onFactEventForPassiveChain: (event, units) => {
          if (
            event.eventType === "ShieldConsumed" &&
            (event.payload as { shieldType: unknown }).shieldType === "EN"
          ) {
            return units.map((unit) => ({
              ...unit,
              appliedEffects: unit.appliedEffects.filter(
                (effect) => effect.effectInstanceId !== createEffectInstanceId("SHIELD_UNTYPED"),
              ),
            }));
          }
          return units;
        },
      },
      "AS",
      seed.eventId,
      [holder],
    );

    // 連鎖が解除したインスタンスは、後続プールの解決対象から消えている
    // （古い差分を握ったまま存在しないインスタンスを参照して落ちない）。
    const consumed = recorder.getEvents().filter((event) => event.eventType === "ShieldConsumed");
    expect(consumed).toHaveLength(1);
    expect(consumed[0]!.payload).toMatchObject({ shieldType: "EN" });
    expect(result.units[0]!.appliedEffects.map((effect) => effect.effectInstanceId)).toEqual([
      createEffectInstanceId("SHIELD_EN"),
    ]);
  });
});
