import type {
  TraceChangeRow,
  TraceEffectChange,
  TraceValueChange,
} from "./trace-change-projector.js";
import styles from "./TraceChangeTable.module.css";

// 01_UI要求・画面設計.md §8.10「変化の表」。範囲の前後でユニットごとの変化を出し、変化の無い
// ユニットの行は出さない。範囲の最初の状態遷移を「状態遷移」tabで開ける。

export interface TraceChangeTableProps {
  readonly rows: readonly TraceChangeRow[];
  readonly stepMode: boolean;
  /** 範囲の最初の状態遷移の位置。範囲内に遷移が無ければ持たない。 */
  readonly transitionIndex?: number;
  readonly onJumpToTransition: (index: number) => void;
}

const NUMBER_FORMAT = new Intl.NumberFormat("ja-JP");

function formatNumber(value: number): string {
  return NUMBER_FORMAT.format(value);
}

function signed(value: number): string {
  return `${value > 0 ? "+" : "−"}${formatNumber(Math.abs(value))}`;
}

function valueText(change: TraceValueChange): string {
  return `${change.label} ${formatNumber(change.before)} → ${formatNumber(change.after)}`;
}

function effectText(change: TraceEffectChange): string {
  switch (change.change) {
    case "added":
      return `+${change.label}${change.after !== undefined ? `（${change.after}）` : ""}`;
    case "removed":
      return `−${change.label}`;
    case "remaining":
      return `${change.label} ${change.before ?? "—"}→${change.after ?? "—"}`;
  }
}

function Empty() {
  return <span className={styles.none}>—</span>;
}

export function TraceChangeTable({
  rows,
  stepMode,
  transitionIndex,
  onJumpToTransition,
}: TraceChangeTableProps) {
  return (
    <section
      className={styles.section}
      aria-label={stepMode ? "この処理での変化" : "この行動での変化"}
    >
      <div className={styles.head}>
        <h3 className={styles.title}>{stepMode ? "この処理での変化" : "この行動での変化"}</h3>
        <button
          type="button"
          className={styles.link}
          aria-disabled={transitionIndex === undefined ? "true" : undefined}
          onClick={() => {
            if (transitionIndex !== undefined) {
              onJumpToTransition(transitionIndex);
            }
          }}
        >
          状態遷移で開く
        </button>
      </div>
      {rows.length === 0 ? (
        <p className={styles.empty}>この範囲では状態が変化しません。</p>
      ) : (
        <div className={styles.scroll}>
          <table className={styles.table} aria-label="変化の表">
            <thead>
              <tr>
                <th scope="col">ユニット</th>
                <th scope="col">HP</th>
                <th scope="col">リソース</th>
                <th scope="col">効果</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const hp = row.values.find((value) => value.label === "HP");
                const resources = row.values.filter((value) => value.label !== "HP");
                const notes = [
                  ...(row.deployed ? ["出撃"] : []),
                  ...resources.map(valueText),
                  ...(row.defeated ? ["撃破"] : []),
                ];
                return (
                  <tr key={row.battleUnitId}>
                    <td className={row.side === "ALLY" ? styles.ally : styles.enemy}>
                      {row.displayName}
                    </td>
                    <td className={styles.number}>
                      {hp !== undefined ? (
                        <>
                          {formatNumber(hp.before)} → {formatNumber(hp.after)}{" "}
                          <span
                            className={hp.after < hp.before ? styles.negative : styles.positive}
                          >
                            ({signed(hp.after - hp.before)})
                          </span>
                        </>
                      ) : (
                        <Empty />
                      )}
                    </td>
                    <td className={styles.number}>
                      {notes.length > 0 ? notes.join(" · ") : <Empty />}
                    </td>
                    <td>
                      {row.effects.length > 0 ? (
                        <ul className={styles.effects}>
                          {row.effects.map((effect) => (
                            <li
                              key={effect.key}
                              className={effect.change === "removed" ? styles.removed : undefined}
                              title={effect.logicalName}
                            >
                              {effectText(effect)}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <Empty />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
