import { describe, expect, it } from "vitest";
import { applyDamageAction, type DamageEventContext } from "./damage-application-service.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type { DamageResultRegistry } from "../skill/formula-evaluator.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import {
  effectKindKeyFromDefinitionId,
  SUBUNIT_PROVIDER_ATTACK_KEY,
  type AppliedEffect,
} from "../model/applied-effect.js";
import type { MarkerState } from "../model/marker-state.js";
import { createEffectInstanceId, createMarkerInstanceId } from "../../shared/event-ids.js";
import { createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createMarkerId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import { DomainValidationError } from "../../shared/errors.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import {
  unit,
  defeated,
  damageAction,
  immunityEffect,
  attackDamageBonusEffect,
  freezeEffect,
  evasionEffect,
  hitCountEvasionEffect,
  evasionDefinition,
  guaranteedHitEffect,
  criticalStatusEffect,
  hit,
  damageEventContext,
  STAT_MOD_DEFINITION_ID,
  statModDefinition,
  consumptionEffect,
  testConsumeEffectDuration,
} from "../../../testing/fixtures/damage-application.js";

describe("applyDamageAction", () => {
  it("UT-DAMAGE-APPLICATION-001: a single hit reduces HP by the calculated damage (attack - defense, PREVENTED critical)", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      damageEventContext(),
    );

    expect(result.hits).toEqual([
      {
        targetUnitId: createBattleUnitId("TARGET"),
        hitIndex: 1,
        applied: true,
        isCritical: false,
        damage: 20,
      },
    ]);
    const updatedTarget = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("TARGET"),
    )!;
    expect(updatedTarget.currentHp).toBe(80);
  });

  it("UT-HP-REDUCED-001 (RES-005): a hit records a HitPointReduced FACT between DamageCalculated and DamageApplied, carrying the HP StateDelta (not duplicated onto DamageApplied)", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    const events = context.recorder.getEvents();
    const damageCalculated = events.find((e) => e.eventType === "DamageCalculated")!;
    const hitPointReduced = events.find((e) => e.eventType === "HitPointReduced")!;
    const damageApplied = events.find((e) => e.eventType === "DamageApplied")!;

    expect(hitPointReduced.parentEventId).toBe(damageCalculated.eventId);
    expect(damageApplied.parentEventId).toBe(hitPointReduced.eventId);
    expect(hitPointReduced.payload).toEqual({
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATTACK"),
      hitIndex: 1,
      targetUnitId: createBattleUnitId("TARGET"),
      hitPointDamage: 20,
      hpBefore: 100,
      hpAfter: 80,
    });
    expect(hitPointReduced.stateDelta).toEqual({
      units: { [createBattleUnitId("TARGET")]: { hp: { before: 100, after: 80 } } },
    });
    expect(damageApplied.stateDelta).toBeUndefined();
  });

  it("UT-DAMAGE-APPLICATION-002: overkill damage clamps HP at 0 and defeats the target", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 999 });
    const target = unit("TARGET", "ENEMY", { defense: 0, maximumHp: 50 });
    const random = new SequenceRandomSource([]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      damageEventContext(),
    );

    const updatedTarget = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("TARGET"),
    )!;
    expect(updatedTarget.currentHp).toBe(0);
    expect(isDefeated(updatedTarget)).toBe(true);
  });

  it("UT-DAMAGE-APPLICATION-003 (R-SKL-03/R-ACTN-01): remaining hits on an already-defeated target are skipped, not applied", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 999 });
    const target = unit("TARGET", "ENEMY", { defense: 0, maximumHp: 50 });
    const random = new SequenceRandomSource([]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1), hit("TARGET", 2), hit("TARGET", 3)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      damageEventContext(),
    );

    expect(result.hits.map((h) => h.applied)).toEqual([true, false, false]);
    expect(result.hits[1]!.damage).toBe(0);
    expect(result.hits[2]!.damage).toBe(0);
    const updatedTarget = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("TARGET"),
    )!;
    expect(updatedTarget.currentHp).toBe(0);
  });

  it("UT-DAMAGE-APPLICATION-015 (R-ACTN-01 #2): context.includeDefeated: true still applies hits against an already-defeated target, instead of skipping them", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 999 });
    const target = unit("TARGET", "ENEMY", { defense: 0, maximumHp: 50 });
    const random = new SequenceRandomSource([]);
    const context: DamageEventContext = { ...damageEventContext(), includeDefeated: true };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1), hit("TARGET", 2), hit("TARGET", 3)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    expect(result.hits.map((h) => h.applied)).toEqual([true, true, true]);
    const eventTypes = context.recorder.getEvents().map((e) => e.eventType);
    expect(eventTypes.filter((t) => t === "DamageApplied")).toHaveLength(3);
    // The target was alive before hit 1 (it dies from hit 1's overkill damage),
    // so only that hit's HP transition (>0 -> 0) may emit UnitDefeated. Hits 2
    // and 3 keep applying damage to an already-defeated target and must not
    // re-emit it (08_ドメインイベント.md「HPが0になった直後」).
    expect(eventTypes.filter((t) => t === "UnitDefeated")).toHaveLength(1);
    const updatedTarget = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("TARGET"),
    )!;
    expect(updatedTarget.currentHp).toBe(0);
  });

  it("UT-DAMAGE-APPLICATION-016 (R-ACTN-01 #2): hits against a target that was already defeated BEFORE this EffectAction started never emit UnitDefeated, even with context.includeDefeated: true", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 999 });
    const target = defeated(unit("TARGET", "ENEMY", { defense: 0, maximumHp: 50 }));
    const random = new SequenceRandomSource([]);
    const context: DamageEventContext = { ...damageEventContext(), includeDefeated: true };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1), hit("TARGET", 2)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    expect(result.hits.map((h) => h.applied)).toEqual([true, true]);
    const eventTypes = context.recorder.getEvents().map((e) => e.eventType);
    expect(eventTypes.filter((t) => t === "DamageApplied")).toHaveLength(2);
    expect(eventTypes.filter((t) => t === "UnitDefeated")).toHaveLength(0);
    const updatedTarget = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("TARGET"),
    )!;
    expect(updatedTarget.currentHp).toBe(0);
  });

  it("UT-DAMAGE-APPLICATION-004: hits against independent targets do not affect each other's HP", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const targetA = unit("TARGET_A", "ENEMY", { defense: 10, maximumHp: 100 });
    const targetB = unit("TARGET_B", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET_A", 1), hit("TARGET_B", 1)],
      damageAction("PREVENTED"),
      [attacker, targetA, targetB],
      random,
      damageEventContext(),
    );

    const updatedA = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET_A"))!;
    const updatedB = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET_B"))!;
    expect(updatedA.currentHp).toBe(80);
    expect(updatedB.currentHp).toBe(80);
  });

  it("UT-DAMAGE-APPLICATION-005: GUARANTEED critical mode applies the critical multiplier without consuming the RandomSource", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30, criticalDamageBonus: 0.5 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("GUARANTEED"),
      [attacker, target],
      random,
      damageEventContext(),
    );

    random.assertFullyConsumed();
    expect(result.hits[0]!.isCritical).toBe(true);
    // base damage 20 * (1 + 0.5 criticalDamageBonus) = 30
    expect(result.hits[0]!.damage).toBe(30);
  });

  it("UT-DAMAGE-APPLICATION-006: throws when a hit references a BattleUnitId absent from the given units (defensive)", () => {
    const attacker = unit("ATTACKER", "ALLY", {});
    const random = new SequenceRandomSource([]);

    expect(() =>
      applyDamageAction(
        attacker,
        [hit("MISSING_TARGET", 1)],
        damageAction("PREVENTED"),
        [attacker],
        random,
        damageEventContext(),
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-DAMAGE-APPLICATION-007 (R-SKL-01/R-SKL-03): once the attacker itself becomes defeated mid-sequence, remaining hits (even against other targets) are interrupted", () => {
    // A lethal SELF-targeting hit comes first, then a hit against an unrelated target.
    const attacker = unit("ATTACKER", "ALLY", { attack: 999, defense: 0, maximumHp: 10 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);

    const result = applyDamageAction(
      attacker,
      [hit("ATTACKER", 1), hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      damageEventContext(),
    );

    expect(result.hits[0]!.applied).toBe(true);
    expect(result.hits[1]).toEqual({
      targetUnitId: createBattleUnitId("TARGET"),
      hitIndex: 1,
      applied: false,
      isCritical: false,
      damage: 0,
    });
    const updatedAttacker = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("ATTACKER"),
    )!;
    const updatedTarget = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("TARGET"),
    )!;
    expect(isDefeated(updatedAttacker)).toBe(true);
    expect(updatedTarget.currentHp).toBe(100);
  });

  it("UT-DAMAGE-APPLICATION-008 (R-SKL-01/R-SKL-03): an already-defeated attacker cannot apply any hit", () => {
    const attacker = defeated(unit("ATTACKER", "ALLY", { attack: 999 }));
    const target = unit("TARGET", "ENEMY", { defense: 0, maximumHp: 10 });
    const random = new SequenceRandomSource([]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      damageEventContext(),
    );

    expect(result.hits[0]!.applied).toBe(false);
    const updatedTarget = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("TARGET"),
    )!;
    expect(updatedTarget.currentHp).toBe(10);
  });

  it("UT-DAMAGE-APPLICATION-009 (会心・ダメージイベントのpayload監査可能性): the recorded CriticalCheckResolved/DamageCalculated events carry the correct, non-swapped calculation values — not just calculateDamage()/resolveCritical()'s own return values", () => {
    // criticalRate above 100% so baseCriticalRate (1.5) and effectiveCriticalRate
    // (clamped to 1) are guaranteed to differ, catching a "stored baseRate into
    // effectiveRate" bug. criticalMultiplier (2.0, from a 100% criticalDamageBonus)、
    // attributeMultiplier (1.35, favorable attribute + affinityBonus)、
    // actionDamageMultiplier (1.2, from damageModifiers) are
    // chosen to differ from each other and from 1, catching a field swap.
    const attacker = unit("ATTACKER", "ALLY", {
      attack: 50,
      criticalRate: 1.5,
      criticalDamageBonus: 1,
      affinityBonus: 0.35,
      attribute: "AGGRESSIVE",
    });
    const target = unit("TARGET", "ENEMY", {
      defense: 20,
      maximumHp: 1000,
      attribute: "SHY", // AGGRESSIVE is favorable against SHY (R-ATR-01/02).
    });
    const richDamageAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }> = {
      kind: "DAMAGE",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATTACK"),
      metadata: { tags: [] },
      payload: {
        damageType: "PHYSICAL",
        formula: { kind: "SKILL_POWER", power: 1 },
        hitCount: 1,
        critical: { mode: "GUARANTEED" },
        accuracy: { mode: "NORMAL" },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
        damageModifiers: [{ kind: "CONSTANT", value: 0.2 }],
        link: { enabled: false },
      },
    };
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      richDamageAction,
      [attacker, target],
      random,
      context,
    );

    const events = context.recorder.getEvents();
    const criticalCheckResolved = events.find((e) => e.eventType === "CriticalCheckResolved");
    const damageCalculated = events.find((e) => e.eventType === "DamageCalculated");
    expect(criticalCheckResolved).toBeDefined();
    expect(damageCalculated).toBeDefined();

    expect(criticalCheckResolved!.payload).toEqual({
      mode: "GUARANTEED",
      baseCriticalRate: 1.5,
      effectiveCriticalRate: 1,
      result: true,
    });

    const damageDetails = damageCalculated!.payload as Record<string, unknown>;
    expect(damageDetails).toMatchObject({
      skillDefinitionId: context.skillDefinitionId,
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATTACK"),
      hitIndex: 1,
      targetUnitId: createBattleUnitId("TARGET"),
      attackerAttack: 50,
      defenderDefense: 20,
      effectiveDefense: 20,
      defenseIgnoreRate: 0,
      skillPower: 1,
      criticalMultiplier: 2,
      // 30 base damage * 1 * 1.35 * 2 * 1.2 = 97.2 -> floor -> 97.
      finalDamage: 97,
      damageType: "PHYSICAL",
    });
    expect(damageDetails.attributeMultiplier).toBeCloseTo(1.35);
    expect(damageDetails.actionDamageMultiplier).toBeCloseTo(1.2);
    expect(damageDetails.preTruncationDamage).toBeCloseTo(97.2);
  });

  it("UT-DAMAGE-APPLICATION-019 (DMG-012): DamageCalculated exposes the calculation inputs (基礎ダメージ・Formula種別・属性相性) and the post-calculation stages at their neutral values", () => {
    const attacker = unit("ATTACKER", "ALLY", {
      attack: 50,
      affinityBonus: 0.35,
      attribute: "AGGRESSIVE",
    });
    const target = unit("TARGET", "ENEMY", {
      defense: 20,
      maximumHp: 1000,
      attribute: "SHY", // AGGRESSIVE is favorable against SHY (R-ATR-01).
    });
    const context = damageEventContext();

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    const details = context.recorder.getEvents().find((e) => e.eventType === "DamageCalculated")!
      .payload as Record<string, unknown>;
    expect(details).toMatchObject({
      baseDamage: 30,
      skillPowerFormulaKind: "SKILL_POWER",
      attackerAttribute: "AGGRESSIVE",
      defenderAttribute: "SHY",
      isFavorableAttribute: true,
      attackerAffinityBonus: 0.35,
      // 凍結増幅・肩代わり・閾値軽減・無効化はどれも成立していないため中立値になる。
      // 「宣言が無い」と「中立」を読み分けられるよう、成立しないヒットでも省略せず
      // 出す（R-DMG-03の貫通率と同じ規約）。
      freezeMultiplier: 1,
      guardRate: 0,
      thresholdReductionMultiplier: 1,
      damageImmunityNullified: false,
    });
    expect(details.rawPreTruncationDamage).toBeCloseTo(40.5);
  });

  it("UT-DAMAGE-APPLICATION-020 (DMG-012): the DamageCalculated payload alone reproduces preTruncationDamage and finalDamage across 凍結増幅 (R-STS-03)", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const freeze = freezeEffect("eff-freeze", "TARGET", { damageAmplificationOnBreak: 0.5 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [freeze],
    };
    const context = damageEventContext();

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    const details = context.recorder.getEvents().find((e) => e.eventType === "DamageCalculated")!
      .payload as Record<string, unknown>;
    expect(details).toMatchObject({
      baseDamage: 20,
      freezeMultiplier: 1.5,
      // 基礎20 * 1.5 = 30。倍率群だけの積(20)とは別の値であり、この2欄が揃わないと
      // 記録済みの倍率から preTruncationDamage へ到達できない。
      rawPreTruncationDamage: 20,
      preTruncationDamage: 30,
      finalDamage: 30,
    });
  });

  it("UT-DAMAGE-APPLICATION-021 (DMG-012): damageImmunityNullified explains a finalDamage of 1 that the recorded multipliers alone cannot account for", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const immunity = immunityEffect("eff-immunity", "TARGET", {});
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [immunity],
    };
    const context = damageEventContext();

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    const details = context.recorder.getEvents().find((e) => e.eventType === "DamageCalculated")!
      .payload as Record<string, unknown>;
    expect(details).toMatchObject({
      preTruncationDamage: 20,
      damageImmunityNullified: true,
      finalDamage: 1,
    });
  });

  it("a lethal hit still passes DamageApplied (not just the resulting UnitDefeated) to onFactEventForPassiveChain, in event order", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 100 });
    const target = unit("TARGET", "ENEMY", { defense: 0, maximumHp: 10 });
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    const seenEventTypes: string[] = [];
    const contextWithHook: DamageEventContext = {
      ...context,
      onFactEventForPassiveChain: (event, units) => {
        seenEventTypes.push(event.eventType);
        return units;
      },
    };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      contextWithHook,
    );

    expect(
      isDefeated(result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!),
    ).toBe(true);
    // All facts from this one lethal hit must reach the hook, in causal
    // order, so a third party's DamageApplied-triggered PS (e.g. "when an
    // ally is damaged") is not silently skipped just because the hit also
    // happened to be lethal. `UnitBeingAttacked` (R-EFF-07, EFF-003) also
    // reaches the hook, ahead of all three — the target was determined
    // attackable before hit judgment, damage calculation, or defeat.
    // `HitPointReduced` (RES-005) reaches the hook right before
    // `DamageApplied` — it's the fact of the HP change itself.
    // `HitConfirmed`/`CriticalCheckResolved` and
    // `DamageWillBeApplied` (R-DMG-05 #4, DMG-001) reach the hook in
    // R-DMG-05 order, each right after it is recorded: this callback path is the
    // ONLY delivery route for them (`effect-action-group-resolver.ts` leaves
    // `innerEvents` empty whenever the callback is supplied), and the chain of
    // each may still cancel or re-shape this hit before damage is calculated.
    expect(seenEventTypes).toEqual([
      "HitConfirmed",
      "CriticalCheckResolved",
      "DamageWillBeApplied",
      "HitPointReduced",
      "DamageApplied",
      "UnitDefeated",
    ]);
  });

  it("UT-R-EFF-07-007 (R-EFF-07 NEXT_OUTGOING_ATTACK/OUTGOING_HIT): consumes the attacker's matching effects when a hit reaches judgment and is confirmed (not MISS)", () => {
    const nextAttackEffect = consumptionEffect(
      "eff-next-outgoing",
      createBattleUnitId("ATTACKER"),
      "NEXT_OUTGOING_ATTACK",
      1,
    );
    const outgoingHitEffect = consumptionEffect(
      "eff-outgoing-hit",
      createBattleUnitId("ATTACKER"),
      "OUTGOING_HIT",
      2,
    );
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30 }),
      appliedEffects: [nextAttackEffect, outgoingHitEffect],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);
    const baseContext = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      {
        ...baseContext,
        consumeEffectDuration: testConsumeEffectDuration(
          baseContext.recorder,
          new Map([[STAT_MOD_DEFINITION_ID, statModDefinition()]]),
        ),
      },
    );

    const updatedAttacker = result.units.find((u) => u.battleUnitId === attacker.battleUnitId)!;
    expect(updatedAttacker.appliedEffects).toHaveLength(1);
    expect(updatedAttacker.appliedEffects[0]!.effectInstanceId).toBe(
      outgoingHitEffect.effectInstanceId,
    );
    expect(updatedAttacker.appliedEffects[0]!.duration.consumptionRemaining).toBe(1);
  });

  it("UT-R-EFF-07-008 (R-EFF-07 NEXT_INCOMING_ATTACK/INCOMING_HIT): consumes the target's matching effects when it is attacked and the hit is confirmed", () => {
    const nextIncomingEffect = consumptionEffect(
      "eff-next-incoming",
      createBattleUnitId("TARGET"),
      "NEXT_INCOMING_ATTACK",
      1,
    );
    const incomingHitEffect = consumptionEffect(
      "eff-incoming-hit",
      createBattleUnitId("TARGET"),
      "INCOMING_HIT",
      2,
    );
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [nextIncomingEffect, incomingHitEffect],
    };
    const random = new SequenceRandomSource([]);
    const baseContext = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      {
        ...baseContext,
        consumeEffectDuration: testConsumeEffectDuration(
          baseContext.recorder,
          new Map([[STAT_MOD_DEFINITION_ID, statModDefinition()]]),
        ),
      },
    );

    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.appliedEffects).toHaveLength(1);
    expect(updatedTarget.appliedEffects[0]!.effectInstanceId).toBe(
      incomingHitEffect.effectInstanceId,
    );
    expect(updatedTarget.appliedEffects[0]!.duration.consumptionRemaining).toBe(1);
  });

  it("UT-R-EFF-09-022 (R-EFF-09 cross-type 通知順序): a PARENT effect expiring from an INCOMING_HIT consumption notifies each cascade step in order, so a watcher of the CHILD's EffectExpired still observes the PARENT and its Marker", () => {
    const parentId = createBattleUnitId("TARGET");
    // 消費で0になるPARENT効果と、同じグループのCHILD効果／CHILD Marker。
    const parentEffect: AppliedEffect = {
      ...consumptionEffect("eff-parent", parentId, "INCOMING_HIT", 1),
      duration: {
        definition: {
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
          dispellable: true,
          linkedEffectGroupId: "GROUP_A",
          linkedEffectGroupRole: "PARENT",
        },
        consumptionRemaining: 1,
      },
    };
    const childEffect: AppliedEffect = {
      ...consumptionEffect("eff-child", parentId, "OUTGOING_HIT", 5),
      duration: {
        definition: {
          dispellable: true,
          linkedEffectGroupId: "GROUP_A",
          linkedEffectGroupRole: "CHILD",
        },
      },
    };
    const childMarker: MarkerState = {
      markerInstanceId: createMarkerInstanceId("marker-child"),
      markerId: createMarkerId("MARKER_CHILD"),
      sourceUnitId: parentId,
      targetUnitId: parentId,
      stackCount: 1,
      stackMax: null,
      duration: {
        definition: {
          dispellable: true,
          linkedEffectGroupId: "GROUP_A",
          linkedEffectGroupRole: "CHILD",
        },
      },
    };
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [parentEffect, childEffect],
      markerStates: [childMarker],
    };
    const random = new SequenceRandomSource([]);
    const baseContext = damageEventContext();

    const observations: {
      eventType: string;
      parentEffectPresent: boolean;
      childMarkerPresent: boolean;
    }[] = [];

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      {
        ...baseContext,
        consumeEffectDuration: testConsumeEffectDuration(
          baseContext.recorder,
          new Map([[STAT_MOD_DEFINITION_ID, statModDefinition()]]),
        ),
        onFactEventForPassiveChain: (event, units) => {
          const holder = units.find((u) => u.battleUnitId === parentId);
          observations.push({
            eventType: event.eventType,
            parentEffectPresent:
              holder?.appliedEffects.some(
                (effect) => effect.effectInstanceId === parentEffect.effectInstanceId,
              ) ?? false,
            childMarkerPresent:
              holder?.markerStates.some(
                (marker) => marker.markerInstanceId === childMarker.markerInstanceId,
              ) ?? false,
          });
          return units;
        },
      },
    );

    const updatedTarget = result.units.find((u) => u.battleUnitId === parentId)!;
    expect(updatedTarget.appliedEffects).toHaveLength(0);
    expect(updatedTarget.markerStates).toHaveLength(0);

    const cascadeObservations = observations.filter(
      (o) => o.eventType === "EffectExpired" || o.eventType === "MarkerRemoved",
    );
    // R-EFF-09: 子`AppliedEffect` → 子`MarkerState` → 親（消費で失効）の順。
    expect(cascadeObservations.map((o) => o.eventType)).toEqual([
      "EffectExpired",
      "MarkerRemoved",
      "EffectExpired",
    ]);
    // 子の`EffectExpired`を観測する時点では、親効果も子Markerもまだ残っている。
    expect(cascadeObservations[0]).toMatchObject({
      parentEffectPresent: true,
      childMarkerPresent: true,
    });
    // 子Markerの`MarkerRemoved`時点では親効果だけが残っている。
    expect(cascadeObservations[1]).toMatchObject({
      parentEffectPresent: true,
      childMarkerPresent: false,
    });
    // 親の`EffectExpired`時点で全て除去済み。
    expect(cascadeObservations[2]).toMatchObject({
      parentEffectPresent: false,
      childMarkerPresent: false,
    });
  });

  it("UT-R-EFF-07-010 (R-EFF-07 / R-DMG-05 #1): consumes NEXT_INCOMING_ATTACK at the start of the hit — before hit judgment — and the hit itself emits no UnitBeingAttacked (that moved to the pre-attack observation, R-ATM-03)", () => {
    const nextIncomingEffect = consumptionEffect(
      "eff-next-incoming",
      createBattleUnitId("TARGET"),
      "NEXT_INCOMING_ATTACK",
      1,
    );
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [nextIncomingEffect],
    };
    const random = new SequenceRandomSource([]);
    const baseContext = damageEventContext();

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      {
        ...baseContext,
        consumeEffectDuration: testConsumeEffectDuration(
          baseContext.recorder,
          new Map([[STAT_MOD_DEFINITION_ID, statModDefinition()]]),
        ),
      },
    );

    const events = baseContext.recorder.getEvents();
    // R-ATM-03: ヒット単位の`UnitBeingAttacked`は存在しない。効果処理の開始前に
    // 対象ごと1回だけ発行される（`lifecycle/pre-attack-observation-service.ts`）。
    expect(events.some((e) => e.eventType === "UnitBeingAttacked")).toBe(false);
    // R-DMG-05 #1: 消費タイミングは変えない — 命中判定（`HitConfirmed`）より前に
    // 消費し、そのイベントの因果親はこのヒットの起点イベントのままである。
    const consumptionIndex = events.findIndex((e) => e.eventType === "EffectConsumptionChanged");
    const hitConfirmedIndex = events.findIndex((e) => e.eventType === "HitConfirmed");
    expect(consumptionIndex).toBeGreaterThanOrEqual(0);
    expect(hitConfirmedIndex).toBeGreaterThan(consumptionIndex);
    expect(events[consumptionIndex]!.parentEventId).toBe(baseContext.parentEventId);
  });

  it("UT-R-EFF-07-011: consumes nothing for a hit skipped because the target is already defeated", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = defeated(unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }));
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    // R-ACTN-01 #2でスキップされたヒットは観測列（R-DMG-05 #1の消費を含む）へ
    // 一切入らないため、ヒット由来のイベントを1件も発行しない。
    expect(
      context.recorder
        .getEvents()
        .map((e) => e.eventType)
        .filter((eventType) => eventType !== "ActionStarted"),
    ).toEqual([]);
  });

  it("UT-R-EFF-07-009 (R-EFF-07 boundary/expiry): a NEXT_OUTGOING_ATTACK effect at maxCount 1 expires (EffectConsumptionChanged then EffectExpired) after being consumed", () => {
    const nextAttackEffect = consumptionEffect(
      "eff-next-outgoing",
      createBattleUnitId("ATTACKER"),
      "NEXT_OUTGOING_ATTACK",
      1,
    );
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30 }),
      appliedEffects: [nextAttackEffect],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);
    const baseContext = damageEventContext();
    const context: DamageEventContext = {
      ...baseContext,
      consumeEffectDuration: testConsumeEffectDuration(
        baseContext.recorder,
        new Map([[STAT_MOD_DEFINITION_ID, statModDefinition()]]),
      ),
    };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    const updatedAttacker = result.units.find((u) => u.battleUnitId === attacker.battleUnitId)!;
    expect(updatedAttacker.appliedEffects).toHaveLength(0);

    const types = context.recorder.getEvents().map((e) => e.eventType);
    expect(types).toContain("EffectConsumptionChanged");
    expect(types).toContain("EffectExpired");
    expect(types.indexOf("EffectConsumptionChanged")).toBeLessThan(types.indexOf("EffectExpired"));
  });

  it("UT-R-EFF-07-012 (hpBefore/hpAfter staleness): an HP change made by a PS reacting to HitConfirmed (before damage calculation) is reflected as the damage baseline, not silently discarded", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();
    // Simulate a PS that heals the target by 5 HP the instant the hit lands
    // (reacting to HitConfirmed, before damage calculation).
    const contextWithHeal: DamageEventContext = {
      ...context,
      onFactEventForPassiveChain: (event, units) =>
        event.eventType === "HitConfirmed"
          ? units.map((u) =>
              u.battleUnitId === target.battleUnitId ? { ...u, currentHp: u.currentHp + 5 } : u,
            )
          : units,
    };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      contextWithHeal,
    );

    // attack(30) - defense(10) = 20 damage. Baseline must be the healed HP
    // (100 + 5 = 105), not the stale pre-heal snapshot (100).
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.currentHp).toBe(85);
    const damageApplied = context.recorder
      .getEvents()
      .find((e) => e.eventType === "DamageApplied")!;
    expect(damageApplied.payload).toMatchObject({ hpBefore: 105, hpAfter: 85 });
  });

  it("UT-DAMAGE-APPLICATION-010 (R-SKL-08): an applied hit records lastDamageDealt/lastDamageReceived into the caller-supplied resolution-scope registry, not onto BattleUnit", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);
    const damageResults: DamageResultRegistry = new Map();

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      { ...damageEventContext(), damageResults },
    );

    expect(damageResults.get(attacker.battleUnitId)?.lastDamageDealt).toBe(20);
    expect(damageResults.get(target.battleUnitId)?.lastDamageReceived).toBe(20);
    expect(damageResults.get(attacker.battleUnitId)?.lastDamageReceived).toBeUndefined();
    expect(damageResults.get(target.battleUnitId)?.lastDamageDealt).toBeUndefined();
  });

  it("UT-DAMAGE-APPLICATION-011 (R-SKL-08 mirrors production ACT_AOI_GUARDIAN_PS2_COUNTER): a DAMAGE_RECEIVED_RATIO formula reads the actor's own lastDamageReceived from an earlier hit in the SAME resolution scope (shared registry)", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const defender = unit("DEFENDER", "ENEMY", { defense: 10, maximumHp: 200 });
    const random = new SequenceRandomSource([]);
    // One registry instance shared across both calls, standing in for the
    // single resolution scope (one action) that both the triggering hit and
    // the counter it provokes belong to (`PassiveActivationRuntime` threads
    // the same instance through nested PS chains in production).
    const damageResults: DamageResultRegistry = new Map();

    // First hit: ATTACKER deals 20 to DEFENDER (attack 30 - defense 10).
    const firstHit = applyDamageAction(
      attacker,
      [hit("DEFENDER", 1)],
      damageAction("PREVENTED"),
      [attacker, defender],
      random,
      { ...damageEventContext(), damageResults },
    );
    const defenderAfterFirstHit = firstHit.units.find(
      (u) => u.battleUnitId === defender.battleUnitId,
    )!;
    expect(damageResults.get(defender.battleUnitId)?.lastDamageReceived).toBe(20);

    // Second hit: DEFENDER counters using DAMAGE_RECEIVED_RATIO(LAST_DAMAGE_RECEIVED, ratio: 1),
    // which should equal the 20 it just received, independent of its own attack stat.
    const counterAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }> = {
      kind: "DAMAGE",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_COUNTER"),
      metadata: { tags: [] },
      payload: {
        damageType: "PHYSICAL",
        formula: { kind: "DAMAGE_RECEIVED_RATIO", sourceResult: "LAST_DAMAGE_RECEIVED", ratio: 1 },
        hitCount: 1,
        critical: { mode: "PREVENTED" },
        accuracy: { mode: "NORMAL" },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
        damageModifiers: [],
        link: { enabled: false },
      },
    };
    const attackerAfterFirstHit = firstHit.units.find(
      (u) => u.battleUnitId === attacker.battleUnitId,
    )!;
    const counterHit = applyDamageAction(
      defenderAfterFirstHit,
      [
        {
          targetUnitId: attacker.battleUnitId,
          effectActionDefinitionId: counterAction.effectActionDefinitionId,
          hitIndex: 1,
        },
      ],
      counterAction,
      firstHit.units,
      random,
      { ...damageEventContext(), damageResults },
    );

    expect(counterHit.hits[0]!.damage).toBe(20);
    const attackerAfterCounter = counterHit.units.find(
      (u) => u.battleUnitId === attacker.battleUnitId,
    )!;
    expect(attackerAfterCounter.currentHp).toBe(attackerAfterFirstHit.currentHp - 20);
  });

  it("UT-DAMAGE-APPLICATION-012 (R-NUM-04): a DAMAGE_RECEIVED_RATIO formula throws when the registry has no recorded lastDamageReceived yet", () => {
    const attacker = unit("ATTACKER", "ALLY");
    const target = unit("TARGET", "ENEMY");
    const random = new SequenceRandomSource([]);
    const counterAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }> = {
      kind: "DAMAGE",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_COUNTER"),
      metadata: { tags: [] },
      payload: {
        damageType: "PHYSICAL",
        formula: { kind: "DAMAGE_RECEIVED_RATIO", sourceResult: "LAST_DAMAGE_RECEIVED", ratio: 1 },
        hitCount: 1,
        critical: { mode: "PREVENTED" },
        accuracy: { mode: "NORMAL" },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
        damageModifiers: [],
        link: { enabled: false },
      },
    };

    expect(() =>
      applyDamageAction(
        attacker,
        [hit("TARGET", 1)],
        counterAction,
        [attacker, target],
        random,
        damageEventContext(),
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-DAMAGE-APPLICATION-013 (R-SKL-08): a DAMAGE_RECEIVED_RATIO formula in a NEW resolution scope (a fresh registry) does not see a value recorded in an earlier, unrelated resolution scope", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const defender = unit("DEFENDER", "ENEMY", { defense: 10, maximumHp: 200 });
    const random = new SequenceRandomSource([]);

    // Scope 1 (e.g. an earlier, unrelated action): records DEFENDER's
    // lastDamageReceived into its own registry.
    const scope1Registry: DamageResultRegistry = new Map();
    const firstHit = applyDamageAction(
      attacker,
      [hit("DEFENDER", 1)],
      damageAction("PREVENTED"),
      [attacker, defender],
      random,
      { ...damageEventContext(), damageResults: scope1Registry },
    );
    const defenderAfterFirstHit = firstHit.units.find(
      (u) => u.battleUnitId === defender.battleUnitId,
    )!;
    expect(scope1Registry.get(defender.battleUnitId)?.lastDamageReceived).toBe(20);

    // Scope 2 (a brand-new resolution scope, e.g. a later, independent
    // action): a fresh, empty registry — must NOT see scope 1's value even
    // though it's evaluating a formula for the very same BattleUnit.
    const scope2Registry: DamageResultRegistry = new Map();
    const counterAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }> = {
      kind: "DAMAGE",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_COUNTER"),
      metadata: { tags: [] },
      payload: {
        damageType: "PHYSICAL",
        formula: { kind: "DAMAGE_RECEIVED_RATIO", sourceResult: "LAST_DAMAGE_RECEIVED", ratio: 1 },
        hitCount: 1,
        critical: { mode: "PREVENTED" },
        accuracy: { mode: "NORMAL" },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
        damageModifiers: [],
        link: { enabled: false },
      },
    };

    expect(() =>
      applyDamageAction(
        defenderAfterFirstHit,
        [
          {
            targetUnitId: attacker.battleUnitId,
            effectActionDefinitionId: counterAction.effectActionDefinitionId,
            hitIndex: 1,
          },
        ],
        counterAction,
        firstHit.units,
        random,
        { ...damageEventContext(), damageResults: scope2Registry },
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-DAMAGE-APPLICATION-014 (R-SKL-08): a successful DAMAGE followed by a not-applied one (target already defeated) in the SAME resolution scope records lastDamageDealt/lastDamageReceived as 0, instead of leaving the earlier success value visible or making later Formula references throw", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const defender = unit("DEFENDER", "ENEMY", { defense: 10, maximumHp: 200 });
    const random = new SequenceRandomSource([]);
    const damageResults: DamageResultRegistry = new Map();

    // Hit 1 (success): ATTACKER deals 20 to DEFENDER, recorded in the shared
    // registry for this resolution scope.
    const firstHit = applyDamageAction(
      attacker,
      [hit("DEFENDER", 1)],
      damageAction("PREVENTED"),
      [attacker, defender],
      random,
      { ...damageEventContext(), damageResults },
    );
    expect(damageResults.get(attacker.battleUnitId)?.lastDamageDealt).toBe(20);
    expect(damageResults.get(defender.battleUnitId)?.lastDamageReceived).toBe(20);
    const attackerAfterFirstHit = firstHit.units.find(
      (u) => u.battleUnitId === attacker.battleUnitId,
    )!;
    const defeatedDefender = defeated(
      firstHit.units.find((u) => u.battleUnitId === defender.battleUnitId)!,
    );

    // Hit 2 (not applied — target already defeated), same attacker/target
    // pair, same shared registry: R-SKL-08 treats this not-applied result as
    // a regular "last result" for this scope (not a Catalog-definition
    // error), so it must overwrite hit 1's success value with 0 rather than
    // leaving it visible or erasing it entirely.
    applyDamageAction(
      attackerAfterFirstHit,
      [hit("DEFENDER", 1)],
      damageAction("PREVENTED"),
      [attackerAfterFirstHit, defeatedDefender],
      random,
      { ...damageEventContext(), damageResults },
    );
    expect(damageResults.get(attacker.battleUnitId)?.lastDamageDealt).toBe(0);
    expect(damageResults.get(defender.battleUnitId)?.lastDamageReceived).toBe(0);

    // A later Formula referencing LAST_DAMAGE_DEALT in this same scope must
    // now evaluate to 0 — not the stale 20, and not a thrown error (MISS/
    // no-target is a normal runtime outcome under a valid Catalog
    // definition, not the "reference doesn't exist" case R-NUM-04 reserves
    // for Catalog/preflight rejection).
    const referencingAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }> = {
      kind: "DAMAGE",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_REFERENCING"),
      metadata: { tags: [] },
      payload: {
        damageType: "PHYSICAL",
        formula: { kind: "DAMAGE_DEALT_RATIO", sourceResult: "LAST_DAMAGE_DEALT", ratio: 1 },
        hitCount: 1,
        critical: { mode: "PREVENTED" },
        accuracy: { mode: "NORMAL" },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
        damageModifiers: [],
        link: { enabled: false },
      },
    };
    const otherTarget = unit("OTHER_TARGET", "ENEMY");

    const referencingResult = applyDamageAction(
      attackerAfterFirstHit,
      [hit("OTHER_TARGET", 1)],
      referencingAction,
      [attackerAfterFirstHit, otherTarget],
      random,
      { ...damageEventContext(), damageResults },
    );
    // baseDamage = LAST_DAMAGE_DEALT(0) * ratio(1) = 0; R-DMG-02's minimum-1
    // still applies since this is a DAMAGE-kind effect.
    expect(referencingResult.hits[0]!.damage).toBe(1);
  });

  it("UT-R-HIT-02-009 (R-HIT-02): a target with an active EVASION effect evades a DAMAGE hit, skipping DamageApplied and emitting EvasionActivated instead of HitConfirmed", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const evasion = evasionEffect("eff-evasion", "TARGET", { probability: 1 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [evasion],
    };
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    expect(result.hits).toEqual([
      {
        targetUnitId: createBattleUnitId("TARGET"),
        hitIndex: 1,
        applied: false,
        isCritical: false,
        damage: 0,
      },
    ]);
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.currentHp).toBe(100);

    const eventTypes = context.recorder.getEvents().map((e) => e.eventType);
    expect(eventTypes).toContain("EvasionActivated");
    expect(eventTypes).not.toContain("HitConfirmed");
    expect(eventTypes).not.toContain("DamageApplied");

    const evasionActivated = context.recorder
      .getEvents()
      .find((e) => e.eventType === "EvasionActivated")!;
    expect(evasionActivated.payload).toEqual({
      effectActionDefinitionId: evasion.effectActionDefinitionId,
      effectInstanceId: evasion.effectInstanceId,
      hitIndex: 1,
      targetUnitId: createBattleUnitId("TARGET"),
    });
  });

  it("UT-R-HIT-02-010 (R-HIT-02 #2): a GUARANTEED-hit attack ignores the target's EVASION effect and applies damage normally", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const evasion = evasionEffect("eff-evasion", "TARGET", { probability: 1 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [evasion],
    };
    const random = new SequenceRandomSource([]);
    const guaranteedAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }> = {
      ...damageAction("PREVENTED"),
      payload: { ...damageAction("PREVENTED").payload, accuracy: { mode: "GUARANTEED" } },
    };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      guaranteedAction,
      [attacker, target],
      random,
      damageEventContext(),
    );

    expect(result.hits[0]!.applied).toBe(true);
    expect(result.hits[0]!.damage).toBe(20);
  });

  it("UT-R-HIT-02-012 (): EvasionActivated reaches onFactEventForPassiveChain, so a PS/Memory triggered by it is not silently skipped", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const evasion = evasionEffect("eff-evasion", "TARGET", { probability: 1 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [evasion],
    };
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();
    const seenEventTypes: string[] = [];
    const contextWithHook: DamageEventContext = {
      ...context,
      onFactEventForPassiveChain: (event, units) => {
        seenEventTypes.push(event.eventType);
        return units;
      },
    };

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      contextWithHook,
    );

    expect(seenEventTypes).toContain("EvasionActivated");
  });

  it("UT-R-HIT-04-006 (R-HIT-04, M7-018): the hit an evasion effect evades consumes that instance's own INCOMING_HIT count, so a 2-hit evasion buff evades exactly two hits and the third lands", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const evasion = hitCountEvasionEffect("eff-evasion", "TARGET", "EVASION", 2);
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [evasion],
    };
    const random = new SequenceRandomSource([]);
    const baseContext = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1), hit("TARGET", 2), hit("TARGET", 3)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      {
        ...baseContext,
        consumeEffectDuration: testConsumeEffectDuration(
          baseContext.recorder,
          new Map([
            [STAT_MOD_DEFINITION_ID, statModDefinition()],
            [createEffectActionDefinitionId("ACT_EVASION"), evasionDefinition()],
          ]),
        ),
      },
    );

    expect(result.hits.map((outcome) => outcome.applied)).toEqual([false, false, true]);
    expect(result.hits[2]!.damage).toBe(20);

    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.appliedEffects).toEqual([]);

    const eventTypes = baseContext.recorder.getEvents().map((e) => e.eventType);
    expect(eventTypes.filter((type) => type === "EvasionActivated")).toHaveLength(2);
    expect(eventTypes.filter((type) => type === "EffectConsumptionChanged")).toHaveLength(2);
    expect(eventTypes).toContain("EffectExpired");
  });

  it("UT-R-HIT-04-007 (R-HIT-04, M7-018): an evaded hit consumes only the evading instance — other INCOMING_HIT-consumption effects on the same target keep their count (R-EFF-07 still requires a confirmed hit for them)", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const evasion = hitCountEvasionEffect("eff-evasion", "TARGET", "HIT_EVASION", 1);
    const bystander = consumptionEffect(
      "eff-incoming-hit",
      createBattleUnitId("TARGET"),
      "INCOMING_HIT",
      2,
    );
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [evasion, bystander],
    };
    const random = new SequenceRandomSource([]);
    const baseContext = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      {
        ...baseContext,
        consumeEffectDuration: testConsumeEffectDuration(
          baseContext.recorder,
          new Map([
            [STAT_MOD_DEFINITION_ID, statModDefinition()],
            [createEffectActionDefinitionId("ACT_EVASION"), evasionDefinition()],
          ]),
        ),
      },
    );

    expect(result.hits[0]!.applied).toBe(false);
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.appliedEffects).toHaveLength(1);
    expect(updatedTarget.appliedEffects[0]!.effectInstanceId).toBe(bystander.effectInstanceId);
    expect(updatedTarget.appliedEffects[0]!.duration.consumptionRemaining).toBe(2);
  });

  it("UT-R-HIT-04-008 (R-HIT-04, M7-018): a HIT_EVASION buff shaped like ACT_FLUTE_VAMPIRE_PS2_EVASION evades exactly one hit and expires, so the next hit lands", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const evasion = hitCountEvasionEffect("eff-evasion", "TARGET", "HIT_EVASION", 1);
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [evasion],
    };
    const random = new SequenceRandomSource([]);
    const baseContext = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1), hit("TARGET", 2)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      {
        ...baseContext,
        consumeEffectDuration: testConsumeEffectDuration(
          baseContext.recorder,
          new Map([
            [STAT_MOD_DEFINITION_ID, statModDefinition()],
            [createEffectActionDefinitionId("ACT_EVASION"), evasionDefinition()],
          ]),
        ),
      },
    );

    expect(result.hits.map((outcome) => outcome.applied)).toEqual([false, true]);
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.appliedEffects).toEqual([]);
    expect(updatedTarget.currentHp).toBe(80);
  });

  it("UT-R-HIT-05-006 (R-HIT-05 #2, M7-018): an attacker holding a GUARANTEED_HIT effect lands a NORMAL-accuracy hit through the target's evasion, leaving the evasion count untouched", () => {
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30 }),
      appliedEffects: [guaranteedHitEffect("eff-guaranteed", "ATTACKER")],
    };
    const evasion = hitCountEvasionEffect("eff-evasion", "TARGET", "HIT_EVASION", 1);
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [evasion],
    };
    const random = new SequenceRandomSource([]);
    const baseContext = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      {
        ...baseContext,
        consumeEffectDuration: testConsumeEffectDuration(
          baseContext.recorder,
          new Map([
            [STAT_MOD_DEFINITION_ID, statModDefinition()],
            [createEffectActionDefinitionId("ACT_EVASION"), evasionDefinition()],
          ]),
        ),
      },
    );

    expect(result.hits[0]!.applied).toBe(true);
    expect(result.hits[0]!.damage).toBe(20);
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    // R-HIT-04: an N-hit evasion is consumed only by a hit it actually evaded.
    // This hit landed (the attacker is guaranteed-hit), so the evasion keeps
    // its full count for a later, non-guaranteed attack.
    expect(updatedTarget.appliedEffects).toHaveLength(1);
    expect(updatedTarget.appliedEffects[0]!.duration.consumptionRemaining).toBe(1);
    expect(baseContext.recorder.getEvents().map((event) => event.eventType)).not.toContain(
      "EvasionActivated",
    );
  });

  it("UT-R-CRT-03-013 (R-CRT-03 #2, DMG-003A): an attacker holding CRITICAL_GUARANTEE crits a NORMAL-declared attack at 0% criticalRate, and CriticalCheckResolved reports the effective GUARANTEED mode", () => {
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30, criticalRate: 0, criticalDamageBonus: 0.5 }),
      appliedEffects: [criticalStatusEffect("eff-crit", "ATTACKER", "CRITICAL_GUARANTEE")],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });
    // GUARANTEED は RandomSource を消費しない（R-CRT-01 の NORMAL 判定なら1消費する）。
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("NORMAL"),
      [attacker, target],
      random,
      context,
    );

    // 基礎20 × 会心倍率1.5（100% + 会心ダメージボーナス50%）。
    expect(result.hits[0]!.damage).toBe(30);
    random.assertFullyConsumed();
    const criticalCheckResolved = context.recorder
      .getEvents()
      .find((event) => event.eventType === "CriticalCheckResolved");
    expect(criticalCheckResolved!.payload).toMatchObject({ mode: "GUARANTEED", result: true });
  });

  it("UT-R-CRT-03-014 (R-CRT-03 #1, DMG-003A): an attacker holding CRITICAL_PREVENTION never crits, even when the definition itself declares GUARANTEED", () => {
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30, criticalRate: 1, criticalDamageBonus: 0.5 }),
      appliedEffects: [criticalStatusEffect("eff-crit", "ATTACKER", "CRITICAL_PREVENTION")],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("GUARANTEED"),
      [attacker, target],
      random,
      context,
    );

    // 基礎20 × 会心倍率1.0（非会心）。
    expect(result.hits[0]!.damage).toBe(20);
    random.assertFullyConsumed();
    const criticalCheckResolved = context.recorder
      .getEvents()
      .find((event) => event.eventType === "CriticalCheckResolved");
    expect(criticalCheckResolved!.payload).toMatchObject({ mode: "PREVENTED", result: false });
  });

  it("UT-R-CRT-03-015 (R-CRT-03 direction, DMG-003A): CRITICAL_PREVENTION held by the *defender* does not stop the attacker's critical — both critical statuses work on their holder's own attacks", () => {
    const attacker = unit("ATTACKER", "ALLY", {
      attack: 30,
      criticalRate: 1,
      criticalDamageBonus: 0.5,
    });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 }),
      appliedEffects: [criticalStatusEffect("eff-crit", "TARGET", "CRITICAL_PREVENTION")],
    };
    // 宣言は NORMAL のままなので R-CRT-01 の実効会心率100%で判定する（1消費）。
    const random = new SequenceRandomSource([0.999999]);
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("NORMAL"),
      [attacker, target],
      random,
      context,
    );

    // 基礎20 × 会心倍率1.5（100% + 会心ダメージボーナス50%）。
    expect(result.hits[0]!.damage).toBe(30);
    random.assertFullyConsumed();
    const criticalCheckResolved = context.recorder
      .getEvents()
      .find((event) => event.eventType === "CriticalCheckResolved");
    expect(criticalCheckResolved!.payload).toMatchObject({ mode: "NORMAL", result: true });
  });

  it("UT-R-HIT-04-010 (R-HIT-04): an evasion whose probability roll fails keeps its hit count — the landed hit must not consume it through the ordinary R-EFF-07 confirmed-hit rule", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    // ACT_STELLA_STATUE_AS2_SELF_EVASION shape: probability 0.6, 1 hit.
    const evasion: AppliedEffect = {
      ...hitCountEvasionEffect("eff-evasion", "TARGET", "EVASION", 1),
      statusDetails: { probability: 0.6 },
    };
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [evasion],
    };
    // 0.6 <= 0.6 => the evasion roll fails, so the hit lands.
    const random = new SequenceRandomSource([0.6]);
    const baseContext = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      {
        ...baseContext,
        consumeEffectDuration: testConsumeEffectDuration(
          baseContext.recorder,
          new Map([
            [STAT_MOD_DEFINITION_ID, statModDefinition()],
            [createEffectActionDefinitionId("ACT_EVASION"), evasionDefinition()],
          ]),
        ),
      },
    );

    expect(result.hits[0]!.applied).toBe(true);
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.appliedEffects).toHaveLength(1);
    expect(updatedTarget.appliedEffects[0]!.duration.consumptionRemaining).toBe(1);
    expect(baseContext.recorder.getEvents().map((event) => event.eventType)).not.toContain(
      "EffectConsumptionChanged",
    );
  });

  it("UT-R-HIT-04-011 (R-HIT-04 boundary): a non-evasion INCOMING_HIT-consumption effect on the same target is still consumed by the confirmed hit (R-EFF-07 unchanged)", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const evasion: AppliedEffect = {
      ...hitCountEvasionEffect("eff-evasion", "TARGET", "HIT_EVASION", 1),
      statusDetails: { probability: 0.6 },
    };
    const bystander = consumptionEffect(
      "eff-incoming-hit",
      createBattleUnitId("TARGET"),
      "INCOMING_HIT",
      2,
    );
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [evasion, bystander],
    };
    const random = new SequenceRandomSource([0.6]);
    const baseContext = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      {
        ...baseContext,
        consumeEffectDuration: testConsumeEffectDuration(
          baseContext.recorder,
          new Map([
            [STAT_MOD_DEFINITION_ID, statModDefinition()],
            [createEffectActionDefinitionId("ACT_EVASION"), evasionDefinition()],
          ]),
        ),
      },
    );

    expect(result.hits[0]!.applied).toBe(true);
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.appliedEffects).toHaveLength(2);
    expect(updatedTarget.appliedEffects[0]!.duration.consumptionRemaining).toBe(1);
    expect(updatedTarget.appliedEffects[1]!.duration.consumptionRemaining).toBe(1);
  });

  it("UT-R-DMG-02-008 (R-DMG-02): an unconditional DAMAGE_IMMUNITY effect nullifies a hit's damage to exactly 1, still confirming the hit (HitConfirmed/DamageApplied still fire)", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const immunity = immunityEffect("eff-immunity", "TARGET", {});
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [immunity],
    };
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    expect(result.hits[0]!.applied).toBe(true);
    expect(result.hits[0]!.damage).toBe(1);
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.currentHp).toBe(99);

    const eventTypes = context.recorder.getEvents().map((e) => e.eventType);
    expect(eventTypes).toContain("HitConfirmed");
    expect(eventTypes).toContain("DamageApplied");

    const damageCalculated = context.recorder
      .getEvents()
      .find((e) => e.eventType === "DamageCalculated")!;
    expect(damageCalculated.payload).toMatchObject({
      // Base damage 20 (attack 30 - defense 10) would normally apply, but the
      // nullification overrides just finalDamage — preTruncationDamage keeps
      // auditing the pre-nullification value.
      preTruncationDamage: 20,
      finalDamage: 1,
    });
  });

  it("UT-R-DMG-02-009 (R-DMG-02 damageThreshold): a DAMAGE_IMMUNITY gated by damageThreshold lets damage below the threshold through unmodified", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const immunity = immunityEffect("eff-immunity", "TARGET", {
      damageThreshold: {
        op: "GT",
        formula: { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.5 },
      },
    });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [immunity],
    };
    const random = new SequenceRandomSource([]);

    // Base damage 20 (attack 30 - defense 10) does not exceed 50% of 100 HP
    // (50), so the immunity does not trigger and full damage applies.
    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      damageEventContext(),
    );

    expect(result.hits[0]!.damage).toBe(20);
  });

  it("UT-R-STS-03-005 (R-STS-03): a DAMAGE hit against a frozen target amplifies this hit's damage by damageAmplificationOnBreak, clears FREEZE, and records FreezeRemoved between DamageCalculated and HitPointReduced", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const freeze = freezeEffect("eff-freeze", "TARGET", { damageAmplificationOnBreak: 0.5 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [freeze],
    };
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    // Base damage 20 (attack 30 - defense 10) * 1.5 amplification = 30.
    expect(result.hits[0]!.damage).toBe(30);
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.currentHp).toBe(70);
    expect(updatedTarget.appliedEffects).toHaveLength(0);

    const eventTypes = context.recorder.getEvents().map((e) => e.eventType);
    expect(eventTypes).toContain("FreezeRemoved");
    const damageCalculatedIndex = eventTypes.indexOf("DamageCalculated");
    const freezeRemovedIndex = eventTypes.indexOf("FreezeRemoved");
    const hitPointReducedIndex = eventTypes.indexOf("HitPointReduced");
    expect(damageCalculatedIndex).toBeLessThan(freezeRemovedIndex);
    expect(freezeRemovedIndex).toBeLessThan(hitPointReducedIndex);

    const freezeRemoved = context.recorder
      .getEvents()
      .find((e) => e.eventType === "FreezeRemoved")!;
    expect(freezeRemoved.payload).toEqual({
      effectInstanceId: freeze.effectInstanceId,
      battleUnitId: target.battleUnitId,
      triggeringDamage: 30,
    });
  });

  it("UT-R-STS-03-006 (R-STS-03 default amplification +50%): a frozen target with no explicit damageAmplificationOnBreak amplifies by 1.5x", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const freeze = freezeEffect("eff-freeze", "TARGET", {});
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [freeze],
    };
    const random = new SequenceRandomSource([]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      damageEventContext(),
    );

    expect(result.hits[0]!.damage).toBe(30);
  });

  it("UT-R-STS-03-012 (Q-DMG-01 'ダメージ計算の途中では丸めず、最終結果で切り捨てる'): freeze amplification is applied to the unrounded pre-truncation damage and floored exactly once, not floored again after calculateDamage's own floor", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const freeze = freezeEffect("eff-freeze", "TARGET", { damageAmplificationOnBreak: 0.5 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 }),
      appliedEffects: [freeze],
    };
    const random = new SequenceRandomSource([]);
    // Base damage 20 (attack 30 - defense 10) * actionDamageMultiplier 1.045
    // (from a 4.5% damageModifier) = 20.9 pre-truncation.
    const fractionalDamageAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }> = {
      ...damageAction("PREVENTED"),
      payload: {
        ...damageAction("PREVENTED").payload,
        damageModifiers: [{ kind: "CONSTANT", value: 0.045 }],
      },
    };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      fractionalDamageAction,
      [attacker, target],
      random,
      damageEventContext(),
    );

    // Correct (single final floor): 20.9 * 1.5 = 31.35 -> floor -> 31.
    // The bug this guards against: flooring 20.9 -> 20 first, then *1.5 -> 30
    // -> floor -> 30 (a full point of damage silently lost to Q-DMG-01
    // non-compliant intermediate rounding).
    expect(result.hits[0]!.damage).toBe(31);
  });

  it("UT-R-STS-03-007 (R-STS-03 interacts with R-DMG-02): freeze still clears even when DAMAGE_IMMUNITY nullifies the (already amplified) triggering damage down to 1", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const freeze = freezeEffect("eff-freeze", "TARGET", { damageAmplificationOnBreak: 0.5 });
    const immunity = immunityEffect("eff-immunity", "TARGET", {});
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [freeze, immunity],
    };
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    expect(result.hits[0]!.damage).toBe(1);
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    // FREEZE cleared, DAMAGE_IMMUNITY (unrelated effect) remains.
    expect(updatedTarget.appliedEffects).toEqual([immunity]);
    expect(context.recorder.getEvents().some((e) => e.eventType === "FreezeRemoved")).toBe(true);

    const freezeRemoved = context.recorder
      .getEvents()
      .find((e) => e.eventType === "FreezeRemoved")!;
    // triggeringDamage reflects the final (nullified) damage, not the
    // pre-nullification amplified value.
    expect(freezeRemoved.payload).toMatchObject({ triggeringDamage: 1 });
  });

  it("UT-R-STS-03-008 (R-STS-03 'MISSでは解除しない'): an evaded hit against a frozen target does not amplify damage or clear FREEZE", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const freeze = freezeEffect("eff-freeze", "TARGET", { damageAmplificationOnBreak: 0.5 });
    const evasion = evasionEffect("eff-evasion", "TARGET", { probability: 1 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [freeze, evasion],
    };
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    expect(result.hits[0]!.applied).toBe(false);
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.appliedEffects.some((e) => e.statusKind === "FREEZE")).toBe(true);
    expect(context.recorder.getEvents().some((e) => e.eventType === "FreezeRemoved")).toBe(false);
  });

  it("UT-R-STS-03-013 (): FreezeRemoved reaches onFactEventForPassiveChain before HP is applied, so a PS reacting to it sees pre-damage HP as the baseline", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const freeze = freezeEffect("eff-freeze", "TARGET", { damageAmplificationOnBreak: 0.5 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [freeze],
    };
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();
    // Simulate a PS that heals the target by 5 HP the instant FreezeRemoved
    // fires (before this hit's HP reduction is computed).
    const seenEventTypes: string[] = [];
    const contextWithHeal: DamageEventContext = {
      ...context,
      onFactEventForPassiveChain: (event, units) => {
        seenEventTypes.push(event.eventType);
        return event.eventType === "FreezeRemoved"
          ? units.map((u) =>
              u.battleUnitId === target.battleUnitId ? { ...u, currentHp: u.currentHp + 5 } : u,
            )
          : units;
      },
    };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      contextWithHeal,
    );

    // FreezeRemoved must reach the hook strictly before DamageApplied/
    // HitPointReduced, so a reacting PS's HP change becomes the baseline the
    // hit's own damage is subtracted from.
    expect(seenEventTypes.indexOf("FreezeRemoved")).toBeLessThan(
      seenEventTypes.indexOf("HitPointReduced"),
    );
    // Base damage 20 (attack 30 - defense 10) * 1.5 amplification = 30.
    // Baseline must be the healed HP (100 + 5 = 105), not the stale
    // pre-heal snapshot (100): 105 - 30 = 75.
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.currentHp).toBe(75);
    const damageApplied = context.recorder
      .getEvents()
      .find((e) => e.eventType === "DamageApplied")!;
    expect(damageApplied.payload).toMatchObject({ hpBefore: 105, hpAfter: 75 });
  });
});

/**
 * R-DMG-06「攻撃時追加攻撃」（production定義: `SKL_ELENA_MOODMAKER_EX` の
 * 「攻撃時に攻撃力×15%のダメージを追加するバフ」）。保持者の`DAMAGE` EffectActionの
 * 解決が終わった後に、保持インスタンスごと×実際に当てた対象ごとに独立した1ヒットを
 * 加える。基準は「元のヒットへの加算ではなく、別ヒットとして観測されること」であり、
 * 会心継承・属性相性・与ダメージ補正が乗り、対象の防御力では減衰しない。
 */
describe("attack bonus attack (R-DMG-06)", () => {
  const BONUS_DEFINITION_ID = "ACT_ATTACK_DAMAGE_BONUS";

  /** 追加攻撃が発行した`DamageCalculated`だけを取り出す（元の攻撃とはIDで分かれる）。 */
  function bonusDamageCalculated(
    context: DamageEventContext,
  ): readonly { readonly [key: string]: unknown }[] {
    return context.recorder
      .getEvents()
      .filter((event) => event.eventType === "DamageCalculated")
      .map((event) => event.payload as { readonly [key: string]: unknown })
      .filter((payload) => payload["effectActionDefinitionId"] === BONUS_DEFINITION_ID);
  }

  function hpOf(units: readonly BattleUnit[], id: string): number {
    return units.find((unit) => unit.battleUnitId === createBattleUnitId(id))!.currentHp;
  }

  it("UT-R-BON-ATTACK-DMG-002 (R-DMG-06 #1/#2, mirrors SKL_ELENA_MOODMAKER_EX): the bonus resolves as its own hit after the attack — the target loses the attack's damage plus the whole magnitude, with no defense attenuation on the bonus", () => {
    const bonus = attackDamageBonusEffect("eff-bonus", "ATTACKER", 6);
    const attacker = { ...unit("ATTACKER", "ALLY", { attack: 30 }), appliedEffects: [bonus] };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    // 元の攻撃は基礎ダメージ20（攻撃30 - 防御10）のまま。追加攻撃は`CONSTANT`
    // Formulaのため基礎ダメージ＝magnitudeそのもので、防御10を引かない。
    expect(hpOf(result.units, "TARGET")).toBe(100 - 20 - 6);
    // 追加攻撃ヒットは`outcomes`に含めない（R-FUP-01の命中・会心集計と
    // R-SKL-08の直前結果を汚さないため）。
    expect(result.hits).toEqual([
      {
        targetUnitId: createBattleUnitId("TARGET"),
        hitIndex: 1,
        applied: true,
        isCritical: false,
        damage: 20,
      },
    ]);
    expect(bonusDamageCalculated(context)).toHaveLength(1);
    expect(bonusDamageCalculated(context)[0]).toMatchObject({
      baseDamage: 6,
      finalDamage: 6,
      damageType: "PHYSICAL",
    });
    // 独立ヒットである証跡として、追加攻撃も自分の`DamageApplied`を発行する。
    expect(
      context.recorder
        .getEvents()
        .filter(
          (event) =>
            event.eventType === "DamageApplied" &&
            (event.payload as { effectActionDefinitionId?: string }).effectActionDefinitionId ===
              BONUS_DEFINITION_ID,
        ),
    ).toHaveLength(1);
  });

  it("UT-R-BON-ATTACK-DMG-003 (R-DMG-06 interacts with R-DMG-02 #2): the bonus attack is capped to 1 by the target's DAMAGE_IMMUNITY, same as any other hit", () => {
    const bonus = attackDamageBonusEffect("eff-bonus", "ATTACKER", 6);
    const attacker = { ...unit("ATTACKER", "ALLY", { attack: 30 }), appliedEffects: [bonus] };
    const immunity = immunityEffect("eff-immunity", "TARGET", {});
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [immunity],
    };
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    expect(result.hits[0]!.damage).toBe(1);
    expect(bonusDamageCalculated(context)[0]).toMatchObject({
      damageImmunityNullified: true,
      finalDamage: 1,
    });
    expect(hpOf(result.units, "TARGET")).toBe(100 - 1 - 1);
  });

  it("UT-R-BON-ATTACK-DMG-004 (R-DMG-06, NEGATIVE): an attack whose every hit was evaded produces no bonus attack — the bonus rides on targets that were actually hit", () => {
    const bonus = attackDamageBonusEffect("eff-bonus", "ATTACKER", 6);
    const attacker = { ...unit("ATTACKER", "ALLY", { attack: 30 }), appliedEffects: [bonus] };
    const evasion = evasionEffect("eff-evasion", "TARGET", { probability: 1 });
    const target = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [evasion],
    };
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([0]),
      context,
    );

    expect(result.hits[0]!.applied).toBe(false);
    expect(bonusDamageCalculated(context)).toEqual([]);
    expect(hpOf(result.units, "TARGET")).toBe(100);
  });

  it("UT-R-BON-ATTACK-DMG-005 (R-DMG-06, critical inheritance): the bonus attack inherits the attack's critical — a critical attack multiplies the bonus by the holder's critical damage bonus without drawing again", () => {
    const bonus = attackDamageBonusEffect("eff-bonus", "ATTACKER", 6);
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30, criticalDamageBonus: 0.5 }),
      appliedEffects: [bonus],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const context = damageEventContext();

    // 乱数列を空にしておくことで、追加攻撃が独自の命中・会心判定を持たない
    // （乱数を消費しない）ことも同時に固定する。
    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("GUARANTEED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    expect(bonusDamageCalculated(context)[0]).toMatchObject({
      criticalMultiplier: 1.5,
      finalDamage: 9,
    });
    // 元の攻撃 20 × 1.5 = 30、追加攻撃 6 × 1.5 = 9。
    expect(hpOf(result.units, "TARGET")).toBe(100 - 30 - 9);
  });

  it("UT-R-BON-ATTACK-DMG-006 (R-DMG-06, R-ATR-02, R-DMG-04): the bonus attack takes the attribute multiplier and the holder's outgoing damage modifier, unlike a flat addition", () => {
    const bonus = attackDamageBonusEffect("eff-bonus", "ATTACKER", 6);
    const outgoing: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("DMG_MOD"),
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_DMG_MOD"),
      kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId("ACT_DMG_MOD")),
      duplicate: true,
      targetUnitId: createBattleUnitId("ATTACKER"),
      magnitude: 0.1,
      categories: ["DAMAGE_MOD"],
      damageModifier: { direction: "OUTGOING", damageType: null },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30, affinityBonus: 0.25, attribute: "AGGRESSIVE" }),
      appliedEffects: [bonus, outgoing],
    };
    // R-ATR-01: アグレッシブはシャイに対して有利。
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100, attribute: "SHY" });
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    expect(bonusDamageCalculated(context)[0]).toMatchObject({
      attributeMultiplier: 1.25,
      outgoingDamageMultiplier: 1.1,
      // 6 × 1.25 × 1.1 = 8.25 → 切り捨て8。
      finalDamage: 8,
    });
    // 元の攻撃 20 × 1.25 × 1.1 = 27.5 → 27。
    expect(hpOf(result.units, "TARGET")).toBe(100 - 27 - 8);
  });

  it("UT-R-BON-ATTACK-DMG-007 (R-DMG-06, per EffectAction): a 3-hit attack still produces exactly one bonus attack — the unit is the DAMAGE EffectAction, not the hit", () => {
    const bonus = attackDamageBonusEffect("eff-bonus", "ATTACKER", 6);
    const attacker = { ...unit("ATTACKER", "ALLY", { attack: 30 }), appliedEffects: [bonus] };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1), hit("TARGET", 2), hit("TARGET", 3)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    expect(bonusDamageCalculated(context)).toHaveLength(1);
    expect(hpOf(result.units, "TARGET")).toBe(100 - 20 * 3 - 6);
  });

  it("UT-R-BON-ATTACK-DMG-008 (R-DMG-06, per target): a two-target attack produces one bonus attack per target that was actually hit", () => {
    const bonus = attackDamageBonusEffect("eff-bonus", "ATTACKER", 6);
    const attacker = { ...unit("ATTACKER", "ALLY", { attack: 30 }), appliedEffects: [bonus] };
    const first = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const second = unit("TARGET_2", "ENEMY", { defense: 10, maximumHp: 100 });
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1), hit("TARGET_2", 1)],
      damageAction("PREVENTED"),
      [attacker, first, second],
      new SequenceRandomSource([]),
      context,
    );

    expect(bonusDamageCalculated(context).map((payload) => payload["targetUnitId"])).toEqual([
      createBattleUnitId("TARGET"),
      createBattleUnitId("TARGET_2"),
    ]);
    expect(hpOf(result.units, "TARGET")).toBe(100 - 20 - 6);
    expect(hpOf(result.units, "TARGET_2")).toBe(100 - 20 - 6);
  });

  it("UT-R-BON-ATTACK-DMG-009 (R-DMG-06, stacking): holding two instances produces two bonus attacks, one per instance", () => {
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30 }),
      appliedEffects: [
        attackDamageBonusEffect("eff-bonus-1", "ATTACKER", 6),
        attackDamageBonusEffect("eff-bonus-2", "ATTACKER", 4),
      ],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    expect(bonusDamageCalculated(context).map((payload) => payload["finalDamage"])).toEqual([6, 4]);
    expect(hpOf(result.units, "TARGET")).toBe(100 - 20 - 6 - 4);
  });

  it("UT-R-BON-ATTACK-DMG-010 (R-DMG-06, NEGATIVE): an already defeated target is skipped by the attack and gets no bonus attack either", () => {
    const bonus = attackDamageBonusEffect("eff-bonus", "ATTACKER", 6);
    const attacker = { ...unit("ATTACKER", "ALLY", { attack: 30 }), appliedEffects: [bonus] };
    const target = defeated(unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }));
    const context = damageEventContext();

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    expect(result.hits[0]!.applied).toBe(false);
    expect(bonusDamageCalculated(context)).toEqual([]);
  });

  it("UT-R-BON-ATTACK-DMG-012 (R-DMG-06 #9, R-SKL-08): the additional attack is recorded into the damage-result registry like any other hit — it does not appear in hits[] but it does count as damage dealt", () => {
    const bonus = attackDamageBonusEffect("eff-bonus", "ATTACKER", 6);
    const attacker = { ...unit("ATTACKER", "ALLY", { attack: 30 }), appliedEffects: [bonus] };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const damageResults: DamageResultRegistry = new Map();
    const context = { ...damageEventContext(), damageResults };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    // ヒット列（R-FUP-01の命中・会心集計が読む側）には現れない。
    expect(result.hits).toHaveLength(1);
    // 直前結果は追加攻撃ヒットのもので上書きされ、累計には両方が乗る。R-SUB-02の
    // 追加ヒット・R-FUP-01の追撃と同じ扱いであり、3者は同じ適用経路を共有する。
    const dealt = damageResults.get(attacker.battleUnitId)!;
    expect(dealt.lastDamageDealt).toBe(6);
    expect(dealt.sumDamageDealt?.get(context.skillUseId)).toBe(20 + 6);
    const received = damageResults.get(target.battleUnitId)!;
    expect(received.lastDamageReceived).toBe(6);
    expect(received.sumDamageReceived?.get(context.skillUseId)).toBe(20 + 6);
  });

  it("UT-R-BON-ATTACK-DMG-011 (R-DMG-06, R-SUB-02 boundary): the bonus attack neither triggers a further bonus attack nor a sub unit additional damage hit", () => {
    const SUBUNIT_DEFINITION_ID = createEffectActionDefinitionId("ACT_SUBUNIT_SUB_1");
    const subUnit: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("SUB_1"),
      effectActionDefinitionId: SUBUNIT_DEFINITION_ID,
      kindKey: effectKindKeyFromDefinitionId(SUBUNIT_DEFINITION_ID),
      duplicate: true,
      targetUnitId: createBattleUnitId("ATTACKER"),
      magnitude: 50,
      categories: ["SUBUNIT"],
      subUnit: {
        durability: 50,
        additionalDamage: {
          formula: {
            kind: "SUBUNIT_ADDITIONAL_DAMAGE",
            ownerAttack: "CURRENT_ATTACK",
            providerAttack: "SOURCE_SNAPSHOT_ATTACK",
            skillMultiplier: 0.5,
            targetDefense: "TARGET_CURRENT_DEFENSE",
          },
        },
      },
      snapshot: { [SUBUNIT_PROVIDER_ATTACK_KEY]: 100 },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
    const attacker = {
      ...unit("ATTACKER", "ALLY", { attack: 30 }),
      appliedEffects: [attackDamageBonusEffect("eff-bonus", "ATTACKER", 6), subUnit],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });
    const context = damageEventContext();

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    // 追加攻撃は1回だけ（自分自身をもう一度誘発しない）。
    expect(bonusDamageCalculated(context)).toHaveLength(1);
    // サブユニット追加ダメージも元の攻撃対象1体につき1回だけ（追加攻撃は誘発しない）。
    expect(
      context.recorder
        .getEvents()
        .filter(
          (event) =>
            event.eventType === "DamageCalculated" &&
            (event.payload as { effectActionDefinitionId?: string }).effectActionDefinitionId ===
              SUBUNIT_DEFINITION_ID,
        ),
    ).toHaveLength(1);
  });
});

/**
 * R-DMG-06 の中断・スキップ経路。追加攻撃の解決中にPS/Memory連鎖が前提を崩したときの
 * 契約を、production（AS/EX）と同じ`onFactEventForPassiveChain`経路で踏む。連鎖は
 * FACTイベントの記録直後に同期で呼ばれるため、追加攻撃1件と次の1件の**間**へ状態変化を
 * 差し込める。
 */
describe("attack bonus attack interruption (R-DMG-06 #3)", () => {
  const BONUS_DEFINITION_ID = "ACT_ATTACK_DAMAGE_BONUS";

  function definitionIdOf(event: { readonly payload: unknown }): string | undefined {
    return (event.payload as { effectActionDefinitionId?: string }).effectActionDefinitionId;
  }

  function bonusHitCount(context: DamageEventContext): number {
    return context.recorder
      .getEvents()
      .filter(
        (event) =>
          event.eventType === "DamageApplied" && definitionIdOf(event) === BONUS_DEFINITION_ID,
      ).length;
  }

  /** `chain`が返したユニットだけを差し替えるPS/Memory即時連鎖フック。 */
  function contextWithChain(
    chain: (event: BattleDomainEvent) => readonly BattleUnit[],
  ): DamageEventContext {
    return { ...damageEventContext(), onFactEventForPassiveChain: (event) => chain(event) };
  }

  it("UT-R-BON-ATTACK-DMG-013 (R-SKL-01): a chain that defeats the holder on the attack's own last event leaves the additional attacks unresolved and reports the interruption", () => {
    const bonus = attackDamageBonusEffect("eff-bonus", "ATTACKER", 6);
    const attacker = { ...unit("ATTACKER", "ALLY", { attack: 30 }), appliedEffects: [bonus] };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    let defeatedAttacker: BattleUnit | undefined;
    const context = contextWithChain((event) =>
      event.eventType === "DamageApplied" && definitionIdOf(event) !== BONUS_DEFINITION_ID
        ? [(defeatedAttacker = defeated(attacker))]
        : [],
    );

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    expect(defeatedAttacker).toBeDefined();
    expect(result.interrupted).toBe(true);
    expect(bonusHitCount(context)).toBe(0);
  });

  it("UT-R-BON-ATTACK-DMG-014 (R-SKL-01): a chain that defeats the holder during an additional attack interrupts that hit and the remaining targets", () => {
    const bonus = attackDamageBonusEffect("eff-bonus", "ATTACKER", 6);
    const attacker = { ...unit("ATTACKER", "ALLY", { attack: 30 }), appliedEffects: [bonus] };
    const first = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const second = unit("TARGET_2", "ENEMY", { defense: 10, maximumHp: 100 });
    // 1体目への追加攻撃が命中を確定した時点で、連鎖（反射など）が使用者を倒す。
    const context = contextWithChain((event) =>
      event.eventType === "HitConfirmed" && definitionIdOf(event) === BONUS_DEFINITION_ID
        ? [defeated(attacker)]
        : [],
    );

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1), hit("TARGET_2", 1)],
      damageAction("PREVENTED"),
      [attacker, first, second],
      new SequenceRandomSource([]),
      context,
    );

    expect(result.interrupted).toBe(true);
    // 命中確定後に倒れたため、1体目のヒットも適用されず2体目は解決自体が行われない。
    expect(bonusHitCount(context)).toBe(0);
  });

  it("UT-R-BON-ATTACK-DMG-017 (R-SKL-01): a chain that defeats the holder between two additional attacks leaves the remaining ones unresolved", () => {
    const bonus = attackDamageBonusEffect("eff-bonus", "ATTACKER", 6);
    const attacker = { ...unit("ATTACKER", "ALLY", { attack: 30 }), appliedEffects: [bonus] };
    const first = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const second = unit("TARGET_2", "ENEMY", { defense: 10, maximumHp: 100 });
    // 1体目への追加攻撃が適用され切った時点で、連鎖が使用者を倒す。
    const context = contextWithChain((event) =>
      event.eventType === "DamageApplied" && definitionIdOf(event) === BONUS_DEFINITION_ID
        ? [defeated(attacker)]
        : [],
    );

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1), hit("TARGET_2", 1)],
      damageAction("PREVENTED"),
      [attacker, first, second],
      new SequenceRandomSource([]),
      context,
    );

    // 1体目は適用済みのまま残り、2体目だけが未解決になる（R-SUB-02の追加ヒットと同じ）。
    expect(result.interrupted).toBe(true);
    expect(bonusHitCount(context)).toBe(1);
  });

  it("UT-R-BON-ATTACK-DMG-015 (R-DMG-06 #6): a buff instance removed by the chain stops producing additional attacks for the remaining targets", () => {
    const bonus = attackDamageBonusEffect("eff-bonus", "ATTACKER", 6);
    const attacker = { ...unit("ATTACKER", "ALLY", { attack: 30 }), appliedEffects: [bonus] };
    const first = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const second = unit("TARGET_2", "ENEMY", { defense: 10, maximumHp: 100 });
    // 1体目への追加攻撃が適用された時点で、連鎖がバフそのものを解除する。
    const context = contextWithChain((event) =>
      event.eventType === "DamageApplied" && definitionIdOf(event) === BONUS_DEFINITION_ID
        ? [{ ...attacker, appliedEffects: [] }]
        : [],
    );

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1), hit("TARGET_2", 1)],
      damageAction("PREVENTED"),
      [attacker, first, second],
      new SequenceRandomSource([]),
      context,
    );

    expect(result.interrupted).toBe(false);
    expect(bonusHitCount(context)).toBe(1);
  });

  it("UT-R-BON-ATTACK-DMG-016 (R-ACTN-01 #2): a target defeated by the chain is skipped without interrupting the remaining additional attacks", () => {
    const bonus = attackDamageBonusEffect("eff-bonus", "ATTACKER", 6);
    const attacker = { ...unit("ATTACKER", "ALLY", { attack: 30 }), appliedEffects: [bonus] };
    const first = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const second = unit("TARGET_2", "ENEMY", { defense: 10, maximumHp: 100 });
    // 1体目への追加攻撃が適用された時点で、連鎖が2体目を倒す。
    const context = contextWithChain((event) =>
      event.eventType === "DamageApplied" && definitionIdOf(event) === BONUS_DEFINITION_ID
        ? [defeated(second)]
        : [],
    );

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1), hit("TARGET_2", 1)],
      damageAction("PREVENTED"),
      [attacker, first, second],
      new SequenceRandomSource([]),
      context,
    );

    expect(result.interrupted).toBe(false);
    expect(bonusHitCount(context)).toBe(1);
  });
});
