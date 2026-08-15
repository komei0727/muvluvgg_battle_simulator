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
      // 編成補正・適性補正の適用前。`combatStats`とは別の値にして、取り違えを検知する。
      enhancedBaseStats: {
        maximumHp: 1000,
        attack: 80.5,
        defense: 40,
        criticalRate: 0.1,
        criticalDamageBonus: 0.5,
        affinityBonus: 0.25,
        actionSpeed: 12,
        maximumAp: 3,
        maximumPp: 4,
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

  it("API-STAT-PREVIEW-013 (10_API設計.md「FormationStatPreviewUnitResponse」/R-ENH-06): publishes the enhanced base stats in the same units as combatStats, without the resource maximums", () => {
    const unit = toFormationStatPreviewResponseBody(RESULT).units[0]!;

    // 比率3項目は`combatStats`と同じくパーセントポイントで公開する。
    expect(unit.enhancedBaseStats).toEqual({
      maximumHp: 1000,
      attack: 80.5,
      defense: 40,
      criticalRate: 10,
      actionSpeed: 12,
      affinityBonus: 25,
      criticalDamageBonus: 50,
    });
    // AP/PPはプレビューの表示対象ではないため公開しない。
    expect(unit.enhancedBaseStats).not.toHaveProperty("maximumAp");
    expect(unit.enhancedBaseStats).not.toHaveProperty("maximumPp");
  });
});
