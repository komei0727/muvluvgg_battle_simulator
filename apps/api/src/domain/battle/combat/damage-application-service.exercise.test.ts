import { describe, expect, it } from "vitest";
import { applyDamageAction } from "./damage-application-service.js";
import { ExerciseRuntime } from "../model/exercise-runtime.js";
import { createHitPoint } from "../model/resource-gauge.js";
import type { BattleUnit } from "../model/battle-unit.js";
import {
  effectKindKeyFromDefinitionId,
  SUBUNIT_PROVIDER_ATTACK_KEY,
  type AppliedEffect,
} from "../model/applied-effect.js";
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

  function subUnitEffect(id: string, holderId: string, durability: number): AppliedEffect {
    const definitionId = createEffectActionDefinitionId(`ACT_SUBUNIT_${id}`);
    return {
      effectInstanceId: createEffectInstanceId(id),
      effectActionDefinitionId: definitionId,
      kindKey: effectKindKeyFromDefinitionId(definitionId),
      duplicate: true,
      targetUnitId: createBattleUnitId(holderId),
      magnitude: durability,
      categories: ["SUBUNIT"],
      subUnit: {
        durability,
        additionalDamage: {
          formula: {
            kind: "SUBUNIT_ADDITIONAL_DAMAGE",
            ownerAttack: "CURRENT_ATTACK",
            providerAttack: "SOURCE_SNAPSHOT_ATTACK",
            skillMultiplier: 0,
            targetDefense: "TARGET_CURRENT_DEFENSE",
          },
        },
      },
      snapshot: { [SUBUNIT_PROVIDER_ATTACK_KEY]: 0 },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
  }

  /** `DamageEventContext`を通る介入効果（反射・リンク・振り替え）の共通部分。 */
  function interventionEffect(
    id: string,
    holderId: string,
    extra: Partial<AppliedEffect>,
  ): AppliedEffect {
    const definitionId = createEffectActionDefinitionId(`ACT_${id}`);
    return {
      effectInstanceId: createEffectInstanceId(id),
      effectActionDefinitionId: definitionId,
      kindKey: effectKindKeyFromDefinitionId(definitionId),
      duplicate: true,
      sourceUnitId: createBattleUnitId(holderId),
      targetUnitId: createBattleUnitId(holderId),
      magnitude: 0,
      categories: ["BUFF"],
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
      ...extra,
    };
  }

  function reflectHeldByDefender(id: string, defenderId: string, ratio: number): AppliedEffect {
    return interventionEffect(id, defenderId, {
      reflect: {
        formula: { kind: "DAMAGE_RECEIVED_RATIO", sourceResult: "LAST_DAMAGE_RECEIVED", ratio },
        allowRecursiveReflect: false,
      },
    });
  }

  function damageLinkHeldByDamaged(
    id: string,
    damagedId: string,
    linkToUnitId: string,
    linkRate: number,
  ): AppliedEffect {
    return interventionEffect(id, damagedId, {
      damageLink: { linkToUnitId: createBattleUnitId(linkToUnitId), linkRate },
    });
  }

  function redirectHeldByAttacker(
    id: string,
    attackerId: string,
    redirectTo: string,
  ): AppliedEffect {
    return interventionEffect(id, attackerId, {
      targetRedirect: {
        redirectToUnitId: createBattleUnitId(redirectTo),
        actionKinds: ["DAMAGE"],
      },
    });
  }

  /** R-DTH-01（幻惑）: 保持者のヒットのダメージを回復へ変換する。 */
  function damageToHealEffect(id: string, holderId: string, healRate = 0.7): AppliedEffect {
    return interventionEffect(id, holderId, {
      categories: ["DEBUFF"],
      statusKind: "DAMAGE_TO_HEAL",
      statusDetails: { damageToHeal: { healRate } },
    });
  }

  /** 演習状態は原基準値スナップショットを必ず持つ（R-TEX-04）。スコア計上の検証では値自体は使わない。 */
  function exerciseRuntime(): ExerciseRuntime {
    return new ExerciseRuntime(unit("TARGET", "ENEMY").baseCombatStats);
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
    const exercise = exerciseRuntime();
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
    const exercise = exerciseRuntime();
    const shielded: BattleUnit = {
      ...unit("TARGET", "ENEMY", { defense: 10 }),
      appliedEffects: [shieldEffect("SHIELD", "TARGET", 12)],
    };

    attack(shielded, exercise);

    // finalDamage 20 のうち 12 をシールドが吸収し、HPへ向かうのは 8。
    expect(exercise.totalScore).toBe(8);
  });

  it("UT-R-TEX-02-009: counts the full amount directed at HP including the overkill discarded above zero HP", () => {
    const exercise = exerciseRuntime();
    const target = unit("TARGET", "ENEMY", { defense: 10 });
    const nearlyDead: BattleUnit = { ...target, currentHp: createHitPoint(5, 100) };

    const context = attack(nearlyDead, exercise);

    const applied = context.recorder.getEvents().find((e) => e.eventType === "DamageApplied")!;
    // 実HP減少は5、破棄は15。スコアはオーバーキルを含む20。
    expect(applied.payload).toMatchObject({ hitPointDamage: 5, discardedDamage: 15 });
    expect(exercise.totalScore).toBe(20);
  });

  it("UT-R-TEX-02-010: does not count damage dealt to an ally unit, since only the enemy's HP feeds the score", () => {
    const exercise = exerciseRuntime();

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

  it("UT-R-TEX-02-019: excludes the sub-unit-absorbed portion, counting only what reached HP (R-SUB-01)", () => {
    const exercise = exerciseRuntime();
    const guarded: BattleUnit = {
      ...unit("TARGET", "ENEMY", { defense: 10 }),
      appliedEffects: [subUnitEffect("SUB_1", "TARGET", 12)],
    };

    attack(guarded, exercise);

    // finalDamage 20 のうち 12 をサブユニット耐久が吸収し、HPへ向かうのは 8。
    expect(exercise.totalScore).toBe(8);
  });

  it("UT-R-TEX-02-020: a hit fully absorbed before HP counts zero, so no ExerciseScoreAccumulated is emitted", () => {
    const exercise = exerciseRuntime();
    const fullyShielded: BattleUnit = {
      ...unit("TARGET", "ENEMY", { defense: 10 }),
      appliedEffects: [shieldEffect("SHIELD", "TARGET", 50)],
    };

    const context = attack(fullyShielded, exercise);

    expect(exercise.totalScore).toBe(0);
    expect(
      context.recorder.getEvents().filter((e) => e.eventType === "ExerciseScoreAccumulated"),
    ).toEqual([]);
  });

  it("UT-R-TEX-02-021: counts the reflected damage that returns to the attacking enemy, while the ally it damaged is not counted (R-INT-03)", () => {
    const exercise = exerciseRuntime();
    const enemyAttacker = unit("ENEMY_ATTACKER", "ENEMY", { attack: 30, maximumHp: 100 });
    const allyDefender: BattleUnit = {
      ...unit("ALLY_DEFENDER", "ALLY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [reflectHeldByDefender("REFLECT", "ALLY_DEFENDER", 0.75)],
    };
    const context = damageEventContext({ exercise });

    applyDamageAction(
      enemyAttacker,
      [hit("ALLY_DEFENDER", 0)],
      damageAction("PREVENTED"),
      [enemyAttacker, allyDefender],
      new SequenceRandomSource([]),
      { ...context, damageResults: new Map() },
    );

    const scored = context.recorder
      .getEvents()
      .filter((e) => e.eventType === "ExerciseScoreAccumulated");
    // 元ダメージ20は味方へ向かうため非計上。反射の 20 × 75% = 15 だけが敵HPへ向かう。
    expect(scored).toHaveLength(1);
    expect(scored[0]!.payload).toMatchObject({
      targetUnitId: createBattleUnitId("ENEMY_ATTACKER"),
      amount: 15,
    });
    expect(exercise.totalScore).toBe(15);
  });

  it("UT-R-TEX-02-022: counts the linked damage forwarded onto the enemy, while the ally that took the original hit is not counted (R-LNK-01)", () => {
    const exercise = exerciseRuntime();
    const enemyAttacker = unit("ENEMY_ATTACKER", "ENEMY", { attack: 30, maximumHp: 100 });
    const allyTarget: BattleUnit = {
      ...unit("ALLY_TARGET", "ALLY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [damageLinkHeldByDamaged("LINK", "ALLY_TARGET", "ENEMY_ATTACKER", 0.5)],
    };
    const context = damageEventContext({ exercise });

    applyDamageAction(
      enemyAttacker,
      [hit("ALLY_TARGET", 0)],
      damageAction("PREVENTED"),
      [enemyAttacker, allyTarget],
      new SequenceRandomSource([]),
      { ...context, damageResults: new Map() },
    );

    const scored = context.recorder
      .getEvents()
      .filter((e) => e.eventType === "ExerciseScoreAccumulated");
    // 元ダメージ20の50%＝10がリンク先（敵）へ向かう。元ダメージ自体は味方なので非計上。
    expect(scored).toHaveLength(1);
    expect(scored[0]!.payload).toMatchObject({
      targetUnitId: createBattleUnitId("ENEMY_ATTACKER"),
      amount: 10,
    });
    expect(exercise.totalScore).toBe(10);
  });

  it("UT-R-TEX-02-023: counts the hit at the unit it was redirected onto, not at the originally selected target (R-INT-01/R-CFS-01)", () => {
    const exercise = exerciseRuntime();
    const attacker: BattleUnit = {
      ...unit("ATTACKER", "ALLY", { attack: 30 }),
      appliedEffects: [redirectHeldByAttacker("REDIRECT", "ATTACKER", "TARGET")],
    };
    const originalTarget = unit("ORIGINAL", "ALLY", { defense: 10, maximumHp: 100 });
    const redirectDestination = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const context = damageEventContext({ exercise });

    applyDamageAction(
      attacker,
      [hit("ORIGINAL", 0)],
      damageAction("PREVENTED"),
      [attacker, originalTarget, redirectDestination],
      new SequenceRandomSource([]),
      context,
    );

    const scored = context.recorder
      .getEvents()
      .filter((e) => e.eventType === "ExerciseScoreAccumulated");
    expect(scored).toHaveLength(1);
    expect(scored[0]!.payload).toMatchObject({
      targetUnitId: createBattleUnitId("TARGET"),
      amount: 20,
    });
  });

  it("UT-R-TEX-02-024: does not count a hit converted into healing by dazzle, since no damage reaches the enemy's HP (R-DTH-01)", () => {
    const exercise = exerciseRuntime();
    const dazzled: BattleUnit = {
      ...unit("ATTACKER", "ALLY", { attack: 30 }),
      appliedEffects: [damageToHealEffect("DAZZLE", "ATTACKER")],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const context = damageEventContext({ exercise });

    applyDamageAction(
      dazzled,
      [hit("TARGET", 0)],
      damageAction("PREVENTED"),
      [dazzled, target],
      new SequenceRandomSource([]),
      context,
    );

    const events = context.recorder.getEvents();
    expect(events.some((e) => e.eventType === "DamageConvertedToHeal")).toBe(true);
    expect(events.filter((e) => e.eventType === "ExerciseScoreAccumulated")).toEqual([]);
    expect(exercise.totalScore).toBe(0);
  });
});
