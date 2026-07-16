import { describe, expect, it } from "vitest";
import { selectBattleSummary, selectRoster } from "./summary-projector.js";
import type { SummaryProjection } from "./summary-projector.js";
import type {
  BattleLogEventResponse,
  BattleSimulationCatalogResponse,
  BattleSimulationResponse,
  BattleUnitStateResponse,
} from "../simulation/api-contract.js";

// selectBattleSummary returns a Result so a roster/finalState contract
// mismatch can be reported explicitly (03_API・データ連携設計.md §10 rule 5)
// instead of rendering fabricated UNKNOWN/0 rows. Tests that expect success
// unwrap through this helper; tests that expect failure call the function
// directly.
function projectionOf(result: ReturnType<typeof selectBattleSummary>): SummaryProjection {
  if (!result.ok) {
    throw new Error(`expected an ok projection but got: ${result.error.message}`);
  }
  return result.projection;
}

function catalogWith(
  units: BattleSimulationCatalogResponse["units"],
): BattleSimulationCatalogResponse {
  return { schemaVersion: 1, catalogRevision: "rev-1", units, memories: [] };
}

function unitDefinition(unitDefinitionId: string, displayName: string) {
  return {
    unitDefinitionId,
    displayName,
    characterName: displayName,
    attribute: "CUTE",
    unitType: "HUMANOID",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT"],
    selectable: true,
    unavailableCapabilities: [],
  };
}

function battleUnit(overrides: {
  battleUnitId: string;
  unitDefinitionId?: string;
  side?: string;
  combatStatus?: string;
  hp?: { current: number; maximum: number };
}): BattleUnitStateResponse {
  return {
    battleUnitId: overrides.battleUnitId,
    unitDefinitionId: overrides.unitDefinitionId ?? "UNIT_A",
    side: overrides.side ?? "ALLY",
    combatStatus: overrides.combatStatus ?? "ACTIVE",
    hp: overrides.hp ?? { current: 100, maximum: 100 },
  };
}

function damageAppliedEvent(overrides: {
  sequence: number;
  sourceUnitId?: string;
  targetUnitIds: readonly string[];
  targetUnitId: string;
  hitPointDamage: number;
  calculatedDamage?: number;
}): BattleLogEventResponse {
  return {
    sequence: overrides.sequence,
    type: "DAMAGE_APPLIED",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    rootSequence: overrides.sequence,
    ...(overrides.sourceUnitId !== undefined ? { sourceUnitId: overrides.sourceUnitId } : {}),
    targetUnitIds: overrides.targetUnitIds,
    details: {
      effectActionDefinitionId: "EFFECT_1",
      hitIndex: 0,
      targetUnitId: overrides.targetUnitId,
      calculatedDamage: overrides.calculatedDamage ?? overrides.hitPointDamage,
      hitPointDamage: overrides.hitPointDamage,
      hpBefore: 100,
      hpAfter: 100 - overrides.hitPointDamage,
      defeated: false,
    },
    stateVersionBefore: 0,
    stateVersionAfter: 1,
  };
}

function responseWith(overrides: {
  initialUnits: readonly BattleUnitStateResponse[];
  finalUnits: readonly BattleUnitStateResponse[];
  events?: readonly BattleLogEventResponse[];
}): BattleSimulationResponse {
  return {
    schemaVersion: 1,
    battleId: "battle-1",
    catalogRevision: "rev-1",
    result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
    initialState: { units: overrides.initialUnits },
    finalState: { units: overrides.finalUnits },
    events: overrides.events ?? [],
    stateTransitions: [],
  };
}

describe("selectRoster", () => {
  it("resolves displayName from the catalog and keeps initialState.units order (UI-UT-SUM-010)", () => {
    const catalog = catalogWith([
      unitDefinition("UNIT_B", "ビー"),
      unitDefinition("UNIT_A", "エー"),
    ]);
    const response = responseWith({
      initialUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
        battleUnit({ battleUnitId: "ally:2", unitDefinitionId: "UNIT_B", side: "ALLY" }),
      ],
      finalUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
        battleUnit({ battleUnitId: "ally:2", unitDefinitionId: "UNIT_B", side: "ALLY" }),
      ],
    });

    const roster = selectRoster(response, catalog);

    expect(roster.map((entry) => entry.battleUnitId)).toEqual(["ally:1", "ally:2"]);
    expect(roster[0]?.displayName).toBe("エー");
    expect(roster[1]?.displayName).toBe("ビー");
  });

  it("falls back to unitDefinitionId when the catalog has no matching definition", () => {
    const catalog = catalogWith([]);
    const response = responseWith({
      initialUnits: [battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_UNKNOWN" })],
      finalUnits: [battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_UNKNOWN" })],
    });

    const roster = selectRoster(response, catalog);

    expect(roster[0]?.displayName).toBe("UNIT_UNKNOWN");
  });
});

describe("selectBattleSummary", () => {
  it("adds DAMAGE_APPLIED.hitPointDamage to the source unit's DAMAGE (UI-UT-SUM-001)", () => {
    const catalog = catalogWith([
      unitDefinition("UNIT_A", "エー"),
      unitDefinition("UNIT_B", "ビー"),
    ]);
    const response = responseWith({
      initialUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
        battleUnit({ battleUnitId: "enemy:1", unitDefinitionId: "UNIT_B", side: "ENEMY" }),
      ],
      finalUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
        battleUnit({
          battleUnitId: "enemy:1",
          unitDefinitionId: "UNIT_B",
          side: "ENEMY",
          hp: { current: 70, maximum: 100 },
        }),
      ],
      events: [
        damageAppliedEvent({
          sequence: 1,
          sourceUnitId: "ally:1",
          targetUnitIds: ["enemy:1"],
          targetUnitId: "enemy:1",
          hitPointDamage: 30,
        }),
      ],
    });

    const projection = projectionOf(selectBattleSummary(response, catalog));

    const allySummary = projection.allyRows.find((row) => row.roster.battleUnitId === "ally:1");
    expect(allySummary?.summary.damageDealt).toBe(30);
  });

  it("adds the same hitPointDamage to the target unit's DEFENSE (UI-UT-SUM-002)", () => {
    const catalog = catalogWith([
      unitDefinition("UNIT_A", "エー"),
      unitDefinition("UNIT_B", "ビー"),
    ]);
    const response = responseWith({
      initialUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
        battleUnit({ battleUnitId: "enemy:1", unitDefinitionId: "UNIT_B", side: "ENEMY" }),
      ],
      finalUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
        battleUnit({ battleUnitId: "enemy:1", unitDefinitionId: "UNIT_B", side: "ENEMY" }),
      ],
      events: [
        damageAppliedEvent({
          sequence: 1,
          sourceUnitId: "ally:1",
          targetUnitIds: ["enemy:1"],
          targetUnitId: "enemy:1",
          hitPointDamage: 30,
        }),
      ],
    });

    const projection = projectionOf(selectBattleSummary(response, catalog));

    const enemySummary = projection.enemyRows.find((row) => row.roster.battleUnitId === "enemy:1");
    expect(enemySummary?.summary.damageTaken).toBe(30);
  });

  it("uses hitPointDamage rather than calculatedDamage when they differ (UI-UT-SUM-003)", () => {
    const catalog = catalogWith([
      unitDefinition("UNIT_A", "エー"),
      unitDefinition("UNIT_B", "ビー"),
    ]);
    const response = responseWith({
      initialUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
        battleUnit({ battleUnitId: "enemy:1", unitDefinitionId: "UNIT_B", side: "ENEMY" }),
      ],
      finalUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
        battleUnit({ battleUnitId: "enemy:1", unitDefinitionId: "UNIT_B", side: "ENEMY" }),
      ],
      events: [
        damageAppliedEvent({
          sequence: 1,
          sourceUnitId: "ally:1",
          targetUnitIds: ["enemy:1"],
          targetUnitId: "enemy:1",
          hitPointDamage: 20,
          calculatedDamage: 250,
        }),
      ],
    });

    const projection = projectionOf(selectBattleSummary(response, catalog));

    const allySummary = projection.allyRows.find((row) => row.roster.battleUnitId === "ally:1");
    expect(allySummary?.summary.damageDealt).toBe(20);
  });

  it("aggregates separately for the same unitDefinitionId with different battleUnitId (UI-UT-SUM-004)", () => {
    const catalog = catalogWith([unitDefinition("UNIT_A", "エー")]);
    const response = responseWith({
      initialUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
        battleUnit({ battleUnitId: "ally:2", unitDefinitionId: "UNIT_A", side: "ALLY" }),
        battleUnit({ battleUnitId: "enemy:1", unitDefinitionId: "UNIT_A", side: "ENEMY" }),
      ],
      finalUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
        battleUnit({ battleUnitId: "ally:2", unitDefinitionId: "UNIT_A", side: "ALLY" }),
        battleUnit({ battleUnitId: "enemy:1", unitDefinitionId: "UNIT_A", side: "ENEMY" }),
      ],
      events: [
        damageAppliedEvent({
          sequence: 1,
          sourceUnitId: "ally:1",
          targetUnitIds: ["enemy:1"],
          targetUnitId: "enemy:1",
          hitPointDamage: 10,
        }),
        damageAppliedEvent({
          sequence: 2,
          sourceUnitId: "ally:2",
          targetUnitIds: ["enemy:1"],
          targetUnitId: "enemy:1",
          hitPointDamage: 5,
        }),
      ],
    });

    const projection = projectionOf(selectBattleSummary(response, catalog));

    expect(
      projection.allyRows.find((row) => row.roster.battleUnitId === "ally:1")?.summary.damageDealt,
    ).toBe(10);
    expect(
      projection.allyRows.find((row) => row.roster.battleUnitId === "ally:2")?.summary.damageDealt,
    ).toBe(5);
  });

  it("shows 0 for a unit with no matching events (UI-UT-SUM-005)", () => {
    const catalog = catalogWith([unitDefinition("UNIT_A", "エー")]);
    const response = responseWith({
      initialUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
      ],
      finalUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
      ],
      events: [],
    });

    const projection = projectionOf(selectBattleSummary(response, catalog));

    const summary = projection.allyRows[0]?.summary;
    expect(summary?.damageDealt).toBe(0);
    expect(summary?.damageTaken).toBe(0);
  });

  it("always shows 0 for HEAL ahead of the M7 heal event contract (UI-UT-SUM-006)", () => {
    const catalog = catalogWith([unitDefinition("UNIT_A", "エー")]);
    const response = responseWith({
      initialUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
      ],
      finalUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
      ],
    });

    const projection = projectionOf(selectBattleSummary(response, catalog));

    expect(projection.allyRows[0]?.summary.healingDone).toBe(0);
  });

  it("resolves combatStatus and hp from finalState (UI-UT-SUM-007)", () => {
    const catalog = catalogWith([unitDefinition("UNIT_A", "エー")]);
    const response = responseWith({
      initialUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
      ],
      finalUnits: [
        battleUnit({
          battleUnitId: "ally:1",
          unitDefinitionId: "UNIT_A",
          side: "ALLY",
          combatStatus: "DEFEATED",
          hp: { current: 0, maximum: 500 },
        }),
      ],
    });

    const projection = projectionOf(selectBattleSummary(response, catalog));

    const summary = projection.allyRows[0]?.summary;
    expect(summary?.combatStatus).toBe("DEFEATED");
    expect(summary?.finalHp).toBe(0);
    expect(summary?.maximumHp).toBe(500);
  });

  it("ignores unknown events and still succeeds (UI-UT-SUM-008)", () => {
    const catalog = catalogWith([unitDefinition("UNIT_A", "エー")]);
    const response = responseWith({
      initialUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
      ],
      finalUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
      ],
      events: [{ sequence: 1, type: "SOME_FUTURE_EVENT", details: { anything: true } }],
    });

    expect(() => selectBattleSummary(response, catalog)).not.toThrow();
    expect(projectionDamage(projectionOf(selectBattleSummary(response, catalog)))).toBe(0);
  });

  it("excludes a malformed DAMAGE_APPLIED event from aggregation and reports a warning (UI-UT-SUM-009)", () => {
    const catalog = catalogWith([unitDefinition("UNIT_A", "エー")]);
    const response = responseWith({
      initialUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
      ],
      finalUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
      ],
      events: [
        {
          sequence: 1,
          type: "DAMAGE_APPLIED",
          sourceUnitId: "ally:1",
          targetUnitIds: [],
          details: { hitPointDamage: "not-a-number" },
        },
      ],
    });

    const projection = projectionOf(selectBattleSummary(response, catalog));

    expect(projection.allyRows[0]?.summary.damageDealt).toBe(0);
    expect(projection.hasProjectionWarning).toBe(true);
  });

  it("excludes a DAMAGE_APPLIED event whose target isn't part of the roster and warns, without crediting the source (review: unknown targetUnitId)", () => {
    const catalog = catalogWith([unitDefinition("UNIT_A", "エー")]);
    const response = responseWith({
      initialUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
      ],
      finalUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
      ],
      events: [
        damageAppliedEvent({
          sequence: 1,
          sourceUnitId: "ally:1",
          targetUnitIds: ["enemy:ghost"],
          targetUnitId: "enemy:ghost",
          hitPointDamage: 30,
        }),
      ],
    });

    const projection = projectionOf(selectBattleSummary(response, catalog));

    expect(projection.allyRows[0]?.summary.damageDealt).toBe(0);
    expect(projection.hasProjectionWarning).toBe(true);
  });

  it("excludes a DAMAGE_APPLIED event whose source isn't part of the roster and warns, without crediting the target (review: unknown sourceUnitId)", () => {
    const catalog = catalogWith([unitDefinition("UNIT_A", "エー")]);
    const response = responseWith({
      initialUnits: [
        battleUnit({ battleUnitId: "enemy:1", unitDefinitionId: "UNIT_A", side: "ENEMY" }),
      ],
      finalUnits: [
        battleUnit({ battleUnitId: "enemy:1", unitDefinitionId: "UNIT_A", side: "ENEMY" }),
      ],
      events: [
        damageAppliedEvent({
          sequence: 1,
          sourceUnitId: "ally:ghost",
          targetUnitIds: ["enemy:1"],
          targetUnitId: "enemy:1",
          hitPointDamage: 30,
        }),
      ],
    });

    const projection = projectionOf(selectBattleSummary(response, catalog));

    expect(projection.enemyRows[0]?.summary.damageTaken).toBe(0);
    expect(projection.hasProjectionWarning).toBe(true);
  });

  it("rejects a non-integer hitPointDamage as malformed rather than aggregating a rounded display value (review: fractional hitPointDamage)", () => {
    const catalog = catalogWith([unitDefinition("UNIT_A", "エー")]);
    const response = responseWith({
      initialUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
        battleUnit({ battleUnitId: "enemy:1", unitDefinitionId: "UNIT_A", side: "ENEMY" }),
      ],
      finalUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
        battleUnit({ battleUnitId: "enemy:1", unitDefinitionId: "UNIT_A", side: "ENEMY" }),
      ],
      events: [
        damageAppliedEvent({
          sequence: 1,
          sourceUnitId: "ally:1",
          targetUnitIds: ["enemy:1"],
          targetUnitId: "enemy:1",
          hitPointDamage: 1.23456,
        }),
      ],
    });

    const projection = projectionOf(selectBattleSummary(response, catalog));

    expect(projection.allyRows[0]?.summary.damageDealt).toBe(0);
    expect(projection.hasProjectionWarning).toBe(true);
  });

  it("returns a contract-mismatch error when finalState is missing a unit present in the initialState roster (03_API・データ連携設計.md §10 rule 5)", () => {
    const catalog = catalogWith([unitDefinition("UNIT_A", "エー")]);
    const response = responseWith({
      initialUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
      ],
      finalUnits: [],
    });

    const result = selectBattleSummary(response, catalog);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("RESPONSE_CONTRACT_MISMATCH");
      expect(result.error.message).toContain("ally:1");
    }
  });
});

function projectionDamage(projection: SummaryProjection): number {
  return [...projection.allyRows, ...projection.enemyRows].reduce(
    (total, row) => total + row.summary.damageDealt,
    0,
  );
}
