import { describe, expect, it } from "vitest";
import { applyDamageAction, type DamageEventContext } from "./damage-application-service.js";
import { shieldPoolsOf } from "./shield-policy.js";
import { fc, PROPERTY_ASSERT_CONFIG } from "../../../testing/property/index.js";
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

describe("applyDamageAction shield absorption (DMG-004 R-SHD-01/02/03)", () => {
  function shieldEffect(
    id: string,
    holderId: string,
    amount: number,
    shieldType: "PHYSICAL" | "EN" | null,
  ): AppliedEffect {
    const definitionId = createEffectActionDefinitionId(`ACT_SHIELD_${id}`);
    return {
      effectInstanceId: createEffectInstanceId(id),
      effectActionDefinitionId: definitionId,
      kindKey: effectKindKeyFromDefinitionId(definitionId),
      duplicate: true,
      targetUnitId: createBattleUnitId(holderId),
      magnitude: amount,
      categories: ["SHIELD"],
      shield: { shieldType, remaining: amount },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
  }

  function shieldedTarget(
    shields: readonly AppliedEffect[],
    overrides: { defense?: number } = {},
  ): BattleUnit {
    const target = unit("TARGET", "ENEMY", { defense: overrides.defense ?? 10 });
    return { ...target, appliedEffects: shields };
  }

  it("UT-R-SHD-02-004: absorbs the hit with the matching typed shield before the untyped shield and HP", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 40 });
    // finalDamage = 40 - 10 = 30
    const target = shieldedTarget([
      shieldEffect("SHIELD_TYPED", "TARGET", 20, "PHYSICAL"),
      shieldEffect("SHIELD_UNTYPED", "TARGET", 5, null),
    ]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    const updated = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
    expect(updated.currentHp).toBe(95);
    // R-SHD-01第3項: 使い切った2インスタンスは`SHIELD_DEPLETED`で失効している。
    expect(updated.appliedEffects).toEqual([]);

    const consumed = context.recorder
      .getEvents()
      .filter((event) => event.eventType === "ShieldConsumed");
    expect(consumed.map((event) => event.payload)).toEqual([
      expect.objectContaining({ shieldType: "PHYSICAL", before: 20, after: 0, absorbed: 20 }),
      expect.objectContaining({ shieldType: null, before: 5, after: 0, absorbed: 5 }),
    ]);

    const applied = context.recorder.getEvents().find((e) => e.eventType === "DamageApplied")!;
    expect(applied.payload).toMatchObject({
      calculatedDamage: 30,
      hpDirectDamage: 0,
      typedShieldAbsorbed: 20,
      untypedShieldAbsorbed: 5,
      discardedDamage: 0,
      hitPointDamage: 5,
    });
  });

  it("UT-R-SHD-02-005: leaves a typed shield of a different type untouched", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 40 });
    const target = shieldedTarget([shieldEffect("SHIELD_EN", "TARGET", 100, "EN")]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    const updated = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
    expect(updated.currentHp).toBe(70);
    expect(updated.appliedEffects[0]!.shield!.remaining).toBe(100);
    expect(context.recorder.getEvents().some((e) => e.eventType === "ShieldConsumed")).toBe(false);
  });

  it("UT-R-SHD-03-003: discards the overflow that would take HP below zero and reports it", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 210 });
    // finalDamage = 210 - 10 = 200, shield 50 -> HP damage 150, HP is 100
    const target = shieldedTarget([shieldEffect("SHIELD_UNTYPED", "TARGET", 50, null)]);

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    const applied = context.recorder.getEvents().find((e) => e.eventType === "DamageApplied")!;
    expect(applied.payload).toMatchObject({
      calculatedDamage: 200,
      untypedShieldAbsorbed: 50,
      hitPointDamage: 100,
      discardedDamage: 50,
      hpAfter: 0,
      defeated: true,
    });
  });

  function ignoringAction(shieldIgnoreRate: number) {
    const action = damageAction("PREVENTED");
    return {
      ...action,
      payload: {
        ...action.payload,
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate, damageReductionIgnoreRate: 0 },
      },
    };
  }

  function ignoringHit(
    shieldIgnoreRate: number,
    finalDamagePerHit: number,
    shields: readonly AppliedEffect[],
    hitCount = 1,
  ) {
    const context = damageEventContext();
    // finalDamage = attack - defense(10)
    const attacker = unit("ATTACKER", "ALLY", { attack: finalDamagePerHit + 10 });
    const base = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 10000 });
    const target: BattleUnit = { ...base, appliedEffects: shields };
    const result = applyDamageAction(
      attacker,
      Array.from({ length: hitCount }, (_, index) => hit("TARGET", index + 1)),
      ignoringAction(shieldIgnoreRate),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );
    const updated = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
    const remainingOf = (id: string): number | undefined =>
      updated.appliedEffects.find((e) => e.effectInstanceId === createEffectInstanceId(id))?.shield
        ?.remaining;
    const applied = context.recorder
      .getEvents()
      .filter((e) => e.eventType === "DamageApplied")
      .map((e) => e.payload);
    return { updated, remainingOf, applied, events: context.recorder.getEvents() };
  }

  it("UT-R-SHD-02-006 (R-DMG-03, Q-SRV-01): a partly ignored shield still stops the whole hit while its functioning share covers it", () => {
    // 無視50%・盾100 → 機能分50。40ダメージは機能分に収まり、HPは減らない。
    const { updated, remainingOf, applied } = ignoringHit(0.5, 40, [
      shieldEffect("SHIELD_UNTYPED", "TARGET", 100, null),
    ]);

    expect(updated.currentHp).toBe(10000);
    expect(remainingOf("SHIELD_UNTYPED")).toBe(60);
    expect(applied[0]).toMatchObject({
      hpDirectDamage: 0,
      untypedShieldAbsorbed: 40,
      hitPointDamage: 0,
    });
  });

  it("UT-R-SHD-02-008 (Q-SRV-01): 50% ignore, shield 2000, damage 800 -> HP unchanged, shield 1200 left", () => {
    const { updated, remainingOf, applied } = ignoringHit(0.5, 800, [
      shieldEffect("SHIELD", "TARGET", 2000, null),
    ]);

    expect(updated.currentHp).toBe(10000);
    expect(remainingOf("SHIELD")).toBe(1200);
    expect(applied[0]).toMatchObject({ untypedShieldAbsorbed: 800, hitPointDamage: 0 });
  });

  it("UT-R-SHD-02-009 (Q-SRV-01): beyond the functioning share only the excess reaches HP and only the functioning share is consumed", () => {
    // 無視50%・盾2000 → 機能分1000。1200のうち超過200だけがHPへ通り、盾は1000残る。
    const { updated, remainingOf, applied } = ignoringHit(0.5, 1200, [
      shieldEffect("SHIELD", "TARGET", 2000, null),
    ]);

    expect(updated.currentHp).toBe(9800);
    expect(remainingOf("SHIELD")).toBe(1000);
    expect(applied[0]).toMatchObject({
      calculatedDamage: 1200,
      untypedShieldAbsorbed: 1000,
      hitPointDamage: 200,
      // 無視がなければ盾が受け止めていた200。
      hpDirectDamage: 200,
    });
  });

  it("UT-R-SHD-02-010 (Q-SRV-01): 50% ignore, shield 2000, damage 1500 -> 500 to HP, shield 1000 left (U1 example)", () => {
    const { updated, remainingOf } = ignoringHit(0.5, 1500, [
      shieldEffect("SHIELD", "TARGET", 2000, null),
    ]);

    expect(updated.currentHp).toBe(9500);
    expect(remainingOf("SHIELD")).toBe(1000);
  });

  it("UT-R-SHD-02-011 (Q-SRV-01): each following hit applies the ignore rate again to the shield's remainder", () => {
    // 1ヒット目: 機能分1000 → 吸収1000・HP200・残1000。
    // 2ヒット目: 機能分500 → 吸収500・HP700・残500。
    const { updated, remainingOf, applied } = ignoringHit(
      0.5,
      1200,
      [shieldEffect("SHIELD", "TARGET", 2000, null)],
      2,
    );

    expect(applied.map((d) => [d["untypedShieldAbsorbed"], d["hitPointDamage"]])).toEqual([
      [1000, 200],
      [500, 700],
    ]);
    expect(updated.currentHp).toBe(9100);
    expect(remainingOf("SHIELD")).toBe(500);
  });

  it("UT-R-SHD-02-012 (Q-SRV-01): several shields of one type each apply the ignore rate on their own, oldest first", () => {
    // 盾1000＋1000・無視50%: 古い盾が機能分500を吸収し、残300を新しい盾が吸収する。
    const { updated, remainingOf, applied } = ignoringHit(0.5, 800, [
      shieldEffect("SHIELD_OLD", "TARGET", 1000, null),
      shieldEffect("SHIELD_NEW", "TARGET", 1000, null),
    ]);

    expect(updated.currentHp).toBe(10000);
    expect(remainingOf("SHIELD_OLD")).toBe(500);
    expect(remainingOf("SHIELD_NEW")).toBe(700);
    expect(applied[0]).toMatchObject({ untypedShieldAbsorbed: 800, hitPointDamage: 0 });
  });

  it("UT-R-SHD-02-013 (Q-SRV-01): the typed pool and then the untyped pool each use their functioning share before HP", () => {
    // 物理盾400（機能200）→ タイプなし盾400（機能200）→ 残り100がHPへ。
    const { updated, remainingOf, applied } = ignoringHit(0.5, 500, [
      shieldEffect("SHIELD_TYPED", "TARGET", 400, "PHYSICAL"),
      shieldEffect("SHIELD_UNTYPED", "TARGET", 400, null),
    ]);

    expect(updated.currentHp).toBe(9900);
    expect(remainingOf("SHIELD_TYPED")).toBe(200);
    expect(remainingOf("SHIELD_UNTYPED")).toBe(200);
    expect(applied[0]).toMatchObject({
      typedShieldAbsorbed: 200,
      untypedShieldAbsorbed: 200,
      hitPointDamage: 100,
      hpDirectDamage: 100,
    });
  });

  it("UT-R-SHD-02-014 (Q-SRV-01): the functioning share is truncated before absorption", () => {
    // 盾101・無視50% → 機能分 floor(50.5) = 50。60のうち10がHPへ、盾は51残る。
    const { updated, remainingOf } = ignoringHit(0.5, 60, [
      shieldEffect("SHIELD", "TARGET", 101, null),
    ]);

    expect(updated.currentHp).toBe(9990);
    expect(remainingOf("SHIELD")).toBe(51);
  });

  it("UT-R-SHD-02-015 (Q-SRV-01): a 0% ignore rate is the ordinary full-shield absorption", () => {
    const { updated, remainingOf, applied } = ignoringHit(0, 150, [
      shieldEffect("SHIELD", "TARGET", 100, null),
    ]);

    expect(updated.currentHp).toBe(9950);
    expect(remainingOf("SHIELD")).toBeUndefined();
    expect(applied[0]).toMatchObject({
      untypedShieldAbsorbed: 100,
      hitPointDamage: 50,
      hpDirectDamage: 0,
    });
  });

  it("UT-R-SHD-02-016 (Q-SRV-01): a 100% ignore rate leaves the shield untouched and records no ShieldConsumed", () => {
    const { updated, remainingOf, applied, events } = ignoringHit(1, 150, [
      shieldEffect("SHIELD", "TARGET", 100, null),
    ]);

    expect(updated.currentHp).toBe(9850);
    expect(remainingOf("SHIELD")).toBe(100);
    expect(events.some((e) => e.eventType === "ShieldConsumed")).toBe(false);
    expect(applied[0]).toMatchObject({
      untypedShieldAbsorbed: 0,
      hitPointDamage: 150,
      hpDirectDamage: 100,
    });
  });

  it("UT-R-DMG-03-024 (TEMP_PIERCING_GRANT, DMG-003): an APPLY_PIERCING_MOD the attacker holds reaches the confirmed calculation, not only the DamageWillBeApplied snapshot", () => {
    const context = damageEventContext();
    // 一時貫通の保持者。定義自身の`payload.piercing`はすべて0のため、実効防御が
    // 下がったならそれは合成された一時貫通が確定計算まで届いた証拠にしかならない。
    const grantId = createEffectActionDefinitionId("ACT_TEMP_PIERCE");
    const bareAttacker = unit("ATTACKER", "ALLY", { attack: 200 });
    const attacker: BattleUnit = {
      ...bareAttacker,
      appliedEffects: [
        {
          effectInstanceId: createEffectInstanceId("TEMP_PIERCE"),
          effectActionDefinitionId: grantId,
          kindKey: effectKindKeyFromDefinitionId(grantId),
          duplicate: true,
          targetUnitId: bareAttacker.battleUnitId,
          magnitude: 0,
          categories: ["BUFF"],
          piercing: {
            defenseIgnoreRate: 0.5,
            shieldIgnoreRate: 0,
            damageReductionIgnoreRate: 0,
          },
          duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
          appliedTurnNumber: 1,
        },
      ],
    };
    const target = unit("TARGET", "ENEMY", { defense: 100 });

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    // R-DMG-05の順序どおり `DamageWillBeApplied`（snapshot）→ `DamageCalculated`
    // （確定値）。両方が合成後の率を持つことを要求する — 前者だけに現れて
    // 実計算が静的値のまま、という不整合を許さない。
    const willBeApplied = context.recorder
      .getEvents()
      .find((e) => e.eventType === "DamageWillBeApplied")!;
    expect(willBeApplied.payload).toMatchObject({ defenseIgnoreRate: 0.5 });
    const calculated = context.recorder
      .getEvents()
      .find((e) => e.eventType === "DamageCalculated")!;
    expect(calculated.payload).toMatchObject({
      defenseIgnoreRate: 0.5,
      defenderDefense: 100,
      effectiveDefense: 50,
    });
  });

  it("UT-R-SHD-01-005: expires a shield instance whose remaining amount reaches zero", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 40 });
    const target = shieldedTarget([shieldEffect("SHIELD_UNTYPED", "TARGET", 10, null)]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    // `context.expireDepletedShields`未注入のfallbackでも、枯渇したインスタンスは除去される。
    const updated = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
    expect(updated.appliedEffects).toEqual([]);
    const expired = context.recorder.getEvents().find((e) => e.eventType === "EffectExpired")!;
    expect(expired.payload).toMatchObject({
      effectInstanceId: createEffectInstanceId("SHIELD_UNTYPED"),
      reason: "SHIELD_DEPLETED",
    });
  });

  it("UT-R-SKL-03-003 (R-SKL-03「ヒットごとに命中判定・会心判定・シールド・HP適用を解決する」): each hit of a multi-hit action resolves shield absorption on its own, draining the pool progressively", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    // finalDamage = 30 - 10 = 20 per hit, shield 50 -> 20 / 20 / 10 absorbed.
    const target = shieldedTarget([shieldEffect("SHIELD_UNTYPED", "TARGET", 50, null)]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1), hit("TARGET", 2), hit("TARGET", 3)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    expect(result.hits.map((outcome) => outcome.applied)).toEqual([true, true, true]);
    const consumed = context.recorder
      .getEvents()
      .filter((event) => event.eventType === "ShieldConsumed");
    expect(consumed.map((event) => (event.payload as { absorbed: number }).absorbed)).toEqual([
      20, 20, 10,
    ]);
    const updated = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
    // 3ヒット目でシールドを使い切り、超過分の10だけがHPへ通る。
    expect(updated.currentHp).toBe(90);
    expect(updated.appliedEffects).toEqual([]);
  });

  it("UT-R-SHD-02-007 (PR): resolves each pool completely (ShieldConsumed -> chain -> depletion expiry) before touching the next pool or HP", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 60 });
    // finalDamage = 60 - 10 = 50。typed 20 → untyped 20 → HP 10。
    const target = shieldedTarget([
      shieldEffect("SHIELD_TYPED", "TARGET", 20, "PHYSICAL"),
      shieldEffect("SHIELD_UNTYPED", "TARGET", 20, null),
    ]);

    // 各FACT通知の時点で観測できる対象の状態を記録する。
    const observed: {
      readonly event: string;
      readonly shieldType?: unknown;
      readonly pools: { physical: number; energy: number; untyped: number };
      readonly hp: number;
    }[] = [];
    const contextWithHook: DamageEventContext = {
      ...context,
      onFactEventForPassiveChain: (event, units) => {
        const current = units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
        observed.push({
          event: event.eventType,
          ...(event.eventType === "ShieldConsumed"
            ? { shieldType: (event.payload as { shieldType: unknown }).shieldType }
            : {}),
          pools: shieldPoolsOf(current.appliedEffects),
          hp: current.currentHp,
        });
        return units;
      },
    };

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      contextWithHook,
    );

    const shieldEvents = observed.filter((entry) => entry.event === "ShieldConsumed");
    expect(shieldEvents.map((entry) => entry.shieldType)).toEqual(["PHYSICAL", null]);
    // タイプありプールの`ShieldConsumed`時点では、タイプなしプールもHPもまだ手つかず。
    expect(shieldEvents[0]).toMatchObject({
      pools: { physical: 0, energy: 0, untyped: 20 },
      hp: 100,
    });
    // タイプなしプールの`ShieldConsumed`時点でもHPはまだ手つかず。
    expect(shieldEvents[1]).toMatchObject({
      pools: { physical: 0, energy: 0, untyped: 0 },
      hp: 100,
    });

    // 枯渇インスタンスの`EffectExpired`は、`DamageApplied`より前に届く —
    // `DamageApplied`に反応するPSが残量0のシールドを有効として観測しないため。
    const order = observed.map((entry) => entry.event);
    const lastExpired = order.lastIndexOf("EffectExpired");
    expect(lastExpired).toBeGreaterThanOrEqual(0);
    expect(lastExpired).toBeLessThan(order.indexOf("HitPointReduced"));
    expect(order.indexOf("HitPointReduced")).toBeLessThan(order.indexOf("DamageApplied"));
    // `DamageApplied`の時点では、枯渇した2インスタンスが既に除去されている。
    const atDamageApplied = observed.find((entry) => entry.event === "DamageApplied")!;
    expect(atDamageApplied.pools).toEqual({ physical: 0, energy: 0, untyped: 0 });
  });

  it("UT-R-SHD-01-013 (PR): ShieldConsumed reports the whole pool total, not just the instances this hit touched", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 15 });
    // finalDamage = 15 - 10 = 5。タイプなしプールは 10 + 50 = 60 のうち5だけ減る。
    const target = shieldedTarget([
      shieldEffect("SHIELD_A", "TARGET", 10, null),
      shieldEffect("SHIELD_B", "TARGET", 50, null),
    ]);

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    const consumed = context.recorder.getEvents().find((e) => e.eventType === "ShieldConsumed")!;
    expect(consumed.payload).toMatchObject({
      shieldType: null,
      before: 60,
      after: 55,
      absorbed: 5,
    });
  });

  it("UT-R-SHD-01-006: keeps events and state unchanged for a target that holds no shield", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 40 });
    const target = unit("TARGET", "ENEMY");

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    expect(context.recorder.getEvents().some((e) => e.eventType === "ShieldConsumed")).toBe(false);
    const applied = context.recorder.getEvents().find((e) => e.eventType === "DamageApplied")!;
    expect(applied.payload).toMatchObject({
      typedShieldAbsorbed: 0,
      untypedShieldAbsorbed: 0,
      hitPointDamage: 30,
      discardedDamage: 0,
    });
  });
});

/**
 * R-SHD-03の保存則（`12_テスト戦略.md`「SHD: Unit／Property」）。任意のダメージ・
 * `shieldIgnoreRate`・複数のタイプあり／なしプール・HPについて、適用先ごとの内訳が
 * 計算ダメージを過不足なく説明することを確かめる（`08_ドメインイベント.md`の
 * 不変条件#6）。`DamageApplied`のpayloadを正本にするのは、これが外部公開契約
 * そのものであり、内部の中間値ではないためである。
 */
describe("shield absorption conservation properties (R-SHD-03)", () => {
  const shieldArb = fc.record({
    amount: fc.integer({ min: 1, max: 200 }),
    shieldType: fc.constantFrom("PHYSICAL" as const, "EN" as const, null),
  });

  it("PROP-SHD-03-001 [R-SHD-03]: typedShieldAbsorbed + untypedShieldAbsorbed + hitPointDamage + discardedDamage === calculatedDamage", () => {
    fc.assert(
      fc.property(
        fc.record({
          attack: fc.integer({ min: 11, max: 400 }),
          maximumHp: fc.integer({ min: 1, max: 300 }),
          shieldIgnoreRate: fc.constantFrom(0, 0.25, 0.3, 0.5, 0.75, 1),
          damageType: fc.constantFrom("PHYSICAL" as const, "EN" as const),
          shields: fc.array(shieldArb, { minLength: 0, maxLength: 5 }),
        }),
        (scenario) => {
          const context = damageEventContext();
          const attacker = unit("ATTACKER", "ALLY", { attack: scenario.attack });
          const base = unit("TARGET", "ENEMY", {
            defense: 10,
            maximumHp: scenario.maximumHp,
          });
          const target: BattleUnit = {
            ...base,
            appliedEffects: scenario.shields.map((shield, index) => {
              const definitionId = createEffectActionDefinitionId(`ACT_SHIELD_${index}`);
              return {
                effectInstanceId: createEffectInstanceId(`SHIELD_${index}`),
                effectActionDefinitionId: definitionId,
                kindKey: effectKindKeyFromDefinitionId(definitionId),
                duplicate: true,
                targetUnitId: createBattleUnitId("TARGET"),
                magnitude: shield.amount,
                categories: ["SHIELD"],
                shield: { shieldType: shield.shieldType, remaining: shield.amount },
                duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
                appliedTurnNumber: 1,
              } satisfies AppliedEffect;
            }),
          };
          const action = damageAction("PREVENTED");
          const piercingAction = {
            ...action,
            payload: {
              ...action.payload,
              damageType: scenario.damageType,
              piercing: {
                defenseIgnoreRate: 0,
                shieldIgnoreRate: scenario.shieldIgnoreRate,
                damageReductionIgnoreRate: 0,
              },
            },
          };

          applyDamageAction(
            attacker,
            [hit("TARGET", 1)],
            piercingAction,
            [attacker, target],
            new SequenceRandomSource([]),
            context,
          );

          const applied = context.recorder.getEvents().find((e) => e.eventType === "DamageApplied");
          if (applied === undefined) {
            return false;
          }
          const d = applied.payload as unknown as Record<string, number>;
          return (
            d["typedShieldAbsorbed"]! +
              d["untypedShieldAbsorbed"]! +
              d["hitPointDamage"]! +
              d["discardedDamage"]! ===
              d["calculatedDamage"] &&
            // 各項は非負であり、HPは0未満にならない（R-SHD-03第2項）。
            d["typedShieldAbsorbed"]! >= 0 &&
            d["untypedShieldAbsorbed"]! >= 0 &&
            d["hitPointDamage"]! >= 0 &&
            d["discardedDamage"]! >= 0 &&
            d["hpAfter"]! >= 0 &&
            // `hpDirectDamage`は`hitPointDamage`の内訳ではあるが、HPが尽きた場合は
            // 破棄分に飲まれるため上限だけを課す。
            d["hpDirectDamage"]! <= d["calculatedDamage"]
          );
        },
      ),
      PROPERTY_ASSERT_CONFIG,
    );
  });

  it("PROP-SHD-03-002 [R-SHD-03]: each matching shield absorbs up to its functioning share (Q-SRV-01), oldest first, typed before untyped", () => {
    fc.assert(
      fc.property(
        fc.record({
          attack: fc.integer({ min: 11, max: 400 }),
          shieldIgnoreRate: fc.constantFrom(0, 0.25, 0.5, 1),
          damageType: fc.constantFrom("PHYSICAL" as const, "EN" as const),
          typedAmount: fc.integer({ min: 0, max: 200 }),
          untypedAmount: fc.integer({ min: 0, max: 200 }),
          offTypeAmount: fc.integer({ min: 0, max: 200 }),
        }),
        (scenario) => {
          const context = damageEventContext();
          const attacker = unit("ATTACKER", "ALLY", { attack: scenario.attack });
          const offType = scenario.damageType === "PHYSICAL" ? "EN" : "PHYSICAL";
          const pools: readonly { amount: number; shieldType: "PHYSICAL" | "EN" | null }[] = [
            { amount: scenario.typedAmount, shieldType: scenario.damageType },
            { amount: scenario.untypedAmount, shieldType: null },
            { amount: scenario.offTypeAmount, shieldType: offType },
          ];
          const base = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 10000 });
          const target: BattleUnit = {
            ...base,
            appliedEffects: pools
              .filter((pool) => pool.amount > 0)
              .map((pool, index) => {
                const definitionId = createEffectActionDefinitionId(`ACT_SHIELD_${index}`);
                return {
                  effectInstanceId: createEffectInstanceId(`SHIELD_${index}`),
                  effectActionDefinitionId: definitionId,
                  kindKey: effectKindKeyFromDefinitionId(definitionId),
                  duplicate: true,
                  targetUnitId: createBattleUnitId("TARGET"),
                  magnitude: pool.amount,
                  categories: ["SHIELD"],
                  shield: { shieldType: pool.shieldType, remaining: pool.amount },
                  duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
                  appliedTurnNumber: 1,
                } satisfies AppliedEffect;
              }),
          };
          const action = damageAction("PREVENTED");
          const piercingAction = {
            ...action,
            payload: {
              ...action.payload,
              damageType: scenario.damageType,
              piercing: {
                defenseIgnoreRate: 0,
                shieldIgnoreRate: scenario.shieldIgnoreRate,
                damageReductionIgnoreRate: 0,
              },
            },
          };

          const result = applyDamageAction(
            attacker,
            [hit("TARGET", 1)],
            piercingAction,
            [attacker, target],
            new SequenceRandomSource([]),
            context,
          );

          const applied = context.recorder.getEvents().find((e) => e.eventType === "DamageApplied");
          if (applied === undefined) {
            return false;
          }
          const d = applied.payload as unknown as Record<string, number>;
          const finalDamage = d["calculatedDamage"]!;
          // 各盾は1枚ずつ「切り捨て(残量 × (1 − 無視率))」までしか受け止めない。
          const functioning = (amount: number) =>
            Math.trunc(amount * (1 - scenario.shieldIgnoreRate));
          const expectedTyped = Math.min(functioning(scenario.typedAmount), finalDamage);
          const expectedUntyped = Math.min(
            functioning(scenario.untypedAmount),
            finalDamage - expectedTyped,
          );
          const toHitPoints = finalDamage - expectedTyped - expectedUntyped;
          // 無視がなければ受け止められていた量。
          const bypassed = Math.min(
            toHitPoints,
            scenario.typedAmount + scenario.untypedAmount - expectedTyped - expectedUntyped,
          );
          const updated = result.units.find(
            (u) => u.battleUnitId === createBattleUnitId("TARGET"),
          )!;
          return (
            d["hpDirectDamage"] === bypassed &&
            d["typedShieldAbsorbed"] === expectedTyped &&
            d["untypedShieldAbsorbed"] === expectedUntyped &&
            // R-SHD-02末尾: 対応しないタイプありシールドは常に無傷。
            (scenario.damageType === "PHYSICAL"
              ? shieldPoolsOf(updated.appliedEffects).energy
              : shieldPoolsOf(updated.appliedEffects).physical) === scenario.offTypeAmount
          );
        },
      ),
      PROPERTY_ASSERT_CONFIG,
    );
  });
});
