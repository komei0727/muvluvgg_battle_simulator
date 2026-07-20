import { describe, expect, it } from "vitest";
import { applyMarker, removeMarker } from "./marker-state.js";
import type { MarkerState } from "../model/marker-state.js";
import { createMarkerId } from "../../catalog/definitions/catalog-ids.js";
import { createBattleUnitId } from "../../shared/ids.js";

const TARGET = createBattleUnitId("ally:1");
const SOURCE = createBattleUnitId("enemy:1");
const MARKER = createMarkerId("MARKER_WARNING_ROD");

const DURATION_A = { definition: { dispellable: true, linkedEffectGroupId: null } };
const DURATION_B = {
  definition: {
    timeLimit: { unit: "TURN" as const, count: 3 },
    dispellable: true,
    linkedEffectGroupId: null,
  },
  timeLimitRemaining: 3,
};

function baseRequest(overrides: {
  readonly policy: "ADD" | "KEEP_EXISTING" | "REFRESH" | "REPLACE";
  readonly stackMax?: number | null;
  readonly duration?: typeof DURATION_A;
}) {
  return {
    markerId: MARKER,
    sourceId: SOURCE,
    targetId: TARGET,
    policy: overrides.policy,
    stackMax: overrides.stackMax ?? null,
    duration: overrides.duration ?? DURATION_A,
    dispellable: true,
    linkedEffectGroupId: null,
  };
}

describe("applyMarker (R-EFF-10)", () => {
  it("UT-EFF-MARKER-001: grants a new Marker with stack 1 when none exists, regardless of policy", () => {
    const result = applyMarker([], baseRequest({ policy: "ADD" }));

    expect(result.before).toBeUndefined();
    expect(result.after).toMatchObject({ markerId: MARKER, stackCount: 1 });
    expect(result.markers).toHaveLength(1);
  });

  it("UT-EFF-MARKER-002: ADD adds to the existing stack count", () => {
    const existing: MarkerState = {
      markerId: MARKER,
      sourceId: SOURCE,
      targetId: TARGET,
      stackCount: 2,
      stackMax: null,
      duration: DURATION_A,
      dispellable: true,
      linkedEffectGroupId: null,
    };

    const result = applyMarker([existing], baseRequest({ policy: "ADD" }));

    expect(result.after.stackCount).toBe(3);
  });

  it("UT-EFF-MARKER-003: ADD does not exceed stack.max", () => {
    const existing: MarkerState = {
      markerId: MARKER,
      sourceId: SOURCE,
      targetId: TARGET,
      stackCount: 3,
      stackMax: 3,
      duration: DURATION_A,
      dispellable: true,
      linkedEffectGroupId: null,
    };

    const result = applyMarker([existing], baseRequest({ policy: "ADD", stackMax: 3 }));

    expect(result.after.stackCount).toBe(3);
  });

  it("UT-EFF-MARKER-004: KEEP_EXISTING leaves an existing Marker's stack and duration unchanged", () => {
    const existing: MarkerState = {
      markerId: MARKER,
      sourceId: SOURCE,
      targetId: TARGET,
      stackCount: 2,
      stackMax: null,
      duration: DURATION_A,
      dispellable: true,
      linkedEffectGroupId: null,
    };

    const result = applyMarker(
      [existing],
      baseRequest({ policy: "KEEP_EXISTING", duration: DURATION_B }),
    );

    expect(result.after).toEqual(existing);
  });

  it("UT-EFF-MARKER-005: REFRESH keeps the stack count but resets the duration", () => {
    const existing: MarkerState = {
      markerId: MARKER,
      sourceId: SOURCE,
      targetId: TARGET,
      stackCount: 2,
      stackMax: null,
      duration: DURATION_A,
      dispellable: true,
      linkedEffectGroupId: null,
    };

    const result = applyMarker(
      [existing],
      baseRequest({ policy: "REFRESH", duration: DURATION_B }),
    );

    expect(result.after.stackCount).toBe(2);
    expect(result.after.duration).toEqual(DURATION_B);
  });

  it("UT-EFF-MARKER-006: REPLACE overwrites the existing Marker with the new definition's stack and duration", () => {
    const existing: MarkerState = {
      markerId: MARKER,
      sourceId: SOURCE,
      targetId: TARGET,
      stackCount: 5,
      stackMax: null,
      duration: DURATION_A,
      dispellable: true,
      linkedEffectGroupId: null,
    };

    const result = applyMarker(
      [existing],
      baseRequest({ policy: "REPLACE", duration: DURATION_B }),
    );

    expect(result.after.stackCount).toBe(1);
    expect(result.after.duration).toEqual(DURATION_B);
  });

  it("UT-EFF-MARKER-007: stack count never goes below 0", () => {
    const result = applyMarker([], baseRequest({ policy: "ADD", stackMax: 0 }));

    expect(result.after.stackCount).toBe(0);
  });
});

describe("removeMarker", () => {
  it("UT-EFF-MARKER-008: removes the whole Marker instance when it exists", () => {
    const existing: MarkerState = {
      markerId: MARKER,
      sourceId: SOURCE,
      targetId: TARGET,
      stackCount: 3,
      stackMax: null,
      duration: DURATION_A,
      dispellable: true,
      linkedEffectGroupId: null,
    };

    const result = removeMarker([existing], MARKER);

    expect(result.markers).toEqual([]);
    expect(result.removed).toEqual(existing);
  });

  it("UT-EFF-MARKER-009: no-ops when the Marker doesn't exist", () => {
    const result = removeMarker([], MARKER);

    expect(result.markers).toEqual([]);
    expect(result.removed).toBeUndefined();
  });
});
