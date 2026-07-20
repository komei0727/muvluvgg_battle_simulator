import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface AffiliationMember {
  readonly characterId: string;
  readonly characterName: string;
  readonly evidence: string;
}

interface AffiliationRegistryEntry {
  readonly affiliationId: string;
  readonly displayName: string;
  readonly sourceMemories: readonly string[];
  readonly sourceQuote: string;
  readonly members: readonly AffiliationMember[];
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

interface MemberLedgerRow {
  readonly affiliationId: string;
  readonly characterId: string;
}

function parseMemberLedgerTable(): MemberLedgerRow[] {
  const ledger = readRepositoryFile("docs/ddd/18_Affiliation台帳.md");
  const table = ledger.slice(
    ledger.indexOf("## 所属キャラクター一覧（手動入力）"),
    ledger.indexOf("## Unit metadata 更新方針"),
  );
  return table
    .split("\n")
    .filter((line) => line.startsWith("| `AFF_"))
    .map((line) => {
      const columns = line.split("|").map((column) => column.trim());
      return {
        affiliationId: columns[1]?.replaceAll("`", "") ?? "",
        characterId: columns[2]?.replaceAll("`", "") ?? "",
      };
    });
}

interface CatalogSrcUnit {
  readonly unitDefinitionId: string;
  readonly metadata: { readonly characterId: string; readonly affiliations: readonly string[] };
}

function readCatalogSrcUnits(): CatalogSrcUnit[] {
  const unitsDir = `${repositoryRoot}/apps/api/catalog-src/units`;
  return readdirSync(unitsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(
      (entry) =>
        JSON.parse(readFileSync(`${unitsDir}/${entry.name}/unit.json`, "utf8")) as CatalogSrcUnit,
    );
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

  it("UT-CAT-001-005: cites non-empty characterId/characterName/evidence for every member and assigns each character to at most one affiliation", () => {
    const registry = readRegistry();
    const allCharacterIds: string[] = [];
    for (const entry of registry.affiliations) {
      for (const member of entry.members) {
        expect(member.characterId.trim().length).toBeGreaterThan(0);
        expect(member.characterName.trim().length).toBeGreaterThan(0);
        expect(member.evidence.trim().length).toBeGreaterThan(0);
        allCharacterIds.push(member.characterId);
      }
    }
    expect(new Set(allCharacterIds).size).toBe(allCharacterIds.length);
  });

  it("UT-CAT-001-006: the manual-entry Markdown table lists exactly the JSON registry's members", () => {
    const registry = readRegistry();
    const registryRows = registry.affiliations
      .flatMap((entry) =>
        entry.members.map((member) => `${entry.affiliationId}:${member.characterId}`),
      )
      .sort();
    const ledgerRows = parseMemberLedgerTable()
      .map((row) => `${row.affiliationId}:${row.characterId}`)
      .sort();
    expect(ledgerRows).toEqual(registryRows);
  });

  it("UT-CAT-001-007: every registered member's production Catalog Unit(s) carry the affiliationId, and no Unit carries an unregistered one", () => {
    const registry = readRegistry();
    const characterIdToAffiliationId = new Map<string, string>();
    for (const entry of registry.affiliations) {
      for (const member of entry.members) {
        characterIdToAffiliationId.set(member.characterId, entry.affiliationId);
      }
    }

    const units = readCatalogSrcUnits();
    for (const [characterId, affiliationId] of characterIdToAffiliationId) {
      const unitsForCharacter = units.filter((unit) => unit.metadata.characterId === characterId);
      expect(unitsForCharacter.length).toBeGreaterThan(0);
      for (const unit of unitsForCharacter) {
        expect(unit.metadata.affiliations).toContain(affiliationId);
      }
    }

    for (const unit of units) {
      for (const affiliationId of unit.metadata.affiliations) {
        expect(characterIdToAffiliationId.get(unit.metadata.characterId)).toBe(affiliationId);
      }
    }
  });
});
