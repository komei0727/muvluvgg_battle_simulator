import { ApplicationError } from "../contracts/application-error.js";
import type { Clock } from "../../domain/ports/clock.js";

/** 大量試行の1ケース分の計画。`runIndices`はリクエストの順のまま渡す。 */
export interface EvaluationCasePlan {
  readonly caseId: string;
  readonly runIndices: readonly number[];
}

export interface CompletedEvaluationRun<R> {
  readonly runIndex: number;
  readonly result: R;
}

export interface EvaluationCaseOutcome<R> {
  readonly caseId: string;
  /** 完了した試行だけ。リクエストの`runIndices`の順に並ぶ。 */
  readonly runs: readonly CompletedEvaluationRun<R>[];
  /** 期限までに完了しなかった試行番号。リクエストの順のまま、詰めて採番し直さない。 */
  readonly incompleteRunIndices: readonly number[];
}

export interface EvaluationScheduleOutcome<R> {
  readonly requestedRuns: number;
  readonly completedRuns: number;
  readonly partial: boolean;
  /** リクエストのケース順。 */
  readonly cases: readonly EvaluationCaseOutcome<R>[];
}

export interface EvaluationScheduleOptions<C extends EvaluationCasePlan, R> {
  readonly clock: Clock;
  readonly deadlineEpochMs: number;
  /** 1試行を実行する。完了結果の値はスケジュール（実行順）に依存させてはならない。 */
  readonly runTrial: (plan: C, runIndex: number) => R;
}

/**
 * 大量試行APIの共通実行部。試行の並び・期限・完了／未完了の整理だけを持ち、スコア・
 * 目的関数・戦闘形式固有のルールを持たない。
 *
 * ケースを順番に1試行ずつ進める（ラウンドロビン）。1ケースへ先に全試行を配ると、期限で
 * 打ち切られたときに後方のケースが1件も観測されず、ケース間を比べられないためである。
 * 期限は試行の境界で確認し、試行がターン境界で`EXECUTION_TIMEOUT`に達した場合も
 * その試行を未完了として扱う。どちらも以降の試行を始めない — 途中で尽きた試行を
 * 敗北などの結果として記録しない。
 */
export function runEvaluationSchedule<C extends EvaluationCasePlan, R>(
  cases: readonly C[],
  options: EvaluationScheduleOptions<C, R>,
): EvaluationScheduleOutcome<R> {
  const completed = cases.map(() => new Map<number, R>());
  const roundCount = Math.max(0, ...cases.map((plan) => plan.runIndices.length));
  let stopped = false;

  for (let round = 0; round < roundCount && !stopped; round++) {
    for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
      const plan = cases[caseIndex]!;
      if (round >= plan.runIndices.length) {
        continue;
      }
      if (options.clock.now() >= options.deadlineEpochMs) {
        stopped = true;
        break;
      }
      const runIndex = plan.runIndices[round]!;
      try {
        completed[caseIndex]!.set(runIndex, options.runTrial(plan, runIndex));
      } catch (error) {
        if (error instanceof ApplicationError && error.code === "EXECUTION_TIMEOUT") {
          stopped = true;
          break;
        }
        throw error;
      }
    }
  }

  const caseOutcomes = cases.map((plan, caseIndex): EvaluationCaseOutcome<R> => {
    const results = completed[caseIndex]!;
    return {
      caseId: plan.caseId,
      runs: plan.runIndices
        .filter((runIndex) => results.has(runIndex))
        .map((runIndex) => ({ runIndex, result: results.get(runIndex)! })),
      incompleteRunIndices: plan.runIndices.filter((runIndex) => !results.has(runIndex)),
    };
  });
  const requestedRuns = cases.reduce((total, plan) => total + plan.runIndices.length, 0);
  const completedRuns = caseOutcomes.reduce((total, outcome) => total + outcome.runs.length, 0);

  return {
    requestedRuns,
    completedRuns,
    partial: completedRuns < requestedRuns,
    cases: caseOutcomes,
  };
}
