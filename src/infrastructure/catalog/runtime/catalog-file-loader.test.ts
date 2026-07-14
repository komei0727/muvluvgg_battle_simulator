import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CatalogIntegrityError } from "../../../domain/catalog/catalog-integrity.js";
import { loadBattleCatalogDirectory, loadCatalogFromDirectory } from "./catalog-file-loader.js";
import {
  CatalogFileHashMismatchError,
  UnsupportedCatalogSchemaVersionError,
} from "./catalog-manifest.js";

function fixturePath(...segments: string[]): string {
  return fileURLToPath(new URL(`../__fixtures__/${segments.join("/")}`, import.meta.url));
}

describe("loadCatalogFromDirectory", () => {
  it("IT-CAT-LOADER-001: loads the minimal Catalog and builds an in-memory index", () => {
    const catalog = loadCatalogFromDirectory(fixturePath("runtime", "valid", "minimal"));
    expect(catalog.catalogRevision).toBe("test-minimal.1");
    const snapshot = catalog.loadSnapshot(["UNIT_001" as never], []);
    expect(snapshot.catalogRevision).toBe("test-minimal.1");
    expect(snapshot.units.has("UNIT_001" as never)).toBe(true);
    expect(snapshot.skills.has("SKL_001_AS1" as never)).toBe(true);
    expect(snapshot.skills.has("SKL_001_EX" as never)).toBe(true);
    expect(snapshot.effectActions.has("ACT_DAMAGE_PHYSICAL_100" as never)).toBe(true);
  });

  it("IT-CAT-LOADER-002: loading the same directory twice yields an identical snapshot for the same revision", () => {
    const first = loadCatalogFromDirectory(fixturePath("runtime", "valid", "minimal")).loadSnapshot(
      ["UNIT_001" as never],
      [],
    );
    const second = loadCatalogFromDirectory(
      fixturePath("runtime", "valid", "minimal"),
    ).loadSnapshot(["UNIT_001" as never], []);
    expect(second.catalogRevision).toBe(first.catalogRevision);
    expect([...second.units.keys()]).toEqual([...first.units.keys()]);
    expect([...second.skills.keys()]).toEqual([...first.skills.keys()]);
  });

  it("IT-CAT-LOADER-003: rejects a Catalog with a duplicate id, naming the offending id", () => {
    try {
      loadCatalogFromDirectory(fixturePath("runtime", "invalid", "duplicate-id"));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogIntegrityError);
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("DUPLICATE_ID");
      expect(err.violations[0]?.targetId).toBe("UNIT_001");
    }
  });

  it("IT-CAT-LOADER-004: rejects a Catalog with a dangling Skill reference", () => {
    try {
      loadCatalogFromDirectory(fixturePath("runtime", "invalid", "dangling-reference"));
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("DANGLING_REFERENCE");
    }
  });

  it("IT-CAT-LOADER-005: rejects a Catalog referencing a Skill of the wrong skillType", () => {
    try {
      loadCatalogFromDirectory(fixturePath("runtime", "invalid", "wrong-skill-type"));
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("TYPE_MISMATCH");
    }
  });

  it("IT-CAT-LOADER-006: rejects a Catalog whose EX skill cost.amount mismatches extraGaugeMaximum", () => {
    try {
      loadCatalogFromDirectory(fixturePath("runtime", "invalid", "ex-cost-mismatch"));
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("EX_COST_MISMATCH");
    }
  });

  it("IT-CAT-LOADER-007: rejects a Catalog referencing an undefined Capability", () => {
    try {
      loadCatalogFromDirectory(fixturePath("runtime", "invalid", "unknown-capability"));
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("UNKNOWN_CAPABILITY");
    }
  });

  it("IT-CAT-LOADER-008: rejects a Catalog with a Trigger referencing an unknown eventType", () => {
    try {
      loadCatalogFromDirectory(fixturePath("runtime", "invalid", "unknown-event-type"));
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("UNKNOWN_EVENT_TYPE");
    }
  });

  it("IT-CAT-LOADER-009: rejects a Catalog whose file content does not match the manifest hash", () => {
    expect(() =>
      loadCatalogFromDirectory(fixturePath("runtime", "invalid", "hash-mismatch")),
    ).toThrow(CatalogFileHashMismatchError);
  });

  it("IT-CAT-LOADER-010: rejects a Catalog with an unknown schemaVersion", () => {
    expect(() =>
      loadCatalogFromDirectory(fixturePath("runtime", "invalid", "unknown-schema-version")),
    ).toThrow(UnsupportedCatalogSchemaVersionError);
  });

  it("IT-CAT-LOADER-011: loadSnapshot excludes Skills belonging to Units that were not requested", () => {
    const catalog = loadCatalogFromDirectory(fixturePath("runtime", "valid", "minimal"));
    const snapshot = catalog.loadSnapshot([], []);
    expect(snapshot.units.size).toBe(0);
    expect(snapshot.skills.size).toBe(0);
    expect(snapshot.effectActions.size).toBe(0);
  });

  it("IT-CAT-LOADER-012: loadSnapshot omits ids that do not exist in the Catalog rather than throwing", () => {
    const catalog = loadCatalogFromDirectory(fixturePath("runtime", "valid", "minimal"));
    const snapshot = catalog.loadSnapshot(["UNIT_MISSING" as never], []);
    expect(snapshot.units.has("UNIT_MISSING" as never)).toBe(false);
    expect(snapshot.units.size).toBe(0);
  });
});

describe("loadBattleCatalogDirectory", () => {
  it("IT-CAT-LOADER-013 (11_インフラストラクチャ設計.md「Catalog一覧read modelを起動時に1回だけ構築する」): loads the whole Catalog into a BattleCatalogDirectory snapshot without requesting specific ids", () => {
    const directory = loadBattleCatalogDirectory(fixturePath("runtime", "valid", "minimal"));
    const snapshot = directory.loadSnapshot();
    expect(snapshot.catalogRevision).toBe("test-minimal.1");
    expect(snapshot.units.has("UNIT_001" as never)).toBe(true);
    expect(snapshot.skills.has("SKL_001_AS1" as never)).toBe(true);
    expect(snapshot.effectActions.has("ACT_DAMAGE_PHYSICAL_100" as never)).toBe(true);
  });

  it("IT-CAT-LOADER-014: rejects the same invalid Catalogs as loadCatalogFromDirectory (shares the Read → Hash → Shape → Resolve → Semantic pipeline)", () => {
    expect(() =>
      loadBattleCatalogDirectory(fixturePath("runtime", "invalid", "dangling-reference")),
    ).toThrow(CatalogIntegrityError);
  });
});
