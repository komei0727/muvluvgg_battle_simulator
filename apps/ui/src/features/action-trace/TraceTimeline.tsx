import type { TraceFollow } from "./trace-cursor-reducer.js";
import styles from "./ActionTraceSection.module.css";

// 01_UI要求・画面設計.md §8.10「タイムライン」。ターンごとに区間の目盛りを並べ、陣営を色と
// 文言（accessible name）で分ける。処理単位の進み具合はSVGの属性で描く（CSPの
// `style-src 'self'`のためinline styleで幅を与えない）。

export interface TraceTimelineTick {
  readonly segmentIndex: number;
  readonly turnNumber: number;
  /** 行動者の陣営。システム区間では持たない。 */
  readonly side?: string;
  readonly system: boolean;
  readonly title: string;
  readonly short: string;
  readonly skill?: string;
  readonly containsDefeat: boolean;
}

export interface TraceTimelineProps {
  readonly ticks: readonly TraceTimelineTick[];
  readonly currentSegmentIndex: number;
  readonly follow: TraceFollow;
  /** 処理単位のときの現在の区間の進み具合（0〜1）。 */
  readonly progress?: number;
  readonly onJump: (segmentIndex: number) => void;
}

function sideClass(tick: TraceTimelineTick): string | undefined {
  if (tick.system) {
    return styles.tickSystem;
  }
  return tick.side === "ALLY"
    ? styles.tickAlly
    : tick.side === "ENEMY"
      ? styles.tickEnemy
      : undefined;
}

function isFollowed(tick: TraceTimelineTick, follow: TraceFollow): boolean {
  return follow === "all" || (!tick.system && tick.side === follow);
}

function groupByTurn(
  ticks: readonly TraceTimelineTick[],
): readonly { readonly turnNumber: number; readonly ticks: readonly TraceTimelineTick[] }[] {
  const groups: { turnNumber: number; ticks: TraceTimelineTick[] }[] = [];
  for (const tick of ticks) {
    const last = groups.at(-1);
    if (last?.turnNumber === tick.turnNumber) {
      last.ticks.push(tick);
    } else {
      groups.push({ turnNumber: tick.turnNumber, ticks: [tick] });
    }
  }
  return groups;
}

export function TraceTimeline({
  ticks,
  currentSegmentIndex,
  follow,
  progress,
  onJump,
}: TraceTimelineProps) {
  return (
    <nav className={styles.timeline} aria-label="タイムライン">
      {groupByTurn(ticks).map((group) => (
        <div
          key={`${group.turnNumber.toString()}:${group.ticks[0]?.segmentIndex.toString() ?? ""}`}
          className={styles.timelineTurn}
        >
          <span className={styles.timelineTurnLabel}>TURN {group.turnNumber}</span>
          <div className={styles.timelineTicks}>
            {group.ticks.map((tick) => {
              const state =
                tick.segmentIndex < currentSegmentIndex
                  ? styles.tickDone
                  : tick.segmentIndex === currentSegmentIndex
                    ? styles.tickCurrent
                    : undefined;
              const current = tick.segmentIndex === currentSegmentIndex;
              const label = [
                `ターン${tick.turnNumber.toString()}`,
                tick.title,
                ...(tick.skill !== undefined ? [tick.skill] : []),
                ...(tick.containsDefeat ? ["撃破あり"] : []),
              ].join(" ");
              return (
                <button
                  key={tick.segmentIndex}
                  type="button"
                  className={[
                    styles.tick,
                    sideClass(tick),
                    state,
                    isFollowed(tick, follow) ? undefined : styles.dim,
                  ]
                    .filter((name) => name !== undefined)
                    .join(" ")}
                  aria-label={label}
                  aria-current={current ? "step" : undefined}
                  title={label}
                  onClick={() => {
                    onJump(tick.segmentIndex);
                  }}
                >
                  <span className={styles.tickLabel} aria-hidden="true">
                    {tick.short}
                  </span>
                  {tick.containsDefeat ? (
                    <span className={styles.defeatMark} aria-hidden="true">
                      KO
                    </span>
                  ) : null}
                  {current && progress !== undefined ? (
                    <svg
                      className={styles.tickProgress}
                      viewBox="0 0 100 3"
                      preserveAspectRatio="none"
                      aria-hidden="true"
                    >
                      <rect width={Math.round(progress * 100)} height="3" />
                    </svg>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
