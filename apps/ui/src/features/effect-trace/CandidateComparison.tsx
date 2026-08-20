import { useId } from "react";
import { resolveDisplayName } from "../details/event-presentation.js";
import type { RosterIndex } from "../details/event-presentation.js";
import type { RankCandidate, RankCandidateComparison } from "./candidate-comparison.js";
import type { CombatStatContribution } from "./combat-stat-timeline.js";
import styles from "./CandidateComparison.module.css";

export interface CandidateComparisonProps {
  readonly comparison: RankCandidateComparison;
  readonly roster: RosterIndex;
}

const NO_VALUE_PLACEHOLDER = "-";

// docs/ui-design/01_UI要求・画面設計.md §8.7: この比較が観測ではなく逆算であることを、
// 画面から必ず読めるようにする。対象決定を表すイベントが存在しないため、
// サーバーが実際にどう比較したかの直接の証拠は持てない。
const INFERENCE_NOTICE =
  "この比較は付与先からの逆算である。対象決定そのものを表すイベントは無いため、同点処理のような細部が食い違っていても検出できない。";

const MISMATCH_NOTICE =
  "復元した順位の1位が実際の付与先と一致しません。候補の絞り込みや同点処理が復元と違う可能性があります。";

const UNREADABLE_NOTICE = "値を読めなかった候補があります。順位はその候補を除いたものです。";

function formatValue(value: number | undefined): string {
  return value === undefined ? NO_VALUE_PLACEHOLDER : Math.round(value).toLocaleString();
}

function formatSigned(amount: number): string {
  const rounded = Math.round(amount);
  return `${rounded >= 0 ? "+" : ""}${rounded.toLocaleString()}`;
}

function contributionLabel(contribution: CombatStatContribution): string {
  const name =
    "effectActionDefinitionId" in contribution
      ? contribution.effectActionDefinitionId
      : contribution.reason;
  return `${name} ${formatSigned(contribution.amount)}`;
}

function CandidateRow({
  candidate,
  rank,
  roster,
}: {
  readonly candidate: RankCandidate;
  readonly rank: number | undefined;
  readonly roster: RosterIndex;
}) {
  return (
    <tr className={candidate.isChosen ? styles["chosenRow"] : undefined}>
      <td className={styles["mono"]}>{rank === undefined ? NO_VALUE_PLACEHOLDER : rank}</td>
      <td>
        {resolveDisplayName(roster, candidate.battleUnitId)}
        {candidate.isChosen ? <span className={styles["chosenBadge"]}>選択</span> : null}
      </td>
      <td className={styles["mono"]}>{formatValue(candidate.value)}</td>
      <td className={styles["mono"]}>{formatValue(candidate.initialValue)}</td>
      <td className={styles["breakdown"]}>
        {candidate.contributions.length === 0
          ? NO_VALUE_PLACEHOLDER
          : candidate.contributions.map((contribution) => (
              <span
                key={
                  "effectActionDefinitionId" in contribution
                    ? contribution.effectActionDefinitionId
                    : contribution.reason
                }
                className={styles["contribution"]}
              >
                {contributionLabel(contribution)}
              </span>
            ))}
      </td>
    </tr>
  );
}

// docs/ui-design/01_UI要求・画面設計.md §8.7（`UI-AC-046`）: 順位セレクタが対象を決めた時点の
// 候補を、解決時点の実効値で並べる。開始時ステータスの順位では代用できない —— 割合バフ1つが
// ギア数十枚分を動かすため、解決時点の順位は開始時と別の順位になる。
export function CandidateComparison({ comparison, roster }: CandidateComparisonProps) {
  const headingId = useId();
  const chosen = comparison.candidates.find((candidate) => candidate.isChosen);
  const gap = comparison.gapToRunnerUp;

  return (
    <section className={styles["section"]} aria-labelledby={headingId}>
      <h4 id={headingId} className={styles["heading"]}>
        {`${comparison.spec.label}候補が選ばれた（${comparison.orderKey} / 解決 #${comparison.resolvedBeforeSequence.toString()} 直前）`}
      </h4>
      <p className={styles["notice"]}>{INFERENCE_NOTICE}</p>
      {comparison.matchesReconstruction && !comparison.hasUnreadableCandidate ? null : (
        <p role="status" className={styles["warning"]}>
          {[
            comparison.matchesReconstruction ? "" : MISMATCH_NOTICE,
            comparison.hasUnreadableCandidate ? UNREADABLE_NOTICE : "",
          ]
            .filter(Boolean)
            .join(" ")}
        </p>
      )}
      <div className={styles["scrollArea"]}>
        <table className={styles["table"]} aria-label="解決時点の候補">
          <thead>
            <tr>
              <th scope="col">順位</th>
              <th scope="col">ユニット</th>
              <th scope="col">解決時点</th>
              <th scope="col">開始時</th>
              <th scope="col">内訳</th>
            </tr>
          </thead>
          <tbody>
            {comparison.candidates.map((candidate, index) => (
              <CandidateRow
                key={candidate.battleUnitId}
                candidate={candidate}
                rank={candidate.value === undefined ? undefined : index + 1}
                roster={roster}
              />
            ))}
          </tbody>
        </table>
      </div>
      {gap !== undefined && chosen !== undefined ? (
        <p className={styles["gap"]}>
          {`次点との差 ${formatValue(gap.amount)}${
            gap.ratio !== undefined ? `（${(gap.ratio * 100).toFixed(1)}%）` : ""
          } / 次点 ${resolveDisplayName(roster, gap.runnerUpUnitId)}`}
        </p>
      ) : null}
    </section>
  );
}
