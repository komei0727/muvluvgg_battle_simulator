import { useState } from "react";
import { Button } from "../../components/Button.js";
import { formatEvent, resolveDisplayName } from "./event-formatters.js";
import type { RosterIndex } from "./event-formatters.js";
import type { BattleLogEventResponse } from "../simulation/api-contract.js";
import styles from "./EventTimeline.module.css";

export interface EventTimelineProps {
  readonly events: readonly BattleLogEventResponse[];
  readonly roster: RosterIndex;
  readonly onJumpToTransition?: (stateTransitionIndex: number) => void;
}

const INITIAL_VISIBLE_COUNT = 50;
const LOAD_MORE_STEP = 50;
const NO_VALUE_PLACEHOLDER = "-";

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// docs/ui-design/01_UI要求・画面設計.md §8.1: source/targetsは共通envelope
// から常に独立して表示する。formatterのsummary文言がunitに触れないevent
// type(TURN_STARTEDなど)でも監査情報を欠かさない。
function sourceLabelOf(event: BattleLogEventResponse, roster: RosterIndex): string {
  const sourceUnitId = stringOf(event["sourceUnitId"]);
  return sourceUnitId !== undefined
    ? resolveDisplayName(roster, sourceUnitId)
    : NO_VALUE_PLACEHOLDER;
}

function targetsLabelOf(event: BattleLogEventResponse, roster: RosterIndex): string {
  const targetUnitIds = event["targetUnitIds"];
  if (!Array.isArray(targetUnitIds) || targetUnitIds.length === 0) {
    return NO_VALUE_PLACEHOLDER;
  }
  const names = targetUnitIds
    .filter((id): id is string => typeof id === "string")
    .map((id) => resolveDisplayName(roster, id));
  return names.length > 0 ? names.join(", ") : NO_VALUE_PLACEHOLDER;
}

// docs/ui-design/01_UI要求・画面設計.md §8.1: `sequence`昇順で表示し、欠番を
// 許容する。SUMMARYで省略された親イベント参照があってもエラーにしない。
export function EventTimeline({ events, roster, onJumpToTransition }: EventTimelineProps) {
  const [expandedSequences, setExpandedSequences] = useState<ReadonlySet<number>>(new Set());
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT);

  const sorted = [...events].sort(
    (a, b) => (numberOf(a["sequence"]) ?? 0) - (numberOf(b["sequence"]) ?? 0),
  );
  const visible = sorted.slice(0, visibleCount);

  function toggle(sequence: number) {
    setExpandedSequences((current) => {
      const next = new Set(current);
      if (next.has(sequence)) {
        next.delete(sequence);
      } else {
        next.add(sequence);
      }
      return next;
    });
  }

  return (
    <div>
      {events.length > INITIAL_VISIBLE_COUNT ? (
        <span className={styles["count"]}>
          {events.length}件中{visible.length}件を表示
        </span>
      ) : null}
      <ul className={styles["list"]}>
        {visible.map((event) => {
          const sequence = numberOf(event["sequence"]) ?? 0;
          const turnNumber = numberOf(event["turnNumber"]) ?? 0;
          const cycleNumber = numberOf(event["cycleNumber"]) ?? 0;
          const stateVersionAfter = numberOf(event["stateVersionAfter"]);
          const stateTransitionIndex = numberOf(event["stateTransitionIndex"]);
          const parentSequence = numberOf(event["parentSequence"]);
          const rootSequence = numberOf(event["rootSequence"]);
          const presentation = formatEvent(event, roster);
          const isExpanded = expandedSequences.has(sequence);

          return (
            <li key={sequence}>
              <button
                type="button"
                className={styles["row"]}
                aria-expanded={isExpanded}
                onClick={() => {
                  toggle(sequence);
                }}
              >
                <span className={styles["sequence"]}>#{String(sequence).padStart(3, "0")}</span>
                <span>
                  T{turnNumber}/{cycleNumber}
                </span>
                <span className={styles["type"]}>{presentation.title}</span>
                <span className={styles["source"]}>{sourceLabelOf(event, roster)}</span>
                <span className={styles["targets"]}>{targetsLabelOf(event, roster)}</span>
                <span>{presentation.summary}</span>
                <span>v{stateVersionAfter ?? "-"}</span>
              </button>
              {isExpanded ? (
                <div className={styles["expanded"]}>
                  <p>
                    parentSequence: {parentSequence ?? "-"} / rootSequence: {rootSequence ?? "-"}
                  </p>
                  <pre>{JSON.stringify(presentation.details, null, 2)}</pre>
                  {stateTransitionIndex !== undefined && onJumpToTransition !== undefined ? (
                    <Button
                      variant="ghost"
                      className={styles["jumpButton"]}
                      onClick={() => {
                        onJumpToTransition(stateTransitionIndex);
                      }}
                    >
                      状態遷移 #{stateTransitionIndex + 1} を見る
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {visibleCount < sorted.length ? (
        <div className={styles["loadMore"]}>
          <Button
            variant="secondary"
            onClick={() => {
              setVisibleCount((current) => Math.min(current + LOAD_MORE_STEP, sorted.length));
            }}
          >
            さらに表示
          </Button>
        </div>
      ) : null}
    </div>
  );
}
