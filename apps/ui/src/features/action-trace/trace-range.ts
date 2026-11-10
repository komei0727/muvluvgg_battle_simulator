// docs/ui-design/01_UI要求・画面設計.md §8.10「現在の範囲」/ 03_API・データ連携設計.md §12.5
// 「現在の範囲と状態遷移tabへの移動」。
//
// 盤面の差分表示・処理の一覧・変化の表が比べる「範囲の前」「範囲の後」の版と、範囲に入る
// 処理ステップを位置から選ぶ純関数。処理単位は直前のステップの後（先頭なら区間の前）から
// 現在のステップの後まで、行動・ターン単位は区間の前から区間の後までとする。
import type { ActionSegment } from "./action-segment-projector.js";
import type { TraceUnit } from "./trace-cursor-reducer.js";
import type { TraceStep } from "./trace-step-projector.js";

export interface TraceRangeCursor {
  readonly segmentIndex: number;
  readonly stepIndex: number;
  readonly unit: TraceUnit;
}

export interface TraceVersionRange {
  readonly beforeVersion: number;
  readonly afterVersion: number;
}

export interface TraceRange extends TraceVersionRange {
  readonly segment: ActionSegment;
  /** 範囲に入る処理ステップ。処理単位では現在のステップだけ、それ以外は区間の全ステップ。 */
  readonly steps: readonly TraceStep[];
  readonly stepMode: boolean;
}

/** 区間が無い戦闘では`undefined`。 */
export function selectTraceRange(
  segments: readonly ActionSegment[],
  stepsBySegment: readonly (readonly TraceStep[])[],
  cursor: TraceRangeCursor,
): TraceRange | undefined {
  const segment = segments[cursor.segmentIndex];
  if (segment === undefined) {
    return undefined;
  }
  const steps = stepsBySegment[cursor.segmentIndex] ?? [];
  const current = steps[cursor.stepIndex];
  if (cursor.unit !== "step" || current === undefined) {
    return {
      segment,
      beforeVersion: segment.stateVersionBefore,
      afterVersion: segment.stateVersionAfter,
      steps,
      stepMode: false,
    };
  }
  const previous = steps[cursor.stepIndex - 1];
  return {
    segment,
    beforeVersion: previous?.stateVersionAfter ?? segment.stateVersionBefore,
    afterVersion: current.stateVersionAfter,
    steps: [current],
    stepMode: true,
  };
}

interface VersionedTransition {
  readonly stateVersionAfter?: unknown;
}

/**
 * 変化の表から「状態遷移」tabで開く遷移の位置。`stateVersionAfter`が範囲の前の版より大きい
 * 最初の遷移とし、それが範囲の後の版を超える（範囲内に遷移が無い）なら`undefined`を返す。
 */
export function selectFirstTransitionInRange(
  transitions: readonly VersionedTransition[],
  range: TraceVersionRange,
): number | undefined {
  const position = transitions.findIndex(
    (transition) =>
      typeof transition.stateVersionAfter === "number" &&
      transition.stateVersionAfter > range.beforeVersion,
  );
  if (position < 0) {
    return undefined;
  }
  const version = transitions[position]?.stateVersionAfter;
  return typeof version === "number" && version <= range.afterVersion ? position : undefined;
}
