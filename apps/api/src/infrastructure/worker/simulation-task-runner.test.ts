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

function buildTask(
  overrides: Partial<Extract<WorkerSimulationTask, { mode: "BATTLE_SIMULATION" }>> = {},
): WorkerSimulationTask {
  const catalog = loadCatalogFromDirectory(CATALOG_DIR);
  return {
    mode: "BATTLE_SIMULATION",
    requestId: "req-1",
    request: minimalRequest(),
    deadlineEpochMs: Date.now() + 30_000,
    expectedCatalogRevision: catalog.catalogRevision,
    ...overrides,
  };
}

/** 敵ちょうど1体・メモリーなし・`turnLimit`を持たない演習タスク（R-TEX-01）。 */
function buildExerciseTask(
  overrides: Partial<Extract<WorkerSimulationTask, { mode: "TACTICAL_EXERCISE" }>> = {},
): WorkerSimulationTask {
  const catalog = loadCatalogFromDirectory(CATALOG_DIR);
  const { turnLimit: _turnLimit, ...request } = minimalRequest();
  return {
    mode: "TACTICAL_EXERCISE",
    requestId: "req-exercise-1",
    request,
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
    if (outcome.ok && outcome.mode === "BATTLE_SIMULATION") {
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
  it("UT-TASKRUNNER-006 (R-TEX-01 #4): dispatches a TACTICAL_EXERCISE task to the exercise use case and returns an exercise result tagged with the same mode", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const runner = createSimulationTaskRunner(catalog, {
      battleIdGenerator: new FixedBattleIdGenerator(["B_EXERCISE"]),
      randomSourceFactory: new SequenceRandomSourceFactory(Array(500).fill(0.5) as number[]),
      clock: new ManualClock(Date.now()),
    });

    const outcome = runner(buildExerciseTask());

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.mode === "TACTICAL_EXERCISE") {
      expect(outcome.result.battleId).toBe("B_EXERCISE");
      // R-TEX-09 #1: 演習の終了理由は2つだけをとり、規定ターン数5を超えない。
      expect(outcome.result.completedTurn).toBeLessThanOrEqual(5);
      expect(["TURN_LIMIT_REACHED", "ALLY_DEFEATED"]).toContain(outcome.result.completionReason);
      expect(outcome.result.totalScore).toEqual(expect.any(Number));
      expect(outcome.result.breaks).toHaveLength(outcome.result.breakCount);
      expect(outcome.result).not.toHaveProperty("outcome");
    } else {
      expect.fail("expected an ok TACTICAL_EXERCISE outcome");
    }
  });

  it("UT-TASKRUNNER-007: keeps routing BATTLE_SIMULATION tasks to the battle use case, so the exercise mode does not change the existing task's result", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const runner = createSimulationTaskRunner(catalog, {
      battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
      randomSourceFactory: new SequenceRandomSourceFactory(Array(50).fill(0.5) as number[]),
      clock: new ManualClock(Date.now()),
    });

    const outcome = runner(buildTask());

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.mode === "BATTLE_SIMULATION") {
      expect(outcome.result.outcome).toEqual(expect.any(String));
      expect(outcome.result).not.toHaveProperty("totalScore");
    } else {
      expect.fail("expected an ok BATTLE_SIMULATION outcome");
    }
  });

  it("UT-TASKRUNNER-008 (R-TEX-01 #3): rejects an exercise task whose enemy formation is not exactly one memory-less unit with INVALID_COMMAND", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const runner = createSimulationTaskRunner(catalog, {
      battleIdGenerator: new FixedBattleIdGenerator(["B_EXERCISE"]),
      randomSourceFactory: new SequenceRandomSourceFactory(Array(50).fill(0.5) as number[]),
      clock: new ManualClock(Date.now()),
    });

    const outcome = runner(
      buildExerciseTask({
        request: {
          allyFormation: minimalRequest().allyFormation,
          enemyFormation: {
            units: [
              { unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } },
              { unitDefinitionId: "UNIT_001", position: { column: 1, row: "FRONT" } },
            ],
            memoryDefinitionIds: [],
          },
        },
      }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("INVALID_COMMAND");
      expect(outcome.error.violations).toContainEqual(
        expect.objectContaining({ path: "enemyFormation.slots" }),
      );
    }
  });
});
