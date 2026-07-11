import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CatalogSourceError, readCatalogSource } from "./catalog-src-aggregator.js";

/**
 * Issue #50: `catalog-src/` is the human-edited authoring source, split by
 * unit/memory version (`catalog-src/units/<unitDefinitionId>/`,
 * `catalog-src/memories/<memoryDefinitionId>/`) rather than by character, so
 * that a character with multiple gacha versions gets one directory per
 * version. `readCatalogSource` aggregates it back into the same five
 * in-memory arrays `catalog/*.json` holds today.
 */

function fixturePath(...segments: string[]): string {
  return fileURLToPath(new URL(`../__fixtures__/${segments.join("/")}`, import.meta.url));
}

describe("readCatalogSource", () => {
  it("UT-CAT-SRC-001: reads capabilities.json as-is from the catalog-src root", () => {
    const source = readCatalogSource(fixturePath("catalog-src", "valid", "minimal"));
    expect(source.capabilities).toEqual([]);
  });

  it("UT-CAT-SRC-002: aggregates one unit.json per unit directory into the units array", () => {
    const source = readCatalogSource(fixturePath("catalog-src", "valid", "minimal"));
    const unitIds = source.units.map((u) => (u as { unitDefinitionId: string }).unitDefinitionId);
    expect(unitIds).toEqual(["UNIT_001", "UNIT_002"]);
  });

  it("UT-CAT-SRC-003: orders units by directory name for deterministic output", () => {
    const source = readCatalogSource(fixturePath("catalog-src", "valid", "minimal"));
    const displayNames = source.units.map(
      (u) => (u as { metadata: { displayName: string } }).metadata.displayName,
    );
    expect(displayNames).toEqual(["Minimal Unit One", "Minimal Unit Two"]);
  });

  it("UT-CAT-SRC-004: concatenates each unit's skills.json into a single skills array", () => {
    const source = readCatalogSource(fixturePath("catalog-src", "valid", "minimal"));
    const skillIds = source.skills.map(
      (s) => (s as { skillDefinitionId: string }).skillDefinitionId,
    );
    expect(skillIds).toEqual(["SKL_001_AS1", "SKL_001_EX", "SKL_002_EX"]);
  });

  it("UT-CAT-SRC-005: concatenates each unit's effects.json into a single effects array", () => {
    const source = readCatalogSource(fixturePath("catalog-src", "valid", "minimal"));
    const effectIds = source.effects.map(
      (e) => (e as { effectActionDefinitionId: string }).effectActionDefinitionId,
    );
    expect(effectIds).toEqual(["ACT_DAMAGE_PHYSICAL_100", "ACT_DAMAGE_PHYSICAL_100_U2"]);
  });

  it("UT-CAT-SRC-006: yields an empty memories array when catalog-src has no memories/ directory", () => {
    const source = readCatalogSource(fixturePath("catalog-src", "valid", "minimal"));
    expect(source.memories).toEqual([]);
  });

  it("UT-CAT-SRC-007: aggregates memory.json and per-memory effects.json when memories/ exists", () => {
    const source = readCatalogSource(fixturePath("catalog-src", "valid", "with-memory"));
    const memoryIds = source.memories.map(
      (m) => (m as { memoryDefinitionId: string }).memoryDefinitionId,
    );
    expect(memoryIds).toEqual(["MEM_001"]);
    expect(source.units).toEqual([]);
  });

  it("UT-CAT-SRC-008: rejects a unit directory whose name does not match unit.json's unitDefinitionId", () => {
    expect(() =>
      readCatalogSource(fixturePath("catalog-src", "invalid", "mismatched-unit")),
    ).toThrow(CatalogSourceError);
  });

  it("UT-CAT-SRC-009: rejects a unit's skills.json containing a skill not declared by that unit's unit.json", () => {
    expect(() => readCatalogSource(fixturePath("catalog-src", "invalid", "unowned-skill"))).toThrow(
      /SKL_001_ROGUE/,
    );
  });

  it("UT-CAT-SRC-010: rejects a unit whose unit.json declares a skill missing from that unit's skills.json", () => {
    expect(() => readCatalogSource(fixturePath("catalog-src", "invalid", "missing-skill"))).toThrow(
      /SKL_001_AS1/,
    );
  });

  it("UT-CAT-SRC-011: rejects a unit's effects.json containing an effect not referenced by that unit's own skills", () => {
    expect(() =>
      readCatalogSource(fixturePath("catalog-src", "invalid", "unowned-effect")),
    ).toThrow(/ACT_UNUSED_EXTRA/);
  });

  it("UT-CAT-SRC-012: rejects a memory's effects.json containing an effect not referenced by that memory's triggeredEffects", () => {
    expect(() =>
      readCatalogSource(fixturePath("catalog-src", "invalid", "memory-unowned-effect")),
    ).toThrow(/ACT_MEMORY_UNUSED/);
  });

  it("UT-CAT-SRC-013: rejects a unit whose skill references an effect missing from that unit's own effects.json", () => {
    expect(() =>
      readCatalogSource(fixturePath("catalog-src", "invalid", "missing-effect")),
    ).toThrow(/ACT_DAMAGE_PHYSICAL_100/);
  });

  it("UT-CAT-SRC-014: rejects a memory whose triggeredEffects references an effect missing from that memory's own effects.json", () => {
    expect(() =>
      readCatalogSource(fixturePath("catalog-src", "invalid", "memory-missing-effect")),
    ).toThrow(/ACT_MEMORY_USED/);
  });
});
