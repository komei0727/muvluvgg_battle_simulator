import { describe, expect, it } from "vitest";
import { buildInitialDurationState } from "./applied-effect.js";
import { createActionId } from "../../shared/event-ids.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";

describe("buildInitialDurationState", () => {
  it("UT-EFF-DUR-STATE-001: sets timeLimitRemaining and grantedActionId for an ACTION-unit duration", () => {
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

  it("UT-EFF-DUR-STATE-002: sets timeLimitRemaining and grantedTurnNumber for a TURN-unit duration", () => {
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

  it("UT-EFF-DUR-STATE-003: sets consumptionRemaining when the definition has a consumption clause", () => {
    const definition: DurationDefinition = {
      consumption: { kind: "OUTGOING_HIT", maxCount: 3 },
      dispellable: true,
      linkedEffectGroupId: null,
    };

    const state = buildInitialDurationState(definition, { turnNumber: 1 });

    expect(state.consumptionRemaining).toBe(3);
  });

  it("UT-EFF-DUR-STATE-004: has no remaining counters for a battle-persistent duration (no timeLimit, no consumption)", () => {
    const definition: DurationDefinition = { dispellable: true, linkedEffectGroupId: null };

    const state = buildInitialDurationState(definition, { turnNumber: 1 });

    expect(state.timeLimitRemaining).toBeUndefined();
    expect(state.consumptionRemaining).toBeUndefined();
  });

  it("UT-EFF-DUR-STATE-005: does not set grantedActionId for an ACTION-unit duration granted outside an action (PS from a top-level event)", () => {
    const definition: DurationDefinition = {
      timeLimit: { unit: "ACTION", count: 1 },
      dispellable: true,
      linkedEffectGroupId: null,
    };

    const state = buildInitialDurationState(definition, { turnNumber: 1 });

    expect(state.grantedActionId).toBeUndefined();
  });
});
