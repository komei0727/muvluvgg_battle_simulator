import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface AffiliationSourceMemory {
  readonly name: string;
  readonly sourceQuote: string;
}

interface AffiliationMember {
  readonly characterId: string;
  readonly characterName: string;
  readonly evidence: string;
}

interface AffiliationRegistryEntry {
  readonly affiliationId: string;
  readonly displayName: string;
  readonly sourceMemories: readonly AffiliationSourceMemory[];
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

interface SourceQuoteLedgerRow {
  readonly affiliationId: string;
  readonly memoryName: string;
  readonly sourceQuote: string;
}

function parseSourceQuoteLedgerTable(): SourceQuoteLedgerRow[] {
  const ledger = readRepositoryFile("docs/ddd/18_Affiliation台帳.md");
  const table = ledger.slice(
    ledger.indexOf("## 確定した affiliationId 一覧"),
    ledger.indexOf("## 所属キャラクター一覧（手動入力）"),
  );
  return table
    .split("\n")
    .filter((line) => line.startsWith("| `AFF_"))
    .map((line) => {
      const columns = line.split("|").map((column) => column.trim());
      return {
        affiliationId: columns[1]?.replaceAll("`", "") ?? "",
        memoryName: columns[3]?.replaceAll("`", "") ?? "",
        sourceQuote: (columns[4] ?? "").replace(/^「/, "").replace(/」$/, ""),
      };
    });
}

interface MemberLedgerRow {
  readonly affiliationId: string;
  readonly characterId: string;
  readonly characterName: string;
  readonly evidence: string;
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
        characterName: columns[3] ?? "",
        evidence: columns[4] ?? "",
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

  it("UT-CAT-001-003: cites a non-empty verbatim source quote for every Memory of every affiliation", () => {
    const registry = readRegistry();
    expect(registry.affiliations.length).toBeGreaterThan(0);
    for (const entry of registry.affiliations) {
      expect(entry.sourceMemories.length).toBeGreaterThan(0);
      expect(entry.displayName.trim().length).toBeGreaterThan(0);
      for (const sourceMemory of entry.sourceMemories) {
        expect(sourceMemory.name.trim().length).toBeGreaterThan(0);
        expect(sourceMemory.sourceQuote.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("UT-CAT-001-004: covers exactly the Memories the ledger marks as affiliation-conditioned", () => {
    const registry = readRegistry();
    const registeredMemoryNames = [
      ...new Set(
        registry.affiliations.flatMap((entry) => entry.sourceMemories.map((memory) => memory.name)),
      ),
    ].sort();
    const ledgerMemoryNames = parseAffiliationConditionMemoryNames();
    expect(registeredMemoryNames).toEqual(ledgerMemoryNames);
  });

  it("UT-CAT-001-004b: the affiliationId-list Markdown table cites exactly the JSON registry's per-Memory quotes, for all 11 affiliation-conditioned Memories", () => {
    const registry = readRegistry();
    const registryRows = registry.affiliations
      .flatMap((entry) =>
        entry.sourceMemories.map(
          (memory) => `${entry.affiliationId} ${memory.name} ${memory.sourceQuote}`,
        ),
      )
      .sort();
    const ledgerRows = parseSourceQuoteLedgerTable()
      .map((row) => `${row.affiliationId} ${row.memoryName} ${row.sourceQuote}`)
      .sort();
    expect(ledgerRows).toEqual(registryRows);
    expect(registryRows.length).toBe(11);
  });

  it("UT-CAT-001-005: cites non-empty characterId/characterName/evidence for every member, and never lists the same character twice under one affiliation", () => {
    const registry = readRegistry();
    for (const entry of registry.affiliations) {
      const characterIdsInEntry = entry.members.map((member) => member.characterId);
      expect(new Set(characterIdsInEntry).size).toBe(characterIdsInEntry.length);
      for (const member of entry.members) {
        expect(member.characterId.trim().length).toBeGreaterThan(0);
        expect(member.characterName.trim().length).toBeGreaterThan(0);
        expect(member.evidence.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("UT-CAT-001-006: the manual-entry Markdown table lists exactly the JSON registry's members, including characterName and 出典", () => {
    const registry = readRegistry();
    const registryRows = registry.affiliations
      .flatMap((entry) =>
        entry.members.map(
          (member) =>
            `${entry.affiliationId} ${member.characterId} ${member.characterName} ${member.evidence}`,
        ),
      )
      .sort();
    const ledgerRows = parseMemberLedgerTable()
      .map((row) => `${row.affiliationId} ${row.characterId} ${row.characterName} ${row.evidence}`)
      .sort();
    expect(ledgerRows).toEqual(registryRows);
  });

  it("UT-CAT-001-007: every production Catalog Unit's metadata.affiliations equals exactly the affiliationId set registered for its characterId (supports multiple affiliations per character)", () => {
    const registry = readRegistry();
    const characterIdToAffiliationIds = new Map<string, Set<string>>();
    for (const entry of registry.affiliations) {
      for (const member of entry.members) {
        const set = characterIdToAffiliationIds.get(member.characterId) ?? new Set<string>();
        set.add(entry.affiliationId);
        characterIdToAffiliationIds.set(member.characterId, set);
      }
    }

    const units = readCatalogSrcUnits();
    expect(units.length).toBeGreaterThan(0);
    for (const unit of units) {
      const expected = [
        ...(characterIdToAffiliationIds.get(unit.metadata.characterId) ?? new Set<string>()),
      ].sort();
      const actual = [...unit.metadata.affiliations].sort();
      expect(actual).toEqual(expected);
    }

    for (const characterId of characterIdToAffiliationIds.keys()) {
      expect(units.some((unit) => unit.metadata.characterId === characterId)).toBe(true);
    }
  });
});
