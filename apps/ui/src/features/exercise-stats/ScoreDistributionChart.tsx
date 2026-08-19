import type { ScoreDistributionBin } from "./statistics-report.js";
import styles from "./ScoreDistributionChart.module.css";

export interface ScoreDistributionChartProps {
  readonly bins: readonly ScoreDistributionBin[];
  readonly median: number;
  readonly expectedBest: number;
  readonly bestOf: number;
}

// 図の座標系。`index.html`のCSP（`style-src 'self'`）のためinline styleを使えないので、
// 位置と大きさはSVG属性へ、色と線種はCSS Modulesのclassへ分ける。外部の作図
// ライブラリも使わない。
const VIEW_WIDTH = 680;
const VIEW_HEIGHT = 240;
const PLOT_LEFT = 48;
const PLOT_RIGHT = 660;
const PLOT_TOP = 34;
const PLOT_BOTTOM = 196;
const GRID_LINES = 3;
/** 棒の間の隙間。ビンの境界がどこかを棒の形から読めるようにする。 */
const BAR_GAP = 2;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatPercent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

/**
 * 単発スコアのヒストグラムへ、日次ベスト（k回中の最大）の分布を同じビン・同じ縦軸で
 * 重ねる。縦軸を試行数ではなく割合にするのは、2つの分布が同じ標本から出た別の量
 * （1試行あたりと1日あたり）であり、件数では比べられないためである。
 *
 * 05_非機能・アクセシビリティ設計.md §6: 図だけが持つ情報を作らない。同じ数値を
 * 表としても出す。
 */
export function ScoreDistributionChart({
  bins,
  median,
  expectedBest,
  bestOf,
}: ScoreDistributionChartProps) {
  const first = bins[0];
  const last = bins.at(-1);
  if (first === undefined || last === undefined) {
    return null;
  }

  const lowerBound = first.lowerBound;
  const upperBound = last.upperBound;
  const plotWidth = PLOT_RIGHT - PLOT_LEFT;
  const plotHeight = PLOT_BOTTOM - PLOT_TOP;
  // 全試行が同値だと幅0の1本しか作れない。横軸を潰さず、1本の棒として真ん中へ置く。
  const degenerate = upperBound === lowerBound;
  const scoreToX = (score: number): number =>
    degenerate
      ? PLOT_LEFT + plotWidth / 2
      : PLOT_LEFT + ((score - lowerBound) / (upperBound - lowerBound)) * plotWidth;

  const shareMax = Math.max(
    ...bins.map((bin) => Math.max(bin.runShare, bin.dailyBestShare)),
    Number.EPSILON,
  );
  const shareToY = (share: number): number => PLOT_BOTTOM - (share / shareMax) * plotHeight;

  const barWidth = degenerate ? plotWidth / 4 : Math.max(1, plotWidth / bins.length - BAR_GAP);
  const barX = (bin: ScoreDistributionBin): number =>
    degenerate ? PLOT_LEFT + plotWidth / 2 - barWidth / 2 : scoreToX(bin.lowerBound) + BAR_GAP / 2;

  const dailyBestPoints = bins
    .map((bin) => {
      const center = degenerate
        ? PLOT_LEFT + plotWidth / 2
        : scoreToX((bin.lowerBound + bin.upperBound) / 2);
      return `${round(center).toString()},${round(shareToY(bin.dailyBestShare)).toString()}`;
    })
    .join(" ");

  const gridShares = Array.from(
    { length: GRID_LINES + 1 },
    (_value, index) => (shareMax * index) / GRID_LINES,
  );
  const markers = [
    { key: "median", score: median, label: `中央値 ${Math.round(median).toLocaleString()}` },
    {
      key: "expectedBest",
      score: expectedBest,
      label: `E[best${bestOf.toString()}] ${Math.round(expectedBest).toLocaleString()}`,
    },
  ];

  return (
    <div className={styles["chart"]}>
      <div className={styles["scrollArea"]}>
        <svg
          className={styles["svg"]}
          viewBox={`0 0 ${VIEW_WIDTH.toString()} ${VIEW_HEIGHT.toString()}`}
          role="img"
          aria-label={`スコア分布。単発スコアのヒストグラムに、1日${bestOf.toString()}回挑戦した日のベストの分布を重ねた図。中央値${Math.round(median).toLocaleString()}、期待日次ベスト${Math.round(expectedBest).toLocaleString()}。同じ数値を下の表でも読める。`}
        >
          {gridShares.map((share, index) => (
            <g key={share}>
              <line
                className={index === 0 ? styles["axis"] : styles["grid"]}
                x1={PLOT_LEFT}
                y1={round(shareToY(share))}
                x2={PLOT_RIGHT}
                y2={round(shareToY(share))}
              />
              <text
                className={styles["tick"]}
                x={PLOT_LEFT - 6}
                y={round(shareToY(share)) + 4}
                textAnchor="end"
              >
                {formatPercent(share)}
              </text>
            </g>
          ))}

          {bins.map((bin) => (
            <rect
              key={bin.lowerBound}
              className={styles["bar"]}
              x={round(barX(bin))}
              y={round(shareToY(bin.runShare))}
              width={round(barWidth)}
              height={round(PLOT_BOTTOM - shareToY(bin.runShare))}
              rx="2"
            />
          ))}

          <polyline className={styles["dailyBestLine"]} points={dailyBestPoints} />

          {markers.map((marker) => (
            <g key={marker.key}>
              <line
                className={styles[marker.key === "median" ? "medianMarker" : "bestMarker"]}
                x1={round(scoreToX(marker.score))}
                y1={PLOT_TOP}
                x2={round(scoreToX(marker.score))}
                y2={PLOT_BOTTOM}
              />
              <text
                className={styles[marker.key === "median" ? "medianLabel" : "bestLabel"]}
                x={round(scoreToX(marker.score))}
                y={PLOT_TOP - 8}
                textAnchor="middle"
              >
                {marker.label}
              </text>
            </g>
          ))}

          <text className={styles["tick"]} x={PLOT_LEFT} y={PLOT_BOTTOM + 18} textAnchor="start">
            {Math.round(lowerBound).toLocaleString()}
          </text>
          <text className={styles["tick"]} x={PLOT_RIGHT} y={PLOT_BOTTOM + 18} textAnchor="end">
            {Math.round(upperBound).toLocaleString()}
          </text>
          <text
            className={styles["tick"]}
            x={PLOT_LEFT + plotWidth / 2}
            y={VIEW_HEIGHT - 6}
            textAnchor="middle"
          >
            スコア
          </text>
        </svg>
      </div>

      <ul className={styles["legend"]}>
        <li>
          <span className={`${styles["swatch"]} ${styles["barSwatch"]}`} />
          単発スコア分布
        </li>
        <li>
          <span className={`${styles["swatch"]} ${styles["lineSwatch"]}`} />
          {`日次ベスト（${bestOf.toString()}回中の最大）の分布 — 経験分布 F(x)`}
          <sup>{bestOf}</sup>
          {" から導出"}
        </li>
      </ul>

      <details className={styles["table"]}>
        <summary>スコア分布を数値で見る</summary>
        <div className={styles["scrollArea"]}>
          <table>
            <caption>スコア分布: ビンごとの試行数と、単発・日次ベストの割合</caption>
            <thead>
              <tr>
                <th scope="col">スコア範囲</th>
                <th scope="col">試行数</th>
                <th scope="col">単発</th>
                <th scope="col">日次ベスト</th>
              </tr>
            </thead>
            <tbody>
              {bins.map((bin) => (
                <tr key={bin.lowerBound}>
                  <th scope="row">
                    {Math.round(bin.lowerBound).toLocaleString()} –{" "}
                    {Math.round(bin.upperBound).toLocaleString()}
                  </th>
                  <td>{bin.runs.toLocaleString()}</td>
                  <td>{formatPercent(bin.runShare)}</td>
                  <td>{formatPercent(bin.dailyBestShare)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
