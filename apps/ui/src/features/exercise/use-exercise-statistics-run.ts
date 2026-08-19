import { useCallback, useEffect, useReducer, useRef } from "react";
import { buildTacticalExerciseEvaluationRequest } from "./exercise-request-mapper.js";
import {
  EVALUATION_CHUNK_SIZE,
  generateEvaluationSeed,
  mergeEvaluationChunks,
  planEvaluationChunks,
} from "./evaluation-chunk-plan.js";
import type { EvaluationAggregate, EvaluationChunkResult } from "./evaluation-chunk-plan.js";
import type { TacticalExerciseEvaluationRequest } from "./exercise-request-mapper.js";
import { evaluateTacticalExercise as defaultEvaluate } from "../simulation/api-client.js";
import type { SimulateOptions } from "../simulation/api-client.js";
import type {
  TacticalExerciseEvaluationApiResult,
  UiApiError,
} from "../simulation/api-contract.js";
import type { BattleDraft } from "../formation/types.js";

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
  | { readonly kind: "NO_COMPLETED_RUNS" }
  | { readonly kind: "REQUEST_NOT_BUILDABLE" }
  | { readonly kind: "API"; readonly error: UiApiError };

export type ExerciseStatisticsRunState =
  | { readonly status: "idle" }
  | {
      readonly status: "running";
      readonly runId: string;
      readonly seed: string;
      readonly progress: StatisticsRunProgress;
    }
  | {
      readonly status: "succeeded";
      readonly runId: string;
      readonly seed: string;
      readonly progress: StatisticsRunProgress;
      readonly aggregate: EvaluationAggregate;
    }
  | {
      readonly status: "cancelled";
      readonly runId: string;
      readonly seed: string;
      readonly progress: StatisticsRunProgress;
      readonly aggregate: EvaluationAggregate;
    }
  | {
      readonly status: "failed";
      readonly runId: string;
      readonly seed: string;
      readonly progress: StatisticsRunProgress;
      readonly error: ExerciseStatisticsRunError;
    };

type StatisticsRunAction =
  | {
      readonly type: "runStarted";
      readonly runId: string;
      readonly seed: string;
      readonly progress: StatisticsRunProgress;
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
        aggregate: action.aggregate,
      };
    case "runFailed":
      return {
        status: "failed",
        runId: state.runId,
        seed: state.seed,
        progress: state.progress,
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
function classifyFailure(result: {
  readonly error: UiApiError;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
}): ExerciseStatisticsRunError {
  if (result.error.code === "ENDPOINT_DISABLED" || result.status === 404) {
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

export function describeStatisticsRunError(error: ExerciseStatisticsRunError): string {
  switch (error.kind) {
    case "ENDPOINT_DISABLED":
      return "この環境では統計実行を利用できません。単一実行はそのまま使えます。";
    case "RATE_LIMITED":
      return error.retryAfterSeconds === undefined
        ? "実行が制限されました。時間をおいて再実行してください。"
        : `実行が制限されました。約${error.retryAfterSeconds.toString()}秒おいて再実行してください。`;
    case "CATALOG_REVISION_CHANGED":
      return `実行中にCatalogが${error.catalogRevision}から${error.chunkCatalogRevision}へ切り替わりました。同じ条件で実行し直してください。`;
    case "NO_COMPLETED_RUNS":
      return "1試行も完了しなかったため、統計を出せません。";
    case "REQUEST_NOT_BUILDABLE":
      return "編成からリクエストを組み立てられませんでした。編成を確認してください。";
    case "API":
      return error.error.message;
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
      let progress: StatisticsRunProgress = {
        requestedRuns: input.runCount,
        completedRuns: 0,
        completedChunks: 0,
        chunkCount: chunks.length,
      };
      dispatch({ type: "runStarted", runId, seed, progress });

      const isCurrent = () => currentRunIdRef.current === runId;

      const finish = (results: readonly EvaluationChunkResult[], cancelled: boolean): void => {
        if (!isCurrent()) {
          return;
        }
        const merged = results.length === 0 ? undefined : mergeEvaluationChunks(results);
        if (merged === undefined || !merged.ok || merged.aggregate.completedRuns === 0) {
          dispatch({
            type: "runFailed",
            runId,
            error:
              merged !== undefined && !merged.ok
                ? {
                    kind: "CATALOG_REVISION_CHANGED",
                    catalogRevision: merged.catalogRevision,
                    chunkCatalogRevision: merged.chunkCatalogRevision,
                  }
                : { kind: "NO_COMPLETED_RUNS" },
          });
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
          const build = buildTacticalExerciseEvaluationRequest(input.draft, {
            runsPerCandidate: chunk.runs,
            seed: chunk.seed,
          });
          if (!build.ok) {
            if (isCurrent()) {
              dispatch({ type: "runFailed", runId, error: { kind: "REQUEST_NOT_BUILDABLE" } });
            }
            return;
          }
          const requestId = generateRequestId();
          const result = await evaluateImpl(build.request, {
            baseUrl,
            signal: controller.signal,
            ...(requestId !== undefined ? { requestId } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          });
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
            dispatch({
              type: "runFailed",
              runId,
              error: {
                kind: "CATALOG_REVISION_CHANGED",
                catalogRevision: merged.catalogRevision,
                chunkCatalogRevision: merged.chunkCatalogRevision,
              },
            });
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
