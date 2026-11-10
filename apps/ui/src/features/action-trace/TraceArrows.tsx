import { useId, useLayoutEffect, useState } from "react";
import { svgIdOf } from "./svg-id.js";
import type { TraceArrowView } from "./trace-board-view.js";
import styles from "./TraceBoard.module.css";

// 01_UI要求・画面設計.md §8.10「描画上の制約」: 矢印はカードの位置を測ってSVGの属性で
// 引く（inline styleを使わない）。盤面の大きさが変わる（画面幅・カードの高さの変化）
// たびに`ResizeObserver`で測り直す。

export interface TraceArrowsProps {
  /** 矢印の座標の原点にする盤面の要素。描画前は`null`。 */
  readonly board: HTMLElement | null;
  readonly arrows: readonly TraceArrowView[];
  /** 盤面の中身が変わったときに測り直すための値。 */
  readonly layoutKey: string;
}

interface Geometry {
  readonly width: number;
  readonly height: number;
  readonly paths: readonly {
    readonly key: string;
    readonly d: string;
    readonly arrow: TraceArrowView;
  }[];
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly halfWidth: number;
  readonly halfHeight: number;
}

/** カードの縁より少し内側から出し、矢じりが対象のカードに重なりすぎないよう寄せる。 */
const INSET_RATIO = 0.55;
const ARROW_HEAD_GAP = 4;
/** 往復の矢印が重ならないよう、進行方向の左へ膨らませる量。 */
const CURVE_OFFSET = 18;

function round(value: number): string {
  return (Math.round(value * 10) / 10).toString();
}

function boxOf(board: HTMLElement, element: Element): Box {
  const origin = board.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left - origin.left + rect.width / 2,
    y: rect.top - origin.top + rect.height / 2,
    halfWidth: rect.width / 2,
    halfHeight: rect.height / 2,
  };
}

function insetOf(box: Box, ux: number, uy: number): number {
  const horizontal = Math.abs(ux) > 0.01 ? box.halfWidth / Math.abs(ux) : Number.POSITIVE_INFINITY;
  const vertical = Math.abs(uy) > 0.01 ? box.halfHeight / Math.abs(uy) : Number.POSITIVE_INFINITY;
  const inset = Math.min(horizontal, vertical);
  return Number.isFinite(inset) ? inset * INSET_RATIO : 0;
}

function pathBetween(from: Box, to: Box): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const startInset = insetOf(from, ux, uy);
  const endInset = insetOf(to, ux, uy) + ARROW_HEAD_GAP;
  const x1 = from.x + ux * startInset;
  const y1 = from.y + uy * startInset;
  const x2 = to.x - ux * endInset;
  const y2 = to.y - uy * endInset;
  const mx = (x1 + x2) / 2 - uy * CURVE_OFFSET;
  const my = (y1 + y2) / 2 + ux * CURVE_OFFSET;
  return `M${round(x1)} ${round(y1)} Q${round(mx)} ${round(my)} ${round(x2)} ${round(y2)}`;
}

function measure(board: HTMLElement, arrows: readonly TraceArrowView[]): Geometry {
  const rect = board.getBoundingClientRect();
  const cards = new Map<string, HTMLElement>();
  for (const element of board.querySelectorAll<HTMLElement>("[data-trace-unit]")) {
    const id = element.dataset["traceUnit"];
    if (id !== undefined) {
      cards.set(id, element);
    }
  }
  const paths = arrows.flatMap((arrow) => {
    const from = cards.get(arrow.fromUnitId);
    const to = cards.get(arrow.toUnitId);
    if (from === undefined || to === undefined) {
      return [];
    }
    return [
      {
        key: `${arrow.fromUnitId}>${arrow.toUnitId}`,
        d: pathBetween(boxOf(board, from), boxOf(board, to)),
        arrow,
      },
    ];
  });
  return { width: rect.width, height: rect.height, paths };
}

function arrowClass(arrow: TraceArrowView): string | undefined {
  if (arrow.kind === "heal") {
    return styles.arrowHeal;
  }
  if (arrow.kind === "passive") {
    return styles.arrowPassive;
  }
  return arrow.side === "ALLY" ? styles.arrowAttackAlly : styles.arrowAttackEnemy;
}

const MARKER_KINDS = [
  ["attack-ally", styles.headAttackAlly],
  ["attack-enemy", styles.headAttackEnemy],
  ["passive", styles.headPassive],
  ["heal", styles.headHeal],
] as const;

function markerKind(arrow: TraceArrowView): string {
  return arrow.kind === "attack"
    ? `attack-${arrow.side === "ALLY" ? "ally" : "enemy"}`
    : arrow.kind;
}

export function TraceArrows({ board, arrows, layoutKey }: TraceArrowsProps) {
  const markerPrefix = svgIdOf(useId());
  const [geometry, setGeometry] = useState<Geometry | undefined>(undefined);

  useLayoutEffect(() => {
    if (board === null) {
      return undefined;
    }
    const update = () => {
      setGeometry(measure(board, arrows));
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(update);
    observer.observe(board);
    return () => {
      observer.disconnect();
    };
  }, [board, arrows, layoutKey]);

  if (geometry === undefined) {
    return null;
  }
  return (
    <svg
      className={styles.arrows}
      data-trace-arrows=""
      aria-hidden="true"
      viewBox={`0 0 ${round(geometry.width)} ${round(geometry.height)}`}
      width={geometry.width}
      height={geometry.height}
    >
      <defs>
        {MARKER_KINDS.map(([kind, className]) => (
          <marker
            key={kind}
            id={`${markerPrefix}-${kind}`}
            viewBox="0 0 10 10"
            refX="6"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path className={className} d="M0 0L10 5L0 10z" />
          </marker>
        ))}
      </defs>
      {geometry.paths.map(({ key, d, arrow }) => (
        <path
          key={`${key}>${arrow.kind}`}
          data-arrow={key}
          className={arrowClass(arrow)}
          d={d}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          {...(arrow.kind === "passive" ? { strokeDasharray: "5 4" } : {})}
          markerEnd={`url(#${markerPrefix}-${markerKind(arrow)})`}
        />
      ))}
    </svg>
  );
}
