import { describe, expect, it } from "vitest";
import type { ActionSegment } from "./action-segment-projector.js";
import type { TraceStep } from "./trace-step-projector.js";
import { selectFirstTransitionInRange, selectTraceRange } from "./trace-range.js";

function segment(stateVersionBefore: number, stateVersionAfter: number): ActionSegment {
  return {
    kind: "SYSTEM",
    headline: { kind: "OTHER" },
    index: 0,
    turnNumber: 1,
    firstSequence: 1,
    lastSequence: 3,
    stateVersionBefore,
    stateVersionAfter,
    containsDefeat: false,
    events: [],
  };
}

function step(index: number, stateVersionAfter: number): TraceStep {
  return {
    index,
    kind: "OTHER",
    events: [],
    originEvents: [],
    otherEvents: [],
    presentations: [],
    firstSequence: index + 1,
    lastSequence: index + 1,
    stateVersionAfter,
    interruptDepth: 0,
    targetUnitIds: [],
  };
}

const SEGMENTS: readonly ActionSegment[] = [segment(0, 4), segment(4, 9)];
const STEPS: readonly (readonly TraceStep[])[] = [
  [step(0, 2), step(1, 4)],
  [step(0, 5), step(1, 7), step(2, 9)],
];

describe("selectTraceRange", () => {
  it("UI-UT-ATR-015: 処理単位は直前のステップの後→現在のステップの後、行動・ターン単位は区間の前→区間の後になり、変化の表から開く遷移は範囲の前の版より後の最初の遷移になる", () => {
    const firstStep = selectTraceRange(SEGMENTS, STEPS, {
      segmentIndex: 1,
      stepIndex: 0,
      unit: "step",
    });
    expect(firstStep).toMatchObject({ beforeVersion: 4, afterVersion: 5, stepMode: true });
    expect(firstStep?.steps.map((s) => s.index)).toEqual([0]);

    const middleStep = selectTraceRange(SEGMENTS, STEPS, {
      segmentIndex: 1,
      stepIndex: 1,
      unit: "step",
    });
    expect(middleStep).toMatchObject({ beforeVersion: 5, afterVersion: 7 });
    expect(middleStep?.steps.map((s) => s.index)).toEqual([1]);

    for (const unit of ["action", "turn"] as const) {
      const range = selectTraceRange(SEGMENTS, STEPS, { segmentIndex: 1, stepIndex: 2, unit });
      expect(range).toMatchObject({ beforeVersion: 4, afterVersion: 9, stepMode: false });
      expect(range?.segment).toBe(SEGMENTS[1]);
      expect(range?.steps.map((s) => s.index)).toEqual([0, 1, 2]);
    }

    expect(selectTraceRange([], [], { segmentIndex: 0, stepIndex: 0, unit: "action" })).toBe(
      undefined,
    );

    const transitions = [
      { stateVersionAfter: 3 },
      { stateVersionAfter: 5 },
      { stateVersionAfter: 6 },
      { stateVersionAfter: 8 },
    ];
    expect(selectFirstTransitionInRange(transitions, { beforeVersion: 4, afterVersion: 9 })).toBe(
      1,
    );
    expect(selectFirstTransitionInRange(transitions, { beforeVersion: 5, afterVersion: 7 })).toBe(
      2,
    );
    // 範囲内に遷移が無ければ移動の操作を出さない
    expect(selectFirstTransitionInRange(transitions, { beforeVersion: 8, afterVersion: 9 })).toBe(
      undefined,
    );
  });
});
