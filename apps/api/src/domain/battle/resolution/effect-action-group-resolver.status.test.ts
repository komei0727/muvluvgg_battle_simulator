import { describe, expect, it } from "vitest";
import { applyEffectActionGroups } from "./effect-action-group-resolver.js";
import type { BattleUnit } from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId } from "../model/applied-effect.js";
import type { EffectSequencePlan } from "../skill/skill-resolution-service.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createActionId, createEffectInstanceId } from "../../shared/event-ids.js";
import { createEffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import { DomainValidationError } from "../../shared/errors.js";
import {
  unit,
  statusAction,
  skillOf,
  contextFor,
  seedRecorder,
  singleActionStep,
  expectCompleted,
} from "../../../testing/fixtures/effect-sequence-plan.js";

describe("applyEffectActionGroups", () => {
  it("UT-R-EFF-01-044 (TGT-004フェーズ3、Issue #167、R-ACTN-03、real lifecycle wiring): an APPLY_STATUS ACTION step grants a statusKind-bearing AppliedEffect through the real Catalog -> EffectSequence -> AppliedEffect -> event pipeline, without touching CombatStats", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const status = statusAction("ACT_STEALTH");
    const effectActions = new Map([[status.effectActionDefinitionId, status]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, status.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const before = recorder.getEvents().length;
    const result = applyEffectActionGroups(plan, [actor, enemy], context);
    const emitted = recorder
      .getEvents()
      .slice(before)
      .map((e) => e.eventType);

    expect(emitted).toEqual([
      "EffectStepStarting",
      "EffectActionStarting",
      "EffectApplied",
      "EffectActionCompleted",
      "EffectStepCompleted",
    ]);
    expectCompleted(result, 1);

    const grantedTarget = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(grantedTarget.appliedEffects).toHaveLength(1);
    expect(grantedTarget.appliedEffects[0]).toMatchObject({
      effectActionDefinitionId: status.effectActionDefinitionId,
      sourceUnitId: actor.battleUnitId,
      targetUnitId: enemy.battleUnitId,
      duplicate: true,
      magnitude: 0,
      statusKind: "STEALTH",
      appliedTurnNumber: 1,
    });
    expect(grantedTarget.appliedEffects[0]!.duration.timeLimitRemaining).toBe(3);

    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied") as Extract<
      BattleDomainEvent,
      { eventType: "EffectApplied" }
    >;
    expect(applied.payload).toMatchObject({
      effectInstanceId: grantedTarget.appliedEffects[0]!.effectInstanceId,
      statusKind: "STEALTH",
      durationUnit: "SKILL_USE",
      initialRemaining: 3,
    });

    const completed = recorder
      .getEvents()
      .find((e) => e.eventType === "EffectActionCompleted") as Extract<
      BattleDomainEvent,
      { eventType: "EffectActionCompleted" }
    >;
    expect(completed.payload.resultKind).toBe("APPLIED");
    expect(completed.parentEventId).toBe(applied.eventId);
  });

  it("UT-R-EFF-01-045 (TGT-004フェーズ3、Issue #167): an APPLY_STATUS ACTION step against an already-defeated target grants no AppliedEffect and completes as SKIPPED", () => {
    const actor = unit("ACTOR", "ALLY");
    const defeated = unit("DEFEATED", "ENEMY", { currentHp: 0 });
    const status = statusAction("ACT_STEALTH");
    const effectActions = new Map([[status.effectActionDefinitionId, status]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, defeated.battleUnitId, status.effectActionDefinitionId)],
      targetUnitIds: [defeated.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, defeated], context);

    const target = result.units.find((u) => u.battleUnitId === defeated.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(0);
    expect(recorder.getEvents().some((e) => e.eventType === "EffectApplied")).toBe(false);
    const completed = recorder
      .getEvents()
      .find((e) => e.eventType === "EffectActionCompleted") as Extract<
      BattleDomainEvent,
      { eventType: "EffectActionCompleted" }
    >;
    expect(completed.payload.resultKind).toBe("SKIPPED");
  });

  it("UT-R-EFF-01-046 [R-STS-02] (TGT-004フェーズ3、Issue #167): an APPLY_STATUS payload with probability/appliesTo/damageThreshold/damageAmplificationOnBreak (R-STS-01〜04 scope, not yet implemented) throws a clear error instead of silently granting unconditionally", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const status: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_STUN"),
      metadata: { tags: [] },
      payload: {
        status: "STUN",
        probability: 0.5,
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[status.effectActionDefinitionId, status]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, status.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    expect(() => applyEffectActionGroups(plan, [actor, enemy], context)).toThrow(
      DomainValidationError,
    );
  });

  it("UT-R-EFF-01-051 [R-STS-02] (Issue #180, M7-003, R-STS-02): a STUN APPLY_STATUS payload with NO extra fields (e.g. production ACT_CHIZURU_DOMESTIC_AS1_STUN's exact shape: just status+duration) grants the status", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const status: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_STUN_NO_EXTRA_FIELDS"),
      metadata: { tags: [] },
      payload: {
        status: "STUN",
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[status.effectActionDefinitionId, status]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, status.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]).toMatchObject({ statusKind: "STUN" });
  });

  it("UT-R-HIT-03-010 [R-HIT-03, R-STS-04] (R-HIT-03/R-STS-04, Issue #183, CAP_STATUS_EFFECT_KIND): an APPLY_STATUS(BLIND) ACTION step grants a statusKind BLIND AppliedEffect carrying statusDetails.probability through the real Catalog -> EffectSequence -> AppliedEffect pipeline", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const status: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_BLIND"),
      metadata: { tags: [] },
      payload: {
        status: "BLIND",
        probability: 0.55,
        duration: {
          timeLimit: { unit: "ACTION", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[status.effectActionDefinitionId, status]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, status.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]).toMatchObject({
      statusKind: "BLIND",
      statusDetails: { probability: 0.55 },
    });
    expect(target.appliedEffects[0]!.duration.timeLimitRemaining).toBe(2);
  });

  it("UT-R-DMG-02-010 (R-DMG-02, Issue #183, CAP_STATUS_EFFECT_KIND): an APPLY_STATUS(DAMAGE_IMMUNITY) ACTION step grants a statusKind DAMAGE_IMMUNITY AppliedEffect carrying statusDetails.damageThreshold through the real Catalog -> EffectSequence -> AppliedEffect pipeline", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const immunity: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_IMMUNITY"),
      metadata: { tags: [] },
      payload: {
        status: "DAMAGE_IMMUNITY",
        damageThreshold: {
          op: "GT",
          formula: { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.35 },
        },
        duration: {
          timeLimit: { unit: "ACTION", count: 2 },
          consumption: { kind: "INCOMING_HIT", maxCount: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[immunity.effectActionDefinitionId, immunity]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, immunity.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]).toMatchObject({
      statusKind: "DAMAGE_IMMUNITY",
      statusDetails: {
        damageThreshold: {
          op: "GT",
          formula: { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.35 },
        },
      },
    });
  });

  it("UT-R-STS-03-004 (R-STS-03, Issue #183, CAP_STATUS_EFFECT_KIND): an APPLY_STATUS(FREEZE) ACTION step grants a statusKind FREEZE AppliedEffect carrying statusDetails.damageAmplificationOnBreak through the real Catalog -> EffectSequence -> AppliedEffect pipeline, without cancelling a pending charge", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY", {
      charge: { skill: {}, startedActionId: {} } as unknown as NonNullable<BattleUnit["charge"]>,
    });
    const freeze: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_FREEZE"),
      metadata: { tags: [] },
      payload: {
        status: "FREEZE",
        damageAmplificationOnBreak: 1.5,
        duration: {
          timeLimit: { unit: "ACTION", count: 3 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[freeze.effectActionDefinitionId, freeze]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, freeze.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]).toMatchObject({
      statusKind: "FREEZE",
      statusDetails: { damageAmplificationOnBreak: 1.5 },
    });
    expect(target.charge).toBeDefined();
    expect(recorder.getEvents().some((e) => e.eventType === "ChargeCancelled")).toBe(false);
  });

  it("UT-R-HIT-02-011 (R-HIT-02, Issue #183, CAP_HIT_COUNT_EVASION): an APPLY_STATUS(EVASION) ACTION step grants a statusKind EVASION AppliedEffect carrying statusDetails.probability/appliesTo through the real Catalog -> EffectSequence -> AppliedEffect pipeline", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const evasion: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_EVASION"),
      metadata: { tags: [] },
      payload: {
        status: "EVASION",
        probability: 0.6,
        appliesTo: { incomingActionKinds: ["DAMAGE"] },
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[evasion.effectActionDefinitionId, evasion]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, evasion.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]).toMatchObject({
      statusKind: "EVASION",
      statusDetails: {
        probability: 0.6,
        appliesTo: { incomingActionKinds: ["DAMAGE"] },
      },
    });
  });

  it("UT-R-HIT-04-009 (R-HIT-04, M7-018/Issue #272, CAP_HIT_COUNT_EVASION): an APPLY_STATUS(HIT_EVASION) ACTION step shaped like ACT_FLUTE_VAMPIRE_PS2_EVASION grants a statusKind HIT_EVASION AppliedEffect with its INCOMING_HIT consumption through the real Catalog -> EffectSequence -> AppliedEffect pipeline", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const hitEvasion: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_HIT_EVASION"),
      metadata: { tags: [] },
      payload: {
        status: "HIT_EVASION",
        probability: 1,
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[hitEvasion.effectActionDefinitionId, hitEvasion]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, hitEvasion.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]).toMatchObject({
      statusKind: "HIT_EVASION",
      statusDetails: { probability: 1 },
      duration: { consumptionRemaining: 1 },
    });
  });

  it("UT-R-HIT-05-007 (R-HIT-05, M7-018/Issue #272, CAP_STATUS_EFFECT_KIND): an APPLY_STATUS(GUARANTEED_HIT) ACTION step shaped like ACT_LAYLA_ENTREPRENEUR_PS1_GUARANTEED_HIT grants a statusKind GUARANTEED_HIT AppliedEffect with its SKILL_USE time limit through the real Catalog -> EffectSequence -> AppliedEffect pipeline", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const guaranteedHit: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_GUARANTEED_HIT"),
      metadata: { tags: [] },
      payload: {
        status: "GUARANTEED_HIT",
        probability: 1,
        duration: {
          timeLimit: { unit: "SKILL_USE", count: 4 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[guaranteedHit.effectActionDefinitionId, guaranteedHit]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        singleActionStep(0, true, enemy.battleUnitId, guaranteedHit.effectActionDefinitionId),
      ],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]).toMatchObject({
      statusKind: "GUARANTEED_HIT",
      duration: { timeLimitRemaining: 4 },
    });
  });

  it("UT-R-HIT-05-008 (R-HIT-05, M7-018/Issue #272): an APPLY_STATUS(GUARANTEED_HIT) carrying incoming-side fields is rejected instead of being granted without effect", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const guaranteedHit: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_GUARANTEED_HIT"),
      metadata: { tags: [] },
      payload: {
        status: "GUARANTEED_HIT",
        appliesTo: { incomingActionKinds: ["DAMAGE"] },
        duration: { dispellable: true, linkedEffectGroupId: null },
      },
    };
    const effectActions = new Map([[guaranteedHit.effectActionDefinitionId, guaranteedHit]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        singleActionStep(0, true, enemy.battleUnitId, guaranteedHit.effectActionDefinitionId),
      ],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    expect(() => applyEffectActionGroups(plan, [actor, enemy], context)).toThrow(
      DomainValidationError,
    );
  });

  it("UT-R-CRT-03-010 (R-CRT-03, DMG-003A/Issue #295, CAP_CRITICAL_CONTROL): an APPLY_STATUS(CRITICAL_GUARANTEE) ACTION step shaped like ACT_MIKOTO_SURVIVOR_EX_CRIT_GUARANTEE grants a statusKind CRITICAL_GUARANTEE AppliedEffect with its ACTION time limit", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const criticalGuarantee: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_CRIT_GUARANTEE"),
      metadata: { tags: [] },
      payload: {
        status: "CRITICAL_GUARANTEE",
        duration: {
          timeLimit: { unit: "ACTION", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([
      [criticalGuarantee.effectActionDefinitionId, criticalGuarantee],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        singleActionStep(0, true, enemy.battleUnitId, criticalGuarantee.effectActionDefinitionId),
      ],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]).toMatchObject({
      statusKind: "CRITICAL_GUARANTEE",
      duration: { timeLimitRemaining: 2 },
    });
  });

  it("UT-R-CRT-03-011 (R-CRT-03, DMG-003A/Issue #295): an APPLY_STATUS(CRITICAL_PREVENTION) ACTION step shaped like ACT_TARISA_TROUBLEMAKER_AS1_CRIT_PREVENTION grants a statusKind CRITICAL_PREVENTION AppliedEffect", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const criticalPrevention: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_CRIT_PREVENTION"),
      metadata: { tags: [] },
      payload: {
        status: "CRITICAL_PREVENTION",
        probability: 1,
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([
      [criticalPrevention.effectActionDefinitionId, criticalPrevention],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        singleActionStep(0, true, enemy.battleUnitId, criticalPrevention.effectActionDefinitionId),
      ],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]).toMatchObject({
      statusKind: "CRITICAL_PREVENTION",
      duration: { timeLimitRemaining: 1 },
    });
  });

  it("UT-R-CRT-03-012 (R-CRT-03 negative, DMG-003A/Issue #295): a critical status carrying incoming-side fields or a probability below 1 is rejected instead of being granted without effect", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const unsupportedPayloads = [
      {
        status: "CRITICAL_GUARANTEE" as const,
        appliesTo: { incomingActionKinds: ["DAMAGE" as const] },
      },
      {
        status: "CRITICAL_PREVENTION" as const,
        damageThreshold: { op: "GTE" as const, formula: { kind: "CONSTANT" as const, value: 10 } },
      },
      { status: "CRITICAL_PREVENTION" as const, damageAmplificationOnBreak: 0.5 },
      { status: "CRITICAL_GUARANTEE" as const, probability: 0.5 },
    ];

    for (const [index, extra] of unsupportedPayloads.entries()) {
      const definition: EffectActionDefinition = {
        kind: "APPLY_STATUS",
        effectActionDefinitionId: createEffectActionDefinitionId(`ACT_CRIT_UNSUPPORTED_${index}`),
        metadata: { tags: [] },
        payload: { ...extra, duration: { dispellable: true, linkedEffectGroupId: null } },
      };
      const effectActions = new Map([[definition.effectActionDefinitionId, definition]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, enemy.battleUnitId, definition.effectActionDefinitionId)],
        targetUnitIds: [enemy.battleUnitId],
        resolvedBindings: new Map(),
      };

      expect(() => applyEffectActionGroups(plan, [actor, enemy], context)).toThrow(
        DomainValidationError,
      );
    }
  });

  it("UT-R-STS-02-004 [R-SKL-05, R-STS-02] (R-SKL-05/R-STS-02, Issue #180): granting STUN to a unit with a pending charge cancels it and records ChargeCancelled", () => {
    const actor = unit("ACTOR", "ALLY");
    const chargedSkill = skillOf({ kind: "IMMEDIATE", targetBindings: [], steps: [] });
    const startedActionId = createActionId("B_TEST:action:1");
    const enemy = unit("ENEMY", "ENEMY", {
      charge: { skill: chargedSkill, startedActionId },
    });
    const stun: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_STUN"),
      metadata: { tags: [] },
      payload: {
        status: "STUN",
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[stun.effectActionDefinitionId, stun]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, stun.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.charge).toBeUndefined();
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]).toMatchObject({ statusKind: "STUN" });

    const cancelled = recorder
      .getEvents()
      .find((e) => e.eventType === "ChargeCancelled") as Extract<
      BattleDomainEvent,
      { eventType: "ChargeCancelled" }
    >;
    expect(cancelled).toBeDefined();
    expect(cancelled.payload).toMatchObject({
      actorUnitId: enemy.battleUnitId,
      skillDefinitionId: chargedSkill.skillDefinitionId,
      startedActionId,
      reason: "STUN",
    });
  });

  it("UT-R-STS-02-005 (R-STS-02, Issue #180): granting STUN to a unit without a pending charge records no ChargeCancelled", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const stun: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_STUN"),
      metadata: { tags: [] },
      payload: {
        status: "STUN",
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[stun.effectActionDefinitionId, stun]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, stun.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    applyEffectActionGroups(plan, [actor, enemy], context);

    expect(recorder.getEvents().some((e) => e.eventType === "ChargeCancelled")).toBe(false);
  });

  it("UT-R-STS-01-001 (R-STS-01 '状態異常はデバフの一種とする'): a real, production-granted STUN AppliedEffect is removed by a REMOVE_EFFECTS(categories: DEBUFF) ACTION step", () => {
    const actor = unit("ACTOR", "ALLY");
    const stunDefId = createEffectActionDefinitionId("ACT_STUN");
    const enemy = unit("ENEMY", "ENEMY", {
      appliedEffects: [
        {
          effectInstanceId: createEffectInstanceId("stun-1"),
          effectActionDefinitionId: stunDefId,
          kindKey: effectKindKeyFromDefinitionId(stunDefId),
          duplicate: true,
          sourceUnitId: createBattleUnitId("SOURCE"),
          targetUnitId: createBattleUnitId("ENEMY"),
          magnitude: 0,
          categories: ["DEBUFF", "STATUS"],
          statusKind: "STUN",
          duration: {
            definition: {
              timeLimit: { unit: "ACTION", count: 1 },
              dispellable: true,
              linkedEffectGroupId: null,
            },
            timeLimitRemaining: 1,
          },
          appliedTurnNumber: 1,
        },
      ],
    });
    const stunDef: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: stunDefId,
      metadata: { tags: [] },
      payload: {
        status: "STUN",
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const remove: EffectActionDefinition = {
      kind: "REMOVE_EFFECTS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_CLEANSE_DEBUFF"),
      metadata: { tags: [] },
      payload: { categories: ["DEBUFF"] },
    };
    const effectActions = new Map<
      ReturnType<typeof createEffectActionDefinitionId>,
      EffectActionDefinition
    >([
      [stunDef.effectActionDefinitionId, stunDef],
      [remove.effectActionDefinitionId, remove],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, remove.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(0);
    const removed = recorder.getEvents().find((e) => e.eventType === "EffectRemoved") as Extract<
      BattleDomainEvent,
      { eventType: "EffectRemoved" }
    >;
    expect(removed.payload).toMatchObject({
      effectInstanceId: createEffectInstanceId("stun-1"),
      battleUnitId: enemy.battleUnitId,
      reason: "REMOVED",
    });
  });
});
