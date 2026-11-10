import styles from "./ActionTraceSection.module.css";

// 01_UI要求・画面設計.md §8.10「行動順」。そのターンの行動区間を行動順に並べ、済み・現在・
// これからを色に加えて印（✓）と`aria-current`で区別する。

export interface TraceActionOrderItem {
  readonly segmentIndex: number;
  readonly side?: string;
  readonly title: string;
  readonly short: string;
}

export interface TraceActionOrderProps {
  readonly turnNumber: number;
  readonly items: readonly TraceActionOrderItem[];
  readonly currentSegmentIndex: number;
  readonly onJump: (segmentIndex: number) => void;
}

export function TraceActionOrder({
  turnNumber,
  items,
  currentSegmentIndex,
  onJump,
}: TraceActionOrderProps) {
  return (
    <nav className={styles.order} aria-label="行動順">
      <span className={styles.orderLabel}>T{turnNumber} 行動順</span>
      {items.length === 0 ? (
        <span className={styles.orderEmpty}>このターンの行動はまだありません。</span>
      ) : (
        <ol className={styles.orderList}>
          {items.map((item) => {
            const done = item.segmentIndex < currentSegmentIndex;
            const current = item.segmentIndex === currentSegmentIndex;
            return (
              <li key={item.segmentIndex}>
                <button
                  type="button"
                  className={[
                    styles.orderItem,
                    item.side === "ALLY" ? styles.orderAlly : styles.orderEnemy,
                    done ? styles.orderDone : undefined,
                    current ? styles.orderCurrent : undefined,
                  ]
                    .filter((name) => name !== undefined)
                    .join(" ")}
                  aria-current={current ? "step" : undefined}
                  title={item.title}
                  onClick={() => {
                    onJump(item.segmentIndex);
                  }}
                >
                  {item.short}
                  {done ? (
                    <>
                      <span aria-hidden="true"> ✓</span>
                      <span className={styles.visuallyHidden}>（済み）</span>
                    </>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </nav>
  );
}
