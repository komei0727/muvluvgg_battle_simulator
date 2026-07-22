import { describe, expect, it } from "vitest";
import { buildInitialDurationState, effectKindKeyFromDefinitionId } from "./applied-effect.js";
import { createActionId } from "../../shared/event-ids.js";
import {
  createRuntimeCounterId,
  type EffectActionDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";

describe("effectKindKeyFromDefinitionId", () => {
  it("UT-R-EFF-01-002: derives the EffectKindKey from the EffectActionDefinitionId", () => {
    const definitionId = "EFFECT_ACTION_TEST" as EffectActionDefinitionId;
    expect(effectKindKeyFromDefinitionId(definitionId)).toBe("EFFECT_ACTION_TEST");
  });
});

describe("buildInitialDurationState", () => {
  it("UT-R-EFF-01-003: sets timeLimitRemaining and grantedActionId for an ACTION-unit duration", () => {
    const definition: DurationDefinition = {
      timeLimit: { unit: "ACTION", count: 2 },
      dispellable: true,
      linkedEffectGroupId: null,
    };
    const actionId = createActionId("battle-1:action:1");

    const state = buildInitialDurationState(definition, { actionId, turnNumber: 1 });

    expect(state.timeLimitRemaining).toBe(2);
    expect(state.grantedActionId).toBe(actionId);
    expect(state.grantedTurnNumber).toBeUndefined();
  });

  it("UT-R-EFF-01-004: sets timeLimitRemaining and grantedTurnNumber for a TURN-unit duration", () => {
    const definition: DurationDefinition = {
      timeLimit: { unit: "TURN", count: 3 },
      dispellable: true,
      linkedEffectGroupId: null,
    };

    const state = buildInitialDurationState(definition, { turnNumber: 5 });

    expect(state.timeLimitRemaining).toBe(3);
    expect(state.grantedTurnNumber).toBe(5);
    expect(state.grantedActionId).toBeUndefined();
  });

  it("UT-R-EFF-01-005: sets consumptionRemaining when the definition has a consumption clause, held independently of timeLimit", () => {
    const definition: DurationDefinition = {
      timeLimit: { unit: "BATTLE", count: 1 },
      consumption: { kind: "OUTGOING_HIT", maxCount: 3 },
      dispellable: true,
      linkedEffectGroupId: "GROUP_1",
    };

    const state = buildInitialDurationState(definition, { turnNumber: 1 });

    expect(state.consumptionRemaining).toBe(3);
    expect(state.timeLimitRemaining).toBe(1);
    expect(state.definition.linkedEffectGroupId).toBe("GROUP_1");
  });

  it("UT-R-EFF-01-006: has no remaining counters for a battle-persistent duration (no timeLimit, no consumption)", () => {
    const definition: DurationDefinition = { dispellable: true, linkedEffectGroupId: null };

    const state = buildInitialDurationState(definition, { turnNumber: 1 });

    expect(state.timeLimitRemaining).toBeUndefined();
    expect(state.consumptionRemaining).toBeUndefined();
  });

  it("UT-R-EFF-01-007: does not set grantedActionId for an ACTION-unit duration granted outside an action (PS from a top-level event)", () => {
    const definition: DurationDefinition = {
      timeLimit: { unit: "ACTION", count: 1 },
      dispellable: true,
      linkedEffectGroupId: null,
    };

    const state = buildInitialDurationState(definition, { turnNumber: 1 });

    expect(state.grantedActionId).toBeUndefined();
  });

  it("UT-R-EFF-11-005 (EFF-005 Issue #162): starts with an empty counters map when the definition declares counterUpdates", () => {
    const definition: DurationDefinition = {
      dispellable: true,
      linkedEffectGroupId: null,
      counterUpdates: [
        {
          kind: "INCREMENT",
          counter: createRuntimeCounterId("RUNTIME_COUNTER_HIT_COUNT"),
          scope: "APPLIED_EFFECT",
          trigger: {
            eventType: "HitPointReduced",
            category: "FACT",
            sourceSelector: "ENEMY",
            targetSelector: "SELF",
            condition: { kind: "TRUE" },
          },
          amount: 1,
        },
      ],
    };

    const state = buildInitialDurationState(definition, { turnNumber: 1 });

    expect(state.counters).toEqual({});
  });

  it("UT-R-EFF-11-006 (EFF-005 Issue #162): omits counters when the definition declares no counterUpdates", () => {
    const definition: DurationDefinition = { dispellable: true, linkedEffectGroupId: null };

    const state = buildInitialDurationState(definition, { turnNumber: 1 });

    expect(state.counters).toBeUndefined();
  });
});
