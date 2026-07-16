import { describe, expect, it } from "vitest";
import {
  createInitialExecutionState,
  executionReducer,
  selectDisplayedSuccess,
  selectIsCatalogRevisionMismatch,
  selectIsResultDirty,
} from "./execution-reducer.js";
import type { SuccessfulExecutionSnapshot } from "./execution-reducer.js";
import type { BattleSimulationRequest } from "../formation/request-mapper.js";
import type { BattleSimulationResponse, UiApiError } from "./api-contract.js";

function request(overrides: Partial<BattleSimulationRequest> = {}): BattleSimulationRequest {
  return {
    allyFormation: {
      units: [{ unitDefinitionId: "UNIT_ALLY", position: { column: 0, row: "FRONT" } }],
      memoryDefinitionIds: [],
    },
    enemyFormation: {
      units: [{ unitDefinitionId: "UNIT_ENEMY", position: { column: 0, row: "FRONT" } }],
      memoryDefinitionIds: [],
    },
    turnLimit: 10,
    options: { logLevel: "DETAILED" },
    ...overrides,
  };
}

function response(): BattleSimulationResponse {
  return {
    schemaVersion: 1,
    battleId: "battle-1",
    catalogRevision: "rev-1",
    result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
    initialState: { units: [] },
    finalState: { units: [] },
    events: [],
    stateTransitions: [],
  };
}

const allySlotKeys = ["ally:FRONT:0"];
const enemySlotKeys = ["enemy:FRONT:0"];
const allyMemorySlotKeys = ["ally:memory:0"];
const enemyMemorySlotKeys = ["enemy:memory:0"];

describe("executionReducer — submissionStarted (UI-UT-EXEC-001)", () => {
  it("transitions idle -> submitting, carrying the submission-time slot map", () => {
    const state = executionReducer(createInitialExecutionState(), {
      type: "submissionStarted",
      executionId: "exec-1",
      request: request(),
      startedAt: 1000,
      allyUnitSlotKeys: allySlotKeys,
      enemyUnitSlotKeys: enemySlotKeys,
      allyMemorySlotKeys: allyMemorySlotKeys,
      enemyMemorySlotKeys: enemyMemorySlotKeys,
    });

    expect(state).toEqual({
      status: "submitting",
      executionId: "exec-1",
      request: request(),
      startedAt: 1000,
      allyUnitSlotKeys: allySlotKeys,
      enemyUnitSlotKeys: enemySlotKeys,
      allyMemorySlotKeys: allyMemorySlotKeys,
      enemyMemorySlotKeys: enemyMemorySlotKeys,
    });
  });

  it("carries the previous success snapshot forward on rerun", () => {
    let state = createInitialExecutionState();
    state = executionReducer(state, {
      type: "submissionStarted",
      executionId: "exec-1",
      request: request(),
      startedAt: 1000,
      allyUnitSlotKeys: allySlotKeys,
      enemyUnitSlotKeys: enemySlotKeys,
      allyMemorySlotKeys: allyMemorySlotKeys,
      enemyMemorySlotKeys: enemyMemorySlotKeys,
    });
    state = executionReducer(state, {
      type: "submissionSucceeded",
      executionId: "exec-1",
      response: response(),
      completedAt: 2000,
    });
    state = executionReducer(state, {
      type: "submissionStarted",
      executionId: "exec-2",
      request: request({ turnLimit: 20 }),
      startedAt: 3000,
      allyUnitSlotKeys: allySlotKeys,
      enemyUnitSlotKeys: enemySlotKeys,
      allyMemorySlotKeys: allyMemorySlotKeys,
      enemyMemorySlotKeys: enemyMemorySlotKeys,
    });

    expect(state.status).toBe("submitting");
    if (state.status !== "submitting") throw new Error("unreachable");
    expect(state.previousSuccess).toEqual({
      executionId: "exec-1",
      request: request(),
      response: response(),
      completedAt: 2000,
    });
  });
});

describe("executionReducer — submissionSucceeded (UI-UT-EXEC-002)", () => {
  it("transitions submitting -> succeeded with a matching executionId", () => {
    let state = createInitialExecutionState();
    state = executionReducer(state, {
      type: "submissionStarted",
      executionId: "exec-1",
      request: request(),
      startedAt: 1000,
      allyUnitSlotKeys: allySlotKeys,
      enemyUnitSlotKeys: enemySlotKeys,
      allyMemorySlotKeys: allyMemorySlotKeys,
      enemyMemorySlotKeys: enemyMemorySlotKeys,
    });
    state = executionReducer(state, {
      type: "submissionSucceeded",
      executionId: "exec-1",
      response: response(),
      requestId: "srv-req-1",
      completedAt: 2000,
    });

    expect(state).toEqual({
      status: "succeeded",
      executionId: "exec-1",
      request: request(),
      response: response(),
      requestId: "srv-req-1",
      completedAt: 2000,
    });
  });

  it("ignores a stale executionId (UI-CMP-002)", () => {
    let state = createInitialExecutionState();
    state = executionReducer(state, {
      type: "submissionStarted",
      executionId: "exec-current",
      request: request(),
      startedAt: 1000,
      allyUnitSlotKeys: allySlotKeys,
      enemyUnitSlotKeys: enemySlotKeys,
      allyMemorySlotKeys: allyMemorySlotKeys,
      enemyMemorySlotKeys: enemyMemorySlotKeys,
    });
    const beforeStale = state;

    state = executionReducer(state, {
      type: "submissionSucceeded",
      executionId: "exec-stale",
      response: response(),
      completedAt: 2000,
    });

    expect(state).toEqual(beforeStale);
  });
});

describe("executionReducer — submissionFailed (UI-UT-EXEC-003)", () => {
  const error: UiApiError = { kind: "SERVER", message: "boom" };

  it("transitions submitting -> failed, keeping the previous success", () => {
    let state = createInitialExecutionState();
    state = executionReducer(state, {
      type: "submissionStarted",
      executionId: "exec-1",
      request: request(),
      startedAt: 1000,
      allyUnitSlotKeys: allySlotKeys,
      enemyUnitSlotKeys: enemySlotKeys,
      allyMemorySlotKeys: allyMemorySlotKeys,
      enemyMemorySlotKeys: enemyMemorySlotKeys,
    });
    state = executionReducer(state, {
      type: "submissionSucceeded",
      executionId: "exec-1",
      response: response(),
      completedAt: 2000,
    });
    state = executionReducer(state, {
      type: "submissionStarted",
      executionId: "exec-2",
      request: request({ turnLimit: 30 }),
      startedAt: 3000,
      allyUnitSlotKeys: allySlotKeys,
      enemyUnitSlotKeys: enemySlotKeys,
      allyMemorySlotKeys: allyMemorySlotKeys,
      enemyMemorySlotKeys: enemyMemorySlotKeys,
    });
    state = executionReducer(state, {
      type: "submissionFailed",
      executionId: "exec-2",
      error,
    });

    expect(state.status).toBe("failed");
    if (state.status !== "failed") throw new Error("unreachable");
    expect(state.error).toEqual(error);
    expect(state.previousSuccess?.executionId).toBe("exec-1");
  });

  it("carries forward the submission-time slot map, not a recomputed one (UI-API-004)", () => {
    let state = createInitialExecutionState();
    state = executionReducer(state, {
      type: "submissionStarted",
      executionId: "exec-1",
      request: request(),
      startedAt: 1000,
      allyUnitSlotKeys: ["ally:FRONT:2"],
      enemyUnitSlotKeys: ["enemy:REAR:1"],
      allyMemorySlotKeys: ["ally:memory:4"],
      enemyMemorySlotKeys: ["enemy:memory:5"],
    });
    state = executionReducer(state, { type: "submissionFailed", executionId: "exec-1", error });

    expect(state.status).toBe("failed");
    if (state.status !== "failed") throw new Error("unreachable");
    expect(state.allyUnitSlotKeys).toEqual(["ally:FRONT:2"]);
    expect(state.enemyUnitSlotKeys).toEqual(["enemy:REAR:1"]);
    expect(state.allyMemorySlotKeys).toEqual(["ally:memory:4"]);
    expect(state.enemyMemorySlotKeys).toEqual(["enemy:memory:5"]);
  });

  it("ignores a stale executionId", () => {
    let state = createInitialExecutionState();
    state = executionReducer(state, {
      type: "submissionStarted",
      executionId: "exec-current",
      request: request(),
      startedAt: 1000,
      allyUnitSlotKeys: allySlotKeys,
      enemyUnitSlotKeys: enemySlotKeys,
      allyMemorySlotKeys: allyMemorySlotKeys,
      enemyMemorySlotKeys: enemyMemorySlotKeys,
    });
    const beforeStale = state;

    state = executionReducer(state, { type: "submissionFailed", executionId: "exec-stale", error });

    expect(state).toEqual(beforeStale);
  });
});

describe("executionReducer — submissionCancelled (UI-UT-EXEC-004)", () => {
  it("transitions submitting -> cancelled, keeping the previous success", () => {
    let state = createInitialExecutionState();
    state = executionReducer(state, {
      type: "submissionStarted",
      executionId: "exec-1",
      request: request(),
      startedAt: 1000,
      allyUnitSlotKeys: allySlotKeys,
      enemyUnitSlotKeys: enemySlotKeys,
      allyMemorySlotKeys: allyMemorySlotKeys,
      enemyMemorySlotKeys: enemyMemorySlotKeys,
    });
    state = executionReducer(state, { type: "submissionCancelled", executionId: "exec-1" });

    expect(state).toEqual({ status: "cancelled", executionId: "exec-1" });
  });

  it("ignores a stale executionId", () => {
    let state = createInitialExecutionState();
    state = executionReducer(state, {
      type: "submissionStarted",
      executionId: "exec-current",
      request: request(),
      startedAt: 1000,
      allyUnitSlotKeys: allySlotKeys,
      enemyUnitSlotKeys: enemySlotKeys,
      allyMemorySlotKeys: allyMemorySlotKeys,
      enemyMemorySlotKeys: enemyMemorySlotKeys,
    });
    const beforeStale = state;

    state = executionReducer(state, { type: "submissionCancelled", executionId: "exec-stale" });

    expect(state).toEqual(beforeStale);
  });

  it("is idempotent once already cancelled (P1 regression: late success must not override an explicit cancel)", () => {
    let state = createInitialExecutionState();
    state = executionReducer(state, {
      type: "submissionStarted",
      executionId: "exec-1",
      request: request(),
      startedAt: 1000,
      allyUnitSlotKeys: allySlotKeys,
      enemyUnitSlotKeys: enemySlotKeys,
      allyMemorySlotKeys: allyMemorySlotKeys,
      enemyMemorySlotKeys: enemyMemorySlotKeys,
    });
    state = executionReducer(state, { type: "submissionCancelled", executionId: "exec-1" });

    // A race where the network call actually succeeded despite the abort
    // must not resurrect the cancelled execution.
    state = executionReducer(state, {
      type: "submissionSucceeded",
      executionId: "exec-1",
      response: response(),
      completedAt: 2000,
    });

    expect(state.status).toBe("cancelled");
  });
});

describe("selectDisplayedSuccess", () => {
  it("returns undefined when idle", () => {
    expect(selectDisplayedSuccess(createInitialExecutionState())).toBeUndefined();
  });

  it("returns the own snapshot when succeeded", () => {
    let state = createInitialExecutionState();
    state = executionReducer(state, {
      type: "submissionStarted",
      executionId: "exec-1",
      request: request(),
      startedAt: 1000,
      allyUnitSlotKeys: allySlotKeys,
      enemyUnitSlotKeys: enemySlotKeys,
      allyMemorySlotKeys: allyMemorySlotKeys,
      enemyMemorySlotKeys: enemyMemorySlotKeys,
    });
    state = executionReducer(state, {
      type: "submissionSucceeded",
      executionId: "exec-1",
      response: response(),
      completedAt: 2000,
    });

    expect(selectDisplayedSuccess(state)?.executionId).toBe("exec-1");
  });

  it("returns the carried-forward snapshot when failed", () => {
    let state = createInitialExecutionState();
    state = executionReducer(state, {
      type: "submissionStarted",
      executionId: "exec-1",
      request: request(),
      startedAt: 1000,
      allyUnitSlotKeys: allySlotKeys,
      enemyUnitSlotKeys: enemySlotKeys,
      allyMemorySlotKeys: allyMemorySlotKeys,
      enemyMemorySlotKeys: enemyMemorySlotKeys,
    });
    state = executionReducer(state, {
      type: "submissionSucceeded",
      executionId: "exec-1",
      response: response(),
      completedAt: 2000,
    });
    state = executionReducer(state, {
      type: "submissionStarted",
      executionId: "exec-2",
      request: request({ turnLimit: 50 }),
      startedAt: 3000,
      allyUnitSlotKeys: allySlotKeys,
      enemyUnitSlotKeys: enemySlotKeys,
      allyMemorySlotKeys: allyMemorySlotKeys,
      enemyMemorySlotKeys: enemyMemorySlotKeys,
    });
    state = executionReducer(state, {
      type: "submissionFailed",
      executionId: "exec-2",
      error: { kind: "SERVER", message: "boom" },
    });

    expect(selectDisplayedSuccess(state)?.executionId).toBe("exec-1");
  });
});

describe("selectIsResultDirty (UI-CMP-003)", () => {
  it("is false when the latest built request matches the displayed success's request", () => {
    expect(selectIsResultDirty(request(), request())).toBe(false);
  });

  it("is true when the latest built request differs", () => {
    expect(selectIsResultDirty(request({ turnLimit: 20 }), request())).toBe(true);
  });

  it("is false when there is no displayed success yet", () => {
    expect(selectIsResultDirty(request(), undefined)).toBe(false);
  });
});

describe("selectIsCatalogRevisionMismatch (Issue #96 P1)", () => {
  function snapshot(): SuccessfulExecutionSnapshot {
    return {
      executionId: "exec-1",
      request: request(),
      response: response(),
      completedAt: 1000,
    };
  }

  it("is false when there is no displayed success yet", () => {
    expect(selectIsCatalogRevisionMismatch(undefined, "rev-1")).toBe(false);
  });

  it("is false when the catalog has not finished loading (revision unknown)", () => {
    expect(selectIsCatalogRevisionMismatch(snapshot(), undefined)).toBe(false);
  });

  it("is false when the displayed success's revision matches the held catalog's revision", () => {
    expect(selectIsCatalogRevisionMismatch(snapshot(), "rev-1")).toBe(false);
  });

  it("is true when the displayed success ran against a different catalog revision", () => {
    expect(selectIsCatalogRevisionMismatch(snapshot(), "rev-2")).toBe(true);
  });
});
