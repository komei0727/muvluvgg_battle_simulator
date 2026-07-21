import { describe, expect, it } from "vitest";
import { grantEffect } from "./effect-grant-service.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createActionId, type createDomainEventId } from "../../shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";
import { DomainValidationError } from "../../shared/errors.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 10 };

function unit(id: string): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
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
  return createBattleUnit(member, "ALLY", LIMITS);
}

function seedRecorder(): {
  recorder: EventRecorder;
  rootEventId: ReturnType<typeof createDomainEventId>;
} {
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

const EFFECT_ACTION_DEFINITION_ID = createEffectActionDefinitionId("ACT_ATK_UP");

const TURN_DURATION: DurationDefinition = {
  timeLimit: { unit: "TURN", count: 2 },
  dispellable: true,
  linkedEffectGroupId: null,
};

describe("grantEffect", () => {
  it("UT-R-EFF-01-016 (R-EFF-01): appends a new AppliedEffect instance to the target's individually-held registry", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();

    const result = grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        actionId: createActionId("B_1:action:1"),
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        effectActionDefinitionId: EFFECT_ACTION_DEFINITION_ID,
        sourceId: source.battleUnitId,
        targetId: target.battleUnitId,
        duplicate: true,
        magnitude: 20,
        durationDefinition: TURN_DURATION,
      },
      rootEventId,
    );

    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.appliedEffects).toHaveLength(1);
    expect(updatedTarget.appliedEffects[0]).toMatchObject({
      effectActionDefinitionId: EFFECT_ACTION_DEFINITION_ID,
      sourceId: source.battleUnitId,
      targetId: target.battleUnitId,
      duplicate: true,
      magnitude: 20,
      appliedTurnNumber: 1,
    });
    expect(result.appliedEffect).toBe(updatedTarget.appliedEffects[0]);
  });

  it("UT-R-EFF-01-017 (R-EFF-01): retains a second grant as a separate instance instead of merging with an existing one of the same kind", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = {
      recorder,
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      rootEventId,
    };
    const request = {
      effectActionDefinitionId: EFFECT_ACTION_DEFINITION_ID,
      sourceId: source.battleUnitId,
      targetId: target.battleUnitId,
      duplicate: true,
      magnitude: 20,
      durationDefinition: TURN_DURATION,
    };

    const first = grantEffect(context, [source, target], request, rootEventId);
    const second = grantEffect(context, first.units, request, rootEventId);

    const updatedTarget = second.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.appliedEffects).toHaveLength(2);
    expect(updatedTarget.appliedEffects[0]!.effectInstanceId).not.toBe(
      updatedTarget.appliedEffects[1]!.effectInstanceId,
    );
  });

  it("UT-R-EFF-01-018 (R-EFF-01/08_ドメインイベント.md EffectApplied payload): records an EffectApplied FACT event carrying the instance id, source/target, duration unit/remaining, and linkedEffectGroupId", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();

    const result = grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        effectActionDefinitionId: EFFECT_ACTION_DEFINITION_ID,
        sourceId: source.battleUnitId,
        targetId: target.battleUnitId,
        duplicate: true,
        magnitude: 20,
        durationDefinition: TURN_DURATION,
      },
      rootEventId,
    );

    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied");
    expect(applied).toBeDefined();
    expect(applied!.eventId).toBe(result.lastEventId);
    expect(applied!.payload).toMatchObject({
      effectInstanceId: result.appliedEffect.effectInstanceId,
      effectActionDefinitionId: EFFECT_ACTION_DEFINITION_ID,
      sourceUnitId: source.battleUnitId,
      targetUnitId: target.battleUnitId,
      duplicate: true,
      kindKey: EFFECT_ACTION_DEFINITION_ID,
      magnitude: 20,
      durationUnit: "TURN",
      initialRemaining: 2,
      linkedEffectGroupId: null,
    });
    const effectDelta =
      applied!.stateDelta?.units?.[target.battleUnitId]?.effects?.[
        result.appliedEffect.effectInstanceId
      ];
    expect(effectDelta?.before).toBeUndefined();
    expect(effectDelta?.after?.effectInstanceId).toBe(result.appliedEffect.effectInstanceId);
  });

  it("UT-R-EFF-01-019 (R-EFF-01): stores a snapshot value fixed at grant time (e.g. continuous-damage source attack)", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();

    const result = grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        effectActionDefinitionId: EFFECT_ACTION_DEFINITION_ID,
        sourceId: source.battleUnitId,
        targetId: target.battleUnitId,
        duplicate: true,
        magnitude: 5,
        durationDefinition: TURN_DURATION,
        snapshot: { sourceAttack: 10 },
      },
      rootEventId,
    );

    expect(result.appliedEffect.snapshot).toEqual({ sourceAttack: 10 });
    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied");
    expect(applied!.payload).toMatchObject({ snapshot: { sourceAttack: 10 } });
  });

  it("UT-R-EFF-01-020 (defensive; preflight should already guarantee this): throws when targetId references an unknown BattleUnitId", () => {
    const source = unit("source-1");
    const { recorder, rootEventId } = seedRecorder();

    expect(() =>
      grantEffect(
        {
          recorder,
          turnNumber: 1,
          cycleNumber: 0,
          resolutionScopeId: recorder.nextResolutionScopeId(),
          rootEventId,
        },
        [source],
        {
          effectActionDefinitionId: EFFECT_ACTION_DEFINITION_ID,
          sourceId: source.battleUnitId,
          targetId: createBattleUnitId("MISSING"),
          duplicate: true,
          magnitude: 20,
          durationDefinition: TURN_DURATION,
        },
        rootEventId,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-R-EFF-01-023 (08_ドメインイベント.md EffectApplied payload: duration owner and expiration conditions): carries timeLimit.owner and expiration.conditions in the recorded event when the duration definition has them", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const durationWithOwnerAndExpiration: DurationDefinition = {
      timeLimit: { unit: "TURN", count: 2, owner: "EFFECT_SOURCE" },
      expiration: { conditions: [{ kind: "TRUE" }] },
      dispellable: true,
      linkedEffectGroupId: null,
    };

    grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        effectActionDefinitionId: EFFECT_ACTION_DEFINITION_ID,
        sourceId: source.battleUnitId,
        targetId: target.battleUnitId,
        duplicate: true,
        magnitude: 20,
        durationDefinition: durationWithOwnerAndExpiration,
      },
      rootEventId,
    );

    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied");
    expect(applied!.payload).toMatchObject({
      durationOwner: "EFFECT_SOURCE",
      expirationConditions: [{ kind: "TRUE" }],
    });
  });

  it("UT-R-EFF-01-024: omits durationOwner/expirationConditions when the duration definition has neither", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();

    grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        effectActionDefinitionId: EFFECT_ACTION_DEFINITION_ID,
        sourceId: source.battleUnitId,
        targetId: target.battleUnitId,
        duplicate: true,
        magnitude: 20,
        durationDefinition: TURN_DURATION,
      },
      rootEventId,
    );

    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied");
    expect(applied!.payload).not.toHaveProperty("durationOwner");
    expect(applied!.payload).not.toHaveProperty("expirationConditions");
  });

  it("UT-R-EFF-01-028 (08_ドメインイベント.md EffectApplied payload: 初期回数、残り回数; PR #207レビュー[P2]): carries the instance's own remainingCount/consumptionRemaining, not just the definition's static initialRemaining/consumptionMaxCount", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const durationWithConsumption: DurationDefinition = {
      timeLimit: { unit: "TURN", count: 2 },
      consumption: { kind: "OUTGOING_HIT", maxCount: 3 },
      dispellable: true,
      linkedEffectGroupId: null,
    };

    grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        effectActionDefinitionId: EFFECT_ACTION_DEFINITION_ID,
        sourceId: source.battleUnitId,
        targetId: target.battleUnitId,
        duplicate: true,
        magnitude: 20,
        durationDefinition: durationWithConsumption,
      },
      rootEventId,
    );

    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied");
    expect(applied!.payload).toMatchObject({
      initialRemaining: 2,
      remainingCount: 2,
      consumptionMaxCount: 3,
      consumptionRemaining: 3,
    });
  });
});
