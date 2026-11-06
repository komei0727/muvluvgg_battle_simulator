import { CATALOG_REVISION } from "./catalog.js";

// Regression fixture: 両陣営2編成ずつの総力戦（`SUMMARY`実行）の成功レスポンス。
// 味方は編成1が2戦とも勝ち抜き、編成2は出撃しないまま終わる。敵の編成2は編成1と同じ
// ユニットの再登場（R-TWR-02 #1）として出撃し、撃破される。
//
// apps/ui/src/test/fixtures/total-war-success.jsonと同じ筋書きだが、ユニットIDを
// catalog.tsの定義へ合わせて手書きする。値はvisual-regression.spec.tsのLinux専用
// baselineへ写るため、生成fixtureの再生成で動かないようにする。
//
// `SUMMARY`実行なのでイベント・状態遷移は空、`finalState`は省略される。
const unit = (
  battleUnitId: string,
  unitDefinitionId: string,
  side: "ALLY" | "ENEMY",
  hp: number,
) => ({
  battleUnitId,
  unitDefinitionId,
  side,
  combatStatus: "ACTIVE",
  hp: { current: hp, maximum: hp },
  formationNumber: 1,
});

export const totalWarSuccessFixture = {
  schemaVersion: 1,
  battleId: "total-war-e2e-001",
  catalogRevision: CATALOG_REVISION,
  result: {
    outcome: "ALLY_WIN",
    completionReason: "ENEMY_DEFEATED",
    completedTurn: 3,
    stages: [
      {
        stageNumber: 1,
        allyFormationNumber: 1,
        enemyFormationNumber: 1,
        startTurn: 1,
        endTurn: 2,
        defeatedSides: ["ENEMY"],
      },
      {
        stageNumber: 2,
        allyFormationNumber: 1,
        enemyFormationNumber: 2,
        startTurn: 3,
        endTurn: 3,
        defeatedSides: ["ENEMY"],
      },
    ],
    defeatedFormationCounts: { ally: 0, enemy: 2 },
  },
  // 両陣営の1番目の編成だけを含む（10_API設計.md「TotalWarResponse」）。
  initialState: {
    stateVersion: 0,
    battleStatus: "READY",
    turnNumber: 0,
    cycleNumber: 0,
    units: [
      unit("ally:1", "UNIT_ALLY_A", "ALLY", 100),
      unit("enemy:1", "UNIT_ENEMY_A", "ENEMY", 80),
    ],
  },
  unitRoster: [
    {
      battleUnitId: "ally:1",
      unitDefinitionId: "UNIT_ALLY_A",
      side: "ALLY",
      formationNumber: 1,
      formationPosition: { column: 0, row: "FRONT" },
      reappearance: false,
      deployed: true,
    },
    {
      battleUnitId: "ally:2",
      unitDefinitionId: "UNIT_ALLY_A",
      side: "ALLY",
      formationNumber: 2,
      formationPosition: { column: 0, row: "FRONT" },
      reappearance: true,
      deployed: false,
    },
    {
      battleUnitId: "enemy:1",
      unitDefinitionId: "UNIT_ENEMY_A",
      side: "ENEMY",
      formationNumber: 1,
      formationPosition: { column: 0, row: "FRONT" },
      reappearance: false,
      deployed: true,
    },
    {
      battleUnitId: "enemy:2",
      unitDefinitionId: "UNIT_ENEMY_A",
      side: "ENEMY",
      formationNumber: 2,
      formationPosition: { column: 0, row: "FRONT" },
      reappearance: true,
      deployed: true,
    },
  ],
  unitSummaries: [
    {
      battleUnitId: "ally:1",
      side: "ALLY",
      damageDealt: 81,
      damageTaken: 20,
      healingDone: 0,
      finalHp: 80,
      maximumHp: 100,
      combatStatus: "ACTIVE",
      formationNumber: 1,
      deployed: true,
    },
    {
      battleUnitId: "ally:2",
      side: "ALLY",
      damageDealt: 0,
      damageTaken: 0,
      healingDone: 0,
      finalHp: 1,
      maximumHp: 1,
      combatStatus: "ACTIVE",
      formationNumber: 2,
      deployed: false,
    },
    {
      battleUnitId: "enemy:1",
      side: "ENEMY",
      damageDealt: 20,
      damageTaken: 80,
      healingDone: 0,
      finalHp: 0,
      maximumHp: 80,
      combatStatus: "DEFEATED",
      formationNumber: 1,
      deployed: true,
    },
    {
      battleUnitId: "enemy:2",
      side: "ENEMY",
      damageDealt: 0,
      damageTaken: 1,
      healingDone: 0,
      finalHp: 0,
      maximumHp: 1,
      combatStatus: "DEFEATED",
      formationNumber: 2,
      deployed: true,
    },
  ],
  events: [],
  stateTransitions: [],
};
