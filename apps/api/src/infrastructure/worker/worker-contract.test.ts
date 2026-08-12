import { describe, expect, it } from "vitest";
import { ApplicationError } from "../../application/contracts/application-error.js";
import {
  toApplicationError,
  toSerializedApplicationError,
  type WorkerSimulationTask,
} from "./worker-contract.js";

const MINIMAL_FORMATION = {
  units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
  memoryDefinitionIds: [],
};

describe("worker-contract serialization", () => {
  it("UT-WORKERCONTRACT-001: toSerializedApplicationError() keeps code and violations, omits absent diagnosticId", () => {
    const error = new ApplicationError("INVALID_COMMAND", [
      { path: "turnLimit", reason: "must be positive" },
    ]);

    const serialized = toSerializedApplicationError(error);

    expect(serialized).toEqual({
      code: "INVALID_COMMAND",
      violations: [{ path: "turnLimit", reason: "must be positive" }],
    });
    expect(serialized).not.toHaveProperty("diagnosticId");
  });

  it("UT-WORKERCONTRACT-002: toSerializedApplicationError() carries diagnosticId when present", () => {
    const error = new ApplicationError("INTERNAL_INVARIANT_VIOLATION", [], "diag-1");

    const serialized = toSerializedApplicationError(error);

    expect(serialized.diagnosticId).toBe("diag-1");
  });

  it("UT-WORKERCONTRACT-003: toApplicationError() round-trips a serialized error back into an ApplicationError", () => {
    const original = new ApplicationError("DEFINITION_NOT_FOUND", [
      { path: "allyFormation.slots[0].unitDefinitionId", reason: "unknown Unit definition" },
    ]);

    const restored = toApplicationError(toSerializedApplicationError(original));

    expect(restored).toBeInstanceOf(ApplicationError);
    expect(restored.code).toBe(original.code);
    expect(restored.violations).toEqual(original.violations);
    expect(restored.diagnosticId).toBeUndefined();
  });

  it("UT-WORKERCONTRACT-004: toApplicationError() round-trips a present diagnosticId", () => {
    const restored = toApplicationError({
      code: "INTERNAL_INVARIANT_VIOLATION",
      violations: [{ reason: "unexpected worker failure" }],
      diagnosticId: "diag-2",
    });

    expect(restored.diagnosticId).toBe("diag-2");
  });

  it("UT-WORKERCONTRACT-005: a BATTLE_SIMULATION task keeps its discriminator and turnLimit across the structured clone of the thread boundary", () => {
    const task: WorkerSimulationTask = {
      mode: "BATTLE_SIMULATION",
      requestId: "req-1",
      request: {
        allyFormation: MINIMAL_FORMATION,
        enemyFormation: MINIMAL_FORMATION,
        turnLimit: 3,
      },
      deadlineEpochMs: 1_000,
      expectedCatalogRevision: "rev-1",
    };

    const cloned = structuredClone(task);

    expect(cloned).toEqual(task);
    expect(cloned.mode).toBe("BATTLE_SIMULATION");
    if (cloned.mode === "BATTLE_SIMULATION") {
      expect(cloned.request.turnLimit).toBe(3);
    }
  });

  it("UT-WORKERCONTRACT-006 (R-TEX-01 #4): a TACTICAL_EXERCISE task keeps its discriminator across the structured clone and carries no turnLimit", () => {
    const task: WorkerSimulationTask = {
      mode: "TACTICAL_EXERCISE",
      requestId: "req-2",
      request: { allyFormation: MINIMAL_FORMATION, enemyFormation: MINIMAL_FORMATION },
      deadlineEpochMs: 2_000,
      expectedCatalogRevision: "rev-1",
    };

    const cloned = structuredClone(task);

    expect(cloned).toEqual(task);
    expect(cloned.mode).toBe("TACTICAL_EXERCISE");
    expect(cloned.request).not.toHaveProperty("turnLimit");
  });
});
