import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface AffiliationRegistryEntry {
  readonly affiliationId: string;
  readonly displayName: string;
  readonly sourceMemories: readonly string[];
  readonly sourceQuote: string;
}

interface AffiliationRegistry {
  readonly schemaVersion: 1;
  readonly affiliations: readonly AffiliationRegistryEntry[];
}

const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

function readRepositoryFile(path: string): string {
  return readFileSync(`${repositoryRoot}/${path}`, "utf8");
}

function readRegistry(): AffiliationRegistry {
  return JSON.parse(readRepositoryFile("docs/ddd/18_Affiliation台帳.json")) as AffiliationRegistry;
}

const AFFILIATION_ID_PATTERN = /^AFF_[A-Z0-9]+(?:_[A-Z0-9]+)*$/;

function parseAffiliationConditionMemoryNames(): string[] {
  const ledger = readRepositoryFile("docs/ddd/15_Unit_Memory変換台帳.md");
  const table = ledger.slice(
    ledger.indexOf("## Memory 変換台帳"),
    ledger.indexOf("### 未変換 Memory の分類基準"),
  );
  return table
    .split("\n")
    .filter((line) => line.startsWith("|") && line.includes("所属条件あり"))
    .map((line) => line.split("|")[1]?.trim())
    .filter((name): name is string => name !== undefined && name.length > 0)
    .sort();
}

describe("affiliationId registry (CAT-001)", () => {
  it("UT-CAT-001-001: accepts AFF_-prefixed uppercase identifiers and rejects malformed ones", () => {
    expect(AFFILIATION_ID_PATTERN.test("AFF_KURASUNA")).toBe(true);
    expect(AFFILIATION_ID_PATTERN.test("AFF_PYXIS_MA_SOEUR")).toBe(true);
    expect(AFFILIATION_ID_PATTERN.test("aff_kurasuna")).toBe(false);
    expect(AFFILIATION_ID_PATTERN.test("KURASUNA")).toBe(false);
    expect(AFFILIATION_ID_PATTERN.test("AFF_")).toBe(false);
    expect(AFFILIATION_ID_PATTERN.test("AFF_KURASU-NA")).toBe(false);
  });

  it("UT-CAT-001-002: registers a uniquely identified, correctly formatted AFF_ entry for each affiliation", () => {
    const registry = readRegistry();
    const registeredIds = registry.affiliations.map((entry) => entry.affiliationId);
    expect(new Set(registeredIds).size).toBe(registeredIds.length);
    for (const id of registeredIds) {
      expect(id).toMatch(AFFILIATION_ID_PATTERN);
    }
  });

  it("UT-CAT-001-003: cites a non-empty verbatim source quote for every affiliation", () => {
    const registry = readRegistry();
    expect(registry.affiliations.length).toBeGreaterThan(0);
    for (const entry of registry.affiliations) {
      expect(entry.sourceMemories.length).toBeGreaterThan(0);
      expect(entry.sourceQuote.trim().length).toBeGreaterThan(0);
      expect(entry.displayName.trim().length).toBeGreaterThan(0);
    }
  });

  it("UT-CAT-001-004: covers exactly the Memories the ledger marks as affiliation-conditioned", () => {
    const registry = readRegistry();
    const registeredMemoryNames = [
      ...new Set(registry.affiliations.flatMap((entry) => entry.sourceMemories)),
    ].sort();
    const ledgerMemoryNames = parseAffiliationConditionMemoryNames();
    expect(registeredMemoryNames).toEqual(ledgerMemoryNames);
  });
});
