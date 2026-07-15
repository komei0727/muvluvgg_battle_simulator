import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSimulationExecution } from "./use-simulation-execution.js";
import type { SimulateOptions } from "./api-client.js";
import type { BattleSimulationRequest } from "../formation/request-mapper.js";
import type { BattleSimulationResponse, SimulationApiResult } from "./api-contract.js";

function request(overrides: Partial<BattleSimulationRequest> = {}): BattleSimulationRequest {
  return {
    allyFormation: {
      units: [{ unitDefinitionId: "UNIT_ALLY", position: { column: 0, row: "FRONT" } }],
      memoryDefinitionIds: [],
    },
    enemyFormation: {
      units: [{ unitDefinitionId: "UNIT_ENEMY", position: { column: 0, row: "FRONT" } }],
      memoryDefinitionIds: [],
    },
    turnLimit: 10,
    options: { logLevel: "DETAILED" },
    ...overrides,
  };
}

function response(): BattleSimulationResponse {
  return {
    schemaVersion: 1,
    battleId: "battle-1",
    catalogRevision: "rev-1",
    result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
    initialState: { units: [] },
    finalState: { units: [] },
    events: [],
    stateTransitions: [],
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useSimulationExecution — submit (UI-UT-EXEC-HOOK-001)", () => {
  it("starts submitting immediately and transitions to succeeded", async () => {
    const simulateImpl = vi.fn<
      (req: BattleSimulationRequest, options: SimulateOptions) => Promise<SimulationApiResult>
    >(() => Promise.resolve({ ok: true, response: response(), requestId: "srv-1" }));
    const { result } = renderHook(() =>
      useSimulationExecution("https://api.example.com", { simulateImpl }),
    );

    act(() => {
      result.current.submit(request());
    });

    expect(result.current.state.status).toBe("submitting");

    await waitFor(() => {
      expect(result.current.state.status).toBe("succeeded");
    });
    expect(result.current.state).toMatchObject({ status: "succeeded", requestId: "srv-1" });
  });

  it("passes credentials-omitting client options and a generated executionId through the reducer", async () => {
    const simulateImpl = vi.fn<
      (req: BattleSimulationRequest, options: SimulateOptions) => Promise<SimulationApiResult>
    >(() => Promise.resolve({ ok: true, response: response() }));
    const { result } = renderHook(() =>
      useSimulationExecution("https://api.example.com", { simulateImpl }),
    );

    act(() => {
      result.current.submit(request());
    });

    expect(simulateImpl).toHaveBeenCalledTimes(1);
    const [sentRequest, options] = simulateImpl.mock.calls[0]!;
    expect(sentRequest).toEqual(request());
    expect(options.baseUrl).toBe("https://api.example.com");
    expect(options.signal.aborted).toBe(false);

    await waitFor(() => {
      expect(result.current.state.status).toBe("succeeded");
    });
  });

  it("transitions to failed on a server error", async () => {
    const simulateImpl = vi.fn<
      (req: BattleSimulationRequest, options: SimulateOptions) => Promise<SimulationApiResult>
    >(() =>
      Promise.resolve({
        ok: false,
        status: 503,
        error: { kind: "CAPACITY", message: "Busy." },
      }),
    );
    const { result } = renderHook(() =>
      useSimulationExecution("https://api.example.com", { simulateImpl }),
    );

    act(() => {
      result.current.submit(request());
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    expect(result.current.state).toMatchObject({ error: { kind: "CAPACITY" } });
  });
});

describe("useSimulationExecution — cancel (UI-UT-EXEC-HOOK-002)", () => {
  it("aborts the in-flight request and transitions to cancelled once the promise settles", async () => {
    const pending = deferred<SimulationApiResult>();
    const simulateImpl = vi.fn<
      (req: BattleSimulationRequest, options: SimulateOptions) => Promise<SimulationApiResult>
    >(() => pending.promise);
    const { result } = renderHook(() =>
      useSimulationExecution("https://api.example.com", { simulateImpl }),
    );

    act(() => {
      result.current.submit(request());
    });
    const signal = simulateImpl.mock.calls[0]![1].signal;
    expect(signal.aborted).toBe(false);

    act(() => {
      result.current.cancel();
    });
    expect(signal.aborted).toBe(true);

    pending.resolve({ ok: false, error: { kind: "CANCELLED", message: "cancelled" } });
    await waitFor(() => {
      expect(result.current.state.status).toBe("cancelled");
    });
  });

  it("aborts the in-flight request on unmount", () => {
    const pending = deferred<SimulationApiResult>();
    const simulateImpl = vi.fn<
      (req: BattleSimulationRequest, options: SimulateOptions) => Promise<SimulationApiResult>
    >(() => pending.promise);
    const { result, unmount } = renderHook(() =>
      useSimulationExecution("https://api.example.com", { simulateImpl }),
    );

    act(() => {
      result.current.submit(request());
    });
    const signal = simulateImpl.mock.calls[0]![1].signal;

    unmount();

    expect(signal.aborted).toBe(true);
  });
});

describe("useSimulationExecution — stale response guard (UI-CMP-002)", () => {
  it("ignores a delayed response from a superseded execution after rerun", async () => {
    const first = deferred<SimulationApiResult>();
    const second = deferred<SimulationApiResult>();
    const simulateImpl = vi
      .fn<
        (req: BattleSimulationRequest, options: SimulateOptions) => Promise<SimulationApiResult>
      >()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() =>
      useSimulationExecution("https://api.example.com", { simulateImpl }),
    );

    act(() => {
      result.current.submit(request());
    });
    const firstSignal = simulateImpl.mock.calls[0]![1].signal;

    act(() => {
      result.current.submit(request({ turnLimit: 42 }));
    });
    expect(firstSignal.aborted).toBe(true);

    second.resolve({ ok: true, response: response() });
    await waitFor(() => {
      expect(result.current.state.status).toBe("succeeded");
    });

    first.resolve({ ok: false, error: { kind: "CANCELLED", message: "stale" } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.current.state.status).toBe("succeeded");
  });
});
