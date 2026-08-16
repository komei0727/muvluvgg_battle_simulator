import { describe, expect, it } from "vitest";
import { SimulateTacticalExerciseUseCase } from "./simulate-tactical-exercise-use-case.js";
import type { SimulateTacticalExerciseCommand } from "./simulate-tactical-exercise-command.js";
import { ApplicationError } from "../contracts/application-error.js";
import { createMemoryDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { createSkillDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { ManualClock } from "../../testing/clock/manual-clock.js";
import { FixedBattleIdGenerator } from "../../testing/id/fixed-battle-id-generator.js";
import { SequenceRandomSourceFactory } from "../../testing/random/sequence-random-source-factory.js";
import { CatalogBuilder, type TestBattleCatalog } from "../../testing/scenario/catalog-builder.js";
import {
  attackSkill,
  damageEffectAction,
  formationSlot,
  unitDefinition,
} from "../../testing/scenario/definition-builders.js";

const ATTACK_SKILL_ID = "SKL_ATTACK";
const ATTACK_ACTION_ID = "ACT_ATTACK";

/** 味方だけが攻撃し、敵は何もしない最小の演習Catalog。 */
function exerciseCatalog(): TestBattleCatalog {
  return new CatalogBuilder()
    .withUnit(
      unitDefinition("UNIT_ALLY", {
        baseStats: { maximumAp: 1 },
        activeSkillDefinitionIds: [createSkillDefinitionId(ATTACK_SKILL_ID)],
      }),
      unitDefinition("UNIT_ENEMY", {
        category: "EXERCISE_ENEMY",
        exerciseActive: true,
        baseStats: { maximumHp: 1000, defense: 0 },
      }),
    )
    .withSkill(attackSkill(ATTACK_SKILL_ID, ATTACK_ACTION_ID))
    .withEffectAction(damageEffectAction(ATTACK_ACTION_ID))
    .build();
}

function exerciseCommand(
  overrides: Partial<SimulateTacticalExerciseCommand> = {},
): SimulateTacticalExerciseCommand {
  return {
    allyFormation: { slots: [formationSlot("UNIT_ALLY", 0)], memoryDefinitionIds: [] },
    enemyFormation: { slots: [formationSlot("UNIT_ENEMY", 0)], memoryDefinitionIds: [] },
    logLevel: "DETAILED",
    ...overrides,
  };
}

function useCaseWith(
  catalog: TestBattleCatalog,
  options: { readonly clockStartMs?: number } = {},
): SimulateTacticalExerciseUseCase {
  return new SimulateTacticalExerciseUseCase({
    battleCatalog: catalog,
    battleIdGenerator: new FixedBattleIdGenerator(["B_EXERCISE"]),
    // 命中・会心判定を決定的にするため、十分な数の同一値を供給する。
    randomSourceFactory: new SequenceRandomSourceFactory(Array.from({ length: 500 }, () => 0.99)),
    clock: new ManualClock(options.clockStartMs ?? 0),
  });
}

const CONTEXT = { requestId: "test", deadlineEpochMs: Number.MAX_SAFE_INTEGER };

/** `execute`が投げた`ApplicationError`を取り出す（投げなければテストを失敗させる）。 */
function captureApplicationError(execute: () => unknown): ApplicationError {
  try {
    execute();
  } catch (error) {
    expect(error).toBeInstanceOf(ApplicationError);
    return error as ApplicationError;
  }
  expect.fail("expected execute to throw an ApplicationError");
}

describe("SimulateTacticalExerciseUseCase", () => {
  it("UT-TEXUSECASE-001 (R-TEX-01 #4 / R-TEX-09 #1 / R-TEX-10 #1): runs the exercise for the fixed 5 turns and returns an exercise result with no outcome", () => {
    const result = useCaseWith(exerciseCatalog()).execute(exerciseCommand(), CONTEXT);

    expect(result.completionReason).toBe("TURN_LIMIT_REACHED");
    expect(result.completedTurn).toBe(5);
    expect(result).not.toHaveProperty("outcome");
    expect(result.battleId).toBe("B_EXERCISE");
    expect(result.catalogRevision).toBe("test-rev-1");
  });

  it("UT-TEXUSECASE-002 (R-TEX-10 #3): totalScore equals the accumulated amounts minus the deducted ones, and the final state's accumulated score", () => {
    const result = useCaseWith(exerciseCatalog()).execute(exerciseCommand(), CONTEXT);

    const amountsOf = (type: string): readonly number[] =>
      result.events
        .filter((event) => event.type === type)
        .map((event) => (event.details as { readonly amount: number }).amount);
    const sum = (amounts: readonly number[]): number =>
      amounts.reduce((total, amount) => total + amount, 0);

    const accumulated = amountsOf("EXERCISE_SCORE_ACCUMULATED");
    expect(accumulated.length).toBeGreaterThan(0);
    expect(result.totalScore).toBe(sum(accumulated) - sum(amountsOf("EXERCISE_SCORE_DEDUCTED")));
    expect(result.finalState!.exercise?.totalScore).toBe(result.totalScore);
  });

  it("UT-TEXUSECASE-003 (R-TEX-01 #3): rejects an enemy formation that is not exactly one unit with INVALID_COMMAND, without loading the Catalog", () => {
    const catalog = exerciseCatalog();

    const error = captureApplicationError(() =>
      useCaseWith(catalog).execute(
        exerciseCommand({
          enemyFormation: {
            slots: [formationSlot("UNIT_ENEMY", 0), formationSlot("UNIT_ENEMY", 1)],
            memoryDefinitionIds: [],
          },
        }),
        CONTEXT,
      ),
    );

    expect(error.code).toBe("INVALID_COMMAND");
    expect(error.violations).toContainEqual(
      expect.objectContaining({ path: "enemyFormation.slots" }),
    );
    expect(catalog.loadSnapshotCallCount).toBe(0);
  });

  it("UT-TEXUSECASE-004 (R-TEX-01 #3): rejects an enemy formation with no unit with INVALID_COMMAND", () => {
    const error = captureApplicationError(() =>
      useCaseWith(exerciseCatalog()).execute(
        exerciseCommand({ enemyFormation: { slots: [], memoryDefinitionIds: [] } }),
        CONTEXT,
      ),
    );

    expect(error.code).toBe("INVALID_COMMAND");
    expect(error.violations).toContainEqual(
      expect.objectContaining({ path: "enemyFormation.slots" }),
    );
  });

  it("UT-TEXUSECASE-005 (R-TEX-01 #3): rejects an enemy formation that specifies a memory with INVALID_COMMAND", () => {
    const error = captureApplicationError(() =>
      useCaseWith(exerciseCatalog()).execute(
        exerciseCommand({
          enemyFormation: {
            slots: [formationSlot("UNIT_ENEMY", 0)],
            memoryDefinitionIds: [createMemoryDefinitionId("MEM_001")],
          },
        }),
        CONTEXT,
      ),
    );

    expect(error.code).toBe("INVALID_COMMAND");
    expect(error.violations).toContainEqual(
      expect.objectContaining({ path: "enemyFormation.memoryDefinitionIds" }),
    );
  });

  it("UT-TEXUSECASE-006: loads the Catalog snapshot exactly once per execution, like the battle use case", () => {
    const catalog = exerciseCatalog();

    useCaseWith(catalog).execute(exerciseCommand(), CONTEXT);

    expect(catalog.loadSnapshotCallCount).toBe(1);
  });

  it("UT-TEXUSECASE-007 (11_インフラストラクチャ設計.md「キャンセルと期限」): shares the deadline check with the battle use case and never returns a partial exercise result", () => {
    const error = captureApplicationError(() =>
      useCaseWith(exerciseCatalog(), { clockStartMs: 1_000 }).execute(exerciseCommand(), {
        requestId: "test",
        deadlineEpochMs: 500,
      }),
    );

    expect(error.code).toBe("EXECUTION_TIMEOUT");
  });
});
