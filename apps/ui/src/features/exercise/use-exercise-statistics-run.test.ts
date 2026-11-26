import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { ApiAccessContext } from "../../shared/api/access-key.js";
import { describe, expect, it, vi } from "vitest";
import {
  describeStatisticsRunError,
  selectStatisticsAggregate,
  useExerciseStatisticsRun,
} from "./use-exercise-statistics-run.js";
import type { ExerciseStatisticsRunState } from "./use-exercise-statistics-run.js";
import type { EvaluationAggregate } from "./evaluation-chunk-plan.js";
import type { BattleDraft, Side, UiColumn, UiRow } from "../../entities/battle-draft.js";
import type {
  TacticalExerciseEvaluationApiResult,
  TacticalExerciseEvaluationRequest,
} from "../../shared/api/api-contract.js";
import { createInitialDraft, slotKeyOf } from "../formation/types.js";
import {
  evaluationResponseFor,
  type EvaluationResponseOptions,
} from "../../test/evaluation-response.js";
import type { SimulateOptions } from "../../shared/api/api-client.js";

function withUnit(
  draft: BattleDraft,
  side: Side,
  row: UiRow,
  column: UiColumn,
  unitDefinitionId: string,
): BattleDraft {
  const slotKey = slotKeyOf(side, row, column);
  const map = (slots: BattleDraft["allySlots"]) =>
    slots.map((slot) => (slot.slotKey === slotKey ? { ...slot, unitDefinitionId } : slot));
  return side === "ally"
    ? { ...draft, allySlots: map(draft.allySlots) }
    : { ...draft, enemySlots: map(draft.enemySlots) };
}

function exerciseDraft(): BattleDraft {
  let draft = createInitialDraft();
  draft = withUnit(draft, "ally", "FRONT", 0, "UNIT_ALLY");
  draft = withUnit(draft, "enemy", "FRONT", 0, "UNIT_ENEMY");
  return draft;
}

type EvaluateImpl = (
  request: TacticalExerciseEvaluationRequest,
  options: SimulateOptions,
) => Promise<TacticalExerciseEvaluationApiResult>;

// 応答は要求のseed・試行番号をそのまま返す（`10_API設計.md`「実際に使ったseed」）。
// 呼び出しごとに部分結果・実行条件を変えられる。最後の指定は以降の呼び出しにも使う。
function okResults(...perCall: readonly EvaluationResponseOptions[]): EvaluateImpl {
  let call = 0;
  return (request) => {
    const options = perCall[call] ?? perCall.at(-1) ?? {};
    call += 1;
    return Promise.resolve({ ok: true, response: evaluationResponseFor(request, options) });
  };
}

function runIndicesOf(request: TacticalExerciseEvaluationRequest | undefined): readonly number[] {
  return request?.cases[0]?.runIndices ?? [];
}

function startInput(overrides: { runCount?: number; seed?: string } = {}) {
  return { draft: exerciseDraft(), runCount: 5, seed: "", ...overrides };
}

// UI-UT-EVL-004: 指定回数をチャンクへ割り、1リクエストずつ直列に送る。
describe("useExerciseStatisticsRun — sequential chunks", () => {
  it("sends one chunk at a time with the same seed and contiguous global run indices, never overlapping requests", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const evaluateImpl = vi.fn<EvaluateImpl>(async (request) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { ok: true, response: evaluationResponseFor(request) };
    });
    const { result } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize: 2 }),
    );

    act(() => {
      result.current.start(startInput({ runCount: 5, seed: "abc" }));
    });

    await waitFor(() => {
      expect(result.current.state.status).not.toBe("running");
    });
    expect(maxInFlight).toBe(1);
    expect(evaluateImpl.mock.calls.map(([request]) => request.seed)).toEqual(["abc", "abc", "abc"]);
    expect(evaluateImpl.mock.calls.map(([request]) => runIndicesOf(request))).toEqual([
      [0, 1],
      [2, 3],
      [4],
    ]);
  });

  it("forwards the configured timeout to every chunk request", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>(okResults());
    const { result } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", {
        evaluateImpl,
        chunkSize: 2,
        timeoutMs: 12_000,
      }),
    );

    act(() => {
      result.current.start(startInput({ runCount: 2, seed: "s" }));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("succeeded");
    });
    expect(evaluateImpl.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 12_000 });
  });

  it("generates a seed when none was entered and keeps it for the whole run", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>(okResults());
    const { result } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize: 2 }),
    );

    act(() => {
      result.current.start(startInput({ runCount: 4, seed: "  " }));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("succeeded");
    });
    const seeds = evaluateImpl.mock.calls.map(([request]) => request.seed);
    const generated = seeds[0];
    expect(generated).toMatch(/^[0-9a-f]+$/);
    expect(seeds).toEqual([generated, generated]);
    expect(
      result.current.state.status === "succeeded" ? result.current.state.seed : undefined,
    ).toBe(generated);
  });

  it("reports progress per chunk and aggregates every run into one sample", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>(okResults());
    const { result } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize: 2 }),
    );

    act(() => {
      result.current.start(startInput({ runCount: 4, seed: "s" }));
    });

    expect(result.current.state).toMatchObject({
      status: "running",
      progress: { requestedRuns: 4, completedRuns: 0, completedChunks: 0, chunkCount: 2 },
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("succeeded");
    });
    const { state } = result.current;
    expect(state.status === "succeeded" ? state.progress : undefined).toEqual({
      requestedRuns: 4,
      completedRuns: 4,
      completedChunks: 2,
      chunkCount: 2,
    });
    expect(state.status === "succeeded" ? state.aggregate.sample.scores : undefined).toEqual([
      1000, 1001, 1002, 1003,
    ]);
  });

  // 同じ（seed・回数）なら同じリクエスト列になる（再現性の要）。
  it("issues the same request sequence for the same seed and run count", async () => {
    const first: TacticalExerciseEvaluationRequest[] = [];
    const second: TacticalExerciseEvaluationRequest[] = [];
    const record = (sink: TacticalExerciseEvaluationRequest[]): EvaluateImpl => {
      return (request) => {
        sink.push(request);
        return Promise.resolve({
          ok: true,
          response: evaluationResponseFor(request),
        });
      };
    };
    const firstRun = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", {
        evaluateImpl: record(first),
        chunkSize: 2,
      }),
    );
    act(() => {
      firstRun.result.current.start(startInput({ runCount: 3, seed: "same" }));
    });
    await waitFor(() => {
      expect(firstRun.result.current.state.status).toBe("succeeded");
    });

    const secondRun = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", {
        evaluateImpl: record(second),
        chunkSize: 2,
      }),
    );
    act(() => {
      secondRun.result.current.start(startInput({ runCount: 3, seed: "same" }));
    });
    await waitFor(() => {
      expect(secondRun.result.current.state.status).toBe("succeeded");
    });

    expect(second).toEqual(first);
  });
});

// UI-UT-EVL-008: 試行の観測値は通し試行番号だけで決まる。チャンクサイズを変えても同じ
// 試行番号へ同じ観測値が対応し、標本・出所が変わらない（旧`<seed>#<runOffset>`規約では
// チャンクサイズを変えると別の試行集合になっていた）。
describe("useExerciseStatisticsRun — chunk size independence", () => {
  async function aggregateWith(chunkSize: number): Promise<EvaluationAggregate | undefined> {
    const evaluateImpl = vi.fn<EvaluateImpl>(
      okResults({ run: (runIndex) => ({ totalScore: 5000 + ((runIndex * 37) % 101) }) }),
    );
    const { result } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize }),
    );
    act(() => {
      result.current.start(startInput({ runCount: 7, seed: "same" }));
    });
    await waitFor(() => {
      expect(result.current.state.status).toBe("succeeded");
    });
    return selectStatisticsAggregate(result.current.state);
  }

  it("aggregates the same sample for the same run indices whatever the chunk size", async () => {
    const small = await aggregateWith(2);
    const large = await aggregateWith(300);

    expect(small?.sample).toEqual(large?.sample);
    expect(small?.runs.map((run) => run.runIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(large?.runs.map((run) => run.runIndex)).toEqual(small?.runs.map((run) => run.runIndex));
  });
});

// UI-UT-EVL-005: 部分結果は再送しない。未完了の試行番号は集約に残す。中断は完了済み
// チャンクまでで確定する。
describe("useExerciseStatisticsRun — partial results and cancellation", () => {
  it("keeps a short chunk as a partial result, lists its unfinished run indices and does not resend them", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>(okResults({ completed: 1 }, {}));
    const { result } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize: 2 }),
    );

    act(() => {
      result.current.start(startInput({ runCount: 4, seed: "s" }));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("succeeded");
    });
    expect(evaluateImpl).toHaveBeenCalledTimes(2);
    expect(evaluateImpl.mock.calls.map(([request]) => runIndicesOf(request))).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(result.current.state).toMatchObject({
      status: "succeeded",
      progress: { requestedRuns: 4, completedRuns: 3 },
      aggregate: { incompleteRunIndices: [1] },
    });
    const { state } = result.current;
    expect(state.status === "succeeded" ? state.aggregate.runs.map((r) => r.runIndex) : []).toEqual(
      [0, 2, 3],
    );
  });

  it("finishes with the chunks already completed when the run is cancelled", async () => {
    let release: (() => void) | undefined;
    const evaluateImpl = vi.fn<EvaluateImpl>((request, options) => {
      if (evaluateImpl.mock.calls.length === 1) {
        return Promise.resolve({
          ok: true,
          response: evaluationResponseFor(request),
        });
      }
      return new Promise((resolve) => {
        release = () => {
          resolve({ ok: false, error: { kind: "CANCELLED", message: "cancelled" } });
        };
        options.signal.addEventListener("abort", () => {
          release?.();
        });
      });
    });
    const { result } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize: 2 }),
    );

    act(() => {
      result.current.start(startInput({ runCount: 6, seed: "s" }));
    });
    await waitFor(() => {
      expect(evaluateImpl).toHaveBeenCalledTimes(2);
    });

    act(() => {
      result.current.cancel();
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("cancelled");
    });
    const { state } = result.current;
    expect(state.status === "cancelled" ? state.aggregate.completedRuns : undefined).toBe(2);
    // 集約が数えるのは送ったチャンクだけである。利用者が入力した6試行は進捗の側に残り、
    // 結果表示はそちらを「要求」として出す。
    expect(state.status === "cancelled" ? state.aggregate.sentRuns : undefined).toBe(2);
    expect(state.status === "cancelled" ? state.progress.requestedRuns : undefined).toBe(6);
    expect(evaluateImpl).toHaveBeenCalledTimes(2);
  });

  it("fails with no result when the run is cancelled before the first chunk returned", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>(
      (_request, options) =>
        new Promise((resolve) => {
          options.signal.addEventListener("abort", () => {
            resolve({ ok: false, error: { kind: "CANCELLED", message: "cancelled" } });
          });
        }),
    );
    const { result } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize: 2 }),
    );

    act(() => {
      result.current.start(startInput({ runCount: 4, seed: "s" }));
    });
    act(() => {
      result.current.cancel();
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    expect(result.current.state).toMatchObject({
      status: "failed",
      error: { kind: "NO_COMPLETED_RUNS" },
    });
  });

  it("fails with no result when every chunk completed zero runs", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>(okResults({ completed: 0 }));
    const { result } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize: 2 }),
    );

    act(() => {
      result.current.start(startInput({ runCount: 4, seed: "s" }));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    expect(result.current.state).toMatchObject({ error: { kind: "NO_COMPLETED_RUNS" } });
  });

  it("aborts the in-flight chunk when the hook unmounts", async () => {
    const aborted = vi.fn();
    const evaluateImpl = vi.fn<EvaluateImpl>(
      (_request, options) =>
        new Promise((resolve) => {
          options.signal.addEventListener("abort", () => {
            aborted();
            resolve({ ok: false, error: { kind: "CANCELLED", message: "cancelled" } });
          });
        }),
    );
    const { result, unmount } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize: 2 }),
    );

    act(() => {
      result.current.start(startInput({ runCount: 4, seed: "s" }));
    });
    unmount();

    await waitFor(() => {
      expect(aborted).toHaveBeenCalledOnce();
    });
  });
});

// UI-UT-EVL-006: 失敗は再試行せず中断する。原因ごとに読み分けられる形で残す。
describe("useExerciseStatisticsRun — failures", () => {
  it("stops the run on a 404 ENDPOINT_DISABLED and reports it as unavailable here", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        error: { kind: "SERVER", status: 404, code: "ENDPOINT_DISABLED", message: "disabled" },
      }),
    );
    const { result } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize: 2 }),
    );

    act(() => {
      result.current.start(startInput({ runCount: 4, seed: "s" }));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    expect(result.current.state).toMatchObject({ error: { kind: "ENDPOINT_DISABLED" } });
    expect(evaluateImpl).toHaveBeenCalledOnce();
    expect(
      describeStatisticsRunError(
        result.current.state.status === "failed"
          ? result.current.state.error
          : { kind: "NO_COMPLETED_RUNS" },
      ).guidance,
    ).toContain("この環境では統計実行を利用できません");
  });

  // 配備の設定で閉じている（Q-TEX-19）ことの根拠は`code`だけである。`VITE_API_BASE_URL`の
  // 設定ミスやプロキシのパス取り違えによる404を同じ案内にすると、単一実行も動かない
  // 状況で「単一実行はそのまま使えます」と誤って案内してしまう。
  it("does not read a 404 without the ENDPOINT_DISABLED code as a disabled endpoint", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        error: { kind: "SERVER", status: 404, message: "Request failed with HTTP 404." },
      }),
    );
    const { result } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize: 2 }),
    );

    act(() => {
      result.current.start(startInput({ runCount: 4, seed: "s" }));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    expect(result.current.state).toMatchObject({ error: { kind: "API" } });
  });

  it("stops the run on a 429 and keeps the retry-after seconds for the message", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>(() =>
      Promise.resolve({
        ok: false,
        status: 429,
        error: {
          kind: "RATE_LIMIT",
          status: 429,
          code: "RATE_LIMIT_EXCEEDED",
          message: "too many",
          retryAfterSeconds: 30,
        },
        retryAfterSeconds: 30,
      }),
    );
    const { result } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize: 2 }),
    );

    act(() => {
      result.current.start(startInput({ runCount: 4, seed: "s" }));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    expect(result.current.state).toMatchObject({
      error: { kind: "RATE_LIMITED", retryAfterSeconds: 30 },
    });
    expect(evaluateImpl).toHaveBeenCalledOnce();
    expect(
      describeStatisticsRunError({ kind: "RATE_LIMITED", retryAfterSeconds: 30 }).guidance,
    ).toContain("30");
  });

  it("stops the run when the engine revision changes between chunks", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>(okResults({}, { engineRevision: "engine-2" }));
    const { result } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize: 2 }),
    );

    act(() => {
      result.current.start(startInput({ runCount: 6, seed: "s" }));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    expect(result.current.state).toMatchObject({
      error: {
        kind: "RUN_CONDITIONS_CHANGED",
        field: "engineRevision",
        expected: "engine-1",
        actual: "engine-2",
      },
    });
    expect(evaluateImpl).toHaveBeenCalledTimes(2);
  });

  it("stops the run on any other API failure and keeps the normalized error", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>(() =>
      Promise.resolve({
        ok: false,
        status: 503,
        error: { kind: "CAPACITY", status: 503, message: "busy" },
      }),
    );
    const { result } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize: 2 }),
    );

    act(() => {
      result.current.start(startInput({ runCount: 4, seed: "s" }));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    expect(result.current.state).toMatchObject({
      error: { kind: "API", error: { kind: "CAPACITY" } },
    });
    // 単一実行（`SubmissionFeedback`）と同じ §13 の種別文言を使い、サーバーの生messageは
    // 案内の下へ添える。生messageだけだと英文が1行出るだけになる。
    expect(
      describeStatisticsRunError({
        kind: "API",
        error: {
          kind: "TIMEOUT",
          message: "The request did not complete before the client timeout.",
        },
      }),
    ).toEqual({
      guidance: "応答がタイムアウトしました。条件を見直すか再試行してください。",
      detail: "The request did not complete before the client timeout.",
    });
  });

  // `TACTICAL_EXERCISE_EVALUATION_MAX_TOTAL_RUNS`を300未満へ絞った配備では全チャンクが422になる。
  // サーバーは試行計画への違反を`/cases`などのJSON Pointerで返すため、violationsを捨てると
  // 実行回数入力へ結びつけられなくなる。
  it("keeps the server violations of a 422 so the run count input can show them", async () => {
    const violations = [{ path: "/cases", message: "300 runs exceed the limit" }];
    const evaluateImpl = vi.fn<EvaluateImpl>(() =>
      Promise.resolve({
        ok: false,
        status: 422,
        error: {
          kind: "VALIDATION",
          status: 422,
          code: "INVALID_COMMAND",
          message: "invalid",
          violations,
        },
      }),
    );
    const { result } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize: 2 }),
    );

    act(() => {
      result.current.start(startInput({ runCount: 4, seed: "s" }));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    const { state } = result.current;
    expect(state.status === "failed" ? describeStatisticsRunError(state.error) : undefined).toEqual(
      {
        guidance: "入力内容を確認してください。",
        detail: "invalid",
        violations,
      },
    );
    // 送信時のslot対応表を残す（UI-API-004）。編成の違反を現在のdraftではなく送信した
    // 編成の枠へ結びつけるために要る。
    expect(state.status === "failed" ? state.submission.allyUnitSlotKeys : undefined).toEqual([
      "ally:FRONT:0",
    ]);
  });

  // 応答検証は要求を知らない。別の番号の試行が返ると通し試行番号と観測値の対応が崩れる。
  it("fails as a contract mismatch when the response does not report exactly the requested run indices", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>((request) =>
      Promise.resolve({
        ok: true,
        response: evaluationResponseFor({
          ...request,
          cases: request.cases.map((c) => ({ ...c, runIndices: [7, 8] })),
        }),
      }),
    );
    const { result } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize: 2 }),
    );

    act(() => {
      result.current.start(startInput({ runCount: 2, seed: "s" }));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    expect(result.current.state).toMatchObject({
      error: { kind: "API", error: { kind: "RESPONSE_CONTRACT_MISMATCH" } },
    });
  });

  // ユニット別集計の列は編成順であり、列に名前を付けられるのは送信時の編成だけである。
  // 実行後に編成を編集できるため、現在のdraftから引くと別のユニット名が列へ付く。
  it("keeps the ally unit definition ids of the submitted formation in formation order", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>(okResults());
    const { result } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize: 2 }),
    );

    act(() => {
      result.current.start(startInput({ runCount: 2, seed: "s" }));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("succeeded");
    });
    const { state } = result.current;
    expect(
      state.status === "succeeded" ? state.submission.allyUnitDefinitionIds : undefined,
    ).toEqual(["UNIT_ALLY"]);
  });

  // 応答の`seed`は実際に使われたseedである（`10_API設計.md`）。食い違いを見逃すと、別の
  // 乱数列で回った試行を同じ試行番号として集計してしまう。
  it("stops the run when the response does not echo the run seed", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>((request) =>
      Promise.resolve({
        ok: true,
        response: evaluationResponseFor({ ...request, seed: "other-seed" }),
      }),
    );
    const { result } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize: 2 }),
    );

    act(() => {
      result.current.start(startInput({ runCount: 4, seed: "s" }));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    expect(result.current.state).toMatchObject({
      error: { kind: "SEED_NOT_ECHOED", requestedSeed: "s", respondedSeed: "other-seed" },
    });
    expect(evaluateImpl).toHaveBeenCalledOnce();
  });

  it("stops the run when the per-unit column count changes between chunks", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>((request) =>
      Promise.resolve({
        ok: true,
        response: evaluationResponseFor(
          request.cases[0]?.runIndices[0] === 0
            ? request
            : {
                ...request,
                cases: request.cases.map((c) => ({
                  ...c,
                  allyFormation: {
                    ...c.allyFormation,
                    units: [...c.allyFormation.units, ...c.allyFormation.units],
                  },
                })),
              },
        ),
      }),
    );
    const { result } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize: 2 }),
    );

    act(() => {
      result.current.start(startInput({ runCount: 6, seed: "s" }));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    expect(result.current.state).toMatchObject({ error: { kind: "UNIT_COLUMN_COUNT_CHANGED" } });
    expect(evaluateImpl).toHaveBeenCalledTimes(2);
  });

  it("fails without sending anything when the draft cannot be turned into a request", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>(okResults());
    const { result } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize: 2 }),
    );

    act(() => {
      result.current.start({ draft: createInitialDraft(), runCount: 4, seed: "s" });
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    expect(result.current.state).toMatchObject({ error: { kind: "REQUEST_NOT_BUILDABLE" } });
    expect(evaluateImpl).not.toHaveBeenCalled();
  });

  it("keeps the retry-after seconds from the error body when the response carries none at top level", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>(() =>
      Promise.resolve({
        ok: false,
        status: 429,
        error: {
          kind: "RATE_LIMIT",
          status: 429,
          code: "RATE_LIMIT_EXCEEDED",
          message: "too many",
          retryAfterSeconds: 45,
        },
      }),
    );
    const { result } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize: 2 }),
    );

    act(() => {
      result.current.start(startInput({ runCount: 4, seed: "s" }));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    expect(result.current.state).toMatchObject({
      error: { kind: "RATE_LIMITED", retryAfterSeconds: 45 },
    });
  });

  it("reports a rate limit without a retry-after when neither the response nor the error body carries one", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>(() =>
      Promise.resolve({
        ok: false,
        status: 429,
        error: {
          kind: "RATE_LIMIT",
          status: 429,
          code: "RATE_LIMIT_EXCEEDED",
          message: "too many",
        },
      }),
    );
    const { result } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize: 2 }),
    );

    act(() => {
      result.current.start(startInput({ runCount: 4, seed: "s" }));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    const { state } = result.current;
    expect(state.status === "failed" ? state.error : undefined).toEqual({ kind: "RATE_LIMITED" });
  });

  // UI-CMP-013と同じ規約: 中断は非同期であり、abort()は既に解決に向かっているPromiseを
  // 取り消せない。実行状態(`asyncRequest.isCurrent`)が古い実行を「もう現在ではない」と
  // 判定できることを、abortの成否に関係なく固定する。
  it("does not let a superseded run's late response overwrite the run that replaced it", async () => {
    let resolveStale: ((result: TacticalExerciseEvaluationApiResult) => void) | undefined;
    const evaluateImpl = vi.fn<EvaluateImpl>((request) => {
      if (evaluateImpl.mock.calls.length === 1) {
        return new Promise((resolve) => {
          resolveStale = resolve;
        });
      }
      return Promise.resolve({ ok: true, response: evaluationResponseFor(request) });
    });
    const { result } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize: 4 }),
    );

    act(() => {
      result.current.start(startInput({ runCount: 4, seed: "stale" }));
    });
    await waitFor(() => {
      expect(evaluateImpl).toHaveBeenCalledTimes(1);
    });
    const staleRunId = result.current.state.status === "running" ? result.current.state.runId : "";

    act(() => {
      result.current.start(startInput({ runCount: 4, seed: "fresh" }));
    });
    const freshRunId = result.current.state.status === "running" ? result.current.state.runId : "";
    expect(freshRunId).not.toBe(staleRunId);

    await waitFor(() => {
      expect(result.current.state.status).toBe("succeeded");
    });
    expect(result.current.state).toMatchObject({ runId: freshRunId });

    act(() => {
      resolveStale?.({
        ok: true,
        response: evaluationResponseFor({ ...evaluateImpl.mock.calls[0]![0] }),
      });
    });

    // 古い実行の遅延応答は無視され、新しい実行が確定したsucceeded stateのままである。
    expect(result.current.state).toMatchObject({ status: "succeeded", runId: freshRunId });
  });
});

describe("describeStatisticsRunError", () => {
  it("describes a rate limit without a retry-after countdown", () => {
    expect(describeStatisticsRunError({ kind: "RATE_LIMITED" }).guidance).toBe(
      "実行が制限されました。時間をおいて再実行してください。",
    );
  });

  it("describes a Catalog or engine revision change mid-run", () => {
    expect(
      describeStatisticsRunError({
        kind: "RUN_CONDITIONS_CHANGED",
        field: "catalogRevision",
        expected: "rev-1",
        actual: "rev-2",
      }).guidance,
    ).toBe("実行中にCatalogがrev-1からrev-2へ切り替わりました。同じ条件で実行し直してください。");
    expect(
      describeStatisticsRunError({
        kind: "RUN_CONDITIONS_CHANGED",
        field: "engineRevision",
        expected: "a",
        actual: "b",
      }).guidance,
    ).toBe("実行中に戦闘エンジンがaからbへ切り替わりました。同じ条件で実行し直してください。");
  });

  it("describes a per-unit column count change mid-run", () => {
    expect(
      describeStatisticsRunError({
        kind: "UNIT_COLUMN_COUNT_CHANGED",
        unitCount: 3,
        chunkUnitCount: 4,
      }).guidance,
    ).toBe("実行中にユニット別集計の列数が3から4へ変わりました。結果を集計できません。");
  });

  it("describes a seed the server did not echo back", () => {
    expect(
      describeStatisticsRunError({
        kind: "SEED_NOT_ECHOED",
        requestedSeed: "seed-a",
        respondedSeed: "seed-b",
      }).guidance,
    ).toBe(
      "サーバーが要求したseed（seed-a）ではなくseed-bで実行しました。試行番号と乱数列が対応しないため結果を集計できません。",
    );
  });

  it("describes a run that completed zero trials", () => {
    expect(describeStatisticsRunError({ kind: "NO_COMPLETED_RUNS" }).guidance).toBe(
      "1試行も完了しなかったため、統計を出せません。",
    );
  });

  it("describes a request that could not be built from the draft", () => {
    expect(describeStatisticsRunError({ kind: "REQUEST_NOT_BUILDABLE" }).guidance).toBe(
      "編成からリクエストを組み立てられませんでした。編成を確認してください。",
    );
  });

  it("keeps the diagnostic id of an API failure alongside its guidance", () => {
    expect(
      describeStatisticsRunError({
        kind: "API",
        error: { kind: "SERVER", message: "unexpected", diagnosticId: "diag-1" },
      }),
    ).toMatchObject({ diagnosticId: "diag-1" });
  });
});

describe("selectStatisticsAggregate", () => {
  it("returns undefined before a run has started", () => {
    const idle: ExerciseStatisticsRunState = { status: "idle" };
    expect(selectStatisticsAggregate(idle)).toBeUndefined();
  });

  it("returns the same aggregate for a succeeded and a cancelled run, and none for a failed one", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>(okResults());
    const { result } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize: 4 }),
    );

    act(() => {
      result.current.start(startInput({ runCount: 4, seed: "s" }));
    });
    await waitFor(() => {
      expect(result.current.state.status).toBe("succeeded");
    });
    const succeededAggregate: EvaluationAggregate | undefined = selectStatisticsAggregate(
      result.current.state,
    );
    expect(succeededAggregate).toBeDefined();

    const cancelled = {
      ...result.current.state,
      status: "cancelled",
    } as ExerciseStatisticsRunState;
    expect(selectStatisticsAggregate(cancelled)).toBe(succeededAggregate);

    const failedEvaluateImpl = vi.fn<EvaluateImpl>(() =>
      Promise.resolve({ ok: false, status: 500, error: { kind: "CAPACITY", message: "busy" } }),
    );
    const { result: failedResult } = renderHook(() =>
      useExerciseStatisticsRun("https://api.example.com", {
        evaluateImpl: failedEvaluateImpl,
        chunkSize: 4,
      }),
    );
    act(() => {
      failedResult.current.start(startInput({ runCount: 4, seed: "s" }));
    });
    await waitFor(() => {
      expect(failedResult.current.state.status).toBe("failed");
    });
    expect(selectStatisticsAggregate(failedResult.current.state)).toBeUndefined();
  });
});

function accessWrapper(accessKey: string | undefined, onUnauthorized: () => void) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(
      ApiAccessContext.Provider,
      { value: { accessKey, generation: 7, onUnauthorized } },
      children,
    );
  };
}

describe("useExerciseStatisticsRun — access key", () => {
  it("UI-API-043: sends the context's access key and reports a 401 so the page can ask for a key", async () => {
    const onUnauthorized = vi.fn();
    const evaluateImpl = vi.fn<EvaluateImpl>(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        error: {
          kind: "UNAUTHORIZED",
          message: "A valid access key is required.",
          status: 401,
          code: "UNAUTHORIZED",
        },
      }),
    );
    const { result } = renderHook(
      () => useExerciseStatisticsRun("https://api.example.com", { evaluateImpl, chunkSize: 2 }),
      { wrapper: accessWrapper("k".repeat(40), onUnauthorized) },
    );

    act(() => {
      result.current.start(startInput({ runCount: 2, seed: "s" }));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    expect(evaluateImpl.mock.calls[0]?.[1].accessKey).toBe("k".repeat(40));
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledWith(7);
  });
});
