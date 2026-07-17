import { describe, expect, it } from "vitest";
import { toBattleSimulationCatalogResponseBody } from "./battle-simulation-catalog-response-mapper.js";
import type { BattleSimulationCatalogResult } from "./get-battle-simulation-catalog-use-case.js";

function result(
  overrides: Partial<BattleSimulationCatalogResult> = {},
): BattleSimulationCatalogResult {
  return {
    catalogRevision: "rev-1",
    units: [],
    memories: [],
    ...overrides,
  };
}

describe("toBattleSimulationCatalogResponseBody", () => {
  it("APP-CATALOG-MAP-001 (10_API設計.md「BattleSimulationCatalogResponse」): sets schemaVersion 1 and carries the catalogRevision through", () => {
    const body = toBattleSimulationCatalogResponseBody(
      result({ catalogRevision: "2026-07-12.12" }),
    );
    expect(body.schemaVersion).toBe(1);
    expect(body.catalogRevision).toBe("2026-07-12.12");
  });

  it("APP-CATALOG-MAP-002 (10_API設計.md「CatalogUnitSummaryResponse」): maps every Unit summary field", () => {
    const body = toBattleSimulationCatalogResponseBody(
      result({
        units: [
          {
            unitDefinitionId: "UNIT_MEIYA_FATED",
            displayName: "【天命を受けし剣術乙女】御剣冥夜",
            characterName: "御剣冥夜",
            attribute: "SHY",
            unitType: "PHYSICAL",
            role: "PHYSICAL_ATTACKER",
            positionAptitudes: ["FRONT"],
            selectable: true,
            unavailableCapabilities: [],
          },
        ] as unknown as BattleSimulationCatalogResult["units"],
      }),
    );

    expect(body.units).toEqual([
      {
        unitDefinitionId: "UNIT_MEIYA_FATED",
        displayName: "【天命を受けし剣術乙女】御剣冥夜",
        characterName: "御剣冥夜",
        attribute: "SHY",
        unitType: "PHYSICAL",
        role: "PHYSICAL_ATTACKER",
        positionAptitudes: ["FRONT"],
        selectable: true,
        unavailableCapabilities: [],
      },
    ]);
  });

  it("APP-CATALOG-MAP-003 (10_API設計.md「CatalogMemorySummaryResponse」): maps every Memory summary field", () => {
    const body = toBattleSimulationCatalogResponseBody(
      result({
        memories: [
          {
            memoryDefinitionId: "MEM_HEART_COLOR",
            displayName: "心の色",
            selectable: false,
            unavailableCapabilities: ["CAP_MEMORY_TRIGGERED_EFFECT"],
          },
        ] as unknown as BattleSimulationCatalogResult["memories"],
      }),
    );

    expect(body.memories).toEqual([
      {
        memoryDefinitionId: "MEM_HEART_COLOR",
        displayName: "心の色",
        selectable: false,
        unavailableCapabilities: ["CAP_MEMORY_TRIGGERED_EFFECT"],
      },
    ]);
  });
});
