import { describe, expect, it } from "vitest";
import { CatalogBuilder } from "./catalog-builder.js";
import {
  attackSkill,
  battleCommand,
  damageEffectAction,
  formationSlot,
  unitDefinition,
} from "./definition-builders.js";
import {
  assertBattleInvariants,
  assertResourcesWithinBounds,
  runScenario,
} from "./run-scenario.js";
import { createSkillDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { fc } from "../property/index.js";

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

/**
 * 全戦闘の不変条件を property-based test（fast-check）で検証する（`12_テスト戦略.md`
 * 「Property／Modelテスト」: 任意の有効編成でHP/AP/PP/EX/期間が負数にならない、
 * `COMPLETED`後に状態が変化しない、状態versionが連続する）。攻撃はPREVENTED会心で
 * RandomSourceを消費しないため、可変長の戦闘でも乱数計上なしに完走できる。
 */
const SKL_ATK = createSkillDefinitionId("SKL_ATK_PROP");

const SIDE_POSITIONS = [
  { column: 0, row: "FRONT" },
  { column: 1, row: "FRONT" },
  { column: 2, row: "FRONT" },
  { column: 0, row: "REAR" },
  { column: 1, row: "REAR" },
  { column: 2, row: "REAR" },
] as const;

/** 1〜5体の互いに異なる配置のスロット列（同一の攻撃Unitを参照）。 */
const sideSlotsArb = fc
  .uniqueArray(fc.integer({ min: 0, max: SIDE_POSITIONS.length - 1 }), {
    minLength: 1,
    maxLength: 5,
  })
  .map((indices) =>
    indices.map((i) => {
      const p = SIDE_POSITIONS[i]!;
      return formationSlot("UNIT_ATK", p.column, p.row);
    }),
  );

const battleSetupArb = fc.record({
  allySlots: sideSlotsArb,
  enemySlots: sideSlotsArb,
  attack: fc.integer({ min: 1, max: 200 }),
  defense: fc.integer({ min: 0, max: 100 }),
  maximumHp: fc.integer({ min: 10, max: 300 }),
  actionSpeed: fc.integer({ min: 1, max: 100 }),
  turnLimit: fc.integer({ min: 1, max: 20 }),
});

describe("runScenario battle invariants (property)", () => {
  it("PROP-BATTLE-001: any valid formation runs to a decided outcome with all battle invariants held", () => {
    fc.assert(
      fc.property(battleSetupArb, (setup) => {
        const attacker = unitDefinition("UNIT_ATK", {
          activeSkillDefinitionIds: [SKL_ATK],
          baseStats: {
            attack: setup.attack,
            defense: setup.defense,
            maximumHp: setup.maximumHp,
            actionSpeed: setup.actionSpeed,
          },
        });
        const catalog = new CatalogBuilder()
          .withUnit(attacker)
          .withSkill(attackSkill("SKL_ATK_PROP", "ACT_DMG_PROP"))
          // PREVENTED会心: RandomSourceを一切消費しない。
          .withEffectAction(damageEffectAction("ACT_DMG_PROP", 50, "PREVENTED"))
          .build();

        const result = runScenario({
          catalog,
          command: battleCommand({
            allyFormation: { slots: setup.allySlots, memoryDefinitionIds: [] },
            enemyFormation: { slots: setup.enemySlots, memoryDefinitionIds: [] },
            turnLimit: setup.turnLimit,
          }),
        });

        expect(typeof result.outcome).toBe("string");
        expect(result.finalState.status).toBe("COMPLETED");
        assertBattleInvariants(result);
        return true;
      }),
      // 戦闘は純関数より重いので実行回数を抑える。seedは固定して再現可能にする。
      { seed: 0x5eed, numRuns: 60 },
    );
  });
});
