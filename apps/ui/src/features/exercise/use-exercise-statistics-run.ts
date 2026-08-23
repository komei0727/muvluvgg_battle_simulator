import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  buildTacticalExerciseEvaluationRequest,
  evaluationFormationSignature,
} from "./exercise-request-mapper.js";
import type { BattleDraft } from "../../entities/battle-draft.js";
import type {
  TacticalExerciseEvaluationApiResult,
  TacticalExerciseEvaluationRequest,
  UiApiError,
  ViolationResponseBody,
} from "../../shared/api/api-contract.js";
import {
  EVALUATION_CHUNK_SIZE,
  generateEvaluationSeed,
  mergeEvaluationChunks,
  planEvaluationChunks,
} from "./evaluation-chunk-plan.js";
import type {
  EvaluationAggregate,
  EvaluationChunkResult,
  EvaluationMergeResult,
} from "./evaluation-chunk-plan.js";
import { evaluateTacticalExercise as defaultEvaluate } from "../../shared/api/api-client.js";
import type { SimulateOptions } from "../../shared/api/api-client.js";
import { ERROR_KIND_GUIDANCE } from "../simulation/error-guidance.js";

// 統計実行の実行経路。指定回数を評価APIの1リクエスト上限（`EVALUATION_CHUNK_SIZE`）へ
// 割り、1リクエストずつ直列に送る。同時に複数投げないのは、サーバーが1リクエストを
// Worker Pool へ `maxScale: 1` で流す（`11_インフラストラクチャ設計.md`）ため、
// 並列化しても総所要時間は縮まず順番待ちの塊が増えるだけだからである。
//
// 自動retryはしない。戦闘は冪等ではなく、期限到達の部分結果（Q-TEX-18）を同じseedで
// 送り直しても同じところで切れる（`runner.py`と同じ方針）。

export interface StatisticsRunProgress {
  /** 利用者が指定した総試行数。 */
  readonly requestedRuns: number;
  readonly completedRuns: number;
  readonly completedChunks: number;
  readonly chunkCount: number;
}

/**
 * 実行を止めた理由。`UiApiError`をそのまま出さないのは、統計実行だけが持つ止まり方
 * （設定で閉じている・チャンク間のCatalog切替・1試行も完了しない）が、単発の
 * HTTP失敗とは別の案内を要するためである。
 */
export type ExerciseStatisticsRunError =
  | { readonly kind: "ENDPOINT_DISABLED" }
  | { readonly kind: "RATE_LIMITED"; readonly retryAfterSeconds?: number }
  | {
      readonly kind: "CATALOG_REVISION_CHANGED";
      readonly catalogRevision: string;
      readonly chunkCatalogRevision: string;
    }
  | {
      readonly kind: "UNIT_COLUMN_COUNT_CHANGED";
      readonly unitCount: number;
      readonly chunkUnitCount: number;
    }
  | {
      readonly kind: "SEED_NOT_ECHOED";
      readonly requestedSeed: string;
      readonly respondedSeed: string;
    }
  | { readonly kind: "NO_COMPLETED_RUNS" }
  | { readonly kind: "REQUEST_NOT_BUILDABLE" }
  | { readonly kind: "API"; readonly error: UiApiError };

/**
 * 送信時のslot対応表と編成の署名。422 violationsのJSON Pointerを送信後に編集され得る
 * 現在のdraftではなく送信時のslotへ対応づけ（`UI-API-004`）、実行後に編成が変わったことを
 * 結果表示へ伝えるために持つ。全チャンクが同じ編成を送るので実行ごとに1つでよい。
 */
export interface StatisticsRunSubmission {
  readonly allyUnitSlotKeys: readonly string[];
  readonly enemyUnitSlotKeys: readonly string[];
  readonly allyMemorySlotKeys: readonly string[];
  readonly enemyMemorySlotKeys: readonly string[];
  readonly allyGearSlotIndices: readonly (readonly number[])[];
  readonly enemyGearSlotIndices: readonly (readonly number[])[];
  /**
   * 送信した味方編成のユニット定義ID。応答の`allyUnit*`の列と同じ並びであり、列に
   * 名前を付けられる唯一の材料である。実行後もdraftは編集できるので、表示のたびに
   * 現在の編成から引くと別のユニット名が列へ付く。
   */
  readonly allyUnitDefinitionIds: readonly string[];
  /**
   * 送信した編成部分のJSON表現。実行回数とシードは結果表示に出ているため含めない ——
   * 画面から読み取れない編成の変化だけをここで見る。
   */
  readonly formationSignature: string;
}

export type ExerciseStatisticsRunState =
  | { readonly status: "idle" }
  | {
      readonly status: "running";
      readonly runId: string;
      readonly seed: string;
      readonly progress: StatisticsRunProgress;
      readonly submission: StatisticsRunSubmission;
    }
  | {
      readonly status: "succeeded";
      readonly runId: string;
      readonly seed: string;
      readonly progress: StatisticsRunProgress;
      readonly submission: StatisticsRunSubmission;
      readonly aggregate: EvaluationAggregate;
    }
  | {
      readonly status: "cancelled";
      readonly runId: string;
      readonly seed: string;
      readonly progress: StatisticsRunProgress;
      readonly submission: StatisticsRunSubmission;
      readonly aggregate: EvaluationAggregate;
    }
  | {
      readonly status: "failed";
      readonly runId: string;
      readonly seed: string;
      readonly progress: StatisticsRunProgress;
      readonly submission: StatisticsRunSubmission;
      readonly error: ExerciseStatisticsRunError;
    };

type StatisticsRunAction =
  | {
      readonly type: "runStarted";
      readonly runId: string;
      readonly seed: string;
      readonly progress: StatisticsRunProgress;
      readonly submission: StatisticsRunSubmission;
    }
  | {
      readonly type: "chunkCompleted";
      readonly runId: string;
      readonly progress: StatisticsRunProgress;
    }
  | {
      readonly type: "runFinished";
      readonly runId: string;
      readonly status: "succeeded" | "cancelled";
      readonly aggregate: EvaluationAggregate;
    }
  | {
      readonly type: "runFailed";
      readonly runId: string;
      readonly error: ExerciseStatisticsRunError;
    };

function createInitialState(): ExerciseStatisticsRunState {
  return { status: "idle" };
}

// 実行中のrunIdと一致しないactionは捨てる。中断・再実行の直後に前の実行の応答が
// 届いても、最新の実行のstateを上書きさせない（`execution-reducer.ts`と同じ規約）。
function statisticsRunReducer(
  state: ExerciseStatisticsRunState,
  action: StatisticsRunAction,
): ExerciseStatisticsRunState {
  if (action.type === "runStarted") {
    return {
      status: "running",
      runId: action.runId,
      seed: action.seed,
      progress: action.progress,
      submission: action.submission,
    };
  }
  if (state.status !== "running" || state.runId !== action.runId) {
    return state;
  }
  switch (action.type) {
    case "chunkCompleted":
      return { ...state, progress: action.progress };
    case "runFinished":
      return {
        status: action.status,
        runId: state.runId,
        seed: state.seed,
        progress: state.progress,
        submission: state.submission,
        aggregate: action.aggregate,
      };
    case "runFailed":
      return {
        status: "failed",
        runId: state.runId,
        seed: state.seed,
        progress: state.progress,
        submission: state.submission,
        error: action.error,
      };
  }
}

export type EvaluateFn = (
  request: TacticalExerciseEvaluationRequest,
  options: SimulateOptions,
) => Promise<TacticalExerciseEvaluationApiResult>;

export interface UseExerciseStatisticsRunOptions {
  readonly evaluateImpl?: EvaluateFn;
  readonly timeoutMs?: number;
  readonly chunkSize?: number;
}

export interface StatisticsRunInput {
  readonly draft: BattleDraft;
  readonly runCount: number;
  /** 空白のみは未入力として扱い、自動生成した実行seedを使う。 */
  readonly seed: string;
}

export interface UseExerciseStatisticsRunResult {
  readonly state: ExerciseStatisticsRunState;
  readonly start: (input: StatisticsRunInput) => void;
  readonly cancel: () => void;
}

/** 編成からリクエストを組み立てられなかった実行。対応づける送信そのものが無い。 */
const EMPTY_SUBMISSION: StatisticsRunSubmission = {
  allyUnitSlotKeys: [],
  enemyUnitSlotKeys: [],
  allyMemorySlotKeys: [],
  enemyMemorySlotKeys: [],
  allyGearSlotIndices: [],
  enemyGearSlotIndices: [],
  allyUnitDefinitionIds: [],
  formationSignature: "",
};

let runCounter = 0;
function generateRunId(): string {
  runCounter += 1;
  return `stats-${Date.now().toString()}-${runCounter.toString()}`;
}

function generateRequestId(): string | undefined {
  try {
    return `ui-${crypto.randomUUID()}`;
  } catch {
    return undefined;
  }
}

// 404 `ENDPOINT_DISABLED` は実装が無いのではなく配備の設定で閉じている（Q-TEX-19）。
// 汎用のサーバーエラーとして出すと、パスやバージョンの取り違えを疑わせてしまう。
//
// 判定に使うのは`code`だけである。statusで判定すると、`VITE_API_BASE_URL`の設定ミスや
// プロキシのパス取り違えによる404まで「この環境では統計実行を利用できません（単一実行は
// 使えます）」と案内してしまう——単一実行も同じ理由で動かない状況である。
function classifyFailure(result: {
  readonly error: UiApiError;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
}): ExerciseStatisticsRunError {
  if (result.error.code === "ENDPOINT_DISABLED") {
    return { kind: "ENDPOINT_DISABLED" };
  }
  if (result.error.kind === "RATE_LIMIT") {
    const retryAfterSeconds = result.retryAfterSeconds ?? result.error.retryAfterSeconds;
    return {
      kind: "RATE_LIMITED",
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
  }
  return { kind: "API", error: result.error };
}

export interface StatisticsRunErrorView {
  /** 種別ごとの案内。`03_API・データ連携設計.md` §13。 */
  readonly guidance: string;
  /** サーバー・クライアントの生message。案内の下へそのままtextとして出す。 */
  readonly detail?: string;
  readonly violations?: readonly ViolationResponseBody[];
  readonly diagnosticId?: string;
}

export function describeStatisticsRunError(
  error: ExerciseStatisticsRunError,
): StatisticsRunErrorView {
  switch (error.kind) {
    case "ENDPOINT_DISABLED":
      return { guidance: "この環境では統計実行を利用できません。単一実行はそのまま使えます。" };
    case "RATE_LIMITED":
      return {
        guidance:
          error.retryAfterSeconds === undefined
            ? "実行が制限されました。時間をおいて再実行してください。"
            : `実行が制限されました。約${error.retryAfterSeconds.toString()}秒おいて再実行してください。`,
      };
    case "CATALOG_REVISION_CHANGED":
      return {
        guidance: `実行中にCatalogが${error.catalogRevision}から${error.chunkCatalogRevision}へ切り替わりました。同じ条件で実行し直してください。`,
      };
    case "UNIT_COLUMN_COUNT_CHANGED":
      return {
        guidance: `実行中にユニット別集計の列数が${error.unitCount.toString()}から${error.chunkUnitCount.toString()}へ変わりました。結果を集計できません。`,
      };
    case "SEED_NOT_ECHOED":
      return {
        guidance: `サーバーが要求したseed（${error.requestedSeed}）ではなく${error.respondedSeed}で実行しました。試行が重複している可能性があるため結果を集計できません。`,
      };
    case "NO_COMPLETED_RUNS":
      return { guidance: "1試行も完了しなかったため、統計を出せません。" };
    case "REQUEST_NOT_BUILDABLE":
      return { guidance: "編成からリクエストを組み立てられませんでした。編成を確認してください。" };
    case "API":
      // 種別ごとの案内は単一実行（`SubmissionFeedback`）と同じ表から採り、サーバーの生
      // messageは案内の下へ添える。生messageだけだと英文が1行出るだけになる。
      return {
        guidance: ERROR_KIND_GUIDANCE[error.error.kind],
        detail: error.error.message,
        ...(error.error.violations !== undefined ? { violations: error.error.violations } : {}),
        ...(error.error.diagnosticId !== undefined
          ? { diagnosticId: error.error.diagnosticId }
          : {}),
      };
  }
}

/**
 * 完了した統計実行の集約。成功と中断で表示するものは変わらない（中断は「完了済み
 * チャンクまでで確定した結果」であり、失敗ではない）ため、両方から同じ形で取り出す。
 */
export function selectStatisticsAggregate(
  state: ExerciseStatisticsRunState,
): EvaluationAggregate | undefined {
  return state.status === "succeeded" || state.status === "cancelled" ? state.aggregate : undefined;
}

export function useExerciseStatisticsRun(
  baseUrl: string,
  options: UseExerciseStatisticsRunOptions = {},
): UseExerciseStatisticsRunResult {
  const { evaluateImpl = defaultEvaluate, timeoutMs, chunkSize = EVALUATION_CHUNK_SIZE } = options;
  const [state, dispatch] = useReducer(statisticsRunReducer, undefined, createInitialState);
  const abortControllerRef = useRef<AbortController | null>(null);
  const currentRunIdRef = useRef<string | null>(null);

  const start = useCallback(
    (input: StatisticsRunInput) => {
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const runId = generateRunId();
      currentRunIdRef.current = runId;

      const trimmedSeed = input.seed.trim();
      const seed = trimmedSeed === "" ? generateEvaluationSeed() : trimmedSeed;
      const chunks = planEvaluationChunks({
        totalRuns: input.runCount,
        baseSeed: seed,
        chunkSize,
      });
      // 編成部分は全チャンクで同一である。1度だけ組み立てて試行数とseedだけ差し替える
      // ことで、チャンクごとに違う編成が送られる余地を残さない。
      const build = buildTacticalExerciseEvaluationRequest(input.draft, {
        runsPerCandidate: chunks[0]?.runs ?? input.runCount,
        seed,
      });
      const submission: StatisticsRunSubmission = build.ok
        ? {
            allyUnitSlotKeys: build.allyUnitSlotKeys,
            enemyUnitSlotKeys: build.enemyUnitSlotKeys,
            allyMemorySlotKeys: build.allyMemorySlotKeys,
            enemyMemorySlotKeys: build.enemyMemorySlotKeys,
            allyGearSlotIndices: build.allyGearSlotIndices,
            enemyGearSlotIndices: build.enemyGearSlotIndices,
            allyUnitDefinitionIds: (build.request.candidates[0]?.allyFormation.units ?? []).map(
              (unit) => unit.unitDefinitionId,
            ),
            formationSignature: evaluationFormationSignature(build.request),
          }
        : EMPTY_SUBMISSION;
      let progress: StatisticsRunProgress = {
        requestedRuns: input.runCount,
        completedRuns: 0,
        completedChunks: 0,
        chunkCount: chunks.length,
      };
      dispatch({ type: "runStarted", runId, seed, progress, submission });

      if (!build.ok) {
        dispatch({ type: "runFailed", runId, error: { kind: "REQUEST_NOT_BUILDABLE" } });
        return;
      }
      const { request } = build;

      const isCurrent = () => currentRunIdRef.current === runId;

      const failWithMerge = (merged: EvaluationMergeResult & { ok: false }): void => {
        dispatch({
          type: "runFailed",
          runId,
          error:
            merged.reason === "CATALOG_REVISION_CHANGED"
              ? {
                  kind: "CATALOG_REVISION_CHANGED",
                  catalogRevision: merged.catalogRevision,
                  chunkCatalogRevision: merged.chunkCatalogRevision,
                }
              : {
                  kind: "UNIT_COLUMN_COUNT_CHANGED",
                  unitCount: merged.unitCount,
                  chunkUnitCount: merged.chunkUnitCount,
                },
        });
      };

      const finish = (results: readonly EvaluationChunkResult[], cancelled: boolean): void => {
        if (!isCurrent()) {
          return;
        }
        if (results.length === 0) {
          dispatch({ type: "runFailed", runId, error: { kind: "NO_COMPLETED_RUNS" } });
          return;
        }
        const merged = mergeEvaluationChunks(results);
        if (!merged.ok) {
          failWithMerge(merged);
          return;
        }
        if (merged.aggregate.completedRuns === 0) {
          dispatch({ type: "runFailed", runId, error: { kind: "NO_COMPLETED_RUNS" } });
          return;
        }
        dispatch({
          type: "runFinished",
          runId,
          status: cancelled ? "cancelled" : "succeeded",
          aggregate: merged.aggregate,
        });
      };

      void (async () => {
        const results: EvaluationChunkResult[] = [];
        for (const chunk of chunks) {
          // 中断がチャンクの切れ目に入った場合、次を送らずここで確定する。
          if (controller.signal.aborted) {
            finish(results, true);
            return;
          }
          const requestId = generateRequestId();
          const result = await evaluateImpl(
            { ...request, runsPerCandidate: chunk.runs, seed: chunk.seed },
            {
              baseUrl,
              signal: controller.signal,
              ...(requestId !== undefined ? { requestId } : {}),
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            },
          );
          if (!isCurrent()) {
            return;
          }
          if (!result.ok) {
            if (result.error.kind === "CANCELLED") {
              finish(results, true);
              return;
            }
            dispatch({ type: "runFailed", runId, error: classifyFailure(result) });
            return;
          }
          // 応答の`seed`は「実際に使われたseed」（`10_API設計.md`）であり、`#<runOffset>`
          // 規約が効いているかを判定できる唯一の材料である。食い違いを通すと、全チャンクが
          // 同じ試行を繰り返していても数値が揃って見えるだけで気づけない。
          if (result.response.seed !== chunk.seed) {
            dispatch({
              type: "runFailed",
              runId,
              error: {
                kind: "SEED_NOT_ECHOED",
                requestedSeed: chunk.seed,
                respondedSeed: result.response.seed,
              },
            });
            return;
          }
          const candidate = result.response.candidates[0];
          if (candidate === undefined) {
            dispatch({
              type: "runFailed",
              runId,
              error: {
                kind: "API",
                error: {
                  kind: "RESPONSE_CONTRACT_MISMATCH",
                  message: "Tactical exercise evaluation response carried no candidate.",
                },
              },
            });
            return;
          }
          results.push({
            plan: chunk,
            candidate,
            catalogRevision: result.response.catalogRevision,
          });
          const merged = mergeEvaluationChunks(results);
          if (!merged.ok) {
            failWithMerge(merged);
            return;
          }
          progress = {
            ...progress,
            completedRuns: merged.aggregate.completedRuns,
            completedChunks: results.length,
          };
          dispatch({ type: "chunkCompleted", runId, progress });
        }
        finish(results, false);
      })();
    },
    [baseUrl, evaluateImpl, timeoutMs, chunkSize],
  );

  const cancel = useCallback(() => {
    // 単一実行（`use-simulation-execution.ts`）と違い、ここでは同期的に`cancelled`へ
    // 遷移させない。中断の結果は「完了済みチャンクまでの集約」であり、それを確定できるのは
    // チャンクを積んでいる実行ループだけである。ループはabortで解決した応答（CANCELLED）と
    // チャンクの切れ目の`signal.aborted`の両方で確定へ入り、待ち時間は`api-client`の
    // 待機上限（35秒）で頭打ちになる。
    abortControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    // 実行中のチャンクをタブを閉じた後まで走らせない（03_API・データ連携設計.md §7）。
    const handleUnload = () => {
      abortControllerRef.current?.abort();
    };
    window.addEventListener("beforeunload", handleUnload);
    return () => {
      window.removeEventListener("beforeunload", handleUnload);
      // unmount後に届いた応答をdispatchしないよう、runIdごと切り離す。
      currentRunIdRef.current = null;
      abortControllerRef.current?.abort();
    };
  }, []);

  return { state, start, cancel };
}
