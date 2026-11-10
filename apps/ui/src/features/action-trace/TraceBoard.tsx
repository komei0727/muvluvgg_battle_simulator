import { useState } from "react";
import { TraceArrows } from "./TraceArrows.js";
import type {
  TraceArrowKind,
  TraceBoardRow,
  TraceBoardSide,
  TraceBoardView,
  TraceUnitCardView,
} from "./trace-board-view.js";
import { UnitTraceCard } from "./UnitTraceCard.js";
import styles from "./TraceBoard.module.css";

// 01_UI要求・画面設計.md §8.10「盤面」。敵を上・味方を下に置き、前衛どうしが向き合うよう
// 敵は後衛→前衛、味方は前衛→後衛の順に並べる。狭い画面でも3列のまま縮める。

export interface TraceBoardProps {
  readonly view: TraceBoardView;
}

const COLUMNS = [0, 1, 2] as const;
const ROW_LABEL: Readonly<Record<TraceBoardRow, string>> = { FRONT: "前衛", REAR: "後衛" };
const SIDE_LABEL: Readonly<Record<TraceBoardSide, string>> = { ALLY: "味方", ENEMY: "敵" };
const ARROW_LABEL: Readonly<Record<TraceArrowKind, string>> = {
  attack: "攻撃",
  passive: "PS発動",
  heal: "回復",
};

function SideRows({
  side,
  rows,
  units,
}: {
  readonly side: TraceBoardSide;
  readonly rows: readonly TraceBoardRow[];
  readonly units: readonly TraceUnitCardView[];
}) {
  return (
    <section className={styles.side} aria-label={`${SIDE_LABEL[side]}の盤面`}>
      <h3 className={side === "ALLY" ? styles.sideLabelAlly : styles.sideLabelEnemy}>
        {SIDE_LABEL[side]}
      </h3>
      <div className={styles.rows} role="table" aria-label={`${SIDE_LABEL[side]}の配置`}>
        {rows.map((row) => (
          <div key={row} className={styles.row} role="row" aria-label={ROW_LABEL[row]}>
            <span className={styles.rowLabel} aria-hidden="true">
              {ROW_LABEL[row]}
            </span>
            {COLUMNS.map((column) => {
              const unit = units.find(
                (candidate) =>
                  candidate.side === side && candidate.row === row && candidate.column === column,
              );
              return (
                <div key={column} className={styles.cell} role="cell">
                  {unit !== undefined ? (
                    <UnitTraceCard card={unit} />
                  ) : (
                    <div className={styles.empty} aria-hidden="true" />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

export function TraceBoard({ view }: TraceBoardProps) {
  // 子のlayout effectは親のref付与より先に走るため、refではなくstateで要素を渡す
  const [board, setBoard] = useState<HTMLDivElement | null>(null);
  const nameOf = (id: string) =>
    view.units.find((unit) => unit.battleUnitId === id)?.displayName ?? id;
  // カードの高さは印・ダメージ表示の有無で変わるため、盤面の中身が変わったら測り直す
  const layoutKey = view.units
    .map(
      (unit) =>
        `${unit.battleUnitId}:${unit.chips.length.toString()}:${unit.damage !== undefined ? "d" : ""}`,
    )
    .join("|");
  return (
    <div ref={setBoard} className={styles.board} data-trace-board="">
      <SideRows side="ENEMY" rows={["REAR", "FRONT"]} units={view.units} />
      <div className={styles.frontline} aria-hidden="true">
        FRONT LINE
      </div>
      <SideRows side="ALLY" rows={["FRONT", "REAR"]} units={view.units} />
      {view.arrows.length > 0 ? (
        <ul className={styles.visuallyHidden} aria-label="矢印">
          {view.arrows.map((arrow) => (
            <li key={`${arrow.fromUnitId}>${arrow.toUnitId}>${arrow.kind}`}>
              {`${nameOf(arrow.fromUnitId)} → ${nameOf(arrow.toUnitId)}（${ARROW_LABEL[arrow.kind]}）`}
            </li>
          ))}
        </ul>
      ) : null}
      <TraceArrows board={board} arrows={view.arrows} layoutKey={layoutKey} />
    </div>
  );
}
