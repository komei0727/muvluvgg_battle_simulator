/**
 * UT-MOD-001 through UT-MOD-022
 * Verifies that the ESLint `no-restricted-imports` rules enforce the Domain-internal
 * module boundaries fixed by `#132` (04_境界づけられたコンテキスト.md「モジュール依存規則」).
 * Mirrors the approach in layer-boundary.test.ts: type-checked rules are disabled so
 * that lintText works with virtual file paths, since no-restricted-imports is
 * syntax-only and does not need type information.
 */
import { ESLint, type Linter } from "eslint";
import tseslint from "typescript-eslint";
import { beforeAll, describe, expect, it } from "vitest";

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({
    cwd: new URL("../..", import.meta.url).pathname,
    overrideConfig: [tseslint.configs.disableTypeChecked],
  });
});

function violationsOf(results: ESLint.LintResult[], ruleId: string): Linter.LintMessage[] {
  return results.flatMap((r) => r.messages).filter((m) => m.ruleId === ruleId);
}

async function lint(code: string, filePath: string): Promise<Linter.LintMessage[]> {
  const results = await eslint.lintText(code, { filePath });
  return violationsOf(results, "no-restricted-imports");
}

describe("Module boundary — domain/catalog", () => {
  it("UT-MOD-001: catalog cannot import from formation", async () => {
    const violations = await lint(
      "import type {} from '../formation/formation-factory.js';\n",
      "src/domain/catalog/definitions/bad.ts",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it("UT-MOD-002: catalog cannot import from battle (including battle/model)", async () => {
    const violations = await lint(
      "import type {} from '../battle/model/battle-party.js';\n",
      "src/domain/catalog/definitions/bad.ts",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it("UT-MOD-003: catalog CAN import from shared and within catalog", async () => {
    const violations = await lint(
      [
        "import type {} from '../../shared/ids.js';",
        "import type {} from '../integrity/catalog-integrity.js';",
      ].join("\n") + "\n",
      "src/domain/catalog/definitions/ok.ts",
    );
    expect(violations).toHaveLength(0);
  });
});

describe("Module boundary — domain/formation", () => {
  it("UT-MOD-004: formation cannot import from battle/* other than battle/model", async () => {
    const violations = await lint(
      "import type {} from '../battle/outcome/victory-policy.js';\n",
      "src/domain/formation/bad.ts",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it("UT-MOD-005: formation CAN import from battle/model", async () => {
    const violations = await lint(
      "import type {} from '../battle/model/battle-party.js';\n",
      "src/domain/formation/ok.ts",
    );
    expect(violations).toHaveLength(0);
  });
});

describe("Module boundary — domain/battle/model", () => {
  it("UT-MOD-006: battle/model cannot import from another battle/* submodule (outcome)", async () => {
    const violations = await lint(
      "import type {} from '../outcome/victory-policy.js';\n",
      "src/domain/battle/model/bad.ts",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it("UT-MOD-007: battle/model cannot import from battle/lifecycle", async () => {
    const violations = await lint(
      "import type {} from '../lifecycle/battle.js';\n",
      "src/domain/battle/model/bad.ts",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it("UT-MOD-008: battle/model cannot import from formation (reverse dependency)", async () => {
    const violations = await lint(
      "import type {} from '../../formation/formation-factory.js';\n",
      "src/domain/battle/model/bad.ts",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it("UT-MOD-009: battle/model CAN import from catalog and shared", async () => {
    const violations = await lint(
      [
        "import type {} from '../../catalog/definitions/catalog-ids.js';",
        "import type {} from '../../shared/ids.js';",
        "import type {} from './battle-party.js';",
      ].join("\n") + "\n",
      "src/domain/battle/model/ok.ts",
    );
    expect(violations).toHaveLength(0);
  });
});

describe("Module boundary — domain/battle/events", () => {
  it("UT-MOD-010: battle/events cannot import from battle/combat", async () => {
    const violations = await lint(
      "import type {} from '../combat/damage-calculator.js';\n",
      "src/domain/battle/events/bad.ts",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it("UT-MOD-011: battle/events cannot import from battle/lifecycle", async () => {
    const violations = await lint(
      "import type {} from '../lifecycle/battle.js';\n",
      "src/domain/battle/events/bad.ts",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it("UT-MOD-012: battle/events cannot import from battle/triggering", async () => {
    const violations = await lint(
      "import type {} from '../triggering/passive-trigger-matcher.js';\n",
      "src/domain/battle/events/bad.ts",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it("UT-MOD-013: battle/events cannot import from battle/effects", async () => {
    const violations = await lint(
      "import type {} from '../effects/applied-effect.js';\n",
      "src/domain/battle/events/bad.ts",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it("UT-MOD-014: battle/events CAN import from battle/model, battle/action, and battle/outcome", async () => {
    const violations = await lint(
      [
        "import type {} from '../model/battle-status.js';",
        "import type {} from '../action/action-queue.js';",
        "import type {} from '../outcome/victory-policy.js';",
      ].join("\n") + "\n",
      "src/domain/battle/events/ok.ts",
    );
    expect(violations).toHaveLength(0);
  });
});

describe("Module boundary — domain/battle/effects and domain/battle/combat", () => {
  it("UT-MOD-015: battle/effects cannot import from battle/combat", async () => {
    const violations = await lint(
      "import type {} from '../combat/damage-calculator.js';\n",
      "src/domain/battle/effects/bad.ts",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it("UT-MOD-016: battle/combat cannot import from battle/effects", async () => {
    const violations = await lint(
      "import type {} from '../effects/applied-effect.js';\n",
      "src/domain/battle/combat/bad.ts",
    );
    expect(violations.length).toBeGreaterThan(0);
  });
});

describe("Module boundary — reverse dependency on battle/lifecycle", () => {
  it("UT-MOD-017: battle/action cannot import from battle/lifecycle", async () => {
    const violations = await lint(
      "import type {} from '../lifecycle/battle.js';\n",
      "src/domain/battle/action/bad.ts",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it("UT-MOD-018: battle/combat cannot import from battle/lifecycle", async () => {
    const violations = await lint(
      "import type {} from '../lifecycle/battle.js';\n",
      "src/domain/battle/combat/bad.ts",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it("UT-MOD-019: battle/lifecycle CAN import from every other battle/* submodule", async () => {
    const violations = await lint(
      [
        "import type {} from '../model/battle-party.js';",
        "import type {} from '../outcome/victory-policy.js';",
        "import type {} from '../targeting/target-selection-policy.js';",
        "import type {} from '../action/action-queue.js';",
        "import type {} from '../skill/skill-resolution-service.js';",
        "import type {} from '../events/event-recorder.js';",
        "import type {} from '../combat/damage-application-service.js';",
      ].join("\n") + "\n",
      "src/domain/battle/lifecycle/ok.ts",
    );
    expect(violations).toHaveLength(0);
  });
});

describe("Module boundary — Domain Layer rules still apply inside every module-specific block", () => {
  // Regression coverage: ESLint Flat config replaces (rather than merges) `rules` for configs
  // whose `files` glob matches the same file. Each module-specific block below overlaps with
  // the generic `src/domain/**` Layer boundary block, so if a module-specific block's
  // `no-restricted-imports` entry ever stopped including the Domain Layer patterns
  // (`domainRestrictedImports` in eslint.config.mjs), imports from application/infrastructure/
  // presentation/bootstrap and Node.js built-ins would silently pass lint inside that module —
  // exactly as previously happened until domainLayerPatterns was folded into every block.
  const moduleSpecificDirs = [
    "src/domain/catalog/definitions",
    "src/domain/formation",
    "src/domain/battle/model",
    "src/domain/battle/outcome",
    "src/domain/battle/targeting",
    "src/domain/battle/action",
    "src/domain/battle/skill",
    "src/domain/battle/events",
    "src/domain/battle/combat",
    "src/domain/battle/effects",
    "src/domain/battle/triggering",
    "src/domain/battle/lifecycle",
  ];

  it.each(moduleSpecificDirs)(
    "UT-MOD-021: %s cannot import from application (Layer rule)",
    async (dir) => {
      const violations = await lint(
        "import type {} from '../../../../application/simulation/sentinel.js';\n",
        `${dir}/bad.ts`,
      );
      expect(violations.length).toBeGreaterThan(0);
    },
  );

  it.each(moduleSpecificDirs)(
    "UT-MOD-022: %s cannot import Node.js built-in modules (Layer rule)",
    async (dir) => {
      const violations = await lint("import { readFileSync } from 'node:fs';\n", `${dir}/bad.ts`);
      expect(violations.length).toBeGreaterThan(0);
    },
  );
});

describe("Module boundary — presentation cannot depend on domain directly", () => {
  it("UT-MOD-020: presentation cannot import from domain (existing Layer rule)", async () => {
    const violations = await lint(
      "import type {} from '../../domain/battle/model/battle-party.js';\n",
      "src/presentation/http/routes/bad.ts",
    );
    expect(violations.length).toBeGreaterThan(0);
  });
});
