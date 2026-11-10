import { useMemo, useReducer } from "react";
import { createBattleStateReplay } from "../../entities/battle-state-replay.js";
import type { BattleLogResponse, BattleStateResponse } from "../../shared/api/api-contract.js";
import type { RosterIndex } from "../details/event-presentation.js";
import { projectActionSegments } from "./action-segment-projector.js";
import { TraceActionOrder } from "./TraceActionOrder.js";
import { TraceBoard } from "./TraceBoard.js";
import { projectTraceBoard, selectActionOrders } from "./trace-board-projector.js";
import { projectTraceChanges } from "./trace-change-projector.js";
import { TraceChangeTable } from "./TraceChangeTable.js";
import { TraceControls, type TracePositionView } from "./TraceControls.js";
import {
  createInitialTraceCursor,
  createTraceIndex,
  traceCursorReducer,
} from "./trace-cursor-reducer.js";
import { selectFirstTransitionInRange, selectTraceRange } from "./trace-range.js";
import { segmentLabelOf } from "./trace-segment-label.js";
import { projectTraceSteps } from "./trace-step-projector.js";
import { TraceStepList } from "./TraceStepList.js";
import { TraceTimeline, type TraceTimelineTick } from "./TraceTimeline.js";
import { useTracePlayback } from "./use-trace-playback.js";
import styles from "./ActionTraceSection.module.css";

// docs/ui-design/01_UI要求・画面設計.md §8.10 / 04_コンポーネント・状態管理設計.md §3
// 「ActionTraceSection」（UI-CMP-042・UI-CMP-045）。状態の組み立て直し・区間・処理ステップの
// 投影は応答ごとに1回だけ作り、stateへ複製しない。componentが持つのは位置と再生の設定
// （`traceCursorReducer`）だけで、子へは現在の範囲から作った表示用の値を渡す。

export interface ActionTraceSectionProps {
  readonly response: BattleLogResponse;
  readonly roster: RosterIndex;
  readonly onJumpToTransition: (index: number) => void;
}

function useTraceProjection(response: BattleLogResponse, roster: RosterIndex) {
  return useMemo(() => {
    const segments = projectActionSegments(response.events, [...roster.values()]);
    const stepsBySegment = segments.map((segment) => projectTraceSteps(segment, roster));
    // 区間の先頭の版にだけ完全な状態を持ち、その間の版は直前のcheckpointから求める
    // （長い戦闘で1回の移動ごとに戦闘全体を組み立て直さない）
    const replay = createBattleStateReplay<BattleStateResponse>(
      response.initialState,
      response.stateTransitions,
      segments.map((segment) => segment.stateVersionBefore),
    );
    const index = createTraceIndex(
      segments,
      stepsBySegment.map((steps) => steps.length),
    );
    const ticks = segments.map((segment): TraceTimelineTick => {
      const label = segmentLabelOf(segment, roster);
      return {
        segmentIndex: segment.index,
        turnNumber: segment.turnNumber,
        system: segment.kind === "SYSTEM",
        ...(segment.kind === "ACTION" && segment.side !== undefined ? { side: segment.side } : {}),
        title: label.title,
        short: label.short,
        ...(label.skill !== undefined ? { skill: label.skill } : {}),
        containsDefeat: segment.containsDefeat,
      };
    });
    return { segments, stepsBySegment, replay, index, ticks };
  }, [response, roster]);
}

export function ActionTraceSection({
  response,
  roster,
  onJumpToTransition,
}: ActionTraceSectionProps) {
  const projection = useTraceProjection(response, roster);
  const { segments, stepsBySegment, replay, index, ticks } = projection;
  const [state, dispatch] = useReducer(traceCursorReducer, index, createInitialTraceCursor);

  // 再実行中、`BattleDetailsSection`はこのcomponentをunmountせず応答だけを差し替える。
  // 前回の結果の位置を持ち込まないよう、索引が変わった描画で初期へ戻す（UI-CMP-045）。
  // 戻すまでの描画では、新しい索引の初期位置を使う。
  if (state.index !== index) {
    dispatch({ type: "reset", index });
  }
  const cursor = state.index === index ? state : createInitialTraceCursor(index);
  const { onKeyDown } = useTracePlayback(cursor, dispatch);

  const range = selectTraceRange(segments, stepsBySegment, cursor);
  if (range === undefined) {
    return (
      <section className={styles.section} aria-label="行動トレース">
        <p className={styles.notice}>行動トレースに表示するイベントがありません。</p>
      </section>
    );
  }

  const segment = range.segment;
  const segmentSteps = stepsBySegment[cursor.segmentIndex] ?? [];
  // 状態を変えないイベントの版が最後の遷移を超えても落ちないよう、遷移のある範囲へ寄せる
  const stateAt = (version: number) =>
    replay.stateAt(Math.min(Math.max(0, version), replay.latestVersion));
  const before = stateAt(range.beforeVersion);
  const after = stateAt(range.afterVersion);
  const board = projectTraceBoard({
    before,
    after,
    segment,
    steps: range.steps,
    roster,
    actionOrders: selectActionOrders(segments, segment.turnNumber),
  });
  const changes = projectTraceChanges(before, after, roster);
  const transitionIndex = selectFirstTransitionInRange(response.stateTransitions, range);
  const currentStep = segmentSteps[cursor.stepIndex];
  const position: TracePositionView = {
    turnNumber: segment.turnNumber,
    segmentNumber: cursor.segmentIndex + 1,
    segmentTotal: segments.length,
    ...(range.stepMode
      ? { step: { number: cursor.stepIndex + 1, total: segmentSteps.length } }
      : {}),
    firstSequence: currentStep?.firstSequence ?? segment.firstSequence,
    lastSequence: currentStep?.lastSequence ?? segment.lastSequence,
  };
  const label = segmentLabelOf(segment, roster);
  const turnActions = segments.filter(
    (candidate) => candidate.kind === "ACTION" && candidate.turnNumber === segment.turnNumber,
  );
  const jump = (segmentIndex: number) => {
    dispatch({ type: "jumped", segmentIndex });
  };

  return (
    // キー操作は領域の中のフォーカスだけで受ける（詳細タブのtablistは←→でtabを切り替えるため）
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <section className={styles.section} aria-label="行動トレース" onKeyDown={onKeyDown}>
      <TraceControls cursor={cursor} dispatch={dispatch} position={position}>
        <div className={styles.timelineScroll}>
          <TraceTimeline
            ticks={ticks}
            currentSegmentIndex={cursor.segmentIndex}
            follow={cursor.follow}
            {...(range.stepMode
              ? { progress: (cursor.stepIndex + 1) / Math.max(1, segmentSteps.length) }
              : {})}
            onJump={jump}
          />
        </div>
      </TraceControls>
      <div className={styles.main}>
        <section className={styles.card} aria-label="盤面">
          <h3 className={styles.cardTitle}>盤面</h3>
          <div className={styles.cardBody}>
            <TraceBoard view={board} />
            <TraceActionOrder
              turnNumber={segment.turnNumber}
              items={turnActions.map((action) => {
                const actionLabel = segmentLabelOf(action, roster);
                return {
                  segmentIndex: action.index,
                  ...(action.kind === "ACTION" && action.side !== undefined
                    ? { side: action.side }
                    : {}),
                  title: actionLabel.title,
                  short: actionLabel.short,
                };
              })}
              currentSegmentIndex={cursor.segmentIndex}
              onJump={jump}
            />
          </div>
        </section>
        <section className={styles.card} aria-label="この区間の処理">
          <div className={styles.segmentHead}>
            <span className={styles.kicker}>
              {segment.kind === "ACTION"
                ? `ターン ${segment.turnNumber.toString()} · 行動 ${segment.actionOrderInTurn.toString()} / ${turnActions.length.toString()}`
                : `ターン ${segment.turnNumber.toString()} · システム処理`}
            </span>
            <h3 className={styles.segmentTitle}>
              <span
                className={
                  segment.kind === "SYSTEM"
                    ? styles.whoSystem
                    : segment.side === "ALLY"
                      ? styles.whoAlly
                      : styles.whoEnemy
                }
              >
                {label.title}
              </span>
              {label.skill !== undefined ? (
                <span className={styles.skill}>{label.skill}</span>
              ) : null}
            </h3>
          </div>
          <TraceStepList
            steps={segmentSteps}
            {...(range.stepMode ? { currentStepIndex: cursor.stepIndex } : {})}
            roster={roster}
            onSelect={(stepIndex) => {
              dispatch({ type: "jumped", segmentIndex: cursor.segmentIndex, stepIndex });
            }}
          />
          <TraceChangeTable
            rows={changes}
            stepMode={range.stepMode}
            {...(transitionIndex !== undefined ? { transitionIndex } : {})}
            onJumpToTransition={onJumpToTransition}
          />
        </section>
      </div>
    </section>
  );
}
