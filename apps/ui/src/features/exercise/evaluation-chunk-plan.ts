// 統計実行を評価APIの1リクエスト上限へ収まるチャンクへ割り、応答の試行レコードを1つの
// 標本へ積む純関数。分割規約の正本はこの module と `docs/ui-design/03_API・データ連携設計.md`
// §2.6 である。
//
// サーバーは試行の乱数列を`(seed, runIndex)`だけから決める（`10_API設計.md`「戦術演習を
// 大量試行する」）。したがって全チャンクが同じseedを送り、チャンクごとに全体の通し試行番号の
// 区間を`runIndices`として送る。同じseed・同じ編成・同じ実行回数なら、チャンクサイズを
// 変えても同じ試行番号は同じ観測値になる。
import type {
  TacticalExerciseEvaluationResponse,
  TacticalExerciseEvaluationRunResponse,
} from "../../shared/api/api-contract.js";
import type { ExerciseStatisticsSample } from "../exercise-stats/types.js";

/**
 * 1リクエストへ載せる試行数。サーバーの `TACTICAL_EXERCISE_EVALUATION_MAX_TOTAL_RUNS` の
 * 既定値と同じで、ケースが常に1件なので総試行数の上限がそのままチャンクサイズになる。
 */
export const EVALUATION_CHUNK_SIZE = 300;

export interface EvaluationChunkPlan {
  readonly index: number;
  /** このチャンクで送る全体の通し試行番号。昇順の連続区間である。 */
  readonly runIndices: readonly number[];
}

export interface PlanEvaluationChunksInput {
  readonly totalRuns: number;
  readonly chunkSize?: number;
}

export function planEvaluationChunks({
  totalRuns,
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
    const runs = Math.min(chunkSize, totalRuns - runOffset);
    chunks.push({
      index: chunks.length,
      runIndices: Array.from({ length: runs }, (_value, position) => runOffset + position),
    });
  }
  return chunks;
}

/** 自動生成するseedの長さ（16進の桁数）。実行の再現キーとして控えられる長さに留める。 */
const GENERATED_SEED_HEX_DIGITS = 12;

/**
 * seed未入力のときに使う実行seed。評価APIはseedを必須とし、サーバーは生成しない。
 * 全チャンクが同じ値を送る必要があるため、実行の開始時に1度だけ決める。
 */
export function generateEvaluationSeed(): string {
  const bytes = new Uint8Array(GENERATED_SEED_HEX_DIGITS / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface EvaluationChunkResult {
  readonly plan: EvaluationChunkPlan;
  readonly response: TacticalExerciseEvaluationResponse;
}

/**
 * 1試行の出所。生データCSV（`statistics-export.ts`）の`run_index`／`chunk_index`に
 * あたる。`runIndex`はseedと組で試行を再現する鍵であり、連結後の標本の位置とは一致しない
 * —— 期限到達の部分結果があると、未完了の番号が抜けるためである。
 */
export interface EvaluationRunProvenance {
  readonly runIndex: number;
  readonly chunkIndex: number;
}

/** 集約が混ぜてはならない実行条件。試行の再現はこの3つとseed・試行番号で決まる。 */
export type EvaluationRunConditionField =
  | "catalogRevision"
  | "engineRevision"
  | "seedDerivationVersion";

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
  readonly engineRevision: string;
  readonly seedDerivationVersion: string;
  readonly sample: ExerciseStatisticsSample;
  /** 実際に送ったチャンクの最大試行数。試行番号の割り当ては変えないので再現条件ではない。 */
  readonly chunkSize: number;
  /** 試行ごとの出所。`sample`の各配列と同じ添字で同じ試行を指す。 */
  readonly runs: readonly EvaluationRunProvenance[];
  /**
   * 送ったが期限までに完了しなかった試行番号（昇順）。同じseedでこの番号だけを送り直せば、
   * 欠けた試行を同じ乱数列で補える。統計実行は自動では再送しない。
   */
  readonly incompleteRunIndices: readonly number[];
}

export type EvaluationMergeResult =
  | { readonly ok: true; readonly aggregate: EvaluationAggregate }
  | {
      readonly ok: false;
      readonly reason: "RUN_CONDITIONS_CHANGED";
      readonly field: EvaluationRunConditionField;
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly ok: false;
      readonly reason: "UNIT_COLUMN_COUNT_CHANGED";
      readonly unitCount: number;
      readonly chunkUnitCount: number;
    };

const RUN_CONDITION_FIELDS: readonly EvaluationRunConditionField[] = [
  "catalogRevision",
  "engineRevision",
  "seedDerivationVersion",
];

function runsOf(response: TacticalExerciseEvaluationResponse) {
  return response.cases.flatMap((caseResponse) => caseResponse.runs);
}

/** 味方枠を`unitIndex`順に並べた1試行の与ダメージ。応答検証が0..n-1の連番を保証している。 */
function allyDamageOf(run: TacticalExerciseEvaluationRunResponse): readonly number[] {
  return run.units
    .filter((unit) => unit.side === "ALLY")
    .toSorted((left, right) => left.unitIndex - right.unitIndex)
    .map((unit) => unit.damageDealt);
}

function allyBreaksOf(run: TacticalExerciseEvaluationRunResponse): readonly number[] {
  return run.allyUnitBreaks
    .toSorted((left, right) => left.unitIndex - right.unitIndex)
    .map((entry) => entry.breakCount);
}

/**
 * チャンクの応答を送信順に連結し、試行レコードを統計用の標本へ投影する。
 *
 * 期限到達の部分結果は再送せず、短い標本のままにして未完了番号を残す。統計は
 * `completedRuns`ではなく配列長から出る（`exercise-stats`）。
 *
 * チャンクの間でCatalog・戦闘エンジン・乱数導出規約のいずれかが切り替わると、前半と後半が
 * 別の条件で回った標本になる。混ぜた平均には意味が無いので集約せず、不一致として返す。
 */
export function mergeEvaluationChunks(
  chunks: readonly EvaluationChunkResult[],
): EvaluationMergeResult {
  const first = chunks[0];
  if (first === undefined) {
    throw new RangeError("mergeEvaluationChunks requires at least one chunk result.");
  }

  for (const field of RUN_CONDITION_FIELDS) {
    const expected = first.response[field];
    const mismatched = chunks.find((chunk) => chunk.response[field] !== expected);
    if (mismatched !== undefined) {
      return {
        ok: false,
        reason: "RUN_CONDITIONS_CHANGED",
        field,
        expected,
        actual: mismatched.response[field],
      };
    }
  }

  // 1レスポンス内の枠数一致は`response-validator.ts`が見るが、チャンクをまたいだ一致は
  // ここでしか見ていない。崩れたまま連結すると、統計側（`unit-statistics.ts`）が描画の
  // 直前にthrowする——サーバー側の契約違反が、表示の不具合として遅れて出ることになる。
  const unitCounts = chunks.flatMap((chunk) =>
    runsOf(chunk.response)
      .slice(0, 1)
      .map((run) => run.allyUnitBreaks.length),
  );
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

  const runs = chunks.flatMap((chunk) =>
    runsOf(chunk.response).map((run) => ({ run, chunkIndex: chunk.plan.index })),
  );
  const sample: ExerciseStatisticsSample = {
    scores: runs.map(({ run }) => run.totalScore),
    breakCounts: runs.map(({ run }) => run.breakCount),
    completedTurns: runs.map(({ run }) => run.completedTurn),
    completionReasons: runs.map(({ run }) => run.completionReason),
    allyUnitDamageTotals: runs.map(({ run }) => allyDamageOf(run)),
    allyUnitBreakCounts: runs.map(({ run }) => allyBreaksOf(run)),
  };

  return {
    ok: true,
    aggregate: {
      sentRuns: chunks.reduce((total, chunk) => total + chunk.plan.runIndices.length, 0),
      completedRuns: sample.scores.length,
      catalogRevision: first.response.catalogRevision,
      engineRevision: first.response.engineRevision,
      seedDerivationVersion: first.response.seedDerivationVersion,
      sample,
      chunkSize: Math.max(...chunks.map((chunk) => chunk.plan.runIndices.length)),
      runs: runs.map(({ run, chunkIndex }) => ({ runIndex: run.runIndex, chunkIndex })),
      incompleteRunIndices: chunks
        .flatMap((chunk) =>
          chunk.response.cases.flatMap((caseResponse) => caseResponse.incompleteRunIndices),
        )
        .toSorted((left, right) => left - right),
    },
  };
}
