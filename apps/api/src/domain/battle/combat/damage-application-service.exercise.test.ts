import { describe, expect, it } from "vitest";
import { applyDamageAction } from "./damage-application-service.js";
import { ExerciseRuntime } from "../model/exercise-runtime.js";
import { createHitPoint } from "../model/resource-gauge.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import type { DamageEventContext } from "./damage-event-context.js";
import {
  effectKindKeyFromDefinitionId,
  SUBUNIT_PROVIDER_ATTACK_KEY,
  type AppliedEffect,
} from "../model/applied-effect.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createEffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import { deferOrResolveBreakSteps } from "../effects/break-resolution-service.js";
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

  /** R-INT-01: 敵自身が保持する致死ダメージ耐え（R-TEX-08がブレイクより優先させる）。 */
  function deathSurvivalEffect(id: string, holderId: string, survivalHp: number): AppliedEffect {
    return interventionEffect(id, holderId, {
      deathSurvival: {
        survivalHp: { kind: "CONSTANT", value: survivalHp },
        healAfterSurvival: null,
      },
    });
  }

  /**
   * 演習状態は原基準値スナップショットを必ず持つ（R-TEX-04）。ブレイク強化を検証する
   * テストでは対象ユニットとまったく同じ基準値で作る必要があるため、対象の生成に
   * 使ったのと同じoverridesを渡す。
   */
  function exerciseRuntime(overrides: Parameters<typeof unit>[2] = {}): ExerciseRuntime {
    return new ExerciseRuntime(unit("TARGET", "ENEMY", overrides).baseCombatStats);
  }

  /**
   * `combat/`は`effects/`へ依存できないため、production経路（`damage-effect-action.ts`）と
   * まったく同じく`BreakResolutionService`をhookとして注入する。fake実装にすると
   * 「シームが呼ばれたか」しか検証できず、ブレイク解決の結果（復活後HP・強化）まで
   * 通しで確認できない。
   */
  /**
   * production配線（`effect-action-group-context.ts`の`eventContextOf`）と同じ
   * `deferOrResolveBreakSteps`を通す — 保留か即時かは`exercise.deferredBreaks`に
   * 効果処理フェーズのフレームが積まれているかだけで決まる（R-TEX-03 #5）。
   */
  function exerciseDamageContext(exercise: ExerciseRuntime): DamageEventContext {
    const base = damageEventContext({ exercise });
    return {
      ...base,
      resolveBreak: (targetUnitId, units, causeEventId) =>
        deferOrResolveBreakSteps(
          {
            recorder: base.recorder,
            turnNumber: base.turnNumber,
            cycleNumber: base.cycleNumber,
            ...(base.actionId !== undefined ? { actionId: base.actionId } : {}),
            skillUseId: base.skillUseId,
            resolutionScopeId: base.resolutionScopeId,
            rootEventId: base.rootEventId,
            exercise,
          },
          units,
          targetUnitId,
          new Map(),
          causeEventId,
        ),
    };
  }

  function attack(
    target: BattleUnit,
    exercise: ExerciseRuntime | undefined,
  ): ReturnType<typeof damageEventContext> {
    const context =
      exercise === undefined ? damageEventContext({}) : exerciseDamageContext(exercise);
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

  it("UT-R-TEX-03-005 [R-TEX-03, R-TEX-06]: resolves an exercise enemy's HP-0 arrival as a break — UnitBroken and UnitRevived instead of UnitDefeated, with the enemy never observable as DEFEATED", () => {
    const enemyStats = { defense: 10, maximumHp: 15 };
    const exercise = exerciseRuntime(enemyStats);
    const target = unit("TARGET", "ENEMY", enemyStats);
    const context = exerciseDamageContext(exercise);
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    const types = context.recorder.getEvents().map((event) => event.eventType);
    expect(types).toContain("UnitBroken");
    expect(types).toContain("UnitRevived");
    expect(types).not.toContain("UnitDefeated");
    // R-TEX-02 #2: オーバーキル分（20 - 15）を含めて計上する。
    expect(exercise.totalScore).toBe(20);
    expect(exercise.breakCount).toBe(1);
    // R-TEX-05 #3: 強化後の最大HP（15 × 1.20 = 18）まで全回復して復活する。
    const revivedEnemy = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
    expect(revivedEnemy.currentHp).toBe(18);
  });

  it("UT-R-TEX-06-002: lands the remaining hits of a multi-hit skill on the pending (HP 0) enemy and counts every one of them in full", () => {
    const enemyStats = { defense: 10, maximumHp: 15 };
    const exercise = exerciseRuntime(enemyStats);
    const target = unit("TARGET", "ENEMY", enemyStats);
    const context = exerciseDamageContext(exercise);
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    // R-ATM-02 #2: 効果処理フェーズの内側で解決する（AS/EXのDAMAGE EffectActionと同じ）。
    exercise.deferredBreaks.beginEffectProcessing();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1), hit("TARGET", 1), hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    // 1ヒット目（30 - 10 = 20）でHP0へ到達し、ブレイクは保留される。2・3ヒット目は
    // 保留中（HP0）の敵へ通常どおり命中し、HPは0のままでHPへ向かう20をそのまま計上する
    // （R-TEX-06 #4.1）。どのヒットもSKIPされず中断もされない。
    expect(result.hits.map((outcome) => outcome.applied)).toEqual([true, true, true]);
    expect(result.interruptedCount).toBe(0);
    // R-TEX-03 #5: 解決は効果処理フェーズの末尾であり、この時点では何も発行していない。
    const types = context.recorder.getEvents().map((event) => event.eventType);
    expect(types).not.toContain("UnitBroken");
    expect(types).not.toContain("UnitRevived");
    expect(types).not.toContain("UnitDefeated");
    expect(exercise.breakCount).toBe(0);
    expect(exercise.totalScore).toBe(60);

    const pending = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
    expect(pending.currentHp).toBe(0);
    // R-TEX-06 #4.3: 保留窓の間、敵は戦闘不能として観測されない。
    expect(isDefeated(pending)).toBe(false);
    expect(exercise.deferredBreaks.endEffectProcessing()).toMatchObject({
      targetUnitId: createBattleUnitId("TARGET"),
    });
  });

  it("UT-R-TEX-06-012: never reports the enemy as defeated on the very hit that defers the break, so no observer sees a defeat inside the pending window", () => {
    // R-TEX-06 #4.3は「保留窓の間、敵ユニットは戦闘不能として観測されない」を網羅的に
    // 要求する。印を到達ヒットのイベント発行より**後**に立てると、そのヒット自身の
    // `HitPointReduced`／`DamageApplied`のPS/Memory候補検出・特殊失効評価が、HPが0で
    // 印の無い敵を観測してしまう。`DamageApplied.defeated`はその窓を外から見た唯一の
    // 直接の証跡である。
    const enemyStats = { defense: 10, maximumHp: 15 };
    const exercise = exerciseRuntime(enemyStats);
    const context = exerciseDamageContext(exercise);
    exercise.deferredBreaks.beginEffectProcessing();

    applyDamageAction(
      unit("ATTACKER", "ALLY", { attack: 30 }),
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [unit("ATTACKER", "ALLY", { attack: 30 }), unit("TARGET", "ENEMY", enemyStats)],
      new SequenceRandomSource([]),
      context,
    );

    const applied = context.recorder
      .getEvents()
      .find((event) => event.eventType === "DamageApplied")!;
    expect(applied.payload).toMatchObject({ hpAfter: 0, defeated: false });
  });

  it("UT-R-TEX-06-013: still reports the enemy as defeated on an immediate (outside-the-phase) arrival, where no pending window exists", () => {
    const enemyStats = { defense: 10, maximumHp: 15 };
    const exercise = exerciseRuntime(enemyStats);
    const context = exerciseDamageContext(exercise);

    applyDamageAction(
      unit("ATTACKER", "ALLY", { attack: 30 }),
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [unit("ATTACKER", "ALLY", { attack: 30 }), unit("TARGET", "ENEMY", enemyStats)],
      new SequenceRandomSource([]),
      context,
    );

    const applied = context.recorder
      .getEvents()
      .find((event) => event.eventType === "DamageApplied")!;
    // 保留窓が無い経路では、到達の時点で解決が完了する（`defeated`の意味は従来どおり）。
    expect(applied.payload).toMatchObject({ hpAfter: 0, defeated: true });
    expect(exercise.breakCount).toBe(1);
  });

  it("UT-R-TEX-06-009: keeps the damage-event conservation invariant on hits that land on a pending (HP 0) enemy", () => {
    const enemyStats = { defense: 10, maximumHp: 15 };
    const exercise = exerciseRuntime(enemyStats);
    const context = exerciseDamageContext(exercise);
    exercise.deferredBreaks.beginEffectProcessing();

    applyDamageAction(
      unit("ATTACKER", "ALLY", { attack: 30 }),
      [hit("TARGET", 1), hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [unit("ATTACKER", "ALLY", { attack: 30 }), unit("TARGET", "ENEMY", enemyStats)],
      new SequenceRandomSource([]),
      context,
    );

    const applied = context.recorder
      .getEvents()
      .filter((event) => event.eventType === "DamageApplied");
    expect(applied).toHaveLength(2);
    // `08_ドメインイベント.md`不変条件#6。2ヒット目はHPが1も減らないため、HPへ向かった
    // 全量が`discardedDamage`として説明される。
    for (const event of applied) {
      const payload = event.payload as {
        typedShieldAbsorbed: number;
        untypedShieldAbsorbed: number;
        subUnitAbsorbed: number;
        hitPointDamage: number;
        discardedDamage: number;
        calculatedDamage: number;
      };
      expect(
        payload.typedShieldAbsorbed +
          payload.untypedShieldAbsorbed +
          payload.subUnitAbsorbed +
          payload.hitPointDamage +
          payload.discardedDamage,
      ).toBe(payload.calculatedDamage);
    }
    expect(applied[1]!.payload).toMatchObject({
      hpBefore: 0,
      hpAfter: 0,
      hitPointDamage: 0,
      discardedDamage: 20,
      defeated: false,
    });
  });

  it("UT-R-TEX-08-001: a death-survival on the enemy's own skill takes precedence over the break, counting the full damage without incrementing the break count (R-INT-01)", () => {
    const enemyStats = { defense: 10, maximumHp: 15 };
    const exercise = exerciseRuntime(enemyStats);
    const target: BattleUnit = {
      ...unit("TARGET", "ENEMY", enemyStats),
      appliedEffects: [deathSurvivalEffect("SURVIVE", "TARGET", 3)],
    };
    const context = exerciseDamageContext(exercise);
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    const types = context.recorder.getEvents().map((event) => event.eventType);
    expect(types).toContain("LethalDamageSurvived");
    expect(types).not.toContain("UnitBroken");
    expect(exercise.breakCount).toBe(0);
    // R-TEX-08 #3: 耐えたダメージの全量を計上する。
    expect(exercise.totalScore).toBe(20);
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

  it("UT-R-TEX-02-037 / UT-R-DTH-01-005: deducts the HP the enemy actually gained from a hit converted into healing by dazzle", () => {
    const exercise = exerciseRuntime();
    exercise.accumulateScore(100);
    const dazzled: BattleUnit = {
      ...unit("ATTACKER", "ALLY", { attack: 30 }),
      appliedEffects: [damageToHealEffect("DAZZLE", "ATTACKER")],
    };
    const target: BattleUnit = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      currentHp: createHitPoint(50, 100),
    };
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
    const converted = events.find((e) => e.eventType === "DamageConvertedToHeal")!;
    // 本来のダメージ 20 → floor(20 * 0.7) = 14 がそのままHPへ入る。
    expect(converted.payload).toMatchObject({ healAmount: 14, appliedHeal: 14 });
    const deducted = events.filter((e) => e.eventType === "ExerciseScoreDeducted");
    expect(deducted).toHaveLength(1);
    expect(deducted[0]!.payload).toEqual({
      targetUnitId: createBattleUnitId("TARGET"),
      amount: 14,
      totalScore: 86,
      causeEventId: converted.eventId,
    });
    expect(deducted[0]!.parentEventId).toBe(converted.eventId);
    expect(deducted[0]!.stateDelta).toEqual({
      exercise: { totalScore: { before: 100, after: 86 } },
    });
    expect(exercise.totalScore).toBe(86);
  });

  it("UT-R-TEX-02-038 (BOUNDARY) / UT-R-DTH-01-006: deducts only the applied heal of a converted hit, not the overflow discarded above maximum HP", () => {
    const exercise = exerciseRuntime();
    exercise.accumulateScore(100);
    const dazzled: BattleUnit = {
      ...unit("ATTACKER", "ALLY", { attack: 30 }),
      appliedEffects: [damageToHealEffect("DAZZLE", "ATTACKER")],
    };
    const target: BattleUnit = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      currentHp: createHitPoint(95, 100),
    };
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
    const converted = events.find((e) => e.eventType === "DamageConvertedToHeal")!;
    expect(converted.payload).toMatchObject({ healAmount: 14, appliedHeal: 5 });
    const deducted = events.filter((e) => e.eventType === "ExerciseScoreDeducted");
    expect(deducted).toHaveLength(1);
    expect(deducted[0]!.payload).toMatchObject({ amount: 5, totalScore: 95 });
  });

  it("UT-R-TEX-02-039: does not deduct when a dazzled enemy's hit is converted into healing for an ally", () => {
    const exercise = exerciseRuntime();
    exercise.accumulateScore(100);
    const dazzled: BattleUnit = {
      ...unit("ATTACKER", "ENEMY", { attack: 30 }),
      appliedEffects: [damageToHealEffect("DAZZLE", "ATTACKER")],
    };
    const target: BattleUnit = {
      ...unit("TARGET", "ALLY", { defense: 10, maximumHp: 100 }),
      currentHp: createHitPoint(50, 100),
    };
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
    expect(events.filter((e) => e.eventType === "ExerciseScoreDeducted")).toEqual([]);
    expect(exercise.totalScore).toBe(100);
  });
});
