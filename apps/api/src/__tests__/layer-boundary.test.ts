/**
 * UT-LAYER-001 through UT-LAYER-012
 * Verifies that the ESLint no-restricted-imports rules enforce layer boundaries.
 * Type-checked rules are disabled so that lintText works with virtual file paths;
 * no-restricted-imports is syntax-only and does not need type information.
 */
import { ESLint, type Linter } from "eslint";
import tseslint from "typescript-eslint";
import { beforeAll, describe, expect, it } from "vitest";

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({
    cwd: new URL("../..", import.meta.url).pathname,
    overrideConfig: [
      // Disable all type-checked rules so virtual-path lintText calls succeed.
      tseslint.configs.disableTypeChecked,
    ],
  });
});

function violationsOf(results: ESLint.LintResult[], ruleId: string): Linter.LintMessage[] {
  return results.flatMap((r) => r.messages).filter((m) => m.ruleId === ruleId);
}

describe("Layer boundary — domain", () => {
  it("UT-LAYER-001: domain cannot import from infrastructure", async () => {
    const results = await eslint.lintText(
      "import type {} from '../../infrastructure/repos/sentinel.js';\n",
      { filePath: "src/domain/value-objects/bad.ts" },
    );
    const violations = violationsOf(results, "no-restricted-imports");
    expect(violations.length).toBeGreaterThan(0);
  });

  it("UT-LAYER-002: domain cannot import from application", async () => {
    const results = await eslint.lintText(
      "import type {} from '../../application/simulation/sentinel.js';\n",
      {
        filePath: "src/domain/value-objects/bad.ts",
      },
    );
    const violations = violationsOf(results, "no-restricted-imports");
    expect(violations.length).toBeGreaterThan(0);
  });

  it("UT-LAYER-003: domain cannot import Node.js built-in modules (node: prefix)", async () => {
    const results = await eslint.lintText("import { readFileSync } from 'node:fs';\n", {
      filePath: "src/domain/value-objects/bad.ts",
    });
    const violations = violationsOf(results, "no-restricted-imports");
    expect(violations.length).toBeGreaterThan(0);
  });

  it("UT-LAYER-008: domain cannot import Node.js built-in modules (bare name)", async () => {
    const results = await eslint.lintText(
      [
        "import fs from 'fs';",
        "import path from 'path';",
        "import { randomUUID } from 'crypto';",
      ].join("\n") + "\n",
      { filePath: "src/domain/value-objects/bad.ts" },
    );
    const violations = violationsOf(results, "no-restricted-imports");
    expect(violations.length).toBeGreaterThanOrEqual(3);
  });

  it("UT-LAYER-012: domain cannot import Node.js built-in modules not in previous fixture (constants)", async () => {
    const results = await eslint.lintText("import constants from 'constants';\n", {
      filePath: "src/domain/value-objects/bad.ts",
    });
    const violations = violationsOf(results, "no-restricted-imports");
    expect(violations.length).toBeGreaterThan(0);
  });

  it("UT-LAYER-004: domain CAN import from within domain", async () => {
    const results = await eslint.lintText("import type {} from '../entities/index.js';\n", {
      filePath: "src/domain/value-objects/ok.ts",
    });
    const violations = violationsOf(results, "no-restricted-imports");
    expect(violations).toHaveLength(0);
  });
});

describe("Layer boundary — application", () => {
  it("UT-LAYER-005: application cannot import from infrastructure", async () => {
    const results = await eslint.lintText(
      "import type {} from '../../infrastructure/repos/sentinel.js';\n",
      { filePath: "src/application/use-cases/bad.ts" },
    );
    const violations = violationsOf(results, "no-restricted-imports");
    expect(violations.length).toBeGreaterThan(0);
  });

  it("UT-LAYER-006: application CAN import from domain", async () => {
    const results = await eslint.lintText(
      "import type {} from '../../domain/battle/model/sentinel.js';\n",
      {
        filePath: "src/application/use-cases/ok.ts",
      },
    );
    const violations = violationsOf(results, "no-restricted-imports");
    expect(violations).toHaveLength(0);
  });
});

describe("Layer boundary — presentation", () => {
  it("UT-LAYER-009: presentation cannot import from domain", async () => {
    const results = await eslint.lintText(
      "import type {} from '../../domain/battle/model/sentinel.js';\n",
      {
        filePath: "src/presentation/handlers/bad.ts",
      },
    );
    const violations = violationsOf(results, "no-restricted-imports");
    expect(violations.length).toBeGreaterThan(0);
  });
});

describe("Layer boundary — infrastructure", () => {
  it("UT-LAYER-010: infrastructure cannot import from presentation", async () => {
    const results = await eslint.lintText("import type {} from '../../presentation/index.js';\n", {
      filePath: "src/infrastructure/repos/bad.ts",
    });
    const violations = violationsOf(results, "no-restricted-imports");
    expect(violations.length).toBeGreaterThan(0);
  });

  it("UT-LAYER-011: infrastructure cannot import from bootstrap", async () => {
    const results = await eslint.lintText("import type {} from '../../bootstrap/index.js';\n", {
      filePath: "src/infrastructure/repos/bad.ts",
    });
    const violations = violationsOf(results, "no-restricted-imports");
    expect(violations.length).toBeGreaterThan(0);
  });
});

describe("Layer boundary — bootstrap", () => {
  it("UT-LAYER-007: bootstrap CAN import from all layers", async () => {
    const results = await eslint.lintText(
      [
        "import type {} from '../domain/battle/model/sentinel.js';",
        "import type {} from '../application/simulation/sentinel.js';",
        "import type {} from '../infrastructure/repos/sentinel.js';",
        "import type {} from '../presentation/index.js';",
      ].join("\n") + "\n",
      { filePath: "src/bootstrap/composition-root.ts" },
    );
    const violations = violationsOf(results, "no-restricted-imports");
    expect(violations).toHaveLength(0);
  });
});
