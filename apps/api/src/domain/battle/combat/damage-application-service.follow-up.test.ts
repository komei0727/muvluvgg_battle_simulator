import { describe, expect, it } from "vitest";
import {
  applyDamageAction,
  type DamageEventContext,
  type FollowUpAttackCapture,
} from "./damage-application-service.js";
import { emptyFollowUpAttackCapture } from "./damage-event-context.js";
import {
  applyFollowUpAttacksSteps,
  type FollowUpAttackResult,
  type FollowUpAttackRider,
} from "./follow-up-attack.js";
import type { BattleUnit } from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import { createEffectInstanceId, type DomainEventId } from "../../shared/event-ids.js";
import { createBattleUnitId, type BattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  type EffectActionDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import {
  unit,
  damageAction,
  hit,
  hitCountEvasionEffect,
  damageEventContext,
  defeated,
} from "../../../testing/fixtures/damage-application.js";

/**
 * R-FUP-01（Issue #474）: 追撃バフ（`isFollowUpAttack`）のライダー捕捉。
 * `applyDamageAction`は、AS/EXスキル使用側が`followUpAttackCapture`を渡した場合に
 * 限り、「命中判定へ到達したヒット」を基準にライダー・攻撃対象・命中/会心の集計を
 * 記録する。追撃自身の解決はスキル全step解決後（`follow-up-attack-service.ts`）。
 */
describe("applyDamageAction follow-up capture (R-FUP-01)", () => {
  const RIDER_DEFINITION_ID = createEffectActionDefinitionId("ACT_FOLLOW_UP_RIDER");

  function followUpRiderEffect(id: string, holderId: string, grantorId: string): AppliedEffect {
    return {
      effectInstanceId: createEffectInstanceId(id),
      effectActionDefinitionId: RIDER_DEFINITION_ID,
      kindKey: effectKindKeyFromDefinitionId(RIDER_DEFINITION_ID),
      duplicate: true,
      sourceUnitId: createBattleUnitId(grantorId),
      targetUnitId: createBattleUnitId(holderId),
      magnitude: 0,
      categories: ["BUFF"],
      isFollowUpAttack: true,
      duration: {
        definition: {
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
        consumptionRemaining: 1,
      },
      appliedTurnNumber: 1,
    };
  }

  function contextWithCapture(): {
    context: DamageEventContext;
    capture: FollowUpAttackCapture;
  } {
    const capture = emptyFollowUpAttackCapture();
    const context = { ...damageEventContext(), followUpAttackCapture: capture };
    return { context, capture };
  }

  it("UT-R-FUP-01-001: records the holder's riders, attacked targets and applied/critical aggregation for hits that reach observation", () => {
    const { context, capture } = contextWithCapture();
    const attackerBase = unit("ATTACKER", "ALLY", { attack: 60 });
    const attacker: BattleUnit = {
      ...attackerBase,
      appliedEffects: [followUpRiderEffect("RIDER_1", "ATTACKER", "GRANTOR")],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 500 });

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 0), hit("TARGET", 1)],
      damageAction("GUARANTEED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    expect(result.hits.filter((h) => h.applied)).toHaveLength(2);
    expect([...capture.riders.keys()]).toEqual([createEffectInstanceId("RIDER_1")]);
    expect(capture.riders.get(createEffectInstanceId("RIDER_1"))).toMatchObject({
      effectActionDefinitionId: RIDER_DEFINITION_ID,
      sourceUnitId: createBattleUnitId("GRANTOR"),
    });
    // 同一対象への2ヒットは対象1件にまとまる。
    expect(capture.attackedTargetUnitIds).toEqual([createBattleUnitId("TARGET")]);
    expect(capture.anyApplied).toBe(true);
    expect(capture.anyCritical).toBe(true);
  });

  it("UT-R-FUP-01-002: an all-evaded attack still captures the rider (NEXT_OUTGOING_ATTACK reached) but reports no applied hit and no critical", () => {
    const { context, capture } = contextWithCapture();
    const attackerBase = unit("ATTACKER", "ALLY", { attack: 60 });
    const attacker: BattleUnit = {
      ...attackerBase,
      appliedEffects: [followUpRiderEffect("RIDER_1", "ATTACKER", "GRANTOR")],
    };
    const targetBase = unit("TARGET", "ENEMY", { defense: 10 });
    const target: BattleUnit = {
      ...targetBase,
      appliedEffects: [hitCountEvasionEffect("EVADE", "TARGET", "EVASION", 2)],
    };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 0)],
      damageAction("GUARANTEED"),
      [attacker, target],
      new SequenceRandomSource([0]),
      context,
    );

    expect(result.hits.some((h) => h.applied)).toBe(false);
    expect([...capture.riders.keys()]).toEqual([createEffectInstanceId("RIDER_1")]);
    expect(capture.attackedTargetUnitIds).toEqual([createBattleUnitId("TARGET")]);
    expect(capture.anyApplied).toBe(false);
    expect(capture.anyCritical).toBe(false);
  });

  it("UT-R-FUP-01-003: a hit skipped for an already defeated target neither captures riders nor counts the target", () => {
    const { context, capture } = contextWithCapture();
    const attackerBase = unit("ATTACKER", "ALLY", { attack: 60 });
    const attacker: BattleUnit = {
      ...attackerBase,
      appliedEffects: [followUpRiderEffect("RIDER_1", "ATTACKER", "GRANTOR")],
    };
    const target = defeated(unit("TARGET", "ENEMY", { defense: 10 }));

    applyDamageAction(
      attacker,
      [hit("TARGET", 0)],
      damageAction(),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    expect(capture.riders.size).toBe(0);
    expect(capture.attackedTargetUnitIds).toEqual([]);
    expect(capture.anyApplied).toBe(false);
  });
});

/**
 * R-FUP-01（Issue #474）: 追撃ヒットそのものの解決。命中・会心を独自判定せず
 * （乱数非消費）、保持者のステータスで通常ダメージ計算を行い、onHitEffectを
 * ヒット適用対象へ付与する。
 */
describe("applyFollowUpAttacksSteps (R-FUP-01)", () => {
  const RIDER_DEFINITION_ID = createEffectActionDefinitionId("ACT_FOLLOW_UP_RIDER");

  function rider(overrides: Partial<FollowUpAttackRider> = {}): FollowUpAttackRider {
    return {
      effectActionDefinitionId: RIDER_DEFINITION_ID,
      sourceUnitId: createBattleUnitId("GRANTOR"),
      damageType: "EN",
      formula: { kind: "SKILL_POWER", power: 1 },
      ...overrides,
    };
  }

  function drive(
    context: DamageEventContext,
    working: Map<BattleUnitId, BattleUnit>,
    attackerId: string,
    riders: readonly FollowUpAttackRider[],
    targetUnitIdSeeds: readonly string[],
    inheritedCritical: boolean,
  ): FollowUpAttackResult {
    const gen = applyFollowUpAttacksSteps(
      context,
      working,
      new SequenceRandomSource([]),
      createBattleUnitId(attackerId),
      riders,
      targetUnitIdSeeds.map((id) => createBattleUnitId(id)),
      inheritedCritical,
      context.parentEventId,
    );
    let step = gen.next();
    while (!step.done) {
      step = gen.next(step.value.units);
    }
    return step.value;
  }

  it("UT-R-FUP-01-004: resolves one guaranteed non-critical hit per rider x target with the holder's stats (no random consumption)", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 60 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 500 });
    const working = new Map<BattleUnitId, BattleUnit>([
      [attacker.battleUnitId, attacker],
      [target.battleUnitId, target],
    ]);

    const result = drive(context, working, "ATTACKER", [rider()], ["TARGET"], false);

    expect(result.interrupted).toBe(false);
    const after = working.get(target.battleUnitId)!;
    // (60 attack x 1.0 power - 10 defense) x 会心倍率1 = 50。
    expect(after.currentHp).toBe(500 - 50);
    const damageCalculated = context.recorder
      .getEvents()
      .filter((event) => event.eventType === "DamageCalculated");
    expect(damageCalculated).toHaveLength(1);
    expect(damageCalculated[0]?.payload).toMatchObject({
      effectActionDefinitionId: RIDER_DEFINITION_ID,
      attackerAttack: 60,
      criticalMultiplier: 1,
      finalDamage: 50,
      damageType: "EN",
    });
  });

  it("UT-R-FUP-01-005: an inherited critical applies the holder's critical damage bonus without consuming randomness", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 60, criticalDamageBonus: 0.5 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 500 });
    const working = new Map<BattleUnitId, BattleUnit>([
      [attacker.battleUnitId, attacker],
      [target.battleUnitId, target],
    ]);

    drive(context, working, "ATTACKER", [rider()], ["TARGET"], true);

    const after = working.get(target.battleUnitId)!;
    // (60 - 10) x (1 + 0.5) = 75。
    expect(after.currentHp).toBe(500 - 75);
    const criticalChecks = context.recorder
      .getEvents()
      .filter((event) => event.eventType === "CriticalCheckResolved");
    expect(criticalChecks).toHaveLength(1);
    expect(criticalChecks[0]?.payload).toMatchObject({ mode: "GUARANTEED", result: true });
  });

  it("UT-R-FUP-01-006: grants the onHitEffect to targets the follow-up hit applied to, and skips already defeated targets entirely", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 60 });
    const alive = unit("TARGET_A", "ENEMY", { defense: 10, maximumHp: 500 });
    const dead = defeated(unit("TARGET_B", "ENEMY", { defense: 10 }));
    const working = new Map<BattleUnitId, BattleUnit>([
      [attacker.battleUnitId, attacker],
      [alive.battleUnitId, alive],
      [dead.battleUnitId, dead],
    ]);
    const grantedCalls: {
      targetUnitId: BattleUnitId;
      onHitEffectActionDefinitionId: EffectActionDefinitionId;
      attackerUnitId: BattleUnitId;
      sourceUnitId: BattleUnitId | undefined;
    }[] = [];
    const contextWithHook: DamageEventContext = {
      ...context,
      grantFollowUpOnHitEffect: function* (
        targetUnitId,
        onHitEffectActionDefinitionId,
        attackerUnitId,
        sourceUnitId,
        units,
        parentEventId: DomainEventId,
      ) {
        grantedCalls.push({
          targetUnitId,
          onHitEffectActionDefinitionId,
          attackerUnitId,
          sourceUnitId,
        });
        // 実装hookと同じ「1件ごとにyieldする」規約に合わせた空step。
        const injected = yield { events: [], units };
        return { units: injected ?? units, lastEventId: parentEventId };
      },
    };

    drive(
      contextWithHook,
      working,
      "ATTACKER",
      [rider({ onHitEffectActionDefinitionId: createEffectActionDefinitionId("ACT_SPEED_DOWN") })],
      ["TARGET_A", "TARGET_B"],
      false,
    );

    expect(grantedCalls).toEqual([
      {
        targetUnitId: createBattleUnitId("TARGET_A"),
        onHitEffectActionDefinitionId: createEffectActionDefinitionId("ACT_SPEED_DOWN"),
        attackerUnitId: createBattleUnitId("ATTACKER"),
        sourceUnitId: createBattleUnitId("GRANTOR"),
      },
    ]);
    // 戦闘不能対象にはヒットイベント自体を発行しない。
    const attackedTargets = context.recorder
      .getEvents()
      .filter((event) => event.eventType === "UnitBeingAttacked")
      .map((event) => event.targetUnitIds?.[0]);
    expect(attackedTargets).toEqual([createBattleUnitId("TARGET_A")]);
  });
});
