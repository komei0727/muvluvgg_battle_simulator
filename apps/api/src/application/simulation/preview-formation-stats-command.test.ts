import { describe, expect, it } from "vitest";
import {
  validatePreviewFormationStatsCommandShape,
  type PreviewFormationStatsCommand,
} from "./preview-formation-stats-command.js";
import { formationSlot as slot } from "../../testing/scenario/definition-builders.js";

function command(
  overrides: Partial<PreviewFormationStatsCommand> = {},
): PreviewFormationStatsCommand {
  return {
    allyFormation: { slots: [slot("UNIT_ALLY", 0)], memoryDefinitionIds: [] },
    enemyFormation: { slots: [slot("UNIT_ENEMY", 0)], memoryDefinitionIds: [] },
    ...overrides,
  };
}

describe("PreviewFormationStatsCommand", () => {
  it("UT-STAT-PREVIEW-001 (09_アプリケーション設計.md「PreviewFormationStatsCommand」): accepts a formation pair that the battle command would also accept", () => {
    expect(validatePreviewFormationStatsCommandShape(command())).toEqual([]);
  });

  it("UT-STAT-PREVIEW-002: applies the battle command's formation rules to both sides, so a preview cannot show stats for a placement the battle would reject", () => {
    const violations = validatePreviewFormationStatsCommandShape(
      command({
        allyFormation: {
          slots: [slot("UNIT_ALLY", 0), slot("UNIT_ALLY", 0)],
          memoryDefinitionIds: [],
        },
        enemyFormation: {
          slots: [
            slot("UNIT_ENEMY", 0),
            slot("UNIT_ENEMY", 1),
            slot("UNIT_ENEMY", 2),
            slot("UNIT_ENEMY", 0, "REAR"),
            slot("UNIT_ENEMY", 1, "REAR"),
            slot("UNIT_ENEMY", 2, "REAR"),
          ],
          memoryDefinitionIds: [],
        },
      }),
    );

    expect(violations.map((violation) => violation.path)).toEqual([
      "allyFormation.slots[1].position",
      "enemyFormation.slots",
    ]);
  });

  it("UT-STAT-PREVIEW-004: accepts a side with no units, because each side's starting stats are computed independently and the formation is filled in one side at a time", () => {
    expect(
      validatePreviewFormationStatsCommandShape(
        command({ enemyFormation: { slots: [], memoryDefinitionIds: [] } }),
      ),
    ).toEqual([]);
  });

  it("UT-STAT-PREVIEW-003 [R-ENH-01] (R-ENH-01 #3): rejects a unit enhancement whose formation declares none, with the same path the battle command reports", () => {
    const violations = validatePreviewFormationStatsCommandShape(
      command({
        allyFormation: {
          slots: [{ ...slot("UNIT_ALLY", 0), enhancement: { level: 220 } }],
          memoryDefinitionIds: [],
        },
      }),
    );

    expect(violations).toEqual([
      {
        path: "allyFormation.slots[0].enhancement",
        reason: "requires an enhancement specification on its own formation (R-ENH-01)",
      },
    ]);
  });
});
