import { describe, expect, it } from "vitest";
import {
  decrementActionMarkerDurations,
  decrementTurnMarkerDurations,
} from "./marker-duration-decrement.js";
import type { MarkerState } from "../model/marker-state.js";
import { createActionId } from "../../shared/event-ids.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createMarkerId } from "../../catalog/definitions/catalog-ids.js";
import type { DurationOwner } from "../../catalog/definitions/catalog-enums.js";

const MARKER = createMarkerId("MARKER_WARNING_ROD");
const ACTION_1 = createActionId("battle-1:action:1");
const ACTION_2 = createActionId("battle-1:action:2");
const HOLDER = createBattleUnitId("ally:1");
const SOURCE = createBattleUnitId("enemy:1");
const OTHER = createBattleUnitId("enemy:2");

function actionMarker(overrides: {
  readonly remaining: number;
  readonly owner?: DurationOwner;
  readonly grantedActionId?: ReturnType<typeof createActionId>;
}): MarkerState {
  return {
    markerId: MARKER,
    sourceId: SOURCE,
    targetId: HOLDER,
    stackCount: 1,
    stackMax: null,
    duration: {
      definition: {
        timeLimit: {
          unit: "ACTION",
          count: 3,
          ...(overrides.owner !== undefined ? { owner: overrides.owner } : {}),
        },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      timeLimitRemaining: overrides.remaining,
      ...(overrides.grantedActionId !== undefined
        ? { grantedActionId: overrides.grantedActionId }
        : {}),
    },
    dispellable: true,
    linkedEffectGroupId: null,
  };
}

function turnMarker(overrides: {
  readonly remaining: number;
  readonly grantedTurnNumber?: number;
}): MarkerState {
  return {
    markerId: MARKER,
    sourceId: SOURCE,
    targetId: HOLDER,
    stackCount: 1,
    stackMax: null,
    duration: {
      definition: {
        timeLimit: { unit: "TURN", count: 2 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      timeLimitRemaining: overrides.remaining,
      ...(overrides.grantedTurnNumber !== undefined
        ? { grantedTurnNumber: overrides.grantedTurnNumber }
        : {}),
    },
    dispellable: true,
    linkedEffectGroupId: null,
  };
}

describe("decrementActionMarkerDurations (R-EFF-04, applied to Marker)", () => {
  it("decrements a default-owner (EFFECT_TARGET) Marker when its holder acts", () => {
    const markers = [actionMarker({ remaining: 3, grantedActionId: ACTION_1 })];

    const result = decrementActionMarkerDurations(markers, ACTION_2, HOLDER);

    expect(result.changes).toEqual([{ markerId: MARKER, before: 3, after: 2 }]);
  });

  it("does not decrement a Marker granted during the current action", () => {
    const markers = [actionMarker({ remaining: 3, grantedActionId: ACTION_1 })];

    const result = decrementActionMarkerDurations(markers, ACTION_1, HOLDER);

    expect(result.changes).toEqual([]);
  });

  it("honors EFFECT_SOURCE owner: decrements when the source acts, not the holder", () => {
    const markers = [
      actionMarker({ remaining: 3, owner: "EFFECT_SOURCE", grantedActionId: ACTION_1 }),
    ];

    expect(decrementActionMarkerDurations(markers, ACTION_2, SOURCE).changes).toHaveLength(1);
    expect(decrementActionMarkerDurations(markers, ACTION_2, HOLDER).changes).toEqual([]);
  });

  it("honors BATTLE owner: decrements when any unit acts", () => {
    const markers = [actionMarker({ remaining: 1, owner: "BATTLE", grantedActionId: ACTION_1 })];

    const result = decrementActionMarkerDurations(markers, ACTION_2, OTHER);

    expect(result.changes).toEqual([{ markerId: MARKER, before: 1, after: 0 }]);
  });
});

describe("decrementTurnMarkerDurations (R-EFF-06, applied to Marker)", () => {
  it("decrements a TURN-unit Marker not granted this turn", () => {
    const markers = [turnMarker({ remaining: 2, grantedTurnNumber: 1 })];

    const result = decrementTurnMarkerDurations(markers, 2);

    expect(result.changes).toEqual([{ markerId: MARKER, before: 2, after: 1 }]);
  });

  it("does not decrement a Marker granted during the current turn", () => {
    const markers = [turnMarker({ remaining: 2, grantedTurnNumber: 3 })];

    const result = decrementTurnMarkerDurations(markers, 3);

    expect(result.changes).toEqual([]);
  });
});
