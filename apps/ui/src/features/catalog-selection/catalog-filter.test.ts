import { describe, expect, it } from "vitest";
import type { CatalogMemorySummary, CatalogUnitSummary } from "../simulation/api-contract.js";
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
    selectable: true,
    unavailableCapabilities: [],
  },
  {
    unitDefinitionId: "UNIT_BETA",
    displayName: "ベータ",
    characterName: "Beta",
    attribute: "WATER",
    unitType: "GUARDIAN",
    role: "TANK",
    positionAptitudes: ["FRONT", "BACK"],
    selectable: false,
    unavailableCapabilities: ["CAP_UNSUPPORTED"],
  },
  {
    unitDefinitionId: "UNIT_GAMMA",
    displayName: "Gamma Unit",
    characterName: "Gamma",
    attribute: "FIRE",
    unitType: "SUPPORT",
    role: "TANK",
    positionAptitudes: ["BACK"],
    selectable: true,
    unavailableCapabilities: [],
  },
];

const memories: readonly CatalogMemorySummary[] = [
  {
    memoryDefinitionId: "MEMORY_ALPHA",
    displayName: "記憶アルファ",
    selectable: true,
    unavailableCapabilities: [],
  },
  {
    memoryDefinitionId: "MEMORY_BETA",
    displayName: "Beta Memory",
    selectable: false,
    unavailableCapabilities: ["CAP_UNSUPPORTED"],
  },
];

describe("filterUnits", () => {
  // UI-UT-CAT-001
  it("matches displayName case-insensitively", () => {
    const result = filterUnits(units, { query: "gamma", availability: "all" });

    expect(result.map((unit) => unit.unitDefinitionId)).toEqual(["UNIT_GAMMA"]);
  });

  it("matches definitionId case-insensitively", () => {
    const result = filterUnits(units, { query: "unit_beta", availability: "all" });

    expect(result.map((unit) => unit.unitDefinitionId)).toEqual(["UNIT_BETA"]);
  });

  it("matches a Japanese displayName", () => {
    const result = filterUnits(units, { query: "アルファ", availability: "all" });

    expect(result.map((unit) => unit.unitDefinitionId)).toEqual(["UNIT_ALPHA"]);
  });

  it("trims surrounding whitespace from the query", () => {
    const result = filterUnits(units, { query: "  gamma  ", availability: "all" });

    expect(result.map((unit) => unit.unitDefinitionId)).toEqual(["UNIT_GAMMA"]);
  });

  // UI-UT-CAT-002
  it("combines attribute and role filters", () => {
    const result = filterUnits(units, {
      query: "",
      attribute: "FIRE",
      role: "TANK",
      availability: "all",
    });

    expect(result.map((unit) => unit.unitDefinitionId)).toEqual(["UNIT_GAMMA"]);
  });

  it("filters by aptitude using the FRONT/BACK to FRONT/REAR mapping", () => {
    const result = filterUnits(units, { query: "", aptitude: "REAR", availability: "all" });

    // Order is asserted separately; here only membership matters.
    expect(result.map((unit) => unit.unitDefinitionId).toSorted()).toEqual(
      ["UNIT_BETA", "UNIT_GAMMA"].toSorted(),
    );
  });

  // UI-UT-CAT-003
  it("returns only selectable units when availability is 'selectable'", () => {
    const result = filterUnits(units, { query: "", availability: "selectable" });

    expect(result.map((unit) => unit.unitDefinitionId).toSorted()).toEqual(
      ["UNIT_ALPHA", "UNIT_GAMMA"].toSorted(),
    );
  });

  it("returns only unavailable units when availability is 'unavailable'", () => {
    const result = filterUnits(units, { query: "", availability: "unavailable" });

    expect(result.map((unit) => unit.unitDefinitionId)).toEqual(["UNIT_BETA"]);
  });

  // UI-UT-CAT-004
  it("preserves the original selectable and unavailableCapabilities values", () => {
    const result = filterUnits(units, { query: "", availability: "all" });

    const beta = result.find((unit) => unit.unitDefinitionId === "UNIT_BETA");
    expect(beta?.selectable).toBe(false);
    expect(beta?.unavailableCapabilities).toEqual(["CAP_UNSUPPORTED"]);
  });

  it("sorts selectable units first, then by displayName, then by id", () => {
    // Same-script display names to keep locale comparison deterministic
    // across ICU builds.
    const sortSample: readonly CatalogUnitSummary[] = [
      { ...units[1]!, unitDefinitionId: "UNIT_C", displayName: "Charlie", selectable: false },
      {
        ...units[0]!,
        unitDefinitionId: "UNIT_B",
        displayName: "Bravo",
        selectable: true,
        unavailableCapabilities: [],
      },
      {
        ...units[0]!,
        unitDefinitionId: "UNIT_A",
        displayName: "Alpha",
        selectable: true,
        unavailableCapabilities: [],
      },
    ];

    const result = filterUnits(sortSample, { query: "", availability: "all" });

    expect(result.map((unit) => unit.unitDefinitionId)).toEqual(["UNIT_A", "UNIT_B", "UNIT_C"]);
  });

  it("falls back to definitionId when displayName is tied", () => {
    const tiedSample: readonly CatalogUnitSummary[] = [
      { ...units[0]!, unitDefinitionId: "UNIT_Z", displayName: "Same Name" },
      { ...units[0]!, unitDefinitionId: "UNIT_A", displayName: "Same Name" },
    ];

    const result = filterUnits(tiedSample, { query: "", availability: "all" });

    expect(result.map((unit) => unit.unitDefinitionId)).toEqual(["UNIT_A", "UNIT_Z"]);
  });
});

describe("filterMemories", () => {
  it("matches displayName case-insensitively", () => {
    const result = filterMemories(memories, { query: "beta", availability: "all" });

    expect(result.map((memory) => memory.memoryDefinitionId)).toEqual(["MEMORY_BETA"]);
  });

  it("separates selectable and unavailable memories", () => {
    expect(
      filterMemories(memories, { query: "", availability: "selectable" }).map(
        (memory) => memory.memoryDefinitionId,
      ),
    ).toEqual(["MEMORY_ALPHA"]);
    expect(
      filterMemories(memories, { query: "", availability: "unavailable" }).map(
        (memory) => memory.memoryDefinitionId,
      ),
    ).toEqual(["MEMORY_BETA"]);
  });

  it("does not mutate the input array", () => {
    const original = [...memories];

    filterMemories(memories, { query: "", availability: "all" });

    expect(memories).toEqual(original);
  });
});
