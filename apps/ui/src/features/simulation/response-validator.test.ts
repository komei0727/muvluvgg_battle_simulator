import { describe, expect, it } from "vitest";
import {
  validateCatalogResponse,
  validateFormationStatPreviewResponse,
} from "./response-validator.js";

function validUnit(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    unitDefinitionId: "UNIT_A",
    displayName: "Unit A",
    characterName: "Character A",
    attribute: "FIRE",
    unitType: "ATTACKER",
    role: "DPS",
    positionAptitudes: ["FRONT"],
    ...overrides,
  };
}

function validMemory(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    memoryDefinitionId: "MEMORY_A",
    displayName: "Memory A",
    ...overrides,
  };
}

function validResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: 1,
    catalogRevision: "rev-1",
    units: [validUnit()],
    memories: [validMemory()],
    ...overrides,
  };
}

describe("validateCatalogResponse", () => {
  // UI-UT-CAT-000
  it("accepts a well-formed response", () => {
    const result = validateCatalogResponse(validResponse());

    expect(result).toEqual({ ok: true, response: validResponse() });
  });

  it("rejects a non-object body", () => {
    const result = validateCatalogResponse(null);

    expect(result.ok).toBe(false);
  });

  // UI-UT-CAT-010 (Issue #423): ギア効果表は加算的に追加された任意項目.
  it("carries a well-formed gearEffects table through", () => {
    const gearEffects = [
      {
        stat: "MAXIMUM_HP",
        application: "RATIO",
        values: [{ tier: "III", grade: "S", percentagePoints: 3.33 }],
      },
    ];

    const result = validateCatalogResponse(validResponse({ gearEffects }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.gearEffects).toEqual(gearEffects);
  });

  it("accepts a response from an older API that does not publish gearEffects at all", () => {
    const result = validateCatalogResponse(validResponse());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.gearEffects).toBeUndefined();
  });

  it("rejects a malformed gearEffects entry rather than showing a half-read table", () => {
    for (const gearEffects of [
      {},
      [{ stat: "MAXIMUM_HP", application: "RATIO" }],
      [{ stat: "", application: "RATIO", values: [] }],
      [
        {
          stat: "MAXIMUM_HP",
          application: "RATIO",
          values: [{ tier: "III", grade: "S", percentagePoints: "3.33" }],
        },
      ],
    ]) {
      expect(validateCatalogResponse(validResponse({ gearEffects })).ok).toBe(false);
    }
  });

  it("rejects schemaVersion other than 1", () => {
    const result = validateCatalogResponse(validResponse({ schemaVersion: 2 }));

    expect(result.ok).toBe(false);
  });

  it("rejects an empty catalogRevision", () => {
    const result = validateCatalogResponse(validResponse({ catalogRevision: "" }));

    expect(result.ok).toBe(false);
  });

  it("rejects a non-string catalogRevision", () => {
    const result = validateCatalogResponse(validResponse({ catalogRevision: 42 }));

    expect(result.ok).toBe(false);
  });

  it("rejects units that are not an array", () => {
    const result = validateCatalogResponse(validResponse({ units: {} }));

    expect(result.ok).toBe(false);
  });

  it("rejects memories that are not an array", () => {
    const result = validateCatalogResponse(validResponse({ memories: {} }));

    expect(result.ok).toBe(false);
  });

  it("rejects a unit with an empty definition id", () => {
    const result = validateCatalogResponse(
      validResponse({ units: [validUnit({ unitDefinitionId: "" })] }),
    );

    expect(result.ok).toBe(false);
  });

  it("rejects duplicate unit definition ids", () => {
    const result = validateCatalogResponse(validResponse({ units: [validUnit(), validUnit()] }));

    expect(result.ok).toBe(false);
  });

  it("rejects duplicate memory definition ids", () => {
    const result = validateCatalogResponse(
      validResponse({ memories: [validMemory(), validMemory()] }),
    );

    expect(result.ok).toBe(false);
  });

  it("rejects a unit with an empty positionAptitudes array", () => {
    const result = validateCatalogResponse(
      validResponse({ units: [validUnit({ positionAptitudes: [] })] }),
    );

    expect(result.ok).toBe(false);
  });

  it("rejects a unit with a positionAptitudes value outside FRONT/BACK", () => {
    const result = validateCatalogResponse(
      validResponse({ units: [validUnit({ positionAptitudes: ["FRONT", "SIDE"] })] }),
    );

    expect(result.ok).toBe(false);
  });

  it("accepts a unit with both FRONT and BACK aptitudes", () => {
    const result = validateCatalogResponse(
      validResponse({ units: [validUnit({ positionAptitudes: ["FRONT", "BACK"] })] }),
    );

    expect(result.ok).toBe(true);
  });

  it("rejects a unit missing displayName", () => {
    const { displayName: _displayName, ...withoutDisplayName } = validUnit();
    const result = validateCatalogResponse(validResponse({ units: [withoutDisplayName] }));

    expect(result.ok).toBe(false);
  });

  it("reports RESPONSE_CONTRACT_MISMATCH as the error kind on failure", () => {
    const result = validateCatalogResponse(validResponse({ schemaVersion: 2 }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("RESPONSE_CONTRACT_MISMATCH");
    }
  });
});

// docs/ui-design/03_API・データ連携設計.md §9.1: プレビューレスポンスの検証.
describe("validateFormationStatPreviewResponse (UI-UT-API-009)", () => {
  const previewUnit = {
    side: "ALLY",
    unitDefinitionId: "UNIT_ALLY",
    formationPosition: { column: 0, row: "FRONT" },
    maximumHp: 1000.5,
    combatStats: {
      attack: 100,
      defense: 50,
      criticalRate: 12.5,
      actionSpeed: 12,
      affinityBonus: 25,
      criticalDamageBonus: 50,
    },
  };
  const previewBody = { schemaVersion: 1, catalogRevision: "rev-1", units: [previewUnit] };

  it("accepts a well-formed body and keeps unknown optional properties", () => {
    const result = validateFormationStatPreviewResponse({ ...previewBody, futureField: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.units[0]?.maximumHp).toBe(1000.5);
    expect(result.response.catalogRevision).toBe("rev-1");
  });

  it("rejects a unit missing a combatStats member as a contract mismatch", () => {
    const { criticalRate: _dropped, ...withoutCriticalRate } = previewUnit.combatStats;

    const result = validateFormationStatPreviewResponse({
      ...previewBody,
      units: [{ ...previewUnit, combatStats: withoutCriticalRate }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("RESPONSE_CONTRACT_MISMATCH");
  });

  it("rejects a non-finite maximumHp, so NaN never reaches the display", () => {
    const result = validateFormationStatPreviewResponse({
      ...previewBody,
      units: [{ ...previewUnit, maximumHp: Number.NaN }],
    });

    expect(result.ok).toBe(false);
  });

  it("rejects a body whose units is not an array", () => {
    expect(validateFormationStatPreviewResponse({ ...previewBody, units: {} }).ok).toBe(false);
  });
});
