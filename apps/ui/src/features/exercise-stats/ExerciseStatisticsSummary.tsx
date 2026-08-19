import { ScoreDistributionChart } from "./ScoreDistributionChart.js";
import { MIN_RELIABLE_EFFECTIVE_SAMPLES } from "./daily-best.js";
import { ALLY_DEFEATED } from "./descriptive-statistics.js";
import type { BreakCountSummary } from "./descriptive-statistics.js";
import type { ScoreStatisticsReport } from "./statistics-report.js";
import styles from "./ExerciseStatisticsSummary.module.css";

export interface ExerciseStatisticsSummaryProps {
  readonly report: ScoreStatisticsReport;
}

function formatScore(value: number): string {
  return Math.round(value).toLocaleString();
}

function formatMean(value: number): string {
  return value.toFixed(2);
}

function formatPercent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

function Cell({
  label,
  value,
  sub,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
  readonly tone?: "score" | "best";
}) {
  const toneClass = tone === undefined ? "" : ` ${styles[tone] ?? ""}`;
  return (
    <div className={styles["cell"]}>
      <span className={styles["label"]}>{label}</span>
      <span className={`${styles["value"]}${toneClass}`}>{value}</span>
      {sub === undefined ? null : <span className={styles["sub"]}>{sub}</span>}
    </div>
  );
}

// ブレイク回数の分布。棒の高さはSVG属性が持ち、色はCSS Modulesが持つ（CSPのため
// inline styleを使わない）。全体の何割がその回数だったかを読む図なので、割合の
// 一番大きい棒にだけ数値を直接置く。
const BREAK_VIEW_WIDTH = 320;
const BREAK_VIEW_HEIGHT = 120;
const BREAK_BASELINE = 96;
const BREAK_TOP = 16;
/**
 * 目盛りを付ける本数の上限。1試行あたりの総ブレイクが20〜30に達すると回数ごとの棒が
 * 15本以上並び、全部に数字を置くと重なって読めない。間引いても両端は必ず残す。
 */
const BREAK_TICK_LIMIT = 8;

function BreakCountChart({
  summary,
  totalRuns,
}: {
  readonly summary: BreakCountSummary;
  readonly totalRuns: number;
}) {
  const slotWidth = BREAK_VIEW_WIDTH / Math.max(1, summary.distribution.length);
  const barWidth = Math.max(4, slotWidth * 0.6);
  const maxRuns = Math.max(...summary.distribution.map((share) => share.runs), 1);
  const tallest = summary.distribution.reduce(
    (highest, share) => (share.runs > highest.runs ? share : highest),
    summary.distribution[0] ?? { breakCount: 0, runs: 0 },
  );
  const tickStep = Math.ceil(summary.distribution.length / BREAK_TICK_LIMIT);
  const lastIndex = summary.distribution.length - 1;
  const showsTick = (index: number): boolean =>
    index === 0 || index === lastIndex || index % tickStep === 0;

  return (
    <>
      <div className={styles["scrollArea"]}>
        <svg
          className={styles["breakChart"]}
          viewBox={`0 0 ${BREAK_VIEW_WIDTH.toString()} ${BREAK_VIEW_HEIGHT.toString()}`}
          role="img"
          aria-label={`ブレイク回数の分布。平均${formatMean(summary.mean)}回。同じ数値を下の表でも読める。`}
        >
          <line
            className={styles["axis"]}
            x1="0"
            y1={BREAK_BASELINE}
            x2={BREAK_VIEW_WIDTH}
            y2={BREAK_BASELINE}
          />
          {summary.distribution.map((share, index) => {
            const height = ((BREAK_BASELINE - BREAK_TOP) * share.runs) / maxRuns;
            const center = slotWidth * (index + 0.5);
            return (
              <g key={share.breakCount}>
                <rect
                  className={styles["breakBar"]}
                  x={Math.round(center - barWidth / 2)}
                  y={Math.round(BREAK_BASELINE - height)}
                  width={Math.round(barWidth)}
                  height={Math.round(height)}
                  rx="2"
                />
                {showsTick(index) ? (
                  <text
                    className={styles["tick"]}
                    x={Math.round(center)}
                    y={BREAK_BASELINE + 14}
                    textAnchor="middle"
                  >
                    {share.breakCount}
                  </text>
                ) : null}
                {share.breakCount === tallest.breakCount ? (
                  <text
                    className={styles["tick"]}
                    x={Math.round(center)}
                    y={Math.round(BREAK_BASELINE - height) - 4}
                    textAnchor="middle"
                  >
                    {formatPercent(share.runs / totalRuns)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
      <div className={styles["scrollArea"]}>
        <table className={styles["dataTable"]}>
          <caption>ブレイク回数ごとの試行数</caption>
          <thead>
            <tr>
              <th scope="col">ブレイク回数</th>
              <th scope="col">試行数</th>
              <th scope="col">割合</th>
            </tr>
          </thead>
          <tbody>
            {summary.distribution.map((share) => (
              <tr key={share.breakCount}>
                <th scope="row">{share.breakCount}</th>
                <td>{share.runs.toLocaleString()}</td>
                <td>{formatPercent(share.runs / totalRuns)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * 統計実行時の演習サマリ（Panel 02）。単一実行の`ScoreSummaryHeader`と同じstripの
 * イディオムを使うが、出すのは1回の結果ではなく標本の統計量である。
 *
 * 日次ベスト指標を別枠へ強調して置くのは、スコアアタックが1日k回の最大で決まる
 * （`daily-best.ts`）ため、読むべき値が平均ではなくこちらだからである。
 */
export function ExerciseStatisticsSummary({ report }: ExerciseStatisticsSummaryProps) {
  const { score, dailyBest } = report;
  const confidenceInterval =
    score.ciLow === null || score.ciHigh === null
      ? "95% CI ―"
      : `95% CI ±${formatScore((score.ciHigh - score.ciLow) / 2)}`;

  return (
    <div>
      {/* 期限到達（Q-TEX-18）と中断はどちらも要求より短い標本を残す。要求数と並べて
          出さないと「要求どおり終わった」結果として読まれる。 */}
      {report.partial ? (
        <p className={styles["partial"]}>
          {`部分結果です。${report.requestedRuns.toLocaleString()}試行の要求に対し${report.completedRuns.toLocaleString()}試行が集計へ入りました。統計はこの${report.completedRuns.toLocaleString()}試行から出しています。`}
        </p>
      ) : null}

      <h3 className={styles["blockTitle"]}>
        スコア統計（単発 n = {report.completedRuns.toLocaleString()}）
      </h3>
      <div className={styles["strip"]}>
        <Cell
          label="完了 RUN"
          value={report.completedRuns.toLocaleString()}
          sub={`/ ${report.requestedRuns.toLocaleString()} 要求`}
        />
        <Cell label="平均" value={formatScore(score.mean)} sub={confidenceInterval} tone="score" />
        <Cell label="中央値" value={formatScore(score.median)} />
        <Cell
          label="標準偏差"
          // 試行1回では散らばりが定義できない。0（ばらつきが無い）と読ませない。
          value={score.stdev === null ? "―" : formatScore(score.stdev)}
        />
        <Cell
          label="最小 / 最大"
          value={formatScore(score.minimum)}
          sub={`〜 ${formatScore(score.maximum)}`}
        />
        <Cell
          label="P05 / P95"
          value={formatScore(score.p05)}
          sub={`〜 ${formatScore(score.p95)}`}
        />
      </div>

      <h3 className={styles["blockTitle"]}>日次ベスト指標（1日{dailyBest.bestOf}回制）</h3>
      <div className={`${styles["strip"]} ${styles["daily"]}`}>
        <Cell
          label={`E[BEST OF ${dailyBest.bestOf.toString()}] 期待日次ベスト`}
          value={formatScore(dailyBest.expectedBest)}
          tone="best"
        />
        <Cell label="日次ベスト中央値" value={formatScore(dailyBest.median)} />
        <Cell
          label="75% 保証ライン"
          value={formatScore(dailyBest.guaranteed75)}
          sub="75%の日で超える"
        />
        <Cell
          label="90% 保証ライン"
          value={formatScore(dailyBest.guaranteed90)}
          sub="90%の日で超える"
        />
        <Cell
          label="有効サンプル"
          value={Math.floor(dailyBest.effectiveSamples).toLocaleString()}
          sub={`n×9/25 ≥ ${MIN_RELIABLE_EFFECTIVE_SAMPLES.toString()} で信頼可`}
        />
      </div>
      {/* 重みが上位2割前後へ集中するため、試行数をそのまま信頼度として読むと過大評価
          になる。下限未満の値は上位数試行に引きずられている。 */}
      {dailyBest.reliable ? null : (
        <p className={styles["warning"]}>
          {`有効サンプルが${MIN_RELIABLE_EFFECTIVE_SAMPLES.toString()}未満です。日次ベスト指標は上位わずかな試行に左右されるため、実行回数を増やしてください。`}
        </p>
      )}

      <h3 className={styles["blockTitle"]}>スコア分布</h3>
      <ScoreDistributionChart
        bins={report.distribution}
        median={score.median}
        expectedBest={dailyBest.expectedBest}
        bestOf={dailyBest.bestOf}
      />

      <div className={styles["twoColumn"]}>
        <section>
          <h3 className={styles["blockTitle"]}>完走内訳（completionReason）</h3>
          <ul className={styles["pillRow"]}>
            {report.completionReasons.breakdown.map((share) => (
              <li
                key={share.completionReason}
                className={`${styles["pill"]} ${
                  share.completionReason === ALLY_DEFEATED ? styles["bad"] : styles["ok"]
                }`}
              >
                <span className={styles["dot"]} />
                {share.completionReason} {formatPercent(share.ratio)}
              </li>
            ))}
          </ul>
          <p className={styles["hint"]}>
            敗北率が高い編成は日次ベストの下振れ要因です。保証ラインと合わせて読みます。
          </p>
        </section>
        <section>
          <h3 className={styles["blockTitle"]}>
            ブレイク回数分布（平均 {formatMean(report.breaks.mean)}）
          </h3>
          <BreakCountChart summary={report.breaks} totalRuns={report.completedRuns} />
        </section>
      </div>

      <div className={styles["strip"]}>
        <Cell label="SEED" value={report.seed} />
        <Cell label="CHUNK SIZE" value={report.chunkSize.toLocaleString()} />
        <Cell label="CATALOG REVISION" value={report.catalogRevision} />
      </div>
    </div>
  );
}
