import { describe, expect, it } from "vitest";
import { applyDamageAction } from "./damage-application-service.js";
import { ExerciseRuntime } from "../model/exercise-runtime.js";
import { createHitPoint } from "../model/resource-gauge.js";
import type { BattleUnit } from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createEffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import {
  unit,
  damageAction,
  hit,
  damageEventContext,
} from "../../../testing/fixtures/damage-application.js";

/**
 * R-TEX-02: 敵ユニットのHPへ向かったダメージだけを、シールド・サブユニット吸収分を
 * 除いた量で計上する。オーバーキル分は含める。
 */
describe("applyDamageAction exercise score accumulation (R-TEX-02)", () => {
  function shieldEffect(id: string, holderId: string, amount: number): AppliedEffect {
    const definitionId = createEffectActionDefinitionId(`ACT_SHIELD_${id}`);
    return {
      effectInstanceId: createEffectInstanceId(id),
      effectActionDefinitionId: definitionId,
      kindKey: effectKindKeyFromDefinitionId(definitionId),
      duplicate: true,
      targetUnitId: createBattleUnitId(holderId),
      magnitude: amount,
      categories: ["SHIELD"],
      shield: { shieldType: null, remaining: amount },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
  }

  function attack(
    target: BattleUnit,
    exercise: ExerciseRuntime | undefined,
  ): ReturnType<typeof damageEventContext> {
    const context = damageEventContext(exercise === undefined ? {} : { exercise });
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    applyDamageAction(
      attacker,
      [hit(target.battleUnitId, 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );
    return context;
  }

  it("UT-R-TEX-02-007: accumulates the damage that reached the enemy's HP and emits ExerciseScoreAccumulated owning the cumulative-score delta", () => {
    const exercise = new ExerciseRuntime();
    const context = attack(unit("TARGET", "ENEMY", { defense: 10 }), exercise);

    const events = context.recorder.getEvents();
    const damageApplied = events.find((event) => event.eventType === "DamageApplied")!;
    const scored = events.filter((event) => event.eventType === "ExerciseScoreAccumulated");

    // finalDamage = 30 - 10 = 20、全量がHPへ向かう。
    expect(scored).toHaveLength(1);
    expect(scored[0]!.payload).toEqual({
      targetUnitId: createBattleUnitId("TARGET"),
      amount: 20,
      totalScore: 20,
      causeEventId: damageApplied.eventId,
    });
    expect(scored[0]!.category).toBe("FACT");
    expect(scored[0]!.parentEventId).toBe(damageApplied.eventId);
    // 累計スコアの差分は`ExerciseScoreAccumulated`が単独で所有する。
    expect(scored[0]!.stateDelta).toEqual({ exercise: { totalScore: { before: 0, after: 20 } } });
    expect(exercise.totalScore).toBe(20);
  });

  it("UT-R-TEX-02-008: excludes the shield-absorbed portion, counting only what reached HP", () => {
    const exercise = new ExerciseRuntime();
    const shielded: BattleUnit = {
      ...unit("TARGET", "ENEMY", { defense: 10 }),
      appliedEffects: [shieldEffect("SHIELD", "TARGET", 12)],
    };

    attack(shielded, exercise);

    // finalDamage 20 のうち 12 をシールドが吸収し、HPへ向かうのは 8。
    expect(exercise.totalScore).toBe(8);
  });

  it("UT-R-TEX-02-009: counts the full amount directed at HP including the overkill discarded above zero HP", () => {
    const exercise = new ExerciseRuntime();
    const target = unit("TARGET", "ENEMY", { defense: 10 });
    const nearlyDead: BattleUnit = { ...target, currentHp: createHitPoint(5, 100) };

    const context = attack(nearlyDead, exercise);

    const applied = context.recorder.getEvents().find((e) => e.eventType === "DamageApplied")!;
    // 実HP減少は5、破棄は15。スコアはオーバーキルを含む20。
    expect(applied.payload).toMatchObject({ hitPointDamage: 5, discardedDamage: 15 });
    expect(exercise.totalScore).toBe(20);
  });

  it("UT-R-TEX-02-010: does not count damage dealt to an ally unit, since only the enemy's HP feeds the score", () => {
    const exercise = new ExerciseRuntime();

    const context = attack(unit("TARGET", "ALLY", { defense: 10 }), exercise);

    expect(exercise.totalScore).toBe(0);
    expect(
      context.recorder.getEvents().filter((e) => e.eventType === "ExerciseScoreAccumulated"),
    ).toEqual([]);
  });

  it("UT-R-TEX-02-011: a normal battle (no exercise state) emits no ExerciseScoreAccumulated at all", () => {
    const context = attack(unit("TARGET", "ENEMY", { defense: 10 }), undefined);

    expect(
      context.recorder.getEvents().filter((e) => e.eventType === "ExerciseScoreAccumulated"),
    ).toEqual([]);
    expect(
      context.recorder.getEvents().filter((e) => e.stateDelta?.exercise !== undefined),
    ).toEqual([]);
  });
});
