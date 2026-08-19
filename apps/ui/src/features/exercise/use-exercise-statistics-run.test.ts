import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  describeStatisticsRunError,
  useExerciseStatisticsRun,
} from "./use-exercise-statistics-run.js";
import type { TacticalExerciseEvaluationRequest } from "./exercise-request-mapper.js";
import { createInitialDraft, slotKeyOf } from "../formation/types.js";
import type { BattleDraft, Side, UiColumn, UiRow } from "../formation/types.js";
import type { SimulateOptions } from "../simulation/api-client.js";
import type {
  TacticalExerciseEvaluationApiResult,
  TacticalExerciseEvaluationResponse,
} from "../simulation/api-contract.js";

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

function evaluationResponse(
  runs: number,
  overrides: Partial<TacticalExerciseEvaluationResponse> = {},
): TacticalExerciseEvaluationResponse {
  const indices = Array.from({ length: runs }, (_value, index) => index);
  return {
    schemaVersion: 1,
    catalogRevision: "rev-1",
    seed: "seed#0",
    runsPerCandidate: runs,
    candidates: [
      {
        completedRuns: runs,
        scores: indices.map((index) => 1000 + index),
        breakCounts: indices.map(() => 1),
        completedTurns: indices.map(() => 5),
        completionReasons: indices.map(() => "TURN_LIMIT_REACHED"),
        allyUnitDamageTotals: indices.map(() => [500]),
        allyUnitBreakCounts: indices.map(() => [1]),
      },
    ],
    ...overrides,
  };
}

type EvaluateImpl = (
  request: TacticalExerciseEvaluationRequest,
  options: SimulateOptions,
) => Promise<TacticalExerciseEvaluationApiResult>;

function okResults(...responses: readonly TacticalExerciseEvaluationResponse[]): EvaluateImpl {
  let call = 0;
  return () => {
    const response = responses[call] ?? responses.at(-1);
    call += 1;
    return Promise.resolve({ ok: true, response: response as TacticalExerciseEvaluationResponse });
  };
}

function startInput(overrides: { runCount?: number; seed?: string } = {}) {
  return { draft: exerciseDraft(), runCount: 5, seed: "", ...overrides };
}

// UI-UT-EVL-004: 指定回数をチャンクへ割り、1リクエストずつ直列に送る。
describe("useExerciseStatisticsRun — sequential chunks", () => {
  it("sends one chunk at a time with the run-offset seed and never overlaps requests", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const evaluateImpl = vi.fn<EvaluateImpl>(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { ok: true, response: evaluationResponse(2) };
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
    expect(evaluateImpl.mock.calls.map(([request]) => request.seed)).toEqual([
      "abc#0",
      "abc#2",
      "abc#4",
    ]);
    expect(evaluateImpl.mock.calls.map(([request]) => request.runsPerCandidate)).toEqual([2, 2, 1]);
  });

  it("generates a seed when none was entered and keeps it for the whole run", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>(okResults(evaluationResponse(2)));
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
    const [generated] = seeds[0]?.split("#") ?? [];
    expect(generated).not.toBe("");
    expect(seeds).toEqual([`${generated ?? ""}#0`, `${generated ?? ""}#2`]);
    expect(
      result.current.state.status === "succeeded" ? result.current.state.seed : undefined,
    ).toBe(generated);
  });

  it("reports progress per chunk and aggregates every run into one sample", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>(okResults(evaluationResponse(2)));
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
      1000, 1001, 1000, 1001,
    ]);
  });

  // 同じ（seed・回数）なら同じリクエスト列になる（再現性の要）。
  it("issues the same request sequence for the same seed and run count", async () => {
    const first: TacticalExerciseEvaluationRequest[] = [];
    const second: TacticalExerciseEvaluationRequest[] = [];
    const record = (sink: TacticalExerciseEvaluationRequest[]): EvaluateImpl => {
      return (request) => {
        sink.push(request);
        return Promise.resolve({ ok: true, response: evaluationResponse(2) });
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

// UI-UT-EVL-005: 部分結果は再送しない。中断は完了済みチャンクまでで確定する。
describe("useExerciseStatisticsRun — partial results and cancellation", () => {
  it("keeps a short chunk as a partial result without resending it", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>(
      okResults(
        evaluationResponse(1, { runsPerCandidate: 2 }),
        evaluationResponse(2, { runsPerCandidate: 2 }),
      ),
    );
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
    expect(result.current.state).toMatchObject({
      status: "succeeded",
      progress: { requestedRuns: 4, completedRuns: 3 },
    });
  });

  it("finishes with the chunks already completed when the run is cancelled", async () => {
    let release: (() => void) | undefined;
    const evaluateImpl = vi.fn<EvaluateImpl>((_request, options) => {
      if (evaluateImpl.mock.calls.length === 1) {
        return Promise.resolve({ ok: true, response: evaluationResponse(2) });
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
    expect(state.status === "cancelled" ? state.aggregate.requestedRuns : undefined).toBe(2);
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
    const evaluateImpl = vi.fn<EvaluateImpl>(
      okResults(
        evaluationResponse(0, { runsPerCandidate: 2 }),
        evaluationResponse(0, { runsPerCandidate: 2 }),
      ),
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
      ),
    ).toContain("この環境では統計実行を利用できません");
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
    expect(describeStatisticsRunError({ kind: "RATE_LIMITED", retryAfterSeconds: 30 })).toContain(
      "30",
    );
  });

  it("stops the run when catalogRevision changes between chunks", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>(
      okResults(evaluationResponse(2), evaluationResponse(2, { catalogRevision: "rev-2" })),
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
    expect(result.current.state).toMatchObject({
      error: { kind: "CATALOG_REVISION_CHANGED", catalogRevision: "rev-1" },
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
  });

  it("fails without sending anything when the draft cannot be turned into a request", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>(okResults(evaluationResponse(2)));
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
});
