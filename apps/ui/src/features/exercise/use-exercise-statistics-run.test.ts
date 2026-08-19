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

// 応答は送ったチャンクseedをそのまま返す（`10_API設計.md`「実際に使われたseed」）。
function okResults(...responses: readonly TacticalExerciseEvaluationResponse[]): EvaluateImpl {
  let call = 0;
  return (request) => {
    const response = (responses[call] ?? responses.at(-1)) as TacticalExerciseEvaluationResponse;
    call += 1;
    return Promise.resolve({ ok: true, response: { ...response, seed: request.seed } });
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
    const evaluateImpl = vi.fn<EvaluateImpl>(async (request) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { ok: true, response: evaluationResponse(2, { seed: request.seed }) };
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
        return Promise.resolve({
          ok: true,
          response: evaluationResponse(2, { seed: request.seed }),
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
    const evaluateImpl = vi.fn<EvaluateImpl>((request, options) => {
      if (evaluateImpl.mock.calls.length === 1) {
        return Promise.resolve({
          ok: true,
          response: evaluationResponse(2, { seed: request.seed }),
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

  // `EVALUATION_MAX_TOTAL_RUNS`を300未満へ絞った配備では全チャンクが422になる。
  // サーバーは`/runsPerCandidate`をJSON Pointerで返すため、violationsを捨てると
  // 実行回数入力へ結びつけられなくなる。
  it("keeps the server violations of a 422 so the run count input can show them", async () => {
    const violations = [{ path: "/runsPerCandidate", message: "300 runs exceed the limit" }];
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

  // ユニット別集計の列は編成順であり、列に名前を付けられるのは送信時の編成だけである。
  // 実行後に編成を編集できるため、現在のdraftから引くと別のユニット名が列へ付く。
  it("keeps the ally unit definition ids of the submitted formation in formation order", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>(okResults(evaluationResponse(2)));
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

  // 応答の`seed`は、送ったチャンクseedがそのまま使われたかを判定できる唯一の材料である
  // （`10_API設計.md`「実際に使われたseed」）。食い違いを見逃すと、全チャンクが同じ試行を
  // 繰り返していても数値が揃って見えるだけで気づけない。
  it("stops the run when the response does not echo the chunk seed", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>(() =>
      Promise.resolve({ ok: true, response: evaluationResponse(2, { seed: "other-seed" }) }),
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
      error: { kind: "SEED_NOT_ECHOED", requestedSeed: "s#0", respondedSeed: "other-seed" },
    });
    expect(evaluateImpl).toHaveBeenCalledOnce();
  });

  it("stops the run when the per-unit column count changes between chunks", async () => {
    const evaluateImpl = vi.fn<EvaluateImpl>((request) =>
      Promise.resolve({
        ok: true,
        response:
          request.seed === "s#0"
            ? evaluationResponse(2, { seed: request.seed })
            : {
                ...evaluationResponse(2, { seed: request.seed }),
                candidates: [
                  {
                    completedRuns: 2,
                    scores: [1, 2],
                    breakCounts: [0, 0],
                    completedTurns: [5, 5],
                    completionReasons: ["TURN_LIMIT_REACHED", "TURN_LIMIT_REACHED"],
                    allyUnitDamageTotals: [
                      [1, 2],
                      [1, 2],
                    ],
                    allyUnitBreakCounts: [
                      [0, 0],
                      [0, 0],
                    ],
                  },
                ],
              },
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
