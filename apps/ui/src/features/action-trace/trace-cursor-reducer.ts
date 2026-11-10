// docs/ui-design/04_コンポーネント・状態管理設計.md §4「行動トレースの位置と再生」/
// 01_UI要求・画面設計.md §8.10「操作」。
//
// 行動トレースの位置（区間・処理ステップ）と再生の設定を持つ純粋なreducer。投影の本体
// （イベント・状態）は知らず、区間ごとの種別・陣営・ターン・ステップ数だけの索引を読む。
// 位置は常に`0 <= segmentIndex < 区間数`・`0 <= stepIndex < その区間のステップ数`を満たす
// （区間が無い戦闘だけは0・0のまま動かない）。再生のタイマーは`useTracePlayback`が持つ。

export type TraceUnit = "step" | "action" | "turn";
export type TraceFollow = "all" | "ALLY" | "ENEMY";
export type TraceStepCount = 3 | 5 | 10 | 20;
export type TraceSpeed = 0.5 | 1 | 2;
export type TraceDirection = 1 | -1;

export interface TraceIndexSegment {
  readonly kind: "ACTION" | "SYSTEM";
  /** 行動者の陣営。システム区間と、行動者がRosterに無い行動区間では持たない。 */
  readonly side?: string;
  readonly turnNumber: number;
  /** 1以上。 */
  readonly stepCount: number;
}

export interface TraceIndex {
  readonly segments: readonly TraceIndexSegment[];
}

export interface TraceCursorState {
  /** 現在の応答の索引。`reset`で差し替える。 */
  readonly index: TraceIndex;
  readonly segmentIndex: number;
  /** 区間内のステップ位置。行動・ターン単位では区間の最後のステップ。 */
  readonly stepIndex: number;
  readonly unit: TraceUnit;
  /** N単位の移動のN。 */
  readonly stepCount: TraceStepCount;
  readonly follow: TraceFollow;
  readonly playing: boolean;
  readonly speed: TraceSpeed;
}

export type TraceCursorAction =
  | {
      readonly type: "moved";
      readonly direction: TraceDirection;
      readonly times: number;
      /** 再生タイマーが送った移動。再生を止めない。 */
      readonly fromPlayback?: true;
    }
  | { readonly type: "movedToEdge"; readonly edge: "first" | "last" }
  /** `stepIndex`ありはステップ行からの移動であり、処理単位へ切り替える。 */
  | { readonly type: "jumped"; readonly segmentIndex: number; readonly stepIndex?: number }
  | { readonly type: "unitChanged"; readonly unit: TraceUnit }
  | { readonly type: "stepCountChanged"; readonly stepCount: TraceStepCount }
  | { readonly type: "followChanged"; readonly follow: TraceFollow }
  | { readonly type: "speedChanged"; readonly speed: TraceSpeed }
  | { readonly type: "playToggled" }
  | { readonly type: "reset"; readonly index: TraceIndex };

interface TraceIndexSource {
  readonly kind: "ACTION" | "SYSTEM";
  readonly side?: string;
  readonly turnNumber: number;
}

/** 区間の投影と区間ごとのステップ数から索引を作る。`stepCounts`は区間と同じ順。 */
export function createTraceIndex(
  segments: readonly TraceIndexSource[],
  stepCounts: readonly number[],
): TraceIndex {
  return {
    segments: segments.map((segment, position) => ({
      kind: segment.kind,
      ...(segment.side !== undefined ? { side: segment.side } : {}),
      turnNumber: segment.turnNumber,
      // 区間は必ず1件以上のイベントを持つため0は来ないが、位置が範囲外へ出ないよう寄せる
      stepCount: Math.max(1, stepCounts[position] ?? 1),
    })),
  };
}

export function createInitialTraceCursor(index: TraceIndex): TraceCursorState {
  return {
    index,
    segmentIndex: 0,
    stepIndex: lastStepOf(index, 0),
    unit: "action",
    stepCount: 5,
    follow: "all",
    playing: false,
    speed: 1,
  };
}

interface Position {
  readonly segmentIndex: number;
  readonly stepIndex: number;
}

function lastStepOf(index: TraceIndex, segmentIndex: number): number {
  const segment = index.segments[segmentIndex];
  return segment === undefined ? 0 : segment.stepCount - 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 区間の位置へ寄せる。処理単位は区間の先頭のステップ、行動・ターン単位は最後のステップ。 */
function segmentPosition(index: TraceIndex, segmentIndex: number, unit: TraceUnit): Position {
  return {
    segmentIndex,
    stepIndex: unit === "step" ? 0 : lastStepOf(index, segmentIndex),
  };
}

function isFollowed(segment: TraceIndexSegment, follow: TraceFollow): boolean {
  return follow === "all" || (segment.kind === "ACTION" && segment.side === follow);
}

/** 1単位の移動先。動けなければ`undefined`。 */
function stepOnce(state: TraceCursorState, direction: TraceDirection): Position | undefined {
  const { index, segmentIndex, stepIndex } = state;
  const segments = index.segments;
  const current = segments[segmentIndex];
  if (current === undefined) {
    return undefined;
  }
  switch (state.unit) {
    case "step": {
      const nextStep = stepIndex + direction;
      if (nextStep >= 0 && nextStep < current.stepCount) {
        return { segmentIndex, stepIndex: nextStep };
      }
      const nextSegment = segmentIndex + direction;
      if (segments[nextSegment] === undefined) {
        return undefined;
      }
      return direction === 1
        ? { segmentIndex: nextSegment, stepIndex: 0 }
        : { segmentIndex: nextSegment, stepIndex: lastStepOf(index, nextSegment) };
    }
    case "action": {
      for (let next = segmentIndex + direction; segments[next] !== undefined; next += direction) {
        const segment = segments[next];
        if (segment !== undefined && isFollowed(segment, state.follow)) {
          return segmentPosition(index, next, "action");
        }
      }
      return undefined;
    }
    case "turn": {
      const target =
        direction === 1
          ? segments.findIndex(
              (segment, position) =>
                position > segmentIndex && segment.turnNumber > current.turnNumber,
            )
          : turnStartBefore(segments, segmentIndex);
      return target < 0 ? undefined : segmentPosition(index, target, "turn");
    }
  }
}

/**
 * ターン単位で戻る先。ターンの途中ならそのターンの最初の区間、最初の区間なら前のターンの
 * 最初の区間。ターン番号は区間の順に減らない（`projectActionSegments`の区間は`sequence`順）。
 */
function turnStartBefore(segments: readonly TraceIndexSegment[], segmentIndex: number): number {
  const firstOfTurn = (position: number): number => {
    const turnNumber = segments[position]?.turnNumber;
    let first = position;
    while (first > 0 && segments[first - 1]?.turnNumber === turnNumber) {
      first -= 1;
    }
    return first;
  };
  const currentTurnStart = firstOfTurn(segmentIndex);
  if (currentTurnStart < segmentIndex) {
    return currentTurnStart;
  }
  return segmentIndex === 0 ? -1 : firstOfTurn(segmentIndex - 1);
}

function move(state: TraceCursorState, direction: TraceDirection, times: number): TraceCursorState {
  let next = state;
  for (let count = 0; count < times; count += 1) {
    const position = stepOnce(next, direction);
    if (position === undefined) {
      break;
    }
    next = { ...next, ...position };
  }
  return next;
}

/** その向きへ1単位動けるか。端のボタンの無効化と、再生の末尾の判定に使う。 */
export function selectCanMove(state: TraceCursorState, direction: TraceDirection): boolean {
  return stepOnce(state, direction) !== undefined;
}

function edgePosition(state: TraceCursorState, edge: "first" | "last"): Position {
  const lastSegment = Math.max(0, state.index.segments.length - 1);
  return edge === "first"
    ? segmentPosition(state.index, 0, state.unit)
    : { segmentIndex: lastSegment, stepIndex: lastStepOf(state.index, lastSegment) };
}

function jump(
  state: TraceCursorState,
  segmentIndex: number,
  stepIndex: number | undefined,
): TraceCursorState {
  const lastSegment = state.index.segments.length - 1;
  if (lastSegment < 0) {
    return { ...state, playing: false };
  }
  const target = clamp(segmentIndex, 0, lastSegment);
  if (stepIndex === undefined) {
    return { ...state, ...segmentPosition(state.index, target, state.unit), playing: false };
  }
  return {
    ...state,
    unit: "step",
    segmentIndex: target,
    stepIndex: clamp(stepIndex, 0, lastStepOf(state.index, target)),
    playing: false,
  };
}

export function traceCursorReducer(
  state: TraceCursorState,
  action: TraceCursorAction,
): TraceCursorState {
  switch (action.type) {
    case "moved": {
      const next = move(state, action.direction, action.times);
      if (action.fromPlayback !== true) {
        return { ...next, playing: false };
      }
      return { ...next, playing: next.playing && selectCanMove(next, 1) };
    }
    case "movedToEdge":
      return { ...state, ...edgePosition(state, action.edge), playing: false };
    case "jumped":
      return jump(state, action.segmentIndex, action.stepIndex);
    case "unitChanged":
      return {
        ...state,
        unit: action.unit,
        stepIndex:
          action.unit === "step" ? state.stepIndex : lastStepOf(state.index, state.segmentIndex),
      };
    case "stepCountChanged":
      return { ...state, stepCount: action.stepCount };
    case "followChanged":
      return { ...state, follow: action.follow };
    case "speedChanged":
      return { ...state, speed: action.speed };
    case "playToggled":
      if (state.playing) {
        return { ...state, playing: false };
      }
      if (state.index.segments.length === 0) {
        return state;
      }
      return selectCanMove(state, 1)
        ? { ...state, playing: true }
        : { ...state, ...edgePosition(state, "first"), playing: true };
    case "reset":
      return createInitialTraceCursor(action.index);
  }
}
