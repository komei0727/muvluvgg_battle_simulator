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

  it("CFG-003 (レビュー指摘: SIMULATION_TIMEOUT_MS=abc -> Number() -> NaN -> deadline calculations silently disabled): throws ConfigError instead of producing NaN when SIMULATION_TIMEOUT_MS is not numeric", () => {
    expect(() => loadConfig(envWith({ SIMULATION_TIMEOUT_MS: "abc" }))).toThrow(ConfigError);
  });

  it("CFG-004 (レビュー指摘: WORKER_MAX_QUEUE=Infinity -> Number() -> Infinity -> bounded queue要件に反して無制限になる): throws ConfigError instead of accepting a non-finite WORKER_MAX_QUEUE", () => {
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

  it('CFG-011 (PRレビュー指摘: Number("") === 0のため空文字列のWORKER_MAX_QUEUEが暗黙に0として受理されていた): throws ConfigError for an empty-string WORKER_MAX_QUEUE instead of silently defaulting to 0', () => {
    expect(() => loadConfig(envWith({ WORKER_MAX_QUEUE: "" }))).toThrow(ConfigError);
  });

  it("CFG-012 (PRレビュー指摘: 同上): throws ConfigError for a whitespace-only SHUTDOWN_GRACE_MS", () => {
    expect(() => loadConfig(envWith({ SHUTDOWN_GRACE_MS: "   " }))).toThrow(ConfigError);
  });

  it("CFG-013 (PRレビュー指摘: SHUTDOWN_GRACE_MS=2147483648はNode.jsタイマーの32-bit符号付き整数上限を超え、Piscinaのclose待機が実質1msへオーバーフローする): throws ConfigError when SHUTDOWN_GRACE_MS exceeds the 32-bit timer limit", () => {
    expect(() => loadConfig(envWith({ SHUTDOWN_GRACE_MS: "2147483648" }))).toThrow(ConfigError);
  });

  it("CFG-014: accepts SHUTDOWN_GRACE_MS at exactly the 32-bit timer limit", () => {
    const config = loadConfig(envWith({ SHUTDOWN_GRACE_MS: "2147483647" }));
    expect(config.shutdownGraceMs).toBe(2_147_483_647);
  });
});
