import type { Dispatch, ReactNode } from "react";
import {
  selectCanMove,
  selectCanMoveToEdge,
  type TraceCursorAction,
  type TraceCursorState,
  type TraceFollow,
  type TraceSpeed,
  type TraceStepCount,
  type TraceUnit,
} from "./trace-cursor-reducer.js";
import styles from "./ActionTraceSection.module.css";

// 01_UI要求・画面設計.md §8.10「再生コントロール」。進めない方向のボタンは`aria-disabled`で
// 無効を示し、`disabled`にしない —— 押した結果で端に達したボタンがフォーカスを失うと、
// キー操作を受け付ける領域の外へフォーカスが落ち、続けて←→で操作できなくなる。

export interface TracePositionView {
  readonly turnNumber: number;
  readonly segmentNumber: number;
  readonly segmentTotal: number;
  /** 処理単位のときだけ持つ。 */
  readonly step?: { readonly number: number; readonly total: number };
  readonly firstSequence: number;
  readonly lastSequence: number;
}

export interface TraceControlsProps {
  readonly cursor: TraceCursorState;
  readonly dispatch: Dispatch<TraceCursorAction>;
  readonly position: TracePositionView;
  readonly children?: ReactNode;
}

const UNITS: readonly { readonly id: TraceUnit; readonly label: string }[] = [
  { id: "step", label: "処理" },
  { id: "action", label: "行動" },
  { id: "turn", label: "ターン" },
];
const STEP_COUNTS: readonly TraceStepCount[] = [3, 5, 10, 20];
const FOLLOWS: readonly { readonly id: TraceFollow; readonly label: string }[] = [
  { id: "all", label: "すべての行動" },
  { id: "ALLY", label: "味方の行動のみ" },
  { id: "ENEMY", label: "敵の行動のみ" },
];
const SPEEDS: readonly TraceSpeed[] = [0.5, 1, 2];

function TransportButton({
  label,
  hint,
  enabled,
  onPress,
  children,
}: {
  readonly label: string;
  readonly hint: string;
  readonly enabled: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={styles.transportButton}
      aria-label={label}
      title={`${label}（${hint}）`}
      aria-disabled={enabled ? undefined : "true"}
      onClick={() => {
        if (enabled) {
          onPress();
        }
      }}
    >
      {children}
    </button>
  );
}

function Icon({ path }: { readonly path: string }) {
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

function sequenceText(first: number, last: number): string {
  return first === last ? `#${first.toString()}` : `#${first.toString()}–#${last.toString()}`;
}

export function TraceControls({ cursor, dispatch, position, children }: TraceControlsProps) {
  const canBack = selectCanMove(cursor, -1);
  const canForward = selectCanMove(cursor, 1);
  // 先頭・末尾は1単位の移動とは別に、実際の端と比べて判定する（Home／Endと同じ）
  const canFirst = selectCanMoveToEdge(cursor, "first");
  const canLast = selectCanMoveToEdge(cursor, "last");
  const hasSegments = cursor.index.segments.length > 0;
  const n = cursor.stepCount;
  const move = (direction: 1 | -1, times: number) => {
    dispatch({ type: "moved", direction, times });
  };
  return (
    <div className={styles.controls}>
      <div className={styles.controlRow}>
        <div className={styles.transport} role="group" aria-label="移動">
          <TransportButton
            label="先頭へ"
            hint="Home"
            enabled={canFirst}
            onPress={() => {
              dispatch({ type: "movedToEdge", edge: "first" });
            }}
          >
            <Icon path="M3 2h2v12H3zM14 2v12L6 8z" />
          </TransportButton>
          <TransportButton
            label={`${n.toString()}単位戻る`}
            hint="Shift+←"
            enabled={canBack}
            onPress={() => {
              move(-1, n);
            }}
          >
            <Icon path="M8 2v12L1 8zM15 2v12L8 8z" />
            <span className={styles.transportCount} aria-hidden="true">
              {n}
            </span>
          </TransportButton>
          <TransportButton
            label="1単位戻る"
            hint="←"
            enabled={canBack}
            onPress={() => {
              move(-1, 1);
            }}
          >
            <Icon path="M12 2v12L4 8z" />
          </TransportButton>
          <TransportButton
            label={cursor.playing ? "停止" : "再生"}
            hint="Space"
            enabled={hasSegments}
            onPress={() => {
              dispatch({ type: "playToggled" });
            }}
          >
            <Icon path={cursor.playing ? "M3 2h4v12H3zM9 2h4v12H9z" : "M4 2l10 6-10 6z"} />
          </TransportButton>
          <TransportButton
            label="1単位進む"
            hint="→"
            enabled={canForward}
            onPress={() => {
              move(1, 1);
            }}
          >
            <Icon path="M4 2v12l8-6z" />
          </TransportButton>
          <TransportButton
            label={`${n.toString()}単位進む`}
            hint="Shift+→"
            enabled={canForward}
            onPress={() => {
              move(1, n);
            }}
          >
            <span className={styles.transportCount} aria-hidden="true">
              {n}
            </span>
            <Icon path="M1 2v12l7-6zM8 2v12l7-6z" />
          </TransportButton>
          <TransportButton
            label="末尾へ"
            hint="End"
            enabled={canLast}
            onPress={() => {
              dispatch({ type: "movedToEdge", edge: "last" });
            }}
          >
            <Icon path="M2 2v12l8-6zM11 2h2v12h-2z" />
          </TransportButton>
        </div>
        <div className={styles.field}>
          <span aria-hidden="true">進む単位</span>
          <div className={styles.segmented} role="group" aria-label="進む単位">
            {UNITS.map((unit) => (
              <button
                key={unit.id}
                type="button"
                aria-pressed={cursor.unit === unit.id}
                onClick={() => {
                  dispatch({ type: "unitChanged", unit: unit.id });
                }}
              >
                {unit.label}
              </button>
            ))}
          </div>
        </div>
        <label className={styles.field}>
          N
          <select
            value={n}
            onChange={(event) => {
              dispatch({
                type: "stepCountChanged",
                stepCount: Number(event.target.value) as TraceStepCount,
              });
            }}
          >
            {STEP_COUNTS.map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          追跡
          <select
            value={cursor.follow}
            onChange={(event) => {
              dispatch({ type: "followChanged", follow: event.target.value as TraceFollow });
            }}
          >
            {FOLLOWS.map((follow) => (
              <option key={follow.id} value={follow.id}>
                {follow.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          速度
          <select
            value={cursor.speed}
            onChange={(event) => {
              dispatch({ type: "speedChanged", speed: Number(event.target.value) as TraceSpeed });
            }}
          >
            {SPEEDS.map((speed) => (
              <option key={speed} value={speed}>
                {`${speed.toString()}×`}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.position} role="status" aria-label="現在位置">
          <span>
            ターン <b>{position.turnNumber}</b>
          </span>
          <span>
            行動 <b>{position.segmentNumber}</b> / {position.segmentTotal}
          </span>
          {position.step !== undefined ? (
            <span>
              処理 <b>{position.step.number}</b> / {position.step.total}
            </span>
          ) : null}
          <span className={styles.mono}>
            event {sequenceText(position.firstSequence, position.lastSequence)}
          </span>
        </div>
      </div>
      {children}
    </div>
  );
}
