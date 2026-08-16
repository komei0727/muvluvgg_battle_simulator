import type { Violation } from "../contracts/application-error.js";
import { validateFormationShape, type FormationInput } from "./simulate-battle-command.js";
import { validateExerciseEnemyFormationShape } from "./simulate-tactical-exercise-command.js";

/**
 * 評価対象の編成1件。敵編成はリクエスト全体で1つを共有するため、候補は味方編成
 * だけを持つ——同じ敵に対する候補同士を比較するのが一括評価の目的である。
 */
export interface TacticalExerciseCandidateInput {
  readonly allyFormation: FormationInput;
}

/**
 * `09_アプリケーション設計.md`「EvaluateTacticalExerciseCandidatesCommand」。
 * 候補ごとに`runsPerCandidate`回の演習を実行する。`logLevel`は持たない——
 * 返すのはスコアなどの数値だけで、イベント列・状態遷移は返さないためである。
 */
export interface EvaluateTacticalExerciseCandidatesCommand {
  readonly enemyFormation: FormationInput;
  readonly candidates: readonly TacticalExerciseCandidateInput[];
  readonly runsPerCandidate: number;
  /** 省略時はユースケースが生成し、応答へ載せる（再実行で同じ結果を再現できるようにするため）。 */
  readonly seed?: string;
}

/** 1リクエストが要求できる評価の量。設定（`EVALUATION_*`環境変数）から渡る。 */
export interface EvaluationLimits {
  readonly maxCandidates: number;
  readonly maxTotalRuns: number;
}

/**
 * `maxTotalRuns`の既定値は実測から決めた: 5対1の演習1回が50〜70ms（production
 * Catalogの演習敵4体で計測）であり、`SIMULATION_TIMEOUT_MS`（30秒）の7割に最も遅い
 * 敵で約300回収まる。これを超える要求は期限到達で部分結果になるだけなので、
 * 上限は「返せる見込みのある量」に置く。
 */
export const DEFAULT_EVALUATION_LIMITS: EvaluationLimits = {
  maxCandidates: 32,
  maxTotalRuns: 300,
};

/**
 * Command検証。編成の形（R-FRM-01～05、R-ENH-01）と敵編成規則（R-TEX-01 #3）は
 * 単発の演習と同じ規則を共有し、ここでは評価量の上限だけを追加で判定する。
 * 違反はすべて`INVALID_COMMAND`（422）としてまとめて返し、Catalogへは触れない。
 */
export function validateEvaluateTacticalExerciseCandidatesCommandShape(
  command: EvaluateTacticalExerciseCandidatesCommand,
  limits: EvaluationLimits,
): Violation[] {
  const violations: Violation[] = [];

  if (command.candidates.length < 1) {
    violations.push({
      path: "candidates",
      reason: "must contain at least 1 candidate",
    });
  }

  if (command.candidates.length > limits.maxCandidates) {
    violations.push({
      path: "candidates",
      reason: `must not contain more than ${limits.maxCandidates} candidates, got ${command.candidates.length}`,
    });
  }

  if (!Number.isInteger(command.runsPerCandidate) || command.runsPerCandidate < 1) {
    violations.push({
      path: "runsPerCandidate",
      reason: `must be an integer of at least 1, got ${command.runsPerCandidate}`,
    });
  } else if (command.candidates.length * command.runsPerCandidate > limits.maxTotalRuns) {
    // 個々の値が範囲内でも積が実行予算を超え得るため、両者を通ったあとで総量を見る。
    violations.push({
      path: "runsPerCandidate",
      reason: `candidates x runsPerCandidate must not exceed ${limits.maxTotalRuns} total runs, got ${command.candidates.length * command.runsPerCandidate}`,
    });
  }

  command.candidates.forEach((candidate, index) => {
    violations.push(
      ...validateFormationShape(candidate.allyFormation, `candidates[${index}].allyFormation`),
    );
  });

  violations.push(...validateExerciseEnemyFormationShape(command.enemyFormation, "enemyFormation"));

  if (command.seed !== undefined && command.seed.trim() === "") {
    violations.push({
      path: "seed",
      reason: "must not be blank",
    });
  }

  return violations;
}
