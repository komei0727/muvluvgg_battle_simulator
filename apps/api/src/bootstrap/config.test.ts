import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

function envWith(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...overrides };
}

describe("loadConfig", () => {
  it("CFG-001: returns the documented defaults when no relevant environment variables are set", () => {
    const config = loadConfig(envWith({}));

    expect(config).toMatchObject({
      port: 3000,
      host: "0.0.0.0",
      catalogDir: "catalog",
      simulationTimeoutMs: 30_000,
      workerMaxQueue: 100,
      shutdownGraceMs: 30_000,
      logLevel: "info",
      docsEnabled: true,
    });
  });

  it("CFG-002: parses valid overrides for every M4 numeric setting", () => {
    const config = loadConfig(
      envWith({
        PORT: "8080",
        SIMULATION_TIMEOUT_MS: "15000",
        WORKER_MAX_QUEUE: "50",
        SHUTDOWN_GRACE_MS: "5000",
      }),
    );

    expect(config.port).toBe(8080);
    expect(config.simulationTimeoutMs).toBe(15_000);
    expect(config.workerMaxQueue).toBe(50);
    expect(config.shutdownGraceMs).toBe(5_000);
  });

  it("CFG-003 (SIMULATION_TIMEOUT_MS=abc -> Number() -> NaN -> deadline calculations silently disabled): throws ConfigError instead of producing NaN when SIMULATION_TIMEOUT_MS is not numeric", () => {
    expect(() => loadConfig(envWith({ SIMULATION_TIMEOUT_MS: "abc" }))).toThrow(ConfigError);
  });

  it("CFG-004 (WORKER_MAX_QUEUE=Infinity -> Number() -> Infinity -> bounded queue要件に反して無制限になる): throws ConfigError instead of accepting a non-finite WORKER_MAX_QUEUE", () => {
    expect(() => loadConfig(envWith({ WORKER_MAX_QUEUE: "Infinity" }))).toThrow(ConfigError);
  });

  it("CFG-005: throws ConfigError for a negative WORKER_MAX_QUEUE", () => {
    expect(() => loadConfig(envWith({ WORKER_MAX_QUEUE: "-1" }))).toThrow(ConfigError);
  });

  it("CFG-006: accepts WORKER_MAX_QUEUE=0 (a valid Piscina configuration meaning 'reject immediately when all Workers are busy')", () => {
    const config = loadConfig(envWith({ WORKER_MAX_QUEUE: "0" }));
    expect(config.workerMaxQueue).toBe(0);
  });

  it("CFG-007: throws ConfigError for a non-integer numeric value", () => {
    expect(() => loadConfig(envWith({ SIMULATION_TIMEOUT_MS: "1000.5" }))).toThrow(ConfigError);
  });

  it("CFG-008: throws ConfigError for a PORT outside the valid TCP port range", () => {
    expect(() => loadConfig(envWith({ PORT: "70000" }))).toThrow(ConfigError);
  });

  it("CFG-009: throws ConfigError for SIMULATION_TIMEOUT_MS=0 (must be strictly positive)", () => {
    expect(() => loadConfig(envWith({ SIMULATION_TIMEOUT_MS: "0" }))).toThrow(ConfigError);
  });

  it("CFG-010: collects every violation into a single ConfigError instead of failing on the first one", () => {
    try {
      loadConfig(envWith({ SIMULATION_TIMEOUT_MS: "abc", WORKER_MAX_QUEUE: "Infinity" }));
      expect.unreachable("expected loadConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain("SIMULATION_TIMEOUT_MS");
      expect((error as Error).message).toContain("WORKER_MAX_QUEUE");
    }
  });

  it('CFG-011 (Number("") === 0のため空文字列のWORKER_MAX_QUEUEは暗黙に0として受理される): throws ConfigError for an empty-string WORKER_MAX_QUEUE instead of silently defaulting to 0', () => {
    expect(() => loadConfig(envWith({ WORKER_MAX_QUEUE: "" }))).toThrow(ConfigError);
  });

  it("CFG-012 (同上): throws ConfigError for a whitespace-only SHUTDOWN_GRACE_MS", () => {
    expect(() => loadConfig(envWith({ SHUTDOWN_GRACE_MS: "   " }))).toThrow(ConfigError);
  });

  it("CFG-013 (SHUTDOWN_GRACE_MS=2147483648はNode.jsタイマーの32-bit符号付き整数上限を超え、Piscinaのclose待機が実質1msへオーバーフローする): throws ConfigError when SHUTDOWN_GRACE_MS exceeds the 32-bit timer limit", () => {
    expect(() => loadConfig(envWith({ SHUTDOWN_GRACE_MS: "2147483648" }))).toThrow(ConfigError);
  });

  it("CFG-014: accepts SHUTDOWN_GRACE_MS at exactly the 32-bit timer limit", () => {
    const config = loadConfig(envWith({ SHUTDOWN_GRACE_MS: "2147483647" }));
    expect(config.shutdownGraceMs).toBe(2_147_483_647);
  });

  it("CFG-015: returns an empty CORS allowlist when CORS_ALLOWED_ORIGINS is unset", () => {
    const config = loadConfig(envWith({}));
    expect(config.corsAllowedOrigins).toEqual([]);
  });

  it("CFG-016: parses a single valid CORS_ALLOWED_ORIGINS origin", () => {
    const config = loadConfig(envWith({ CORS_ALLOWED_ORIGINS: "https://komei0727.github.io" }));
    expect(config.corsAllowedOrigins).toEqual(["https://komei0727.github.io"]);
  });

  it("CFG-017: parses comma-separated CORS_ALLOWED_ORIGINS and trims whitespace", () => {
    const config = loadConfig(
      envWith({
        CORS_ALLOWED_ORIGINS: " https://komei0727.github.io , http://localhost:5173 ",
      }),
    );
    expect(config.corsAllowedOrigins).toEqual([
      "https://komei0727.github.io",
      "http://localhost:5173",
    ]);
  });

  it("CFG-018 (11_インフラストラクチャ設計.md「wildcard、path、重複、不正URLを拒否する」): throws ConfigError for a wildcard CORS_ALLOWED_ORIGINS entry", () => {
    expect(() => loadConfig(envWith({ CORS_ALLOWED_ORIGINS: "*" }))).toThrow(ConfigError);
  });

  it("CFG-019: throws ConfigError when a CORS_ALLOWED_ORIGINS entry has a path", () => {
    expect(() =>
      loadConfig(envWith({ CORS_ALLOWED_ORIGINS: "https://komei0727.github.io/app" })),
    ).toThrow(ConfigError);
  });

  it("CFG-020: throws ConfigError when a CORS_ALLOWED_ORIGINS entry has a query string", () => {
    expect(() =>
      loadConfig(envWith({ CORS_ALLOWED_ORIGINS: "https://komei0727.github.io?x=1" })),
    ).toThrow(ConfigError);
  });

  it("CFG-021: throws ConfigError when a CORS_ALLOWED_ORIGINS entry has userinfo", () => {
    expect(() =>
      loadConfig(envWith({ CORS_ALLOWED_ORIGINS: "https://user:pass@komei0727.github.io" })),
    ).toThrow(ConfigError);
  });

  it("CFG-022: throws ConfigError for a duplicate CORS_ALLOWED_ORIGINS entry", () => {
    expect(() =>
      loadConfig(
        envWith({
          CORS_ALLOWED_ORIGINS: "https://komei0727.github.io,https://komei0727.github.io",
        }),
      ),
    ).toThrow(ConfigError);
  });

  it("CFG-023: throws ConfigError for a malformed CORS_ALLOWED_ORIGINS entry", () => {
    expect(() => loadConfig(envWith({ CORS_ALLOWED_ORIGINS: "not-a-url" }))).toThrow(ConfigError);
  });

  it("CFG-024: throws ConfigError for a whitespace-only CORS_ALLOWED_ORIGINS", () => {
    expect(() => loadConfig(envWith({ CORS_ALLOWED_ORIGINS: "   " }))).toThrow(ConfigError);
  });

  it("CFG-025: throws ConfigError for an empty CORS_ALLOWED_ORIGINS entry produced by a stray comma", () => {
    expect(() =>
      loadConfig(envWith({ CORS_ALLOWED_ORIGINS: "https://komei0727.github.io,," })),
    ).toThrow(ConfigError);
  });

  it('CFG-026: throws ConfigError for a hostless CORS_ALLOWED_ORIGINS entry (file:///), which would otherwise become the opaque origin "null"', () => {
    expect(() => loadConfig(envWith({ CORS_ALLOWED_ORIGINS: "file:///" }))).toThrow(ConfigError);
  });

  it("CFG-027: throws ConfigError for a hostless CORS_ALLOWED_ORIGINS entry (mailto:)", () => {
    expect(() => loadConfig(envWith({ CORS_ALLOWED_ORIGINS: "mailto:test@example.com" }))).toThrow(
      ConfigError,
    );
  });

  it("CFG-028: throws ConfigError for a CORS_ALLOWED_ORIGINS entry with a trailing slash, which is not an exact scheme+host origin", () => {
    expect(() =>
      loadConfig(envWith({ CORS_ALLOWED_ORIGINS: "https://komei0727.github.io/" })),
    ).toThrow(ConfigError);
  });

  it("CFG-029 (11_インフラストラクチャ設計.md「SimulationExecutionGuard」「上限値は設定から受け取る」): returns the code defaults for every execution guard limit when unset", () => {
    const config = loadConfig(envWith({}));

    expect(config.executionLimits).toEqual({
      maxTotalEvents: 1_000_000,
      maxPassiveDepth: 8,
      maxEffectsPerScope: 100,
      maxEffectRuntimeCounterDepth: 10,
    });
  });

  it("CFG-030: parses overrides for every execution guard limit", () => {
    const config = loadConfig(
      envWith({
        SIMULATION_MAX_EVENTS: "200000",
        SIMULATION_MAX_PASSIVE_DEPTH: "6",
        SIMULATION_MAX_EFFECTS_PER_SCOPE: "40",
        SIMULATION_MAX_EFFECT_RUNTIME_COUNTER_DEPTH: "4",
      }),
    );

    expect(config.executionLimits).toEqual({
      maxTotalEvents: 200_000,
      maxPassiveDepth: 6,
      maxEffectsPerScope: 40,
      maxEffectRuntimeCounterDepth: 4,
    });
  });

  it("CFG-031 (上限0は「1件目で必ず超過する」設定であり、実行保護ではなく全戦闘の停止になる): throws ConfigError for an execution guard limit of 0", () => {
    expect(() => loadConfig(envWith({ SIMULATION_MAX_PASSIVE_DEPTH: "0" }))).toThrow(ConfigError);
    expect(() => loadConfig(envWith({ SIMULATION_MAX_EVENTS: "0" }))).toThrow(ConfigError);
    expect(() => loadConfig(envWith({ SIMULATION_MAX_EFFECTS_PER_SCOPE: "0" }))).toThrow(
      ConfigError,
    );
    expect(() => loadConfig(envWith({ SIMULATION_MAX_EFFECT_RUNTIME_COUNTER_DEPTH: "0" }))).toThrow(
      ConfigError,
    );
  });

  it("CFG-032 (SIMULATION_MAX_EVENTS=Infinityはガードを無効化し、暴走したCatalog定義がプロセスメモリーを食い尽くすまで走る): throws ConfigError for a non-finite execution guard limit", () => {
    expect(() => loadConfig(envWith({ SIMULATION_MAX_EVENTS: "Infinity" }))).toThrow(ConfigError);
  });

  it("CFG-033 (11_インフラストラクチャ設計.md「CPU limitに合わせてWORKER_MAX_THREADSを設定し」): returns undefined worker thread counts when unset so Piscina keeps its own defaults", () => {
    const config = loadConfig(envWith({}));

    expect(config.workerMinThreads).toBeUndefined();
    expect(config.workerMaxThreads).toBeUndefined();
  });

  it("CFG-034: parses WORKER_MIN_THREADS and WORKER_MAX_THREADS", () => {
    const config = loadConfig(envWith({ WORKER_MIN_THREADS: "1", WORKER_MAX_THREADS: "2" }));

    expect(config.workerMinThreads).toBe(1);
    expect(config.workerMaxThreads).toBe(2);
  });

  it("CFG-035 (maxThreads未満のWorkerしか起動できない設定は、Piscinaが起動時に例外を投げる矛盾した構成): throws ConfigError when WORKER_MIN_THREADS exceeds WORKER_MAX_THREADS", () => {
    expect(() => loadConfig(envWith({ WORKER_MIN_THREADS: "3", WORKER_MAX_THREADS: "2" }))).toThrow(
      ConfigError,
    );
  });

  it("CFG-036 (WORKER_MAX_THREADS=0はWorkerを1本も持たないPoolになり、全戦闘が実行されない): throws ConfigError for WORKER_MAX_THREADS=0", () => {
    expect(() => loadConfig(envWith({ WORKER_MAX_THREADS: "0" }))).toThrow(ConfigError);
  });
});

describe("loadConfig — evaluation endpoint", () => {
  it("CFG-037: the evaluation endpoint is disabled unless an environment explicitly opts in", () => {
    expect(loadConfig(envWith({})).evaluationEndpointEnabled).toBe(false);
  });

  it("CFG-038: EVALUATION_ENDPOINT_ENABLED=true opts in", () => {
    expect(
      loadConfig(envWith({ EVALUATION_ENDPOINT_ENABLED: "true" })).evaluationEndpointEnabled,
    ).toBe(true);
  });

  it("CFG-039: a non-boolean EVALUATION_ENDPOINT_ENABLED throws instead of silently disabling the endpoint", () => {
    expect(() => loadConfig(envWith({ EVALUATION_ENDPOINT_ENABLED: "yes" }))).toThrow(ConfigError);
  });

  it("CFG-040: evaluation limits fall back to the measured defaults", () => {
    expect(loadConfig(envWith({})).evaluationLimits).toEqual({
      maxCandidates: 32,
      maxTotalRuns: 300,
    });
  });

  it("CFG-041: evaluation limits accept overrides", () => {
    expect(
      loadConfig(envWith({ EVALUATION_MAX_CANDIDATES: "4", EVALUATION_MAX_TOTAL_RUNS: "40" }))
        .evaluationLimits,
    ).toEqual({ maxCandidates: 4, maxTotalRuns: 40 });
  });

  it("CFG-042: a zero evaluation limit throws instead of producing an endpoint that can never run", () => {
    expect(() => loadConfig(envWith({ EVALUATION_MAX_TOTAL_RUNS: "0" }))).toThrow(ConfigError);
  });
});
