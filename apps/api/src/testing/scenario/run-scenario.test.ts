import { describe, expect, it } from "vitest";
import { CatalogBuilder } from "./catalog-builder.js";
import { battleCommand, formationSlot, unitDefinition } from "./definition-builders.js";
import {
  assertBattleInvariants,
  assertResourcesWithinBounds,
  runScenario,
} from "./run-scenario.js";

/**
 * Battle Scenario Harness（`12_テスト戦略.md`「シナリオHarness」）自体の自己検証。
 * `runScenario` + `CatalogBuilder` + 定義Builder が実Formation/Battle/Observationを
 * 通して最小戦闘を完走できること、共通不変条件ヘルパーが機能することを固定する。
 */
describe("runScenario harness", () => {
  it("UT-HARNESS-001: runs a minimal 1v1 battle to the turn-limit outcome with a synthetic catalog", () => {
    const catalog = new CatalogBuilder()
      .withRevision("harness-rev-1")
      .withUnit(unitDefinition("UNIT_ALLY"), unitDefinition("UNIT_ENEMY"))
      .build();

    const result = runScenario({ catalog, command: battleCommand({ turnLimit: 3 }) });

    // 行動手段（AS/EX/ダメージ）がない最小編成なので、到達可能な終了は
    // ターン上限のみ（R-END-02 の優先度4）。
    expect(result.outcome).toBe("ALLY_LOSE");
    expect(result.completionReason).toBe("TURN_LIMIT_REACHED");
    expect(result.completedTurn).toBe(3);
    assertBattleInvariants(result);
  });

  it("UT-HARNESS-002: loads the catalog snapshot exactly once per battle", () => {
    const catalog = new CatalogBuilder()
      .withUnit(unitDefinition("UNIT_ALLY"), unitDefinition("UNIT_ENEMY"))
      .build();

    runScenario({ catalog, command: battleCommand() });

    expect(catalog.loadSnapshotCallCount).toBe(1);
  });

  it("UT-HARNESS-003: honours formation overrides and the FixedBattleIdGenerator", () => {
    const catalog = new CatalogBuilder()
      .withUnit(unitDefinition("UNIT_ALLY"), unitDefinition("UNIT_ENEMY"))
      .build();

    const result = runScenario({
      catalog,
      battleIds: ["B_HARNESS_1"],
      command: battleCommand({
        allyFormation: {
          slots: [formationSlot("UNIT_ALLY", 0), formationSlot("UNIT_ALLY", 1)],
          memoryDefinitionIds: [],
        },
        enemyFormation: { slots: [formationSlot("UNIT_ENEMY", 0)], memoryDefinitionIds: [] },
      }),
    });

    expect(String(result.battleId)).toBe("B_HARNESS_1");
    expect(result.catalogRevision).toBe("test-rev-1");
    expect(Object.keys(result.finalState.units)).toHaveLength(3);
    assertResourcesWithinBounds(result);
  });

  it("UT-HARNESS-004: the resource-bound assertion rejects a snapshot with negative HP", () => {
    const brokenResult = {
      finalState: {
        units: {
          "unit-x": { hp: -1, ap: 0, pp: 0, extraGauge: 0, combatStats: { maximumHp: 100 } },
        },
      },
    } as unknown as Parameters<typeof assertResourcesWithinBounds>[0];

    expect(() => assertResourcesWithinBounds(brokenResult)).toThrow(/hp must be non-negative/);
  });
});
