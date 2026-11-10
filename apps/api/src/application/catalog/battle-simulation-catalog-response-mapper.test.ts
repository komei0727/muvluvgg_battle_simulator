import { describe, expect, it } from "vitest";
import { toBattleSimulationCatalogResponseBody } from "./battle-simulation-catalog-response-mapper.js";
import type { BattleSimulationCatalogResult } from "./get-battle-simulation-catalog-use-case.js";
import { buildGearEffects } from "./gear-effect-catalog.js";

function result(
  overrides: Partial<BattleSimulationCatalogResult> = {},
): BattleSimulationCatalogResult {
  return {
    catalogRevision: "rev-1",
    units: [],
    memories: [],
    gearEffects: buildGearEffects(),
    skills: [],
    effects: [],
    representationRevision: "rev-1+gear.0000000000000000",
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
      },
    ]);
  });

  it("APP-CATALOG-MAP-004 (10_API設計.md「CatalogGearEffectResponse」, R-ENH-04 #3/R-ENH-06): maps the gear effect table through unchanged, keeping percentage points and the application kind", () => {
    const body = toBattleSimulationCatalogResponseBody(
      result({
        gearEffects: [
          {
            stat: "CRITICAL_RATE",
            application: "POINT",
            values: [{ tier: "III", grade: "S", percentagePoints: 7 }],
          },
        ],
      }),
    );

    expect(body.gearEffects).toEqual([
      {
        stat: "CRITICAL_RATE",
        application: "POINT",
        values: [{ tier: "III", grade: "S", percentagePoints: 7 }],
      },
    ]);
  });

  it("APP-CATALOG-MAP-005: does not publish representationRevision — it is the ETag's derivation source, not part of the response body", () => {
    const body = toBattleSimulationCatalogResponseBody(result());

    expect(Object.keys(body).sort()).toEqual(
      [
        "schemaVersion",
        "catalogRevision",
        "units",
        "memories",
        "gearEffects",
        "skills",
        "effects",
      ].sort(),
    );
  });

  it("APP-CATALOG-MAP-003 (10_API設計.md「CatalogMemorySummaryResponse」): maps every Memory summary field", () => {
    const body = toBattleSimulationCatalogResponseBody(
      result({
        memories: [
          {
            memoryDefinitionId: "MEM_HEART_COLOR",
            displayName: "心の色",
          },
        ] as unknown as BattleSimulationCatalogResult["memories"],
      }),
    );

    expect(body.memories).toEqual([
      {
        memoryDefinitionId: "MEM_HEART_COLOR",
        displayName: "心の色",
      },
    ]);
  });

  it("UT-CATALOG-LABEL-006 (10_API設計.md「CatalogSkillSummaryResponse」): maps every Skill summary field and keeps owner/slot absent when the summary has none", () => {
    const body = toBattleSimulationCatalogResponseBody(
      result({
        skills: [
          {
            skillDefinitionId: "SKL_JUNKA_CHILDHOOD_PS1",
            displayName: "まじ本気だすぞー！！",
            skillType: "PS",
            ownerUnitDefinitionId: "UNIT_JUNKA_CHILDHOOD",
            slotLabel: "PS1",
          },
          { skillDefinitionId: "SKL_ORPHAN", displayName: "孤立", skillType: "AS" },
        ] as unknown as BattleSimulationCatalogResult["skills"],
      }),
    );

    expect(body.skills).toEqual([
      {
        skillDefinitionId: "SKL_JUNKA_CHILDHOOD_PS1",
        displayName: "まじ本気だすぞー！！",
        skillType: "PS",
        ownerUnitDefinitionId: "UNIT_JUNKA_CHILDHOOD",
        slotLabel: "PS1",
      },
      { skillDefinitionId: "SKL_ORPHAN", displayName: "孤立", skillType: "AS" },
    ]);
    expect("slotLabel" in (body.skills[1] ?? {})).toBe(false);
  });

  it("UT-CATALOG-LABEL-007 (10_API設計.md「CatalogEffectSummaryResponse」): maps every EffectAction summary field and keeps undeclared classification fields absent", () => {
    const body = toBattleSimulationCatalogResponseBody(
      result({
        effects: [
          {
            effectActionDefinitionId: "ACT_DMG_MOD",
            kind: "APPLY_DAMAGE_MOD",
            direction: "INCOMING",
            damageType: "EN",
            constantMagnitude: -0.3,
          },
          {
            effectActionDefinitionId: "ACT_STAT",
            kind: "APPLY_STAT_MOD",
            stat: "ATTACK",
            valueType: "RATIO",
            constantMagnitude: 0.05,
          },
          { effectActionDefinitionId: "ACT_STATUS", kind: "APPLY_STATUS", status: "STUN" },
          { effectActionDefinitionId: "ACT_DAMAGE", kind: "DAMAGE" },
        ] as unknown as BattleSimulationCatalogResult["effects"],
      }),
    );

    expect(body.effects).toEqual([
      {
        effectActionDefinitionId: "ACT_DMG_MOD",
        kind: "APPLY_DAMAGE_MOD",
        direction: "INCOMING",
        damageType: "EN",
        constantMagnitude: -0.3,
      },
      {
        effectActionDefinitionId: "ACT_STAT",
        kind: "APPLY_STAT_MOD",
        stat: "ATTACK",
        valueType: "RATIO",
        constantMagnitude: 0.05,
      },
      { effectActionDefinitionId: "ACT_STATUS", kind: "APPLY_STATUS", status: "STUN" },
      { effectActionDefinitionId: "ACT_DAMAGE", kind: "DAMAGE" },
    ]);
    expect(Object.keys(body.effects[3] ?? {}).sort()).toEqual(["effectActionDefinitionId", "kind"]);
  });
});
