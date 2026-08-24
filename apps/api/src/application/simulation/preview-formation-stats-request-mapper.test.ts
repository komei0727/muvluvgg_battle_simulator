import { describe, expect, it } from "vitest";
import { toPreviewFormationStatsCommand } from "./preview-formation-stats-request-mapper.js";
import type { FormationStatPreviewRequestBody } from "../contracts/request.js";

const BODY: FormationStatPreviewRequestBody = {
  allyFormation: {
    units: [
      {
        unitDefinitionId: "UNIT_ALLY",
        position: { column: 2, row: "REAR" },
        enhancement: { level: 220, gears: [{ stat: "ATTACK", tier: "III", grade: "S" }] },
      },
    ],
    memoryDefinitionIds: ["MEM_001"],
    enhancement: { academyLevels: { unitTypes: { PHYSICAL: 50 } } },
  },
  enemyFormation: {
    units: [{ unitDefinitionId: "UNIT_ENEMY", position: { column: 0, row: "FRONT" } }],
    memoryDefinitionIds: [],
  },
};

describe("toPreviewFormationStatsCommand", () => {
  it("UT-STAT-PREVIEW-020 (10_API設計.md「Inbound Adapterでの変換」): converts both formations with the same rules the battle request uses", () => {
    expect(toPreviewFormationStatsCommand(BODY)).toEqual({
      allyFormation: {
        slots: [
          {
            unitDefinitionId: "UNIT_ALLY",
            position: { column: 2, row: "REAR" },
            enhancement: { level: 220, gears: [{ stat: "ATTACK", tier: "III", grade: "S" }] },
          },
        ],
        memoryDefinitionIds: ["MEM_001"],
        enhancement: { academyLevels: { unitTypes: { PHYSICAL: 50 } } },
      },
      enemyFormation: {
        slots: [{ unitDefinitionId: "UNIT_ENEMY", position: { column: 0, row: "FRONT" } }],
        memoryDefinitionIds: [],
      },
    });
  });

  it("UT-STAT-PREVIEW-021 (10_API設計.md「FormationStatPreviewRequest」): produces no turnLimit or logLevel, because the preview runs no battle", () => {
    const command = toPreviewFormationStatsCommand(BODY);

    expect(Object.keys(command).toSorted()).toEqual(["allyFormation", "enemyFormation"]);
  });

  it("UT-STAT-PREVIEW-023 [R-TEX-11] (R-TEX-11 #5): passes mode through, and omits the key when the request omits it", () => {
    expect(toPreviewFormationStatsCommand({ ...BODY, mode: "TACTICAL_EXERCISE" }).mode).toBe(
      "TACTICAL_EXERCISE",
    );
    expect("mode" in toPreviewFormationStatsCommand(BODY)).toBe(false);
  });
});
