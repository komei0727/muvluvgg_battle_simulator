import { defineConfig } from "vitest/config";

// Unit, scenario, property, and contract tests — runs on every PR.
// Integration, e2e, and load tests use their own configs.
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    exclude: ["src/**/*.integration.test.ts", "src/**/*.e2e.test.ts", "src/**/*.load.test.ts"],
    passWithNoTests: false,
    globals: false,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.{test,spec}.ts",
        "src/**/*.integration.test.ts",
        "src/**/*.e2e.test.ts",
        "src/**/*.load.test.ts",
        "src/main.ts",
        // Test-support code (fixtures, scenario/property helpers, traceability
        // tooling): always exercised by the tests that import it, so it reads
        // as artificially high and inflates the denominator (Issue #593).
        "src/testing/**",
        "src/**/__fixtures__/**",
        // Real `worker_threads` runtime behavior (spawn, crash recovery, pool
        // capacity) — verified by *.integration.test.ts, not unit-testable
        // without mocking away the behavior under test (Issue #593).
        "src/infrastructure/worker/simulation-worker-pool.ts",
        "src/infrastructure/worker/simulation-worker-entry.ts",
        // CLI entry points invoked by `mise run` deploy tasks (argv/env
        // wiring only); verified operationally, same rationale as `main.ts`
        // (Issue #593).
        "src/infrastructure/deploy/build-simulation-smoke-request-cli.ts",
        "src/infrastructure/deploy/render-cloud-run-manifest-cli.ts",
        "src/infrastructure/deploy/resolve-current-revision-cli.ts",
        "src/infrastructure/deploy/resolve-tagged-revision-cli.ts",
      ],
      // Floor is baseline (measured after the Issue #593 population fix:
      // lines 94.66 / branches 89.83 / functions 97.45 / statements 94.70)
      // minus a ~3pt regression margin, rounded down. Raise stepwise as the
      // suite grows; never lower to admit a regression (12_テスト戦略.md「品質ゲート」).
      thresholds: { lines: 91, functions: 94, branches: 86, statements: 91 },
    },
  },
});
