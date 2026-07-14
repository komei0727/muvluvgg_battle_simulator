import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createSimulationTaskRunner } from "./simulation-task-runner.js";
import type { WorkerSimulationTask } from "./worker-contract.js";
import { loadCatalogFromDirectory } from "../catalog/runtime/catalog-file-loader.js";
import { FixedBattleIdGenerator } from "../../testing/id/fixed-battle-id-generator.js";
import { ManualClock } from "../../testing/clock/manual-clock.js";
import { SequenceRandomSourceFactory } from "../../testing/random/sequence-random-source-factory.js";

function fixturePath(...segments: string[]): string {
  return fileURLToPath(new URL(`../catalog/__fixtures__/${segments.join("/")}`, import.meta.url));
}

const CATALOG_DIR = fixturePath("runtime", "valid", "minimal");

function minimalRequest(overrides: Record<string, unknown> = {}) {
  return {
    allyFormation: {
      units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
      memoryDefinitionIds: [],
    },
    enemyFormation: {
      units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
      memoryDefinitionIds: [],
    },
    turnLimit: 3,
    ...overrides,
  };
}

function buildTask(overrides: Partial<WorkerSimulationTask> = {}): WorkerSimulationTask {
  const catalog = loadCatalogFromDirectory(CATALOG_DIR);
  return {
    requestId: "req-1",
    request: minimalRequest(),
    deadlineEpochMs: Date.now() + 30_000,
    expectedCatalogRevision: catalog.catalogRevision,
    ...overrides,
  };
}

describe("createSimulationTaskRunner", () => {
  it("UT-TASKRUNNER-001: runs a minimal battle end-to-end and returns ok:true with the assembled result", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const runner = createSimulationTaskRunner(catalog, {
      battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
      randomSourceFactory: new SequenceRandomSourceFactory(Array(50).fill(0.5) as number[]),
      clock: new ManualClock(Date.now()),
    });

    const outcome = runner(buildTask({ expectedCatalogRevision: catalog.catalogRevision }));

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.battleId).toBe("B_1");
      expect(outcome.result.catalogRevision).toBe(catalog.catalogRevision);
      expect(outcome.result.outcome).toEqual(expect.any(String));
    }
  });

  it("UT-TASKRUNNER-002: returns ok:false INVALID_DEFINITION when expectedCatalogRevision does not match the worker's loaded Catalog (11_インフラストラクチャ設計.md「Catalogリビジョンの一致」)", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const runner = createSimulationTaskRunner(catalog, {
      battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
      randomSourceFactory: new SequenceRandomSourceFactory(Array(50).fill(0.5) as number[]),
      clock: new ManualClock(Date.now()),
    });

    const outcome = runner(buildTask({ expectedCatalogRevision: "some-other-revision" }));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("INVALID_DEFINITION");
      expect(outcome.error.violations.length).toBeGreaterThan(0);
    }
  });

  it("UT-TASKRUNNER-003: converts an ApplicationError thrown by the UseCase into a serialized ok:false result", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const runner = createSimulationTaskRunner(catalog, {
      battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
      randomSourceFactory: new SequenceRandomSourceFactory(Array(50).fill(0.5) as number[]),
      clock: new ManualClock(Date.now()),
    });

    const outcome = runner(
      buildTask({
        expectedCatalogRevision: catalog.catalogRevision,
        request: minimalRequest({ turnLimit: 0 }),
      }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("INVALID_COMMAND");
    }
  });

  it("UT-TASKRUNNER-005 (11_インフラストラクチャ設計.md「キャンセルと期限」段階1): returns ok:false EXECUTION_TIMEOUT when the injected Clock has already passed task.deadlineEpochMs, without completing the Battle", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const clock = new ManualClock(1_000);
    const runner = createSimulationTaskRunner(catalog, {
      battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
      randomSourceFactory: new SequenceRandomSourceFactory(Array(50).fill(0.5) as number[]),
      clock,
    });

    const outcome = runner(
      buildTask({ expectedCatalogRevision: catalog.catalogRevision, deadlineEpochMs: 999 }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("EXECUTION_TIMEOUT");
    }
  });

  it("UT-TASKRUNNER-004 (11_インフラストラクチャ設計.md「ワーカー障害」): converts an unexpected non-ApplicationError into a safe INTERNAL_INVARIANT_VIOLATION with a diagnosticId, without leaking the original message", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const catalog = loadCatalogFromDirectory(CATALOG_DIR);
      const runner = createSimulationTaskRunner(catalog, {
        battleIdGenerator: {
          next: () => {
            throw new Error("sensitive internal detail");
          },
        },
        randomSourceFactory: new SequenceRandomSourceFactory(Array(50).fill(0.5) as number[]),
        clock: new ManualClock(Date.now()),
      });

      const outcome = runner(buildTask({ expectedCatalogRevision: catalog.catalogRevision }));

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.code).toBe("INTERNAL_INVARIANT_VIOLATION");
        expect(outcome.error.diagnosticId).toEqual(expect.any(String));
        expect(JSON.stringify(outcome.error)).not.toContain("sensitive internal detail");
      }
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
