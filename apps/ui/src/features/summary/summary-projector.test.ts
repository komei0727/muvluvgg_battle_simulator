import { describe, expect, it } from "vitest";
import { selectBattleSummary } from "./summary-projector.js";
import { selectRoster } from "../../entities/roster.js";
import type {
  BattleSimulationCatalogResponse,
  BattleSimulationResponse,
  BattleUnitStateResponse,
  CatalogUnitSummary,
  UnitBattleSummaryResponse,
} from "../../shared/api/api-contract.js";

function catalogWith(
  units: BattleSimulationCatalogResponse["units"],
): BattleSimulationCatalogResponse {
  return { schemaVersion: 1, catalogRevision: "rev-1", units, memories: [] };
}

function unitDefinition(unitDefinitionId: string, displayName: string): CatalogUnitSummary {
  return {
    unitDefinitionId,
    displayName,
    characterName: displayName,
    attribute: "CUTE",
    unitType: "HUMANOID",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT"],
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

function unitSummary(overrides: {
  battleUnitId: string;
  side?: string;
  damageDealt?: number;
  damageTaken?: number;
  healingDone?: number;
  finalHp?: number;
  maximumHp?: number;
  combatStatus?: string;
}): UnitBattleSummaryResponse {
  return {
    battleUnitId: overrides.battleUnitId,
    side: overrides.side ?? "ALLY",
    damageDealt: overrides.damageDealt ?? 0,
    damageTaken: overrides.damageTaken ?? 0,
    healingDone: overrides.healingDone ?? 0,
    finalHp: overrides.finalHp ?? 100,
    maximumHp: overrides.maximumHp ?? 100,
    combatStatus: overrides.combatStatus ?? "ACTIVE",
  };
}

function responseWith(overrides: {
  initialUnits: readonly BattleUnitStateResponse[];
  unitSummaries: readonly UnitBattleSummaryResponse[];
  finalUnits?: readonly BattleUnitStateResponse[];
  events?: readonly BattleSimulationResponse["events"][number][];
}): BattleSimulationResponse {
  return {
    schemaVersion: 1,
    battleId: "battle-1",
    catalogRevision: "rev-1",
    result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
    initialState: { units: overrides.initialUnits },
    ...(overrides.finalUnits === undefined ? {} : { finalState: { units: overrides.finalUnits } }),
    unitSummaries: overrides.unitSummaries,
    events: overrides.events ?? [],
    stateTransitions: [],
  };
}

describe("selectRoster", () => {
  it("UI-UT-SUM-010: resolves displayName from the catalog and keeps initialState.units order", () => {
    const catalog = catalogWith([
      unitDefinition("UNIT_B", "ビー"),
      unitDefinition("UNIT_A", "エー"),
    ]);
    const response = responseWith({
      initialUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
        battleUnit({ battleUnitId: "ally:2", unitDefinitionId: "UNIT_B", side: "ALLY" }),
      ],
      unitSummaries: [
        unitSummary({ battleUnitId: "ally:1" }),
        unitSummary({ battleUnitId: "ally:2" }),
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
      unitSummaries: [unitSummary({ battleUnitId: "ally:1" })],
    });

    const roster = selectRoster(response, catalog);

    expect(roster[0]?.displayName).toBe("UNIT_UNKNOWN");
  });
});

describe("selectBattleSummary", () => {
  const catalog = catalogWith([unitDefinition("UNIT_A", "エー"), unitDefinition("UNIT_B", "ビー")]);

  it("UI-UT-SUM-001: reads damageDealt/damageTaken/healingDone from unitSummaries, not from the event log", () => {
    const response = responseWith({
      initialUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
        battleUnit({ battleUnitId: "enemy:1", unitDefinitionId: "UNIT_B", side: "ENEMY" }),
      ],
      unitSummaries: [
        unitSummary({ battleUnitId: "ally:1", damageDealt: 30, damageTaken: 4, healingDone: 12 }),
        unitSummary({
          battleUnitId: "enemy:1",
          side: "ENEMY",
          damageDealt: 4,
          damageTaken: 30,
        }),
      ],
      // `SUMMARY`実行ではダメージ・回復イベントが1件も届かない。それでも
      // 集計値が出ることが、この切り替えの目的そのものである。
      events: [],
    });

    const projection = selectBattleSummary(response, catalog);

    const ally = projection.allyRows.find((row) => row.roster.battleUnitId === "ally:1")?.summary;
    expect(ally?.damageDealt).toBe(30);
    expect(ally?.damageTaken).toBe(4);
    expect(ally?.healingDone).toBe(12);
    expect(
      projection.enemyRows.find((row) => row.roster.battleUnitId === "enemy:1")?.summary
        .damageTaken,
    ).toBe(30);
    expect(projection.hasProjectionWarning).toBe(false);
  });

  it("UI-UT-SUM-004: keeps separate rows for the same unitDefinitionId under different battleUnitIds", () => {
    const response = responseWith({
      initialUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
        battleUnit({ battleUnitId: "ally:2", unitDefinitionId: "UNIT_A", side: "ALLY" }),
      ],
      unitSummaries: [
        unitSummary({ battleUnitId: "ally:1", damageDealt: 10 }),
        unitSummary({ battleUnitId: "ally:2", damageDealt: 5 }),
      ],
    });

    const projection = selectBattleSummary(response, catalog);

    expect(
      projection.allyRows.find((row) => row.roster.battleUnitId === "ally:1")?.summary.damageDealt,
    ).toBe(10);
    expect(
      projection.allyRows.find((row) => row.roster.battleUnitId === "ally:2")?.summary.damageDealt,
    ).toBe(5);
  });

  it("UI-UT-SUM-005: shows the server's zeroes for a unit that neither dealt nor took anything", () => {
    const response = responseWith({
      initialUnits: [battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A" })],
      unitSummaries: [unitSummary({ battleUnitId: "ally:1" })],
    });

    const projection = selectBattleSummary(response, catalog);

    const summary = projection.allyRows[0]?.summary;
    expect(summary?.damageDealt).toBe(0);
    expect(summary?.damageTaken).toBe(0);
    expect(summary?.healingDone).toBe(0);
    expect(projection.hasProjectionWarning).toBe(false);
  });

  it("UI-UT-SUM-007: resolves combatStatus and HP from unitSummaries rather than finalState", () => {
    const response = responseWith({
      initialUnits: [battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A" })],
      // `finalState`は`unitSummaries`と食い違う値を持たせる。表示が
      // `unitSummaries`側になることを固定するため。
      finalUnits: [
        battleUnit({
          battleUnitId: "ally:1",
          unitDefinitionId: "UNIT_A",
          combatStatus: "ACTIVE",
          hp: { current: 999, maximum: 999 },
        }),
      ],
      unitSummaries: [
        unitSummary({
          battleUnitId: "ally:1",
          combatStatus: "DEFEATED",
          finalHp: 0,
          maximumHp: 500,
        }),
      ],
    });

    const projection = selectBattleSummary(response, catalog);

    const summary = projection.allyRows[0]?.summary;
    expect(summary?.combatStatus).toBe("DEFEATED");
    expect(summary?.finalHp).toBe(0);
    expect(summary?.maximumHp).toBe(500);
  });

  it("UI-UT-SUM-008: ignores the event log entirely, so an unknown event type cannot affect the table", () => {
    const response = responseWith({
      initialUnits: [battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A" })],
      unitSummaries: [unitSummary({ battleUnitId: "ally:1", damageDealt: 7 })],
      events: [{ sequence: 1, type: "SOME_FUTURE_EVENT", details: { anything: true } }],
    });

    const projection = selectBattleSummary(response, catalog);

    expect(projection.allyRows[0]?.summary.damageDealt).toBe(7);
    expect(projection.hasProjectionWarning).toBe(false);
  });

  it("UI-UT-SUM-016: renders the table from a response that carries no finalState at all (the 3/3 SUMMARY shape)", () => {
    const response = responseWith({
      initialUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
        battleUnit({ battleUnitId: "enemy:1", unitDefinitionId: "UNIT_B", side: "ENEMY" }),
      ],
      unitSummaries: [
        unitSummary({ battleUnitId: "ally:1", damageDealt: 42, finalHp: 80 }),
        unitSummary({
          battleUnitId: "enemy:1",
          side: "ENEMY",
          damageTaken: 42,
          finalHp: 0,
          combatStatus: "DEFEATED",
        }),
      ],
    });
    expect(response.finalState).toBeUndefined();

    const projection = selectBattleSummary(response, catalog);

    expect(projection.allyRows[0]?.summary.damageDealt).toBe(42);
    expect(projection.allyRows[0]?.summary.finalHp).toBe(80);
    expect(projection.enemyRows[0]?.summary.combatStatus).toBe("DEFEATED");
    expect(projection.hasProjectionWarning).toBe(false);
  });

  it("UI-UT-SUM-017: falls back to zeroes and warns when a roster unit has no unitSummaries row, instead of showing a silently empty row", () => {
    const response = responseWith({
      initialUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
        battleUnit({ battleUnitId: "ally:2", unitDefinitionId: "UNIT_A", side: "ALLY" }),
      ],
      unitSummaries: [unitSummary({ battleUnitId: "ally:1", damageDealt: 9 })],
    });

    const projection = selectBattleSummary(response, catalog);

    expect(projection.allyRows).toHaveLength(2);
    expect(projection.allyRows[1]?.summary.damageDealt).toBe(0);
    expect(projection.allyRows[1]?.summary.combatStatus).toBe("UNKNOWN");
    expect(projection.hasProjectionWarning).toBe(true);
  });

  it("UI-UT-SUM-018: splits rows by the roster's side, not by the summary row's own side field", () => {
    const response = responseWith({
      initialUnits: [
        battleUnit({ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }),
        battleUnit({ battleUnitId: "enemy:1", unitDefinitionId: "UNIT_B", side: "ENEMY" }),
      ],
      unitSummaries: [
        unitSummary({ battleUnitId: "ally:1", side: "ALLY" }),
        unitSummary({ battleUnitId: "enemy:1", side: "ENEMY" }),
      ],
    });

    const projection = selectBattleSummary(response, catalog);

    expect(projection.allyRows.map((row) => row.roster.battleUnitId)).toEqual(["ally:1"]);
    expect(projection.enemyRows.map((row) => row.roster.battleUnitId)).toEqual(["enemy:1"]);
  });
});
