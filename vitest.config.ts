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
        "src/bootstrap/**",
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
