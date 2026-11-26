import { describe, expect, it } from "vitest";
import { ApplicationError } from "../contracts/application-error.js";
import { projectEvaluationUnits, type EvaluationRosterEntry } from "./evaluation-unit-records.js";
import type { FormationInput } from "./simulate-battle-command.js";
import type { UnitBattleSummary } from "../observation/unit-battle-summary-projector.js";
import { createUnitDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { createBattleUnitId } from "../../domain/shared/ids.js";
import type { Side } from "../../domain/shared/side.js";
import { formationSlot } from "../../testing/scenario/definition-builders.js";

function formation(...unitIds: string[]): FormationInput {
  return {
    slots: unitIds.map((unitId, index) => formationSlot(unitId, (index % 3) as 0 | 1 | 2)),
    memoryDefinitionIds: [],
  };
}

function rosterEntry(
  battleUnitId: string,
  side: Side,
  unitId: string,
  extra: Partial<EvaluationRosterEntry> = {},
): EvaluationRosterEntry {
  return {
    battleUnitId: createBattleUnitId(battleUnitId),
    unitDefinitionId: createUnitDefinitionId(unitId),
    side,
    ...extra,
  };
}

function summary(battleUnitId: string, side: Side, damageDealt: number): UnitBattleSummary {
  return {
    battleUnitId: createBattleUnitId(battleUnitId),
    side,
    damageDealt,
    damageTaken: 1,
    healingDone: 2,
    finalHp: 3,
    maximumHp: 4,
    combatStatus: "ACTIVE",
  };
}

describe("projectEvaluationUnits", () => {
  it("UT-EVALUNIT-001: identifies two slots holding the same unit definition by their request index", () => {
    const records = projectEvaluationUnits(
      [
        rosterEntry("ally:1", "ALLY", "UNIT_A"),
        rosterEntry("ally:2", "ALLY", "UNIT_A"),
        rosterEntry("enemy:1", "ENEMY", "UNIT_B"),
      ],
      [
        summary("enemy:1", "ENEMY", 30),
        summary("ally:2", "ALLY", 20),
        summary("ally:1", "ALLY", 10),
      ],
      { ALLY: [formation("UNIT_A", "UNIT_A")], ENEMY: [formation("UNIT_B")] },
    );

    expect(records).toEqual([
      {
        side: "ALLY",
        unitIndex: 0,
        unitDefinitionId: "UNIT_A",
        damageDealt: 10,
        damageTaken: 1,
        healingDone: 2,
        finalHp: 3,
        maximumHp: 4,
        combatStatus: "ACTIVE",
      },
      expect.objectContaining({ side: "ALLY", unitIndex: 1, damageDealt: 20 }),
      expect.objectContaining({ side: "ENEMY", unitIndex: 0, damageDealt: 30 }),
    ]);
  });

  it("UT-EVALUNIT-002: numbers total war slots within each formation and keeps deployment and reappearance", () => {
    const records = projectEvaluationUnits(
      [
        rosterEntry("ally:1", "ALLY", "UNIT_A", {
          formationNumber: 1,
          deployed: true,
          reappearance: false,
        }),
        rosterEntry("ally:2", "ALLY", "UNIT_A", {
          formationNumber: 2,
          deployed: false,
          reappearance: true,
        }),
        rosterEntry("enemy:1", "ENEMY", "UNIT_B", {
          formationNumber: 1,
          deployed: true,
          reappearance: false,
        }),
      ],
      [summary("ally:1", "ALLY", 1), summary("ally:2", "ALLY", 0), summary("enemy:1", "ENEMY", 2)],
      { ALLY: [formation("UNIT_A"), formation("UNIT_A")], ENEMY: [formation("UNIT_B")] },
    );

    expect(
      records.map(({ side, formationNumber, unitIndex, deployed, reappearance }) => ({
        side,
        formationNumber,
        unitIndex,
        deployed,
        reappearance,
      })),
    ).toEqual([
      { side: "ALLY", formationNumber: 1, unitIndex: 0, deployed: true, reappearance: false },
      { side: "ALLY", formationNumber: 2, unitIndex: 0, deployed: false, reappearance: true },
      { side: "ENEMY", formationNumber: 1, unitIndex: 0, deployed: true, reappearance: false },
    ]);
  });

  it("UT-EVALUNIT-003: a roster that does not line up with the requested slots is an internal invariant violation", () => {
    const run = (rosterUnitId: string, slots: FormationInput) => () =>
      projectEvaluationUnits(
        [rosterEntry("ally:1", "ALLY", rosterUnitId)],
        [summary("ally:1", "ALLY", 0)],
        { ALLY: [slots], ENEMY: [] },
      );

    expect(run("UNIT_X", formation("UNIT_A"))).toThrow(ApplicationError);
    expect(run("UNIT_A", formation("UNIT_A", "UNIT_B"))).toThrow(
      expect.objectContaining({ code: "INTERNAL_INVARIANT_VIOLATION" }),
    );
  });
});
