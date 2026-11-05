import { describe, expect, it } from "vitest";
import { SimulateTotalWarUseCase } from "./simulate-total-war-use-case.js";
import type { SimulateTotalWarCommand } from "./simulate-total-war-command.js";
import type { FormationInput } from "./simulate-battle-command.js";
import { ApplicationError } from "../contracts/application-error.js";
import {
  createMemoryDefinitionId,
  createSkillDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import { createMemoryDefinition } from "../../domain/catalog/definitions/memory-definition.js";
import { ManualClock } from "../../testing/clock/manual-clock.js";
import { FixedBattleIdGenerator } from "../../testing/id/fixed-battle-id-generator.js";
import { SequenceRandomSourceFactory } from "../../testing/random/sequence-random-source-factory.js";
import { CatalogBuilder, type TestBattleCatalog } from "../../testing/scenario/catalog-builder.js";
import {
  attackSkill,
  damageEffectAction,
  formationSlot,
  statModEffectAction,
  unitDefinition,
} from "../../testing/scenario/definition-builders.js";

const ATTACK_SKILL_ID = "SKL_ATTACK";
const ATTACK_ACTION_ID = "ACT_ATTACK";
const MEMORY_ACTION_ID = "ACT_MEM_ATTACK_UP";
const DEPLOY_MEMORY_ID = "MEM_DEPLOY";

/** 毎ターン1手で敵の出撃中の編成を倒す味方と、何もしない脆い敵。最大HPは再登場補正（−99%）を掛けても下限1に丸められない値にする。 */
function totalWarCatalog(): TestBattleCatalog {
  return new CatalogBuilder()
    .withUnit(
      unitDefinition("UNIT_STRIKER", {
        baseStats: { maximumAp: 1, attack: 999 },
        activeSkillDefinitionIds: [createSkillDefinitionId(ATTACK_SKILL_ID)],
      }),
      unitDefinition("UNIT_FRAGILE", { baseStats: { maximumHp: 500, defense: 0 } }),
      unitDefinition("UNIT_OTHER", { baseStats: { maximumHp: 500, defense: 0 } }),
      unitDefinition("UNIT_TEX", { category: "EXERCISE_ENEMY", exerciseActive: true }),
    )
    .withSkill(attackSkill(ATTACK_SKILL_ID, ATTACK_ACTION_ID))
    .withEffectAction(
      damageEffectAction(ATTACK_ACTION_ID, 1, "PREVENTED"),
      statModEffectAction(MEMORY_ACTION_ID),
    )
    .withMemory(
      createMemoryDefinition({
        memoryDefinitionId: DEPLOY_MEMORY_ID,
        triggeredEffects: [
          {
            trigger: {
              eventType: "BattleStarted",
              category: "FACT",
              sourceSelector: "SELF",
              targetSelector: "SELF",
            },
            effectSequence: {
              targetBindings: [
                {
                  targetBindingId: "TGT_ALL",
                  selector: { kind: "SELECT", side: "ALLY", count: "ALL" },
                },
              ],
              steps: [
                {
                  kind: "ACTION",
                  target: { kind: "BINDING", targetBindingId: "TGT_ALL" },
                  actions: [{ effectActionDefinitionId: MEMORY_ACTION_ID }],
                },
              ],
            },
          },
        ],
        metadata: { displayName: DEPLOY_MEMORY_ID },
      }),
    )
    .build();
}

function formation(unitIds: readonly string[], memoryIds: readonly string[] = []): FormationInput {
  return {
    slots: unitIds.map((unitId, index) => formationSlot(unitId, index as 0 | 1 | 2)),
    memoryDefinitionIds: memoryIds.map((memoryId) => createMemoryDefinitionId(memoryId)),
  };
}

function totalWarCommand(
  overrides: Partial<SimulateTotalWarCommand> = {},
): SimulateTotalWarCommand {
  return {
    allyFormations: [formation(["UNIT_STRIKER"])],
    enemyFormations: [formation(["UNIT_FRAGILE"]), formation(["UNIT_FRAGILE"], [DEPLOY_MEMORY_ID])],
    logLevel: "DETAILED",
    ...overrides,
  };
}

function useCaseWith(
  catalog: TestBattleCatalog,
  options: { readonly clockStartMs?: number } = {},
): SimulateTotalWarUseCase {
  return new SimulateTotalWarUseCase({
    battleCatalog: catalog,
    battleIdGenerator: new FixedBattleIdGenerator(["B_TOTAL_WAR"]),
    // 命中判定を決定的にするため、十分な数の同一値を供給する。
    randomSourceFactory: new SequenceRandomSourceFactory(Array.from({ length: 500 }, () => 0.5)),
    clock: new ManualClock(options.clockStartMs ?? 0),
  });
}

const CONTEXT = { requestId: "test", deadlineEpochMs: Number.MAX_SAFE_INTEGER };

function captureApplicationError(execute: () => unknown): ApplicationError {
  try {
    execute();
  } catch (error) {
    expect(error).toBeInstanceOf(ApplicationError);
    return error as ApplicationError;
  }
  expect.fail("expected execute to throw an ApplicationError");
}

describe("SimulateTotalWarUseCase", () => {
  it("UT-TWUSECASE-001 [R-TWR-03, R-TWR-04, R-TWR-06]: runs the relay until one side has no formation left and returns the outcome and the battle history", () => {
    const result = useCaseWith(totalWarCatalog()).execute(totalWarCommand(), CONTEXT);

    expect(result).toMatchObject({
      battleId: "B_TOTAL_WAR",
      catalogRevision: "test-rev-1",
      outcome: "ALLY_WIN",
      completionReason: "ENEMY_DEFEATED",
      completedTurn: 2,
      defeatedFormationCounts: { ally: 0, enemy: 2 },
    });
    expect(result.stages).toEqual([
      {
        stageNumber: 1,
        allyFormationNumber: 1,
        enemyFormationNumber: 1,
        startTurn: 1,
        endTurn: 1,
        defeatedSides: ["ENEMY"],
      },
      {
        stageNumber: 2,
        allyFormationNumber: 1,
        enemyFormationNumber: 2,
        startTurn: 2,
        endTurn: 2,
        defeatedSides: ["ENEMY"],
      },
    ]);
  });

  it("UT-TWUSECASE-002 [R-TWR-01, R-TWR-04]: numbers BattleUnitIds through all formations of a side and keeps only the first formation in the initial state", () => {
    const result = useCaseWith(totalWarCatalog()).execute(
      totalWarCommand({
        enemyFormations: [formation(["UNIT_FRAGILE", "UNIT_OTHER"]), formation(["UNIT_OTHER"])],
      }),
      CONTEXT,
    );

    expect(
      result.unitRoster.map((entry) => [entry.battleUnitId, entry.formationNumber, entry.deployed]),
    ).toEqual([
      ["ally:1", 1, true],
      ["enemy:1", 1, true],
      ["enemy:2", 1, true],
      ["enemy:3", 2, true],
    ]);
    expect(Object.keys(result.initialState.units)).toEqual(["ally:1", "enemy:1", "enemy:2"]);
    expect(result.unitSummaries.map((summary) => summary.battleUnitId)).toEqual([
      "ally:1",
      "enemy:1",
      "enemy:2",
      "enemy:3",
    ]);
  });

  it("UT-TWUSECASE-003 [R-TWR-02] (R-TWR-02 #1・#2): applies the -99% base stat correction to a unit already used by an earlier formation of the same side only", () => {
    const result = useCaseWith(totalWarCatalog()).execute(
      totalWarCommand({
        allyFormations: [formation(["UNIT_STRIKER"]), formation(["UNIT_FRAGILE"])],
      }),
      CONTEXT,
    );

    const rosterOf = (battleUnitId: string) =>
      result.unitRoster.find((entry) => entry.battleUnitId === battleUnitId)!;
    expect(result.unitRoster.map((entry) => [entry.battleUnitId, entry.reappearance])).toEqual([
      ["ally:1", false],
      ["ally:2", false],
      ["enemy:1", false],
      ["enemy:2", true],
    ]);
    expect(rosterOf("enemy:2").combatStats.maximumHp).toBeCloseTo(
      rosterOf("enemy:1").combatStats.maximumHp * 0.01,
      9,
    );
    // 相手陣営の編成は数えないため、敵が使ったユニットを味方の2番目で使っても補正しない。
    expect(rosterOf("ally:2").combatStats.maximumHp).toBe(
      rosterOf("enemy:1").combatStats.maximumHp,
    );
  });

  it("UT-TWUSECASE-004 [R-TWR-05] (R-TWR-05 #2): wires memories per formation, so a reserve formation's memory triggers on its deployment only", () => {
    const result = useCaseWith(totalWarCatalog()).execute(totalWarCommand(), CONTEXT);

    const memoryTurns = result.events
      .filter((event) => event.type === "MEMORY_TRIGGERED")
      .map((event) => [
        event.turnNumber,
        (event.details as { memoryDefinitionId: string }).memoryDefinitionId,
      ]);
    expect(memoryTurns).toEqual([[2, DEPLOY_MEMORY_ID]]);
  });

  it("UT-TWUSECASE-005 [R-TWR-01] (R-TWR-01 #1・#3): rejects the command shape with INVALID_COMMAND and indexed paths, without loading the Catalog", () => {
    const catalog = totalWarCatalog();

    const error = captureApplicationError(() =>
      useCaseWith(catalog).execute(
        totalWarCommand({
          allyFormations: [],
          enemyFormations: [formation(["UNIT_FRAGILE"]), formation(["UNIT_OTHER", "UNIT_OTHER"])],
        }),
        CONTEXT,
      ),
    );

    expect(error.code).toBe("INVALID_COMMAND");
    expect(error.violations.map((violation) => violation.path)).toEqual([
      "allyFormations",
      "enemyFormations[1].slots[1].unitDefinitionId",
    ]);
    expect(catalog.loadSnapshotCallCount).toBe(0);
  });

  it("UT-TWUSECASE-006 [R-TWR-01] (R-FRM-06): validates the references of every formation before starting the battle", () => {
    const error = captureApplicationError(() =>
      useCaseWith(totalWarCatalog()).execute(
        totalWarCommand({
          enemyFormations: [
            formation(["UNIT_FRAGILE"]),
            formation(["UNIT_FRAGILE"]),
            formation(["UNIT_MISSING"], ["MEM_MISSING"]),
          ],
        }),
        CONTEXT,
      ),
    );

    expect(error.code).toBe("DEFINITION_NOT_FOUND");
    expect(error.violations.map((violation) => violation.path)).toEqual([
      "enemyFormations[2].slots[0].unitDefinitionId",
      "enemyFormations[2].memoryDefinitionIds[0]",
    ]);
  });

  it("UT-TWUSECASE-007 [R-TWR-01] (R-TWR-01 #6): rejects a non-PLAYABLE unit in a reserve formation with INVALID_COMMAND and the rule id", () => {
    const error = captureApplicationError(() =>
      useCaseWith(totalWarCatalog()).execute(
        totalWarCommand({
          enemyFormations: [formation(["UNIT_FRAGILE"]), formation(["UNIT_TEX"])],
        }),
        CONTEXT,
      ),
    );

    expect(error.code).toBe("INVALID_COMMAND");
    expect(error.violations).toEqual([
      expect.objectContaining({
        path: "enemyFormations[1].slots[0].unitDefinitionId",
        ruleId: "R-TEX-11",
      }),
    ]);
  });

  it("UT-TWUSECASE-008: returns EXECUTION_TIMEOUT instead of a result once the deadline has passed", () => {
    const error = captureApplicationError(() =>
      useCaseWith(totalWarCatalog(), { clockStartMs: 1_000 }).execute(totalWarCommand(), {
        requestId: "test",
        deadlineEpochMs: 999,
      }),
    );

    expect(error.code).toBe("EXECUTION_TIMEOUT");
  });

  it("UT-TWUSECASE-009 [R-TWR-04]: SUMMARY omits events, transitions and the final state but keeps the roster and the history", () => {
    const result = useCaseWith(totalWarCatalog()).execute(
      totalWarCommand({ logLevel: "SUMMARY" }),
      CONTEXT,
    );

    expect(result.events).toEqual([]);
    expect(result.stateTransitions).toEqual([]);
    expect(result.finalState).toBeUndefined();
    expect(result.unitRoster).toHaveLength(3);
    expect(result.stages).toHaveLength(2);
  });
});
