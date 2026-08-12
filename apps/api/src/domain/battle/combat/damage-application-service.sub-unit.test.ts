import { describe, expect, it } from "vitest";
import { applyDamageAction, type DamageEventContext } from "./damage-application-service.js";
import type { BattleUnit } from "../model/battle-unit.js";
import {
  effectKindKeyFromDefinitionId,
  SUBUNIT_PROVIDER_ATTACK_KEY,
  type AppliedEffect,
} from "../model/applied-effect.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import { createHitPoint } from "../model/resource-gauge.js";
import { createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  type EffectActionDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import {
  unit,
  damageAction,
  hitCountEvasionEffect,
  hit,
  damageEventContext,
  STAT_MOD_DEFINITION_ID,
  statModDefinition,
  consumptionEffect,
  testConsumeEffectDuration,
} from "../../../testing/fixtures/damage-application.js";

/**
 * R-SUB-01/R-SUB-02（DMG-005）: サブユニットの吸収と追加ダメージを、
 * `applyDamageAction`のヒット処理を通して固定する。シールドと同じ入力・同じ
 * 事前条件（`damageEventContext`はhookを注入しないため、失効はfallback経路を通る）。
 */
describe("applyDamageAction sub-units (R-SUB-01/R-SUB-02)", () => {
  const ADDITIONAL_DAMAGE = {
    formula: {
      kind: "SUBUNIT_ADDITIONAL_DAMAGE",
      ownerAttack: "CURRENT_ATTACK",
      providerAttack: "SOURCE_SNAPSHOT_ATTACK",
      skillMultiplier: 0.5,
      targetDefense: "TARGET_CURRENT_DEFENSE",
    },
  } as const;

  function subUnitEffect(
    id: string,
    holderId: string,
    durability: number,
    overrides: {
      readonly providerAttack?: number;
      readonly damageType?: "PHYSICAL" | "EN";
      readonly debuffId?: string;
    } = {},
  ): AppliedEffect {
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
          ...ADDITIONAL_DAMAGE,
          ...(overrides.damageType !== undefined ? { damageType: overrides.damageType } : {}),
          ...(overrides.debuffId !== undefined
            ? {
                debuff: {
                  effectActionDefinitionId: createEffectActionDefinitionId(overrides.debuffId),
                },
              }
            : {}),
        },
      },
      snapshot: { [SUBUNIT_PROVIDER_ATTACK_KEY]: overrides.providerAttack ?? 0 },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
  }

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

  function targetWith(effects: readonly AppliedEffect[], id = "TARGET"): BattleUnit {
    const target = unit(id, "ENEMY", { defense: 10 });
    return { ...target, appliedEffects: effects };
  }

  it("UT-R-SUB-01-008 (R-SUB-01第1項): applies damage to the subunit only after every normal shield is spent", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 60 });
    // finalDamage = 60 - 10 = 50。タイプあり20 → タイプなし5 → サブユニット10 → HP15。
    const target = targetWith([
      shieldEffect("SHIELD_TYPED", "TARGET", 20, "PHYSICAL"),
      shieldEffect("SHIELD_UNTYPED", "TARGET", 5, null),
      subUnitEffect("SUB_1", "TARGET", 10),
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
    expect(updated.currentHp).toBe(85);
    const applied = context.recorder.getEvents().find((e) => e.eventType === "DamageApplied")!;
    expect(applied.payload).toMatchObject({
      typedShieldAbsorbed: 20,
      untypedShieldAbsorbed: 5,
      subUnitAbsorbed: 10,
      hitPointDamage: 15,
      discardedDamage: 0,
      calculatedDamage: 50,
    });
    // 吸収は`ShieldConsumed`（プール単位）→`SubUnitDamaged`（インスタンス単位）の順。
    const order = context.recorder
      .getEvents()
      .filter((e) => e.eventType === "ShieldConsumed" || e.eventType === "SubUnitDamaged")
      .map((e) => e.eventType);
    expect(order).toEqual(["ShieldConsumed", "ShieldConsumed", "SubUnitDamaged"]);
  });

  it("UT-R-SUB-01-009 (R-SUB-01): reduces one subunit instance at a time in grant order, emitting SubUnitDamaged per instance", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 60 });
    // finalDamage = 50。SUB_1(10) → SUB_2(15) → HP25。
    const target = targetWith([
      subUnitEffect("SUB_1", "TARGET", 10),
      subUnitEffect("SUB_2", "TARGET", 15),
    ]);

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    const damaged = context.recorder.getEvents().filter((e) => e.eventType === "SubUnitDamaged");
    expect(
      damaged.map((e) => e.payload as { effectInstanceId: string; absorbed: number }),
    ).toMatchObject([
      { effectInstanceId: createEffectInstanceId("SUB_1"), absorbed: 10 },
      { effectInstanceId: createEffectInstanceId("SUB_2"), absorbed: 15 },
    ]);
    const updated = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
    expect(updated.currentHp).toBe(75);
    // 両方とも耐久力を使い切ったので`SUBUNIT_DEPLETED`で失効している。
    expect(updated.appliedEffects).toEqual([]);
    const expired = context.recorder.getEvents().filter((e) => e.eventType === "EffectExpired");
    expect(expired.map((e) => (e.payload as { reason: string }).reason)).toEqual([
      "SUBUNIT_DEPLETED",
      "SUBUNIT_DEPLETED",
    ]);
  });

  it("UT-R-SUB-01-010 (R-SUB-01「シールド無視の対象とする」): shieldIgnoreRate bypasses the subunit as well as the shields", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 50 });
    // finalDamage = 40。shieldIgnoreRate 0.5 → 20はHPへ直行、残り20をサブユニットが吸収。
    const target = targetWith([subUnitEffect("SUB_1", "TARGET", 100)]);
    const action = damageAction("PREVENTED");
    const piercingAction = {
      ...action,
      payload: {
        ...action.payload,
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0.5, damageReductionIgnoreRate: 0 },
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

    const updated = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
    expect(updated.currentHp).toBe(80);
    expect(updated.appliedEffects[0]!.subUnit!.durability).toBe(80);
    const applied = context.recorder.getEvents().find((e) => e.eventType === "DamageApplied")!;
    expect(applied.payload).toMatchObject({
      hpDirectDamage: 20,
      subUnitAbsorbed: 20,
      hitPointDamage: 20,
    });
  });

  it("UT-R-SUB-02-005 (R-SUB-02第1項): adds exactly one additional-damage hit per attacked target, not per hit", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const attackerWithSubUnit: BattleUnit = {
      ...attacker,
      appliedEffects: [subUnitEffect("SUB_1", "ATTACKER", 50, { providerAttack: 100 })],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });

    applyDamageAction(
      attackerWithSubUnit,
      [hit("TARGET", 1), hit("TARGET", 2), hit("TARGET", 3)],
      damageAction("PREVENTED"),
      [attackerWithSubUnit, target],
      new SequenceRandomSource([]),
      context,
    );

    const additional = context.recorder
      .getEvents()
      .filter(
        (event) =>
          event.eventType === "DamageApplied" &&
          (event.payload as { effectActionDefinitionId: string }).effectActionDefinitionId ===
            createEffectActionDefinitionId("ACT_SUBUNIT_SUB_1"),
      );
    // 3ヒットの単体攻撃でも追加ダメージは1回だけ。
    expect(additional).toHaveLength(1);
    // R-SUB-02: 所持者の現在攻撃力30 + 付与者の付与時攻撃力100 × 0.5 - 対象の防御力10 = 70。
    expect(additional[0]!.payload).toMatchObject({ calculatedDamage: 70, hitPointDamage: 70 });
  });

  it("UT-R-SUB-02-006 (R-SUB-02第2項): adds one additional-damage hit to each target of a multi-target attack, once per held subunit", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const attackerWithSubUnits: BattleUnit = {
      ...attacker,
      appliedEffects: [
        subUnitEffect("SUB_1", "ATTACKER", 50, { providerAttack: 100 }),
        subUnitEffect("SUB_2", "ATTACKER", 50, { providerAttack: 100 }),
      ],
    };
    const targetA = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });
    const targetB = unit("TARGET_2", "ENEMY", { defense: 10, maximumHp: 1000 });

    applyDamageAction(
      attackerWithSubUnits,
      [hit("TARGET", 1), hit("TARGET_2", 2)],
      damageAction("PREVENTED"),
      [attackerWithSubUnits, targetA, targetB],
      new SequenceRandomSource([]),
      context,
    );

    const additional = context.recorder
      .getEvents()
      .filter(
        (event) =>
          event.eventType === "DamageApplied" &&
          String(
            (event.payload as { effectActionDefinitionId: string }).effectActionDefinitionId,
          ).startsWith("ACT_SUBUNIT_"),
      );
    // 対象2体 × サブユニット2体 = 4ヒット。対象ごとにまとまり、`hitIndex`は通し番号。
    expect(
      additional.map((event) => ({
        target: (event.payload as { targetUnitId: string }).targetUnitId,
        hitIndex: (event.payload as { hitIndex: number }).hitIndex,
      })),
    ).toEqual([
      { target: createBattleUnitId("TARGET"), hitIndex: 0 },
      { target: createBattleUnitId("TARGET"), hitIndex: 1 },
      { target: createBattleUnitId("TARGET_2"), hitIndex: 2 },
      { target: createBattleUnitId("TARGET_2"), hitIndex: 3 },
    ]);
  });

  it("UT-R-SUB-02-007 (R-SUB-02末尾): the additional damage skips the normal defense attenuation and keeps the minimum of 1", () => {
    const context = damageEventContext();
    // 所持者の攻撃力10 + 付与者0 × 0.5 - 対象の防御力1000 は負値 → 最低1ダメージ。
    const attacker = unit("ATTACKER", "ALLY", { attack: 10 });
    const attackerWithSubUnit: BattleUnit = {
      ...attacker,
      appliedEffects: [subUnitEffect("SUB_1", "ATTACKER", 50, { providerAttack: 0 })],
    };
    const target = unit("TARGET", "ENEMY", { defense: 1000, maximumHp: 1000 });

    applyDamageAction(
      attackerWithSubUnit,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attackerWithSubUnit, target],
      new SequenceRandomSource([]),
      context,
    );

    const calculated = context.recorder
      .getEvents()
      .filter(
        (event) =>
          event.eventType === "DamageCalculated" &&
          (event.payload as { effectActionDefinitionId: string }).effectActionDefinitionId ===
            createEffectActionDefinitionId("ACT_SUBUNIT_SUB_1"),
      );
    expect(calculated).toHaveLength(1);
    expect(calculated[0]!.payload).toMatchObject({
      // 防御力減衰（実効防御）を経ず、対象の現在防御力をそのまま引く。
      effectiveDefense: 1000,
      defenseIgnoreRate: 0,
      attributeMultiplier: 1,
      criticalMultiplier: 1,
      finalDamage: 1,
    });
  });

  it("UT-R-SUB-02-008 (R-SUB-02第3項): applies the accompanying debuff through the injected hook, once per additional-damage hit", () => {
    const granted: { targetUnitId: string; debuffId: string; ownerUnitId: string }[] = [];
    const context: DamageEventContext = {
      ...damageEventContext(),
      grantSubUnitAdditionalDamageDebuff: function* (
        targetUnitId,
        debuffEffectActionDefinitionId,
        ownerUnitId,
        units,
        parentEventId,
      ) {
        granted.push({
          targetUnitId,
          debuffId: debuffEffectActionDefinitionId,
          ownerUnitId,
        });
        // production hook（`grantSubUnitAdditionalDamageDebuffSteps`）と同じく、
        // 付与を1ステップとして`yield`し、driverが更新した`units`を返す。
        const injected = yield { events: [], units };
        return { units: injected ?? units, lastEventId: parentEventId };
      },
    };
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const attackerWithSubUnit: BattleUnit = {
      ...attacker,
      appliedEffects: [
        subUnitEffect("SUB_1", "ATTACKER", 50, {
          providerAttack: 100,
          debuffId: "ACT_SPEED_DOWN",
        }),
      ],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });

    applyDamageAction(
      attackerWithSubUnit,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attackerWithSubUnit, target],
      new SequenceRandomSource([]),
      context,
    );

    expect(granted).toEqual([
      {
        targetUnitId: createBattleUnitId("TARGET"),
        debuffId: createEffectActionDefinitionId("ACT_SPEED_DOWN"),
        ownerUnitId: createBattleUnitId("ATTACKER"),
      },
    ]);
  });

  it("UT-R-SUB-02-009 (R-SKL-01/R-SKL-03): skips the additional damage entirely when the attacker was defeated mid-attack", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 30, maximumHp: 100 });
    const defeatedAttacker: BattleUnit = {
      ...attacker,
      currentHp: createHitPoint(0, attacker.combatStats.maximumHp),
      appliedEffects: [subUnitEffect("SUB_1", "ATTACKER", 50, { providerAttack: 100 })],
    };
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });

    const result = applyDamageAction(
      defeatedAttacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [defeatedAttacker, target],
      new SequenceRandomSource([]),
      context,
    );

    expect(result.interruptedCount).toBe(1);
    expect(context.recorder.getEvents().filter((e) => e.eventType === "DamageApplied")).toEqual([]);
  });
});

/**
 * （DMG-005）: サブユニット追加ダメージが
 * R-SUB-02・raw原文（`戦闘システム.md`「サブユニットが攻撃に対して追加するダメージは
 * １ヒットとして扱われます」）どおり**1ヒット**として観測されること、および吸収の
 * 途中でPS/Memory連鎖が前提を崩した場合にR-SKL-01/R-SKL-03の中断契約が働くことを固定する。
 */
describe("sub-unit additional damage is a real hit (R-SUB-02 / R-SKL-03)", () => {
  const ADDITIONAL_DAMAGE = {
    formula: {
      kind: "SUBUNIT_ADDITIONAL_DAMAGE",
      ownerAttack: "CURRENT_ATTACK",
      providerAttack: "SOURCE_SNAPSHOT_ATTACK",
      skillMultiplier: 0.5,
      targetDefense: "TARGET_CURRENT_DEFENSE",
    },
  } as const;

  const SUBUNIT_DEFINITION_ID = createEffectActionDefinitionId("ACT_SUBUNIT_SUB_1");

  function subUnitEffect(holderId: string, durability = 50, providerAttack = 100): AppliedEffect {
    return {
      effectInstanceId: createEffectInstanceId("SUB_1"),
      effectActionDefinitionId: SUBUNIT_DEFINITION_ID,
      kindKey: effectKindKeyFromDefinitionId(SUBUNIT_DEFINITION_ID),
      duplicate: true,
      targetUnitId: createBattleUnitId(holderId),
      magnitude: durability,
      categories: ["SUBUNIT"],
      subUnit: { durability, additionalDamage: ADDITIONAL_DAMAGE },
      snapshot: { [SUBUNIT_PROVIDER_ATTACK_KEY]: providerAttack },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
  }

  function attackerHoldingSubUnit(extra: readonly AppliedEffect[] = []): BattleUnit {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    return { ...attacker, appliedEffects: [subUnitEffect("ATTACKER"), ...extra] };
  }

  /**
   * サブユニット追加ヒットが発行したイベントだけを、発生順の種別列として取り出す。
   * `CriticalCheckResolved`のpayloadは`effectActionDefinitionId`を持たない
   * （`08_ドメインイベント.md`「会心判定イベント」）ため、直前の`HitConfirmed`が
   * 追加ヒットのものだった場合に追加ヒット側として数える。
   */
  function additionalHitEventTypes(context: DamageEventContext): readonly string[] {
    const types: string[] = [];
    let lastWasAdditionalHitConfirmed = false;
    for (const event of context.recorder.getEvents()) {
      const payload = event.payload as { effectActionDefinitionId?: string };
      const isAdditional = payload.effectActionDefinitionId === SUBUNIT_DEFINITION_ID;
      if (event.eventType === "CriticalCheckResolved") {
        if (lastWasAdditionalHitConfirmed) {
          types.push(event.eventType);
        }
        continue;
      }
      if (isAdditional) {
        types.push(event.eventType);
      }
      lastWasAdditionalHitConfirmed = isAdditional && event.eventType === "HitConfirmed";
    }
    return types;
  }

  it("UT-R-SUB-02-010 (R-SKL-03): the additional damage emits the same hit observation events as any other hit", () => {
    const context = damageEventContext();
    const attacker = attackerHoldingSubUnit();
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    expect(additionalHitEventTypes(context)).toEqual([
      "UnitBeingAttacked",
      "HitConfirmed",
      "CriticalCheckResolved",
      "DamageWillBeApplied",
      "DamageCalculated",
      "HitPointReduced",
      "DamageApplied",
    ]);
  });

  it("UT-R-SUB-02-011 (R-EFF-07): the additional hit consumes OUTGOING_HIT on the owner and INCOMING_HIT on the target", () => {
    const recorderContext = damageEventContext();
    const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [STAT_MOD_DEFINITION_ID, statModDefinition()],
    ]);
    const withHooks: DamageEventContext = {
      ...recorderContext,
      consumeEffectDuration: testConsumeEffectDuration(recorderContext.recorder, effectActions),
    };

    const outgoing = consumptionEffect(
      "eff-outgoing",
      createBattleUnitId("ATTACKER"),
      "OUTGOING_HIT",
      2,
    );
    const attacker = attackerHoldingSubUnit([outgoing]);
    const incoming = consumptionEffect(
      "eff-incoming",
      createBattleUnitId("TARGET"),
      "INCOMING_HIT",
      2,
    );
    const baseTarget = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });
    const target: BattleUnit = { ...baseTarget, appliedEffects: [incoming] };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      withHooks,
    );

    // 通常ヒット1回＋追加ダメージ1ヒット＝どちらの消費条件も2回消費して0になる。
    const updatedAttacker = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("ATTACKER"),
    )!;
    const updatedTarget = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("TARGET"),
    )!;
    expect(
      updatedAttacker.appliedEffects.find((e) => e.effectInstanceId === outgoing.effectInstanceId),
    ).toBeUndefined();
    expect(
      updatedTarget.appliedEffects.find((e) => e.effectInstanceId === incoming.effectInstanceId),
    ).toBeUndefined();
  });

  it("UT-R-SUB-02-012 (R-HIT-04): an N-hit evasion can evade the additional hit, consuming only the evading instance", () => {
    const recorderContext = damageEventContext();
    const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [STAT_MOD_DEFINITION_ID, statModDefinition()],
    ]);
    const context: DamageEventContext = {
      ...recorderContext,
      consumeEffectDuration: testConsumeEffectDuration(recorderContext.recorder, effectActions),
    };
    const attacker = attackerHoldingSubUnit();
    // 残り1回のNヒット回避: 通常ヒットで使い切り、追加ヒットは命中する。
    const evasion = hitCountEvasionEffect("eff-evasion", "TARGET", "HIT_EVASION", 1);
    const baseTarget = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });
    const target: BattleUnit = { ...baseTarget, appliedEffects: [evasion] };

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    // 通常ヒットが回避され、追加ヒットは（回避を使い切ったので）命中する。
    const evaded = context.recorder.getEvents().filter((e) => e.eventType === "EvasionActivated");
    expect(evaded).toHaveLength(1);
    expect(additionalHitEventTypes(context)).toContain("HitConfirmed");
    expect(additionalHitEventTypes(context)).toContain("DamageApplied");
  });

  it("UT-R-SUB-02-013 (R-HIT-04): the additional hit itself is evadable, producing no additional damage", () => {
    const recorderContext = damageEventContext();
    const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [STAT_MOD_DEFINITION_ID, statModDefinition()],
    ]);
    const context: DamageEventContext = {
      ...recorderContext,
      consumeEffectDuration: testConsumeEffectDuration(recorderContext.recorder, effectActions),
    };
    const attacker = attackerHoldingSubUnit();
    // 残り2回: 通常ヒットと追加ヒットの両方を回避する。
    const evasion = hitCountEvasionEffect("eff-evasion", "TARGET", "HIT_EVASION", 2);
    const baseTarget = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });
    const target: BattleUnit = { ...baseTarget, appliedEffects: [evasion] };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    expect(
      context.recorder.getEvents().filter((e) => e.eventType === "EvasionActivated"),
    ).toHaveLength(2);
    expect(additionalHitEventTypes(context)).toEqual(["UnitBeingAttacked"]);
    // 追加ダメージが回避されたので対象のHPは無傷。
    const updatedTarget = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("TARGET"),
    )!;
    expect(updatedTarget.currentHp).toBe(1000);
  });

  it("UT-R-SUB-02-014 (R-DMG-04): the additional damage applies the same damage modifiers it advertises in DamageWillBeApplied", () => {
    const context = damageEventContext();
    const attacker = attackerHoldingSubUnit();
    const baseTarget = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });
    // 被ダメージ-50%のデバフ（R-DMG-04、`direction: INCOMING`）を対象へ持たせる。
    const incomingHalf: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("DMG_MOD"),
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_DMG_MOD"),
      kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId("ACT_DMG_MOD")),
      duplicate: true,
      targetUnitId: createBattleUnitId("TARGET"),
      magnitude: -0.5,
      categories: ["DAMAGE_MOD"],
      damageModifier: { direction: "INCOMING", damageType: null },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
    const target: BattleUnit = { ...baseTarget, appliedEffects: [incomingHalf] };

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    const additionalCalculated = context.recorder
      .getEvents()
      .filter(
        (event) =>
          event.eventType === "DamageCalculated" &&
          (event.payload as { effectActionDefinitionId: string }).effectActionDefinitionId ===
            SUBUNIT_DEFINITION_ID,
      );
    expect(additionalCalculated).toHaveLength(1);
    // 所持者30 + 付与者100×0.5 - 防御10 = 70、被ダメージ-50%で 35。
    expect(additionalCalculated[0]!.payload).toMatchObject({
      skillPower: 70,
      incomingDamageMultiplier: 0.5,
      outgoingDamageMultiplier: 1,
      preTruncationDamage: 35,
      finalDamage: 35,
    });

    // 公開イベントの整合: `DamageWillBeApplied`のsnapshotと確定値が一致する。
    const additionalWillBeApplied = context.recorder
      .getEvents()
      .filter(
        (event) =>
          event.eventType === "DamageWillBeApplied" &&
          (event.payload as { effectActionDefinitionId: string }).effectActionDefinitionId ===
            SUBUNIT_DEFINITION_ID,
      );
    expect(additionalWillBeApplied[0]!.payload).toMatchObject({
      incomingDamageMultiplier: 0.5,
      outgoingDamageMultiplier: 1,
    });
  });

  it("UT-R-DMG-07-011 (R-SUB-02×R-DMG-07): the additional hit is reduced by a threshold-gated modifier and consumes only the applied instance", () => {
    const recorderContext = damageEventContext();
    const context: DamageEventContext = {
      ...recorderContext,
      consumeEffectDuration: testConsumeEffectDuration(
        recorderContext.recorder,
        new Map<EffectActionDefinitionId, EffectActionDefinition>(),
      ),
    };
    const attacker = attackerHoldingSubUnit();
    const baseTarget = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });
    const thresholdGuard: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("THRESHOLD_GUARD"),
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_THRESHOLD_GUARD"),
      kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId("ACT_THRESHOLD_GUARD")),
      duplicate: true,
      targetUnitId: createBattleUnitId("TARGET"),
      magnitude: -0.5,
      categories: ["BUFF"],
      damageModifier: {
        direction: "INCOMING",
        damageType: null,
        damageThreshold: {
          op: "GT",
          formula: { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.05 },
        },
      },
      duration: {
        definition: {
          dispellable: true,
          linkedEffectGroupId: null,
          consumption: { kind: "INCOMING_HIT", maxCount: 2 },
        },
        consumptionRemaining: 2,
      },
      appliedTurnNumber: 1,
    };
    const target: BattleUnit = { ...baseTarget, appliedEffects: [thresholdGuard] };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      context,
    );

    // 追加ダメージ 70（30 + 100×0.5 - 防御10）。閾値 = 現在HP1000×5% = 50 < 70 -> 35 へ軽減。
    // R-DMG-04の合成には参加しない（incomingDamageMultiplierは1のまま）。
    const additionalCalculated = context.recorder
      .getEvents()
      .filter(
        (event) =>
          event.eventType === "DamageCalculated" &&
          (event.payload as { effectActionDefinitionId: string }).effectActionDefinitionId ===
            SUBUNIT_DEFINITION_ID,
      );
    expect(additionalCalculated).toHaveLength(1);
    expect(additionalCalculated[0]!.payload).toMatchObject({
      skillPower: 70,
      incomingDamageMultiplier: 1,
      outgoingDamageMultiplier: 1,
      finalDamage: 35,
    });

    // 消費は軽減を適用した追加ヒットでだけ起きる（通常ヒット10は閾値50以下で素通し）。
    const consumption = context.recorder
      .getEvents()
      .filter((event) => event.eventType === "EffectConsumptionChanged");
    expect(consumption).toHaveLength(1);
    expect(consumption[0]!.payload).toMatchObject({ before: 2, after: 1 });
    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(
      updatedTarget.appliedEffects.find(
        (effect) => effect.effectInstanceId === thresholdGuard.effectInstanceId,
      )!.duration.consumptionRemaining,
    ).toBe(1);
  });

  it("UT-R-SUB-02-015 (R-ACTN-01 #2): no accompanying debuff is granted when the additional damage defeats the target", () => {
    const granted: string[] = [];
    const base = damageEventContext();
    const context: DamageEventContext = {
      ...base,
      grantSubUnitAdditionalDamageDebuff: function* (
        targetUnitId,
        debuffEffectActionDefinitionId,
        _ownerUnitId,
        units,
        parentEventId,
      ) {
        granted.push(`${targetUnitId}:${debuffEffectActionDefinitionId}`);
        const injected = yield { events: [], units };
        return { units: injected ?? units, lastEventId: parentEventId };
      },
    };
    const withDebuff: AppliedEffect = {
      ...subUnitEffect("ATTACKER"),
      subUnit: {
        durability: 50,
        additionalDamage: {
          ...ADDITIONAL_DAMAGE,
          debuff: { effectActionDefinitionId: createEffectActionDefinitionId("ACT_SPEED_DOWN") },
        },
      },
    };
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const attackerWithSubUnit: BattleUnit = { ...attacker, appliedEffects: [withDebuff] };
    // 通常ヒット(20)では死なず、追加ダメージ(70)で戦闘不能になるHPにする。
    const baseTarget = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 50 });
    const target: BattleUnit = {
      ...baseTarget,
      currentHp: createHitPoint(50, baseTarget.combatStats.maximumHp),
    };

    const result = applyDamageAction(
      attackerWithSubUnit,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attackerWithSubUnit, target],
      new SequenceRandomSource([]),
      context,
    );

    const updatedTarget = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("TARGET"),
    )!;
    expect(updatedTarget.currentHp).toBe(0);
    // 追加ダメージ自身が対象を倒したので、付随デバフは付与しない。
    expect(granted).toEqual([]);
  });

  it("UT-R-SUB-01-011 (R-SKL-01/R-SKL-03): a SubUnitDamaged chain that defeats the attacker stops the remaining absorption", () => {
    const context = damageEventContext();
    const attacker = unit("ATTACKER", "ALLY", { attack: 200, maximumHp: 100 });
    const first = {
      ...subUnitEffect("TARGET", 10),
      effectInstanceId: createEffectInstanceId("SUB_A"),
    };
    const second = {
      ...subUnitEffect("TARGET", 10),
      effectInstanceId: createEffectInstanceId("SUB_B"),
    };
    const baseTarget = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 1000 });
    const target: BattleUnit = { ...baseTarget, appliedEffects: [first, second] };

    // 最初の`SubUnitDamaged`に反応したPS連鎖が攻撃者を戦闘不能にする。
    let defeatedAttacker = false;
    const withChain: DamageEventContext = {
      ...context,
      onFactEventForPassiveChain: (event, units) => {
        if (event.eventType !== "SubUnitDamaged" || defeatedAttacker) {
          return units;
        }
        defeatedAttacker = true;
        return units.map((u) =>
          u.battleUnitId === createBattleUnitId("ATTACKER")
            ? { ...u, currentHp: createHitPoint(0, u.combatStats.maximumHp) }
            : u,
        );
      },
    };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      new SequenceRandomSource([]),
      withChain,
    );

    // 1体目だけが削られ、2体目は手つかずのまま残る。
    const damaged = context.recorder.getEvents().filter((e) => e.eventType === "SubUnitDamaged");
    expect(damaged).toHaveLength(1);
    const updatedTarget = result.units.find(
      (u) => u.battleUnitId === createBattleUnitId("TARGET"),
    )!;
    expect(
      updatedTarget.appliedEffects.find(
        (e) => e.effectInstanceId === createEffectInstanceId("SUB_B"),
      )?.subUnit?.durability,
    ).toBe(10);
    // 使用者が戦闘不能になった時点で「未解決効果を中断する」
    // （R-SKL-01）。解決済みの吸収（1体目の`SubUnitDamaged`）だけが残り、HP適用と
    // `HitPointReduced`以降のイベントは発行されない。
    expect(context.recorder.getEvents().filter((e) => e.eventType === "HitPointReduced")).toEqual(
      [],
    );
    expect(context.recorder.getEvents().filter((e) => e.eventType === "DamageApplied")).toEqual([]);
    expect(updatedTarget.currentHp).toBe(1000);
    expect(result.interruptedCount).toBe(1);
    expect(result.hits.map((outcome) => outcome.applied)).toEqual([false]);
  });
});
