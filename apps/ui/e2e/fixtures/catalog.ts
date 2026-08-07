// Regression fixture: a minimal but realistic Catalog response used by the
// mock-API E2E suite.
export const CATALOG_REVISION = "e2e-catalog-rev-1";

export const catalogFixture = {
  schemaVersion: 1,
  catalogRevision: CATALOG_REVISION,
  units: [
    {
      unitDefinitionId: "UNIT_ALLY_A",
      displayName: "アライアルファ",
      characterName: "Ally Alpha",
      attribute: "CUTE",
      unitType: "ATTACKER",
      role: "PHYSICAL_ATTACKER",
      positionAptitudes: ["FRONT"],
    },
    {
      unitDefinitionId: "UNIT_ENEMY_A",
      displayName: "エネミーアルファ",
      characterName: "Enemy Alpha",
      attribute: "COOL",
      unitType: "ATTACKER",
      role: "PHYSICAL_ATTACKER",
      positionAptitudes: ["FRONT"],
    },
  ],
  memories: [
    {
      memoryDefinitionId: "MEM_ALPHA",
      displayName: "記憶アルファ",
    },
  ],
};

// Regression fixture: an HTTP 500 error body, covering "Catalog failure"
// (05_非機能・アクセシビリティ設計.md §12: 一覧取得失敗時は編成を有効にしない).
export const catalogFailureFixture = {
  schemaVersion: 1,
  error: {
    code: "INTERNAL_INVARIANT_VIOLATION",
    message: "Catalog is temporarily unavailable.",
    violations: [],
  },
};
