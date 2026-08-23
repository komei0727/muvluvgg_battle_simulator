// 統計実行を評価APIの1リクエスト上限へ収まるチャンクへ割り、応答を1つの標本へ積む
// 純関数。分割規約の正本は `tools/exercise-lab/src/exercise_lab/runner.py` であり、
// 同じseed・同じ編成・同じ実行回数なら exercise-lab とUIが同じ数値を出す。
//
// サーバーは1リクエストの中で `runIndex` を0から振り直して乱数列を決める
// （`apps/api/src/infrastructure/random/seeded-random-source.ts`）。したがって同じseedの
// まま分割すると全チャンクがまったく同じ試行を繰り返す。チャンクごとに通し試行番号
// （`runOffset`）を埋めた別のseed文字列を送ることで重複を避ける。この規約の帰結として、
// 実行を再現する鍵はseed単独ではなく（seed, チャンクサイズ, 実行回数）の3つになる。
import type { TacticalExerciseCandidateEvaluationResponse } from "../../shared/api/api-contract.js";
import type { ExerciseStatisticsSample } from "../exercise-stats/types.js";

/**
 * 1リクエストへ載せる試行数。サーバーの `EVALUATION_MAX_TOTAL_RUNS` の既定値と同じで、
 * 候補が常に1件なので総試行数の上限がそのままチャンクサイズになる。
 */
export const EVALUATION_CHUNK_SIZE = 300;

export interface EvaluationChunkPlan {
  readonly index: number;
  /** 送信するseed。`<baseSeed>#<runOffset>`。 */
  readonly seed: string;
  readonly runs: number;
  /** このチャンクの先頭が全体で何試行目か。 */
  readonly runOffset: number;
}

export interface PlanEvaluationChunksInput {
  readonly totalRuns: number;
  readonly baseSeed: string;
  readonly chunkSize?: number;
}

export function planEvaluationChunks({
  totalRuns,
  baseSeed,
  chunkSize = EVALUATION_CHUNK_SIZE,
}: PlanEvaluationChunksInput): readonly EvaluationChunkPlan[] {
  if (!Number.isInteger(totalRuns) || totalRuns <= 0) {
    throw new RangeError(`totalRuns must be a positive integer, received ${totalRuns.toString()}.`);
  }
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError(`chunkSize must be a positive integer, received ${chunkSize.toString()}.`);
  }

  const chunks: EvaluationChunkPlan[] = [];
  for (let runOffset = 0; runOffset < totalRuns; runOffset += chunkSize) {
    chunks.push({
      index: chunks.length,
      seed: `${baseSeed}#${runOffset.toString()}`,
      runs: Math.min(chunkSize, totalRuns - runOffset),
      runOffset,
    });
  }
  return chunks;
}

/** 自動生成するseedの長さ（16進の桁数）。実行の再現キーとして控えられる長さに留める。 */
const GENERATED_SEED_HEX_DIGITS = 12;

/**
 * seed未入力のときに使う実行seed。サーバー生成（Q-TEX-17）には任せられない —— seedは
 * チャンクごとに`#<runOffset>`を足して送る必要があり、サーバーがチャンクごとに別のseedを
 * 生成すると分割が再現できなくなる。
 */
export function generateEvaluationSeed(): string {
  const bytes = new Uint8Array(GENERATED_SEED_HEX_DIGITS / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface EvaluationChunkResult {
  readonly plan: EvaluationChunkPlan;
  readonly candidate: TacticalExerciseCandidateEvaluationResponse;
  readonly catalogRevision: string;
}

/**
 * 1試行がどのチャンクの何試行目だったか。`runs.csv`（`tools/exercise-lab`）の
 * `chunk_index`／`chunk_seed`／`run_index_in_chunk`にあたる。連結後の標本からは
 * 復元できない —— 期限到達の部分結果があるとチャンクの境界が要求試行数と揃わない。
 */
export interface EvaluationRunProvenance {
  readonly chunkIndex: number;
  readonly chunkSeed: string;
  readonly runIndexInChunk: number;
}

export interface EvaluationAggregate {
  /**
   * 送信したチャンクの試行数の合計。中断で送らなかったチャンクは数えないため、これは
   * **利用者が入力した実行回数ではない**。要求と実績の差を出す側は、実行回数を持っている
   * `StatisticsRunProgress.requestedRuns` を使う —— ここを「要求」として読むと、中断した
   * 実行が「要求どおり完走した」ことになる。
   */
  readonly sentRuns: number;
  readonly completedRuns: number;
  readonly catalogRevision: string;
  readonly sample: ExerciseStatisticsSample;
  /**
   * 実際に送ったチャンクの最大試行数。実行を再現する鍵はseed単独ではなく
   * （seed, チャンクサイズ, 実行回数）の3つなので、結果と一緒に残す。
   */
  readonly chunkSize: number;
  /** 試行ごとの出所。`sample`の各配列と同じ添字で同じ試行を指す。 */
  readonly runs: readonly EvaluationRunProvenance[];
}

export type EvaluationMergeResult =
  | { readonly ok: true; readonly aggregate: EvaluationAggregate }
  | {
      readonly ok: false;
      readonly reason: "CATALOG_REVISION_CHANGED";
      readonly catalogRevision: string;
      readonly chunkCatalogRevision: string;
    }
  | {
      readonly ok: false;
      readonly reason: "UNIT_COLUMN_COUNT_CHANGED";
      readonly unitCount: number;
      readonly chunkUnitCount: number;
    };

/**
 * このチャンクが返したユニット別配列の列数。1試行も完了しなかったチャンクは列数を
 * 決められないため`undefined`——列数の突き合わせから外す（`response-validator.ts`は
 * 1レスポンス内の列数一致を既に保証している）。
 */
function unitCountOf(candidate: TacticalExerciseCandidateEvaluationResponse): number | undefined {
  return candidate.allyUnitDamageTotals[0]?.length;
}

/**
 * チャンクの応答を送信順に連結する。
 *
 * 部分結果（`completedRuns`が要求未満）は再試行せず、短い標本のままにする。再送しても
 * 同じseedで同じ試行をやり直すことになり、期限に間に合わなかった原因も変わらないため
 * 同じところで切れる。統計は`completedRuns`ではなく配列長から出る（`exercise-stats`）。
 *
 * チャンクの間でCatalogが切り替わると、前半と後半が別の定義で回った標本になる。混ぜた
 * 平均には意味が無いので集約せず、不一致として返す。
 */
export function mergeEvaluationChunks(
  chunks: readonly EvaluationChunkResult[],
): EvaluationMergeResult {
  const first = chunks[0];
  if (first === undefined) {
    throw new RangeError("mergeEvaluationChunks requires at least one chunk result.");
  }

  const { catalogRevision } = first;
  const mismatched = chunks.find((chunk) => chunk.catalogRevision !== catalogRevision);
  if (mismatched !== undefined) {
    return {
      ok: false,
      reason: "CATALOG_REVISION_CHANGED",
      catalogRevision,
      chunkCatalogRevision: mismatched.catalogRevision,
    };
  }

  const candidates = chunks.map((chunk) => chunk.candidate);
  // 1レスポンス内の列数一致は`response-validator.ts`が見るが、チャンクをまたいだ一致は
  // ここでしか見ていない。崩れたまま連結すると、統計側（`unit-statistics.ts`）が描画の
  // 直前にthrowする——サーバー側の契約違反が、表示の不具合として遅れて出ることになる。
  const unitCounts = candidates.map(unitCountOf).filter((count) => count !== undefined);
  const unitCount = unitCounts[0];
  const differing = unitCounts.find((count) => count !== unitCount);
  if (unitCount !== undefined && differing !== undefined) {
    return {
      ok: false,
      reason: "UNIT_COLUMN_COUNT_CHANGED",
      unitCount,
      chunkUnitCount: differing,
    };
  }

  const sample: ExerciseStatisticsSample = {
    scores: candidates.flatMap((candidate) => [...candidate.scores]),
    breakCounts: candidates.flatMap((candidate) => [...candidate.breakCounts]),
    completedTurns: candidates.flatMap((candidate) => [...candidate.completedTurns]),
    completionReasons: candidates.flatMap((candidate) => [...candidate.completionReasons]),
    allyUnitDamageTotals: candidates.flatMap((candidate) => [...candidate.allyUnitDamageTotals]),
    allyUnitBreakCounts: candidates.flatMap((candidate) => [...candidate.allyUnitBreakCounts]),
  };

  return {
    ok: true,
    aggregate: {
      sentRuns: chunks.reduce((total, chunk) => total + chunk.plan.runs, 0),
      completedRuns: sample.scores.length,
      catalogRevision,
      sample,
      chunkSize: Math.max(...chunks.map((chunk) => chunk.plan.runs)),
      runs: chunks.flatMap((chunk) =>
        chunk.candidate.scores.map((_score, runIndexInChunk) => ({
          chunkIndex: chunk.plan.index,
          chunkSeed: chunk.plan.seed,
          runIndexInChunk,
        })),
      ),
    },
  };
}
