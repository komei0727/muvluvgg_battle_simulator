import { describe, expect, it } from "vitest";
import { validateCatalogResponse } from "./response-validator.js";

function validUnit(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    unitDefinitionId: "UNIT_A",
    displayName: "Unit A",
    characterName: "Character A",
    attribute: "FIRE",
    unitType: "ATTACKER",
    role: "DPS",
    positionAptitudes: ["FRONT"],
    selectable: true,
    unavailableCapabilities: [],
    ...overrides,
  };
}

function validMemory(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    memoryDefinitionId: "MEMORY_A",
    displayName: "Memory A",
    selectable: true,
    unavailableCapabilities: [],
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

  it("rejects a unit missing displayName", () => {
    const { displayName: _displayName, ...withoutDisplayName } = validUnit();
    const result = validateCatalogResponse(validResponse({ units: [withoutDisplayName] }));

    expect(result.ok).toBe(false);
  });

  it("rejects selectable: true paired with non-empty unavailableCapabilities", () => {
    const result = validateCatalogResponse(
      validResponse({
        units: [validUnit({ selectable: true, unavailableCapabilities: ["CAP_X"] })],
      }),
    );

    expect(result.ok).toBe(false);
  });

  it("rejects selectable: false paired with empty unavailableCapabilities", () => {
    const result = validateCatalogResponse(
      validResponse({
        units: [validUnit({ selectable: false, unavailableCapabilities: [] })],
      }),
    );

    expect(result.ok).toBe(false);
  });

  it("accepts selectable: false with unavailableCapabilities populated", () => {
    const result = validateCatalogResponse(
      validResponse({
        units: [validUnit({ selectable: false, unavailableCapabilities: ["CAP_X"] })],
      }),
    );

    expect(result.ok).toBe(true);
  });

  it("reports RESPONSE_CONTRACT_MISMATCH as the error kind on failure", () => {
    const result = validateCatalogResponse(validResponse({ schemaVersion: 2 }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("RESPONSE_CONTRACT_MISMATCH");
    }
  });
});
