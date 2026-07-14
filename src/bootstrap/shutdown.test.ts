import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ShutdownState,
  installShutdownSignalHandlers,
  runGracefulShutdown,
  type GracefulShutdownDeps,
} from "./shutdown.js";

function fakeDeps(): GracefulShutdownDeps & {
  readonly appCloseCalls: number[];
  readonly poolShutdownCalls: number[];
} {
  const appCloseCalls: number[] = [];
  const poolShutdownCalls: number[] = [];
  let sequence = 0;
  return {
    app: {
      close: () => {
        appCloseCalls.push(sequence++);
        return Promise.resolve();
      },
      log: { info: () => undefined, error: () => undefined },
    },
    pool: {
      shutdown: () => {
        poolShutdownCalls.push(sequence++);
        return Promise.resolve();
      },
    },
    shutdownState: new ShutdownState(),
    appCloseCalls,
    poolShutdownCalls,
  };
}

describe("ShutdownState", () => {
  it("GS-001: starts not shutting down, and latches to true once marked", () => {
    const state = new ShutdownState();
    expect(state.isShuttingDown()).toBe(false);
    state.markShuttingDown();
    expect(state.isShuttingDown()).toBe(true);
  });
});

describe("runGracefulShutdown", () => {
  it("GS-002 (11_インフラストラクチャ設計.md「Graceful Shutdown」ステップ1「readinessを失敗へ変更する」): marks shutdownState before awaiting anything, so /health/ready can observe it immediately", async () => {
    const deps = fakeDeps();

    const promise = runGracefulShutdown(deps);

    // `markShuttingDown()` runs synchronously before the first await, so this
    // is already true even though the returned promise hasn't settled yet.
    expect(deps.shutdownState.isShuttingDown()).toBe(true);

    await promise;
  });

  it("GS-003 (11_インフラストラクチャ設計.md「Graceful Shutdown」ステップ3-7): closes the HTTP server and shuts down the Worker Pool concurrently, not one after the other", async () => {
    const events: string[] = [];
    let resolveAppClose: () => void = () => undefined;
    let resolvePoolShutdown: () => void = () => undefined;
    const deps: GracefulShutdownDeps = {
      app: {
        close: () =>
          new Promise<void>((resolve) => {
            events.push("app.close called");
            resolveAppClose = resolve;
          }),
        log: { info: () => undefined, error: () => undefined },
      },
      pool: {
        shutdown: () =>
          new Promise<void>((resolve) => {
            events.push("pool.shutdown called");
            resolvePoolShutdown = resolve;
          }),
      },
      shutdownState: new ShutdownState(),
    };

    const promise = runGracefulShutdown(deps);

    // Both were invoked before either resolved — proves they run
    // concurrently rather than app.close() gating pool.shutdown().
    expect(events).toEqual(["app.close called", "pool.shutdown called"]);

    resolveAppClose();
    resolvePoolShutdown();
    await promise;
  });

  it("GS-004: resolves only once both app.close() and pool.shutdown() have settled", async () => {
    const deps = fakeDeps();
    await runGracefulShutdown(deps);
    expect(deps.appCloseCalls).toHaveLength(1);
    expect(deps.poolShutdownCalls).toHaveLength(1);
  });
});

describe("installShutdownSignalHandlers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureOnceHandlers(): Map<string, (...args: unknown[]) => void> {
    const captured = new Map<string, (...args: unknown[]) => void>();
    vi.spyOn(process, "once").mockImplementation(((
      event: string,
      listener: (...args: unknown[]) => void,
    ) => {
      captured.set(event, listener);
      return process;
    }) as typeof process.once);
    return captured;
  }

  it("GS-005: registers exactly one SIGTERM and one SIGINT handler", () => {
    const captured = captureOnceHandlers();
    installShutdownSignalHandlers(fakeDeps());

    expect([...captured.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
  });

  function spyOnExit(): { exited: Promise<void>; exitCode: () => number | undefined } {
    let exitCode: number | undefined;
    const exited = new Promise<void>((resolve) => {
      vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        exitCode = code;
        resolve();
        return undefined as never;
      }) as typeof process.exit);
    });
    return { exited, exitCode: () => exitCode };
  }

  it("GS-006: SIGTERM runs the graceful shutdown sequence exactly once and exits 0 — this never touches the real process EventEmitter (the captured handler is invoked directly), so it cannot interfere with the test runner's own signal handling", async () => {
    const captured = captureOnceHandlers();
    const { exited, exitCode } = spyOnExit();
    const deps = fakeDeps();

    installShutdownSignalHandlers(deps);
    captured.get("SIGTERM")?.("SIGTERM");
    await exited;

    expect(deps.appCloseCalls).toHaveLength(1);
    expect(deps.poolShutdownCalls).toHaveLength(1);
    expect(deps.shutdownState.isShuttingDown()).toBe(true);
    expect(exitCode()).toBe(0);
  });

  it("GS-007: a second signal after the first is ignored (shutdown does not run twice)", async () => {
    const captured = captureOnceHandlers();
    const { exited } = spyOnExit();
    const deps = fakeDeps();

    installShutdownSignalHandlers(deps);
    captured.get("SIGTERM")?.("SIGTERM");
    captured.get("SIGINT")?.("SIGINT");
    await exited;

    expect(deps.appCloseCalls).toHaveLength(1);
    expect(deps.poolShutdownCalls).toHaveLength(1);
  });

  it("GS-008: if the shutdown sequence itself throws, it logs the error and exits 1 rather than hanging", async () => {
    const captured = captureOnceHandlers();
    let exitCode: number | undefined;
    const exited = new Promise<void>((resolve) => {
      vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        exitCode = code;
        resolve();
        return undefined as never;
      }) as typeof process.exit);
    });
    const errorLog: unknown[] = [];
    const deps: GracefulShutdownDeps = {
      app: {
        close: () => Promise.reject(new Error("close failed")),
        log: { info: () => undefined, error: (payload: unknown) => errorLog.push(payload) },
      },
      pool: { shutdown: () => Promise.resolve() },
      shutdownState: new ShutdownState(),
    };

    installShutdownSignalHandlers(deps);
    captured.get("SIGTERM")?.("SIGTERM");
    await exited;

    expect(errorLog).toHaveLength(1);
    expect(exitCode).toBe(1);
  });
});
