import { useId, useMemo, useState } from "react";
import { Button } from "../../components/Button.js";
import { downloadTextFile } from "../../lib/download-text-file.js";
import { buildRunsCsv, buildStatisticsSummaryJson } from "./statistics-export.js";
import {
  DEFAULT_TOP_RUN_COUNT,
  TOP_RUN_CHOICES,
  buildUnitStatisticsReport,
} from "./statistics-report.js";
import type {
  AllyUnitLabel,
  ScoreStatisticsReport,
  UnitStatisticsRow,
} from "./statistics-report.js";
import type { EvaluationAggregate } from "../exercise/evaluation-chunk-plan.js";
import styles from "./UnitStatisticsSection.module.css";

export interface UnitStatisticsSectionProps {
  readonly aggregate: EvaluationAggregate;
  /** 送信時の編成から引いた列の名前。列そのものは応答が決める。 */
  readonly labels: readonly AllyUnitLabel[];
  readonly score: ScoreStatisticsReport;
}

/** 分布バー・内訳バーの座標系。位置はSVG属性、色はCSS Modulesが持つ（CSP）。 */
const BAR_WIDTH = 300;
const DISTRIBUTION_HEIGHT = 24;
const BREAKDOWN_HEIGHT = 20;
/** 直接%を書き込むセグメントの下限。これ未満は文字が枠からはみ出す。 */
const BREAKDOWN_LABEL_MIN_SHARE = 0.2;
/**
 * 分布バーの左右の余白。共通スケールの最大値そのものを描く行では、中央値の線も
 * ◆も図の端に来る。余白なしで描くと半分が切れて位置を読めない。
 */
const DISTRIBUTION_INSET = 8;

function formatAmount(value: number): string {
  return Math.round(value).toLocaleString();
}

function formatMean(value: number): string {
  return value.toFixed(2);
}

function formatSignedPercent(ratio: number): string {
  const percent = ratio * 100;
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(0)}%`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 与ダメージの分布バー。全ユニット共通スケール（`damageScaleMax`）で描く —— 行ごとに
 * 伸縮させると、寄与の小さいユニットの箱が最大の列と同じ幅に見える。
 */
function DamageDistributionBar({
  row,
  scaleMax,
}: {
  readonly row: UnitStatisticsRow;
  readonly scaleMax: number;
}) {
  const span = BAR_WIDTH - DISTRIBUTION_INSET * 2;
  const toX = (value: number): number =>
    scaleMax === 0 ? DISTRIBUTION_INSET : DISTRIBUTION_INSET + (value / scaleMax) * span;
  const boxLeft = toX(row.damage.p25);
  const boxWidth = Math.max(1, toX(row.damage.p75) - boxLeft);
  const diamond = toX(row.topMeanDamage);

  return (
    <svg
      className={styles["bar"]}
      viewBox={`0 0 ${BAR_WIDTH.toString()} ${DISTRIBUTION_HEIGHT.toString()}`}
      role="img"
      aria-label={`${row.label.displayName}の与ダメージ分布。最小${formatAmount(row.damage.minimum)}、P25 ${formatAmount(row.damage.p25)}、中央値${formatAmount(row.damage.median)}、P75 ${formatAmount(row.damage.p75)}、最大${formatAmount(row.damage.maximum)}、上位run平均${formatAmount(row.topMeanDamage)}。`}
    >
      <line
        className={styles["range"]}
        x1={round(toX(row.damage.minimum))}
        y1="12"
        x2={round(toX(row.damage.maximum))}
        y2="12"
      />
      <rect
        className={styles["box"]}
        x={round(boxLeft)}
        y="5"
        width={round(boxWidth)}
        height="14"
        rx="3"
      />
      <line
        className={styles["median"]}
        x1={round(toX(row.damage.median))}
        y1="3"
        x2={round(toX(row.damage.median))}
        y2="21"
      />
      <polygon
        className={styles["topMarker"]}
        points={`${round(diamond).toString()},4 ${round(diamond + 7).toString()},12 ${round(diamond).toString()},20 ${round(diamond - 7).toString()},12`}
      />
    </svg>
  );
}

/**
 * runあたりのブレイク回数の内訳。0回→3回以上を1色の濃淡で並べる（順序のある量なので
 * 色相を変えない）。大きいセグメントにだけ割合を直接置く。
 */
function BreakBreakdownBar({
  row,
  totalRuns,
}: {
  readonly row: UnitStatisticsRow;
  readonly totalRuns: number;
}) {
  const segments = [
    { key: "share0", label: "0回", runs: row.breaks.runsByBreakCount.none },
    { key: "share1", label: "1回", runs: row.breaks.runsByBreakCount.one },
    { key: "share2", label: "2回", runs: row.breaks.runsByBreakCount.two },
    { key: "share3", label: "3回以上", runs: row.breaks.runsByBreakCount.threeOrMore },
  ];

  let offset = 0;
  return (
    <svg
      className={styles["bar"]}
      viewBox={`0 0 ${BAR_WIDTH.toString()} ${BREAKDOWN_HEIGHT.toString()}`}
      role="img"
      aria-label={`${row.label.displayName}のrunあたりブレイク回数の内訳。${segments
        .map((segment) => `${segment.label} ${((segment.runs / totalRuns) * 100).toFixed(1)}%`)
        .join("、")}。`}
    >
      {segments.map((segment) => {
        const share = totalRuns === 0 ? 0 : segment.runs / totalRuns;
        const width = share * BAR_WIDTH;
        const x = offset;
        offset += width;
        if (width <= 0) {
          return null;
        }
        return (
          <g key={segment.key}>
            <rect
              className={`${styles["barSegment"]} ${styles[segment.key] ?? ""}`}
              x={round(x)}
              y="4"
              width={round(width)}
              height="12"
              rx="2"
            />
            {share >= BREAKDOWN_LABEL_MIN_SHARE ? (
              <text
                className={styles["segmentLabel"]}
                x={round(x + width / 2)}
                y="14"
                textAnchor="middle"
              >
                {`${(share * 100).toFixed(0)}%`}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

type CopyStatus = "idle" | "succeeded" | "failed";

/**
 * 統計実行時の演習詳細（Panel 03）。全run統計とベストスコア上位N runの部分集計を
 * 並べる —— スコアアタックで意味があるのは平均的な1試行ではなく、上振れした日の
 * 試行がどう作られたかである。Nの切り替えは手元の生値の再集計だけで済ませ、再実行
 * しない（同じseedで同じ試行をやり直すことになるため）。
 */
export function UnitStatisticsSection({ aggregate, labels, score }: UnitStatisticsSectionProps) {
  const [topN, setTopN] = useState<number>(DEFAULT_TOP_RUN_COUNT);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
  const [downloadFailed, setDownloadFailed] = useState(false);
  const groupName = useId();

  const report = useMemo(
    () => buildUnitStatisticsReport(aggregate, labels, topN),
    [aggregate, labels, topN],
  );
  const clipboard = navigator.clipboard as Clipboard | undefined;

  function handleDownloadCsv() {
    const started = downloadTextFile(
      `exercise-runs-${score.completedRuns.toString()}.csv`,
      "text/csv",
      buildRunsCsv(aggregate, labels),
    );
    setDownloadFailed(!started);
  }

  async function handleCopyJson() {
    if (clipboard === undefined) {
      return;
    }
    try {
      await clipboard.writeText(buildStatisticsSummaryJson(score, report));
      setCopyStatus("succeeded");
    } catch {
      setCopyStatus("failed");
    }
  }

  return (
    <div>
      <fieldset className={styles["selector"]}>
        <legend className={styles["legendLabel"]}>ベストスコア比較</legend>
        <div className={styles["segmented"]}>
          {TOP_RUN_CHOICES.map((choice) => (
            <label key={choice} className={styles["segment"]}>
              <input
                type="radio"
                name={groupName}
                value={choice}
                checked={topN === choice}
                onChange={() => {
                  setTopN(choice);
                }}
              />
              上位 {choice} run
            </label>
          ))}
        </div>
      </fieldset>
      <p className={styles["hint"]}>
        全{score.completedRuns.toLocaleString()}run中、スコア上位
        {report.requestedTopN.toLocaleString()}runの平均スコア:{" "}
        <b>{formatAmount(report.topMeanScore)}</b>（全体平均{" "}
        {formatSignedPercent(report.topMeanScoreRatio)}）
        {/* 試行数がNに満たないときは要求Nのまま実数を添える。上位50runと書いたまま
            全試行の平均を出すと、差が0になった理由が読めない。 */}
        {report.topRuns < report.requestedTopN
          ? `。実行が${report.topRuns.toLocaleString()}runしかないため、全${report.topRuns.toLocaleString()}runの平均です`
          : ""}
      </p>

      <h3 className={styles["blockTitle"]}>キャラ別与ダメージ — 全run平均 vs ベスト上位平均</h3>
      <div className={styles["scrollArea"]}>
        <table className={styles["table"]}>
          <caption className={styles["caption"]}>キャラ別与ダメージ</caption>
          <thead>
            <tr>
              <th scope="col">ユニット</th>
              <th scope="col">平均（全run）</th>
              <th scope="col">上位{report.requestedTopN}平均</th>
              <th scope="col">分布（min – P25 – 中央値 – P75 – max ／ ◆ = 上位平均）</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <tr key={row.label.unitIndex}>
                <th scope="row" className={styles["name"]}>
                  {row.label.displayName}
                </th>
                <td>
                  {formatAmount(row.damage.mean)}
                  <span className={styles["share"]}>
                    {" "}
                    寄与 {(row.damage.contribution * 100).toFixed(1)}%
                  </span>
                </td>
                <td className={styles["topValue"]}>
                  {formatAmount(row.topMeanDamage)}
                  <span className={styles["share"]}>
                    {" "}
                    {formatSignedPercent(row.topMeanDamageRatio)}
                  </span>
                </td>
                <td className={styles["barCell"]}>
                  <DamageDistributionBar row={row} scaleMax={report.damageScaleMax} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={styles["hint"]}>
        分布バーは全ユニット共通スケールです。箱 = P25〜P75、白線 = 中央値、横線 = min〜max、◆ =
        ベスト上位run内の平均。◆が箱の右外にあるユニットほど、上振れが ベストスコアを作っています。
      </p>

      <h3 className={styles["blockTitle"]}>
        ユニット別ブレイク回数 — 分布と、ベスト上位平均との比較
      </h3>
      <div className={styles["scrollArea"]}>
        <table className={styles["table"]}>
          <caption className={styles["caption"]}>ユニット別ブレイク回数</caption>
          <thead>
            <tr>
              <th scope="col">ユニット</th>
              <th scope="col">平均（全run）</th>
              <th scope="col">上位{report.requestedTopN}平均</th>
              <th scope="col">runごとのブレイク回数の内訳（0回 → 3回以上）</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <tr key={row.label.unitIndex}>
                <th scope="row" className={styles["name"]}>
                  {row.label.displayName}
                </th>
                <td>{formatMean(row.breaks.mean)}</td>
                <td className={styles["topValue"]}>{formatMean(row.topMeanBreakCount)}</td>
                <td className={styles["barCell"]}>
                  <BreakBreakdownBar row={row} totalRuns={score.completedRuns} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className={styles["legendRow"]}>
        <li>
          <span className={`${styles["swatch"]} ${styles["swatch0"]}`} />
          0回
        </li>
        <li>
          <span className={`${styles["swatch"]} ${styles["swatch1"]}`} />
          1回
        </li>
        <li>
          <span className={`${styles["swatch"]} ${styles["swatch2"]}`} />
          2回
        </li>
        <li>
          <span className={`${styles["swatch"]} ${styles["swatch3"]}`} />
          3回以上
        </li>
      </ul>
      {/* 残差には発生源ユニットを持たないブレイク（R-MEM-04）と、敵の枠自身が起こした
          ブレイク（R-CFS-01）の両方が入る。起源を一つに断定しない。 */}
      <p className={styles["hint"]}>
        ユニット平均の合計 {formatMean(report.unitBreakMeanTotal)} ＋ 味方の枠に帰属しない ブレイク{" "}
        {formatMean(report.unattributedBreakMean)} = 全体平均 {formatMean(report.breakMean)}
        。帰属しない分にはメモリー効果の継続ダメージと、敵の 枠自身が起こしたブレイクが含まれます。
      </p>

      <div className={styles["exportRow"]}>
        <Button variant="secondary" onClick={handleDownloadCsv}>
          全run生データをCSVでダウンロード
        </Button>
        {clipboard === undefined ? null : (
          <Button
            variant="secondary"
            onClick={() => {
              void handleCopyJson();
            }}
          >
            統計サマリをJSONでコピー
          </Button>
        )}
        {copyStatus === "succeeded" ? (
          <span className={styles["status"]}>コピーしました</span>
        ) : null}
        {copyStatus === "failed" ? (
          <span className={styles["status"]}>コピーに失敗しました</span>
        ) : null}
        {downloadFailed ? (
          <span className={styles["status"]}>この環境ではダウンロードを開始できませんでした。</span>
        ) : null}
      </div>
    </div>
  );
}
