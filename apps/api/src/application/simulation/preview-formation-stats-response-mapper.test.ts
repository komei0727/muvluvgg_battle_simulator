import { describe, expect, it } from "vitest";
import { toFormationStatPreviewResponseBody } from "./preview-formation-stats-response-mapper.js";
import type { FormationStatPreviewResult } from "./preview-formation-stats-use-case.js";
import { createUnitDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";

const RESULT: FormationStatPreviewResult = {
  catalogRevision: "rev-1",
  units: [
    {
      side: "ALLY",
      unitDefinitionId: createUnitDefinitionId("UNIT_ALLY"),
      position: { column: "RIGHT", row: "BACK" },
      combatStats: {
        maximumHp: 1234.5,
        attack: 100.25,
        defense: 50,
        criticalRate: 0.125,
        actionSpeed: 12,
        affinityBonus: 0.25,
        criticalDamageBonus: 0.5,
      },
    },
  ],
};

describe("toFormationStatPreviewResponseBody", () => {
  it("API-STAT-PREVIEW-010 (10_API設計.md「FormationStatPreviewResponse」): publishes schemaVersion, catalogRevision and one entry per slot", () => {
    const body = toFormationStatPreviewResponseBody(RESULT);

    expect(body.schemaVersion).toBe(1);
    expect(body.catalogRevision).toBe("rev-1");
    expect(body.units).toHaveLength(1);
  });

  it("API-STAT-PREVIEW-011 (10_API設計.md「FormationPositionRequest」): converts the domain position back to the per-side request representation", () => {
    expect(toFormationStatPreviewResponseBody(RESULT).units[0]).toMatchObject({
      side: "ALLY",
      unitDefinitionId: "UNIT_ALLY",
      formationPosition: { column: 2, row: "REAR" },
    });
  });

  it("API-STAT-PREVIEW-012 (10_API設計.md「CombatStatsResponse」/R-NUM-01): publishes ratios as percentage points and leaves the other values unrounded, with maximumHp beside combatStats", () => {
    const unit = toFormationStatPreviewResponseBody(RESULT).units[0]!;

    expect(unit.maximumHp).toBe(1234.5);
    expect(unit.combatStats).toEqual({
      attack: 100.25,
      defense: 50,
      criticalRate: 12.5,
      actionSpeed: 12,
      affinityBonus: 25,
      criticalDamageBonus: 50,
    });
  });
});
