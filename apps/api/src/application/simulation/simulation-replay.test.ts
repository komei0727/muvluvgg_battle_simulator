import { describe, expect, it } from "vitest";
import { validateSimulationReplay, type SimulationReplayRequest } from "./simulation-replay.js";

const ACTUAL = {
  catalogRevision: "catalog-a",
  engineRevision: "engine-a",
  seedDerivationVersion: "DERIVATION_V1",
};

function replay(overrides: Partial<SimulationReplayRequest> = {}): SimulationReplayRequest {
  return {
    seed: "seed-a",
    runIndex: 7,
    expectedCatalogRevision: ACTUAL.catalogRevision,
    expectedEngineRevision: ACTUAL.engineRevision,
    expectedSeedDerivationVersion: ACTUAL.seedDerivationVersion,
    ...overrides,
  };
}

describe("validateSimulationReplay", () => {
  it("UT-REPLAY-001: accepts a replay whose identity matches the server, with logLevel omitted or DETAILED", () => {
    expect(validateSimulationReplay(replay(), undefined, ACTUAL)).toEqual([]);
    expect(validateSimulationReplay(replay(), "DETAILED", ACTUAL)).toEqual([]);
    expect(validateSimulationReplay(replay({ runIndex: 0 }), undefined, ACTUAL)).toEqual([]);
    expect(validateSimulationReplay(replay({ runIndex: 0xffffffff }), undefined, ACTUAL)).toEqual(
      [],
    );
  });

  it("UT-REPLAY-002: reports each mismatched identity under its own replay path", () => {
    const violations = validateSimulationReplay(
      replay({
        expectedCatalogRevision: "catalog-b",
        expectedEngineRevision: "engine-b",
        expectedSeedDerivationVersion: "DERIVATION_V0",
      }),
      undefined,
      ACTUAL,
    );

    expect(violations.map((violation) => violation.path)).toEqual([
      "replay.expectedCatalogRevision",
      "replay.expectedEngineRevision",
      "replay.expectedSeedDerivationVersion",
    ]);
    expect(violations[2]!.reason).toContain('"DERIVATION_V1"');
  });

  it("UT-REPLAY-003: rejects a blank seed and run numbers outside the unsigned 32-bit range", () => {
    for (const [overrides, path] of [
      [{ seed: " \t" }, "replay.seed"],
      [{ runIndex: -1 }, "replay.runIndex"],
      [{ runIndex: 0x100000000 }, "replay.runIndex"],
      [{ runIndex: 1.5 }, "replay.runIndex"],
    ] as const) {
      expect(validateSimulationReplay(replay(overrides), undefined, ACTUAL)).toEqual([
        expect.objectContaining({ path }),
      ]);
    }
  });

  it("UT-REPLAY-004: rejects an explicit SUMMARY log level, since a replay always returns the detailed log", () => {
    expect(validateSimulationReplay(replay(), "SUMMARY", ACTUAL)).toEqual([
      expect.objectContaining({ path: "options.logLevel" }),
    ]);
  });
});
