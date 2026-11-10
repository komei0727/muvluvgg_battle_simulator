import { describe, expect, it } from "vitest";
import {
  createInitialTraceCursor,
  createTraceIndex,
  selectCanMove,
  traceCursorReducer,
  type TraceCursorAction,
  type TraceCursorState,
  type TraceIndex,
  type TraceIndexSegment,
} from "./trace-cursor-reducer.js";

function action(turnNumber: number, side: string, stepCount: number): TraceIndexSegment {
  return { kind: "ACTION", side, turnNumber, stepCount };
}

function system(turnNumber: number, stepCount: number): TraceIndexSegment {
  return { kind: "SYSTEM", turnNumber, stepCount };
}

// ターン1: システム(2) 味方(3) 敵(2) 味方(1) システム(1)
// ターン2: システム(1) 敵(2) 味方(2)
const INDEX: TraceIndex = {
  segments: [
    system(1, 2),
    action(1, "ALLY", 3),
    action(1, "ENEMY", 2),
    action(1, "ALLY", 1),
    system(1, 1),
    system(2, 1),
    action(2, "ENEMY", 2),
    action(2, "ALLY", 2),
  ],
};

function at(
  segmentIndex: number,
  stepIndex: number,
  overrides: Partial<TraceCursorState> = {},
): TraceCursorState {
  return { ...createInitialTraceCursor(INDEX), segmentIndex, stepIndex, ...overrides };
}

function run(state: TraceCursorState, ...actions: readonly TraceCursorAction[]): TraceCursorState {
  return actions.reduce(traceCursorReducer, state);
}

function position(state: TraceCursorState): readonly [number, number] {
  return [state.segmentIndex, state.stepIndex];
}

const FORWARD: TraceCursorAction = { type: "moved", direction: 1, times: 1 };
const BACKWARD: TraceCursorAction = { type: "moved", direction: -1, times: 1 };

describe("createInitialTraceCursor", () => {
  it("starts at the first segment in action units, paused, with N=5 and 1x speed", () => {
    const state = createInitialTraceCursor(INDEX);
    expect(position(state)).toEqual([0, 1]);
    expect(state).toMatchObject({
      unit: "action",
      stepCount: 5,
      follow: "all",
      playing: false,
      speed: 1,
    });
  });

  it("keeps the position at zero for an empty battle", () => {
    const state = createInitialTraceCursor({ segments: [] });
    expect(position(state)).toEqual([0, 0]);
    expect(run(state, FORWARD, BACKWARD, { type: "movedToEdge", edge: "last" })).toEqual(state);
    expect(run(state, { type: "jumped", segmentIndex: 3, stepIndex: 1 })).toEqual(state);
    // 再生できる位置が無いため、再生を始めない
    expect(run(state, { type: "playToggled" })).toEqual(state);
    expect(selectCanMove(state, 1)).toBe(false);
  });
});

describe("createTraceIndex", () => {
  it("keeps kind, side and turn of each segment and pairs them with step counts", () => {
    const index = createTraceIndex(
      [
        { kind: "SYSTEM", turnNumber: 1 },
        { kind: "ACTION", turnNumber: 1, side: "ENEMY" },
        { kind: "ACTION", turnNumber: 2 },
      ],
      [2, 3, 0],
    );
    expect(index.segments).toEqual([
      { kind: "SYSTEM", turnNumber: 1, stepCount: 2 },
      { kind: "ACTION", turnNumber: 1, side: "ENEMY", stepCount: 3 },
      // 区間は1件以上のイベントを持つが、ステップ数0でも位置が範囲外にならないよう1へ寄せる
      { kind: "ACTION", turnNumber: 2, stepCount: 1 },
    ]);
  });
});

describe("traceCursorReducer moves step by step (UI-UT-ATR-016)", () => {
  it("advances one step inside a segment and crosses into the next segment", () => {
    const start = at(0, 0, { unit: "step" });
    expect(position(run(start, FORWARD))).toEqual([0, 1]);
    expect(position(run(start, FORWARD, FORWARD))).toEqual([1, 0]);
  });

  it("goes back across segments to the last step of the previous segment", () => {
    expect(position(run(at(2, 0, { unit: "step" }), BACKWARD))).toEqual([1, 2]);
  });

  it("stops at the first and the last step", () => {
    expect(position(run(at(0, 0, { unit: "step" }), BACKWARD))).toEqual([0, 0]);
    expect(position(run(at(7, 1, { unit: "step" }), FORWARD))).toEqual([7, 1]);
  });

  it("ignores the follow filter in step units", () => {
    expect(position(run(at(1, 2, { unit: "step", follow: "ALLY" }), FORWARD))).toEqual([2, 0]);
  });
});

describe("traceCursorReducer moves action by action (UI-UT-ATR-017)", () => {
  it("moves to the last step of the next and previous segment", () => {
    expect(position(run(at(0, 1), FORWARD))).toEqual([1, 2]);
    expect(position(run(at(2, 1), BACKWARD))).toEqual([1, 2]);
  });

  it("skips system segments and the other side when following allies", () => {
    const start = at(1, 2, { follow: "ALLY" });
    expect(position(run(start, FORWARD))).toEqual([3, 0]);
    expect(position(run(start, FORWARD, FORWARD))).toEqual([7, 1]);
    expect(position(run(at(7, 1, { follow: "ALLY" }), BACKWARD))).toEqual([3, 0]);
  });

  it("skips system segments and allies when following enemies", () => {
    expect(position(run(at(0, 1, { follow: "ENEMY" }), FORWARD))).toEqual([2, 1]);
    expect(position(run(at(2, 1, { follow: "ENEMY" }), FORWARD))).toEqual([6, 1]);
  });

  it("does not move when no followed segment exists in that direction", () => {
    expect(position(run(at(1, 2, { follow: "ALLY" }), BACKWARD))).toEqual([1, 2]);
    expect(position(run(at(6, 1, { follow: "ENEMY" }), FORWARD))).toEqual([6, 1]);
    expect(selectCanMove(at(6, 1, { follow: "ENEMY" }), 1)).toBe(false);
    expect(selectCanMove(at(6, 1, { follow: "ENEMY" }), -1)).toBe(true);
  });
});

describe("traceCursorReducer moves turn by turn (UI-UT-ATR-018)", () => {
  it("advances to the first segment of the next turn", () => {
    expect(position(run(at(2, 1, { unit: "turn" }), FORWARD))).toEqual([5, 0]);
  });

  it("returns to the first segment of the current turn from its middle", () => {
    expect(position(run(at(7, 1, { unit: "turn" }), BACKWARD))).toEqual([5, 0]);
  });

  it("returns to the first segment of the previous turn from the first segment", () => {
    expect(position(run(at(5, 0, { unit: "turn" }), BACKWARD))).toEqual([0, 1]);
  });

  it("stops at the edges and ignores the follow filter", () => {
    expect(position(run(at(0, 1, { unit: "turn" }), BACKWARD))).toEqual([0, 1]);
    expect(position(run(at(6, 1, { unit: "turn", follow: "ALLY" }), FORWARD))).toEqual([6, 1]);
    expect(position(run(at(2, 1, { unit: "turn", follow: "ALLY" }), FORWARD))).toEqual([5, 0]);
  });
});

describe("traceCursorReducer moves N units at once (UI-UT-ATR-019)", () => {
  it.each([
    ["step", at(0, 0, { unit: "step" })],
    ["action", at(0, 1)],
    ["action following allies", at(0, 1, { follow: "ALLY" })],
    ["turn", at(0, 1, { unit: "turn" })],
  ] as const)("equals N single moves in %s units", (_label, start) => {
    for (const times of [3, 5]) {
      for (const direction of [1, -1] as const) {
        const from = direction === 1 ? start : run(start, { type: "movedToEdge", edge: "last" });
        const single: TraceCursorAction = { type: "moved", direction, times: 1 };
        const repeated = run(from, ...Array.from({ length: times }, () => single));
        expect(position(run(from, { type: "moved", direction, times }))).toEqual(
          position(repeated),
        );
      }
    }
  });

  it("stops at the edge when it is reached on the way", () => {
    expect(position(run(at(6, 1), { type: "moved", direction: 1, times: 5 }))).toEqual([7, 1]);
    expect(
      position(run(at(2, 0, { unit: "step" }), { type: "moved", direction: -1, times: 20 })),
    ).toEqual([0, 0]);
  });
});

describe("traceCursorReducer aligns the position to the unit (UI-UT-ATR-020)", () => {
  it.each(["action", "turn"] as const)(
    "moves to the last step of the segment when switching from step to %s",
    (unit) => {
      const state = run(at(1, 0, { unit: "step" }), { type: "unitChanged", unit });
      expect(state.unit).toBe(unit);
      expect(position(state)).toEqual([1, 2]);
    },
  );

  it("keeps the position when switching to step units", () => {
    const state = run(at(1, 2), { type: "unitChanged", unit: "step" });
    expect(state.unit).toBe("step");
    expect(position(state)).toEqual([1, 2]);
  });

  it("switches to step units on a jump to a step row", () => {
    const state = run(at(0, 1), { type: "jumped", segmentIndex: 1, stepIndex: 1 });
    expect(state.unit).toBe("step");
    expect(position(state)).toEqual([1, 1]);
  });

  it("jumps to the last step of a segment in action units and the first step in step units", () => {
    expect(position(run(at(0, 1), { type: "jumped", segmentIndex: 6 }))).toEqual([6, 1]);
    const stepJump = run(at(0, 0, { unit: "step" }), { type: "jumped", segmentIndex: 6 });
    expect(stepJump.unit).toBe("step");
    expect(position(stepJump)).toEqual([6, 0]);
  });

  it("ignores the follow filter and clamps jumps into range", () => {
    expect(
      position(run(at(0, 1, { follow: "ALLY" }), { type: "jumped", segmentIndex: 2 })),
    ).toEqual([2, 1]);
    expect(position(run(at(0, 1), { type: "jumped", segmentIndex: 99 }))).toEqual([7, 1]);
    expect(position(run(at(3, 0), { type: "jumped", segmentIndex: -1 }))).toEqual([0, 1]);
    expect(position(run(at(0, 1), { type: "jumped", segmentIndex: 1, stepIndex: 9 }))).toEqual([
      1, 2,
    ]);
  });

  it("moves to the first and the last position", () => {
    expect(position(run(at(3, 0), { type: "movedToEdge", edge: "first" }))).toEqual([0, 1]);
    expect(
      position(run(at(3, 0, { unit: "step" }), { type: "movedToEdge", edge: "first" })),
    ).toEqual([0, 0]);
    expect(position(run(at(3, 0), { type: "movedToEdge", edge: "last" }))).toEqual([7, 1]);
  });

  it("changes N, follow and speed without moving", () => {
    const state = run(
      at(3, 0),
      { type: "stepCountChanged", stepCount: 10 },
      { type: "followChanged", follow: "ENEMY" },
      { type: "speedChanged", speed: 2 },
    );
    expect(state).toMatchObject({ stepCount: 10, follow: "ENEMY", speed: 2 });
    expect(position(state)).toEqual([3, 0]);
  });
});

describe("traceCursorReducer controls playback (UI-UT-ATR-021)", () => {
  it.each([
    ["moved", FORWARD],
    ["movedToEdge", { type: "movedToEdge", edge: "first" }],
    ["jumped", { type: "jumped", segmentIndex: 2 }],
  ] as const)("stops playback on %s", (_label, stopAction) => {
    expect(run(at(3, 0, { playing: true }), stopAction).playing).toBe(false);
  });

  it("keeps playing on a move sent by the playback timer", () => {
    const state = run(at(1, 2, { playing: true }), { ...FORWARD, fromPlayback: true });
    expect(position(state)).toEqual([2, 1]);
    expect(state.playing).toBe(true);
  });

  it("stops playing when the playback reaches the end", () => {
    const state = run(at(6, 1, { playing: true }), { ...FORWARD, fromPlayback: true });
    expect(position(state)).toEqual([7, 1]);
    expect(state.playing).toBe(false);
  });

  it("stops playing at the last followed segment", () => {
    const state = run(at(2, 1, { playing: true, follow: "ENEMY" }), {
      ...FORWARD,
      fromPlayback: true,
    });
    expect(position(state)).toEqual([6, 1]);
    expect(state.playing).toBe(false);
  });

  it("toggles playback and restarts from the first position at the end", () => {
    const started = run(at(3, 0), { type: "playToggled" });
    expect(started.playing).toBe(true);
    expect(position(started)).toEqual([3, 0]);
    expect(run(started, { type: "playToggled" }).playing).toBe(false);

    const restarted = run(at(7, 1, { unit: "step" }), { type: "playToggled" });
    expect(restarted.playing).toBe(true);
    expect(position(restarted)).toEqual([0, 0]);
  });

  it.each([
    ["unitChanged", { type: "unitChanged", unit: "step" }],
    ["stepCountChanged", { type: "stepCountChanged", stepCount: 3 }],
    ["followChanged", { type: "followChanged", follow: "ALLY" }],
  ] as const)("stops playback on %s", (_label, settingAction) => {
    const state = run(at(3, 0, { playing: true }), settingAction);
    expect(state.playing).toBe(false);
    expect(position(state)).toEqual([3, 0]);
  });

  it("keeps playing when only the speed changes", () => {
    const state = run(at(3, 0, { playing: true }), { type: "speedChanged", speed: 0.5 });
    expect(state.playing).toBe(true);
    expect(state.speed).toBe(0.5);
  });

  it("resets the position and playback for a new index", () => {
    const next: TraceIndex = { segments: [system(1, 4), action(1, "ALLY", 1)] };
    const state = run(
      at(7, 1, { playing: true, unit: "step", follow: "ENEMY", stepCount: 20, speed: 2 }),
      { type: "reset", index: next },
    );
    expect(state).toEqual(createInitialTraceCursor(next));
    expect(position(state)).toEqual([0, 3]);
  });
});

describe("selectCanMove", () => {
  it("reports whether a move in the direction would change the position", () => {
    expect(selectCanMove(at(0, 1), -1)).toBe(false);
    expect(selectCanMove(at(0, 1), 1)).toBe(true);
    expect(selectCanMove(at(0, 0, { unit: "step" }), -1)).toBe(false);
    expect(selectCanMove(at(7, 1), 1)).toBe(false);
  });
});
