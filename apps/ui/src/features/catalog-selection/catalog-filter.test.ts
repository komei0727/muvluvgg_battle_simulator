import { describe, expect, it } from "vitest";
import type { CatalogMemorySummary, CatalogUnitSummary } from "../../shared/api/api-contract.js";
import { filterMemories, filterUnits } from "./catalog-filter.js";

const units: readonly CatalogUnitSummary[] = [
  {
    unitDefinitionId: "UNIT_ALPHA",
    displayName: "アルファ",
    characterName: "Alpha",
    attribute: "FIRE",
    unitType: "ATTACKER",
    role: "DPS",
    positionAptitudes: ["FRONT"],
  },
  {
    unitDefinitionId: "UNIT_BETA",
    displayName: "ベータ",
    characterName: "Beta",
    attribute: "WATER",
    unitType: "GUARDIAN",
    role: "TANK",
    positionAptitudes: ["FRONT", "BACK"],
  },
  {
    unitDefinitionId: "UNIT_GAMMA",
    displayName: "Gamma Unit",
    characterName: "Gamma",
    attribute: "FIRE",
    unitType: "SUPPORT",
    role: "TANK",
    positionAptitudes: ["BACK"],
  },
];

const memories: readonly CatalogMemorySummary[] = [
  {
    memoryDefinitionId: "MEMORY_ALPHA",
    displayName: "記憶アルファ",
  },
  {
    memoryDefinitionId: "MEMORY_BETA",
    displayName: "Beta Memory",
  },
];

describe("filterUnits", () => {
  // UI-UT-CAT-001
  it("matches displayName case-insensitively", () => {
    const result = filterUnits(units, { query: "gamma" });

    expect(result.map((unit) => unit.unitDefinitionId)).toEqual(["UNIT_GAMMA"]);
  });

  it("matches definitionId case-insensitively", () => {
    const result = filterUnits(units, { query: "unit_beta" });

    expect(result.map((unit) => unit.unitDefinitionId)).toEqual(["UNIT_BETA"]);
  });

  it("matches a Japanese displayName", () => {
    const result = filterUnits(units, { query: "アルファ" });

    expect(result.map((unit) => unit.unitDefinitionId)).toEqual(["UNIT_ALPHA"]);
  });

  it("trims surrounding whitespace from the query", () => {
    const result = filterUnits(units, { query: "  gamma  " });

    expect(result.map((unit) => unit.unitDefinitionId)).toEqual(["UNIT_GAMMA"]);
  });

  // UI-UT-CAT-002
  it("combines attribute and role filters", () => {
    const result = filterUnits(units, {
      query: "",
      attribute: "FIRE",
      role: "TANK",
    });

    expect(result.map((unit) => unit.unitDefinitionId)).toEqual(["UNIT_GAMMA"]);
  });

  it("filters by aptitude using the FRONT/BACK to FRONT/REAR mapping", () => {
    const result = filterUnits(units, { query: "", aptitude: "REAR" });

    // Order is asserted separately; here only membership matters.
    expect(result.map((unit) => unit.unitDefinitionId).toSorted()).toEqual(
      ["UNIT_BETA", "UNIT_GAMMA"].toSorted(),
    );
  });

  it("sorts by displayName, then by id", () => {
    // Same-script display names to keep locale comparison deterministic
    // across ICU builds.
    const sortSample: readonly CatalogUnitSummary[] = [
      { ...units[1]!, unitDefinitionId: "UNIT_C", displayName: "Charlie" },
      {
        ...units[0]!,
        unitDefinitionId: "UNIT_B",
        displayName: "Bravo",
      },
      {
        ...units[0]!,
        unitDefinitionId: "UNIT_A",
        displayName: "Alpha",
      },
    ];

    const result = filterUnits(sortSample, { query: "" });

    expect(result.map((unit) => unit.unitDefinitionId)).toEqual(["UNIT_A", "UNIT_B", "UNIT_C"]);
  });

  it("falls back to definitionId when displayName is tied", () => {
    const tiedSample: readonly CatalogUnitSummary[] = [
      { ...units[0]!, unitDefinitionId: "UNIT_Z", displayName: "Same Name" },
      { ...units[0]!, unitDefinitionId: "UNIT_A", displayName: "Same Name" },
    ];

    const result = filterUnits(tiedSample, { query: "" });

    expect(result.map((unit) => unit.unitDefinitionId)).toEqual(["UNIT_A", "UNIT_Z"]);
  });
});

describe("filterMemories", () => {
  it("matches displayName case-insensitively", () => {
    const result = filterMemories(memories, { query: "beta" });

    expect(result.map((memory) => memory.memoryDefinitionId)).toEqual(["MEMORY_BETA"]);
  });

  it("does not mutate the input array", () => {
    const original = [...memories];

    filterMemories(memories, { query: "" });

    expect(memories).toEqual(original);
  });
});
