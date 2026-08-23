// Regression fixture: a minimal but realistic Catalog response used by the
// mock-API E2E suite.
//
// REF-053 (Issue #598): kept hand-written rather than sourced from
// apps/ui/src/test/fixtures/m4.5-catalog.json — this fixture's exact unit
// names/ids are pinned to visual-regression.spec.ts's Linux-only screenshot
// baselines, which a content swap would invalidate. The generated fixture
// gives independent structural coverage via
// response-validator.contract-fixtures.test.ts.
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
    // R-TEX-11 #1 #4: 戦術演習専用ユニット。通常戦闘の選択プールには現れず、
    // 開催中フラグはバッジ表示にだけ使う（開催終了も選択できる）。
    {
      unitDefinitionId: "UNIT_EXERCISE_A",
      displayName: "エクササイズアルファ",
      characterName: "Exercise Alpha",
      category: "EXERCISE_ENEMY",
      exerciseActive: true,
      attribute: "COOL",
      unitType: "ATTACKER",
      role: "PHYSICAL_ATTACKER",
      positionAptitudes: ["FRONT"],
    },
    {
      unitDefinitionId: "UNIT_EXERCISE_B",
      displayName: "エクササイズブラボー",
      characterName: "Exercise Bravo",
      category: "EXERCISE_ENEMY",
      exerciseActive: false,
      attribute: "COOL",
      unitType: "GUARDIAN",
      role: "TANK",
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
