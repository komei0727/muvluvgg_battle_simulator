import { describe, expect, it } from "vitest";
import {
  applyOneContinuousDamage,
  calculateContinuousDamage,
  countBurnInstances,
  isBurnStackLimitReached,
  isShieldApplicableContinuousDamage,
  type ContinuousDamageEventContext,
} from "./continuous-damage-service.js";
import {
  CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY,
  effectKindKeyFromDefinitionId,
  type AppliedEffect,
} from "../model/applied-effect.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createHitPoint } from "../model/resource-gauge.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import { createEffectInstanceId, type DomainEventId } from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
  type EffectActionDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { ContinuousDamageKind } from "../../catalog/definitions/effect-action-payload.js";
import type { DamageType } from "../../catalog/definitions/catalog-enums.js";
import type { FormulaDefinition } from "../../catalog/definitions/formula-definition.js";
import type { ShieldState } from "../model/applied-effect.js";

function unit(
  id: string,
  overrides: {
    attack?: number;
    maximumHp?: number;
    currentHp?: number;
    effects?: readonly AppliedEffect[];
  } = {},
): BattleUnit {
  const position = { row: "FRONT" as const, column: "LEFT" as const };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate("ALLY", position),
    combatStats: {
      maximumHp: overrides.maximumHp ?? 1000,
      attack: overrides.attack ?? 100,
      defense: 20,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
  const built = createBattleUnit(member, "ALLY", {
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 100,
  });
  return {
    ...built,
    currentHp: createHitPoint(
      overrides.currentHp ?? overrides.maximumHp ?? 1000,
      overrides.maximumHp ?? 1000,
    ),
    appliedEffects: overrides.effects ?? [],
  };
}

let sequence = 0;

function dotDefinition(
  id: string,
  continuousDamageKind: ContinuousDamageKind,
  formula: FormulaDefinition,
  damageType: DamageType = "PHYSICAL",
): Extract<EffectActionDefinition, { kind: "APPLY_CONTINUOUS_DAMAGE" }> {
  return {
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    kind: "APPLY_CONTINUOUS_DAMAGE",
    payload: {
      continuousDamageKind,
      damageType,
      formula,
      timing: { eventType: "ActionStarted", targetSelector: "EFFECT_OWNER" },
      duration: {
        timeLimit: { unit: "ACTION", count: 3 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
    },
    metadata: { tags: [] },
  };
}

function dotEffect(
  definitionId: EffectActionDefinitionId,
  continuousDamageKind: ContinuousDamageKind,
  magnitude: number,
  sourceAttack: number,
  damageType: DamageType = "PHYSICAL",
): AppliedEffect {
  sequence += 1;
  return {
    effectInstanceId: createEffectInstanceId(`EFFECT_INSTANCE_${sequence}`),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    categories: ["DEBUFF"],
    duplicate: true,
    sourceUnitId: createBattleUnitId("enemy:1"),
    targetUnitId: createBattleUnitId("ally:1"),
    magnitude,
    continuousDamage: { continuousDamageKind, damageType },
    snapshot: { [CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY]: sourceAttack },
    duration: {
      definition: {
        timeLimit: { unit: "ACTION", count: 3 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      timeLimitRemaining: 3,
    },
    appliedTurnNumber: 1,
  };
}

function shieldEffect(amount: number, shieldType: ShieldState["shieldType"]): AppliedEffect {
  sequence += 1;
  const definitionId = createEffectActionDefinitionId(`ACT_SHIELD_${sequence}`);
  return {
    effectInstanceId: createEffectInstanceId(`EFFECT_INSTANCE_${sequence}`),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate: true,
    targetUnitId: createBattleUnitId("ally:1"),
    magnitude: amount,
    categories: ["SHIELD"],
    shield: { shieldType, remaining: amount },
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

/**
 * R-SUB-01のサブユニット。`FIXED`継続ダメージは通常シールドをすべて適用した後に
 * サブユニットへ回る（R-SUB-01第1項）。
 */
function subUnitEffect(durability: number): AppliedEffect {
  sequence += 1;
  const definitionId = createEffectActionDefinitionId(`ACT_SUBUNIT_${sequence}`);
  return {
    effectInstanceId: createEffectInstanceId(`EFFECT_INSTANCE_${sequence}`),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate: true,
    targetUnitId: createBattleUnitId("ally:1"),
    magnitude: durability,
    categories: ["SUBUNIT"],
    // R-SUB-02の追加ダメージ自体はこのテストの対象外だが、`SubUnitState`の必須項目。
    subUnit: {
      durability,
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
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

function seedRecorder(): { recorder: EventRecorder; rootEventId: DomainEventId } {
  const recorder = new EventRecorder(createBattleId("B_1"));
  const seed = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber: 1 },
  });
  return { recorder, rootEventId: seed.eventId };
}

function contextOf(
  recorder: EventRecorder,
  rootEventId: DomainEventId,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
): ContinuousDamageEventContext {
  return {
    recorder,
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    rootEventId,
    effectActions,
  };
}

describe("continuous damage (R-DOT-01〜04, DMG-008 Issue #189)", () => {
  it("UT-R-DOT-01-001: a FIXED continuous damage uses the attack snapshot taken at grant time, not the granter's current attack", () => {
    const definition = dotDefinition("ACT_DOT", "FIXED", {
      kind: "STAT_RATIO",
      source: { kind: "SKILL_SOURCE" },
      stat: "ATTACK",
      ratio: 0.3,
    });
    // 付与時攻撃力100 × 30% = 30 を`magnitude`として焼き込んである。
    const effect = dotEffect(definition.effectActionDefinitionId, "FIXED", 30, 100);
    const holder = unit("ally:1", { effects: [effect] });
    // 付与者の現在の攻撃力を10倍にしても発生量は変わらない。
    const granter = unit("enemy:1", { attack: 1000 });

    const amount = calculateContinuousDamage(effect, definition, holder, granter, [
      holder,
      granter,
    ]);

    expect(amount.calculatedDamage).toBe(30);
    expect(amount.burnStackMultiplier).toBe(1);
    expect(amount.cappedBySnapshotAttack).toBe(false);
  });

  it("UT-R-DOT-01-002: a continuous damage still fires with its snapshot after the granter is gone from the board", () => {
    const definition = dotDefinition("ACT_DOT", "FIXED", {
      kind: "STAT_RATIO",
      source: { kind: "SKILL_SOURCE" },
      stat: "ATTACK",
      ratio: 0.3,
    });
    const effect = dotEffect(definition.effectActionDefinitionId, "FIXED", 30, 100);
    const holder = unit("ally:1", { effects: [effect] });

    const amount = calculateContinuousDamage(effect, definition, holder, undefined, [holder]);

    expect(amount.calculatedDamage).toBe(30);
  });

  it("UT-R-DOT-01-003: the final result truncates its fraction and is raised to a minimum of 1", () => {
    const definition = dotDefinition("ACT_DOT", "FIXED", { kind: "CONSTANT", value: 0.4 });
    const fractional = dotEffect(definition.effectActionDefinitionId, "FIXED", 30.9, 100);
    const belowOne = dotEffect(definition.effectActionDefinitionId, "FIXED", 0.4, 100);
    const holder = unit("ally:1");

    expect(
      calculateContinuousDamage(fractional, definition, holder, undefined, [holder])
        .calculatedDamage,
    ).toBe(30);
    expect(
      calculateContinuousDamage(belowOne, definition, holder, undefined, [holder]).calculatedDamage,
    ).toBe(1);
  });

  it("UT-R-DOT-02-001: a FIXED continuous damage is absorbed by the matching typed shield, then the untyped shield, then HP", () => {
    const definition = dotDefinition("ACT_DOT", "FIXED", { kind: "CONSTANT", value: 100 });
    const effect = dotEffect(definition.effectActionDefinitionId, "FIXED", 100, 100);
    const holder = unit("ally:1", {
      currentHp: 500,
      // 対応しないタイプ（EN）のシールドは吸収しない（R-SHD-02末尾）。
      effects: [
        shieldEffect(20, "EN"),
        shieldEffect(30, "PHYSICAL"),
        shieldEffect(40, null),
        effect,
      ],
    });
    const { recorder, rootEventId } = seedRecorder();

    const result = applyOneContinuousDamage(
      effect,
      definition,
      holder,
      undefined,
      [holder],
      contextOf(
        recorder,
        rootEventId,
        new Map([[definition.effectActionDefinitionId, definition]]),
      ),
      rootEventId,
    );

    const applied = recorder.getEvents().find((e) => e.eventType === "ContinuousDamageApplied")!
      .payload as Record<string, unknown>;
    expect(applied).toMatchObject({
      calculatedDamage: 100,
      typedShieldAbsorbed: 30,
      untypedShieldAbsorbed: 40,
      hitPointDamage: 30,
      hpBefore: 500,
      hpAfter: 470,
    });
    // ENシールドは無傷のまま残る。
    const holderAfter = result.units.find((u) => u.battleUnitId === holder.battleUnitId)!;
    expect(
      holderAfter.appliedEffects.find((e) => e.shield?.shieldType === "EN")!.shield!.remaining,
    ).toBe(20);
    expect(recorder.getEvents().filter((e) => e.eventType === "ShieldConsumed").length).toBe(2);
  });

  it("UT-R-DOT-02-002: shields never absorb BURN or POISON continuous damage (R-SUB-01, R-LNK-02)", () => {
    expect(isShieldApplicableContinuousDamage("FIXED")).toBe(true);
    expect(isShieldApplicableContinuousDamage("BURN")).toBe(false);
    expect(isShieldApplicableContinuousDamage("POISON")).toBe(false);

    const definition = dotDefinition("ACT_BURN", "BURN", { kind: "CONSTANT", value: 50 });
    const effect = dotEffect(definition.effectActionDefinitionId, "BURN", 50, 100);
    const holder = unit("ally:1", {
      currentHp: 500,
      effects: [shieldEffect(999, "PHYSICAL"), effect],
    });
    const { recorder, rootEventId } = seedRecorder();

    applyOneContinuousDamage(
      effect,
      definition,
      holder,
      undefined,
      [holder],
      contextOf(
        recorder,
        rootEventId,
        new Map([[definition.effectActionDefinitionId, definition]]),
      ),
      rootEventId,
    );

    const applied = recorder.getEvents().find((e) => e.eventType === "ContinuousDamageApplied")!
      .payload as Record<string, unknown>;
    expect(applied).toMatchObject({
      typedShieldAbsorbed: 0,
      untypedShieldAbsorbed: 0,
      hitPointDamage: 50,
      hpAfter: 450,
    });
    expect(recorder.getEvents().some((e) => e.eventType === "ShieldConsumed")).toBe(false);
  });

  it("UT-R-DOT-03-001: each burn instance doubles its own damage once the holder carries three burns", () => {
    const definition = dotDefinition("ACT_BURN", "BURN", { kind: "CONSTANT", value: 30 });
    const first = dotEffect(definition.effectActionDefinitionId, "BURN", 30.5, 100);
    const second = dotEffect(definition.effectActionDefinitionId, "BURN", 30.5, 100);
    const third = dotEffect(definition.effectActionDefinitionId, "BURN", 30.5, 100);

    const withTwo = unit("ally:1", { effects: [first, second] });
    const withThree = unit("ally:1", { effects: [first, second, third] });

    expect(countBurnInstances(withTwo)).toBe(2);
    expect(countBurnInstances(withThree)).toBe(3);

    const two = calculateContinuousDamage(first, definition, withTwo, undefined, [withTwo]);
    expect(two.burnStackMultiplier).toBe(1);
    expect(two.calculatedDamage).toBe(30);

    // Q-EFF-06: 2倍は各インスタンスの最終結果を算出する**前**に適用する。
    // 30.5×2=61 であり、切り捨て済みの30を2倍した60ではない。
    const three = calculateContinuousDamage(first, definition, withThree, undefined, [withThree]);
    expect(three.burnStackMultiplier).toBe(2);
    expect(three.calculatedDamage).toBe(61);
  });

  it("UT-R-DOT-03-002: a holder carrying three burns is at the stack limit, two is not", () => {
    const definitionId = createEffectActionDefinitionId("ACT_BURN");
    const otherId = createEffectActionDefinitionId("ACT_BURN_OTHER");
    const burns = [
      dotEffect(definitionId, "BURN", 30, 100),
      dotEffect(definitionId, "BURN", 30, 100),
      // R-DOT-03の重複数は定義をまたいで数える（種別単位）。
      dotEffect(otherId, "BURN", 30, 100),
    ];
    const poison = dotEffect(createEffectActionDefinitionId("ACT_POISON"), "POISON", 30, 100);

    expect(isBurnStackLimitReached(unit("ally:1", { effects: burns.slice(0, 2) }))).toBe(false);
    expect(isBurnStackLimitReached(unit("ally:1", { effects: burns }))).toBe(true);
    // 毒は炎上の重複数へ数えない。
    expect(
      isBurnStackLimitReached(unit("ally:1", { effects: [...burns.slice(0, 2), poison] })),
    ).toBe(false);
  });

  it("UT-R-DOT-04-001: poison damage re-evaluates current HP each tick and is capped at the granter's snapshot attack", () => {
    const definition = dotDefinition("ACT_POISON", "POISON", {
      kind: "CURRENT_HP_RATIO",
      source: { kind: "TARGET" },
      ratio: 0.1,
    });
    // 付与時攻撃力50 → 上限50。
    const effect = dotEffect(definition.effectActionDefinitionId, "POISON", 0, 50);

    // 現在HP 1000 → 割合ダメージ100 > 上限50 なので頭打ちになる。
    const highHp = unit("ally:1", { maximumHp: 2000, currentHp: 1000, effects: [effect] });
    const capped = calculateContinuousDamage(effect, definition, highHp, undefined, [highHp]);
    expect(capped.formulaResult).toBe(100);
    expect(capped.cappedBySnapshotAttack).toBe(true);
    expect(capped.calculatedDamage).toBe(50);

    // 現在HP 300 → 割合ダメージ30 < 上限50 なので割合の方を使う。
    const lowHp = unit("ally:1", { maximumHp: 2000, currentHp: 300, effects: [effect] });
    const uncapped = calculateContinuousDamage(effect, definition, lowHp, undefined, [lowHp]);
    expect(uncapped.formulaResult).toBe(30);
    expect(uncapped.cappedBySnapshotAttack).toBe(false);
    expect(uncapped.calculatedDamage).toBe(30);
  });

  it("UT-R-DOT-04-002: poison damage never reaches shields even when the holder carries one", () => {
    const definition = dotDefinition("ACT_POISON", "POISON", {
      kind: "CURRENT_HP_RATIO",
      source: { kind: "TARGET" },
      ratio: 0.1,
    });
    const effect = dotEffect(definition.effectActionDefinitionId, "POISON", 0, 500);
    const holder = unit("ally:1", {
      currentHp: 1000,
      effects: [shieldEffect(999, "PHYSICAL"), effect],
    });
    const { recorder, rootEventId } = seedRecorder();

    applyOneContinuousDamage(
      effect,
      definition,
      holder,
      undefined,
      [holder],
      contextOf(
        recorder,
        rootEventId,
        new Map([[definition.effectActionDefinitionId, definition]]),
      ),
      rootEventId,
    );

    const applied = recorder.getEvents().find((e) => e.eventType === "ContinuousDamageApplied")!
      .payload as Record<string, unknown>;
    expect(applied).toMatchObject({
      continuousDamageKind: "POISON",
      calculatedDamage: 100,
      typedShieldAbsorbed: 0,
      untypedShieldAbsorbed: 0,
      hitPointDamage: 100,
      hpAfter: 900,
    });
  });

  it("UT-R-DOT-01-004 (boundary): a lethal continuous damage clamps HP at 0, discards the excess, and emits UnitDefeated", () => {
    const definition = dotDefinition("ACT_DOT", "FIXED", { kind: "CONSTANT", value: 100 });
    const effect = dotEffect(definition.effectActionDefinitionId, "FIXED", 100, 100);
    const holder = unit("ally:1", { currentHp: 30, effects: [effect] });
    const { recorder, rootEventId } = seedRecorder();

    const result = applyOneContinuousDamage(
      effect,
      definition,
      holder,
      undefined,
      [holder],
      contextOf(
        recorder,
        rootEventId,
        new Map([[definition.effectActionDefinitionId, definition]]),
      ),
      rootEventId,
    );

    const applied = recorder.getEvents().find((e) => e.eventType === "ContinuousDamageApplied")!;
    expect(applied.payload).toMatchObject({
      calculatedDamage: 100,
      hitPointDamage: 30,
      discardedDamage: 70,
      hpBefore: 30,
      hpAfter: 0,
      defeated: true,
    });
    // HP変化のStateDeltaはこのイベントだけが持つ（二重適用を避ける）。
    expect(applied.stateDelta?.units?.[holder.battleUnitId]?.hp).toEqual({ before: 30, after: 0 });
    const defeated = recorder.getEvents().find((e) => e.eventType === "UnitDefeated")!;
    expect(defeated.parentEventId).toBe(applied.eventId);
    expect(result.lastEventId).toBe(defeated.eventId);
    expect(result.units.find((u) => u.battleUnitId === holder.battleUnitId)!.currentHp).toBe(0);
  });

  // DMG-010: `FIXED`継続ダメージはR-SUB-01第1項どおり
  // サブユニットへも吸収されるが、`ContinuousDamageApplied`がその量を公開して
  // いなかったため、`08_ドメインイベント.md`の保存則
  // `typedShieldAbsorbed + untypedShieldAbsorbed + subUnitAbsorbed
  //  + hitPointDamage + discardedDamage === calculatedDamage`
  // が成立せず、UIも差分を説明できなかった。
  it("UT-R-DOT-02-003: a FIXED continuous damage publishes the sub unit absorption that completes the conservation law", () => {
    const definition = dotDefinition("ACT_DOT", "FIXED", { kind: "CONSTANT", value: 100 });
    const effect = dotEffect(definition.effectActionDefinitionId, "FIXED", 100, 100);
    const holder = unit("ally:1", {
      currentHp: 500,
      effects: [shieldEffect(30, "PHYSICAL"), subUnitEffect(50), effect],
    });
    const { recorder, rootEventId } = seedRecorder();

    applyOneContinuousDamage(
      effect,
      definition,
      holder,
      undefined,
      [holder],
      contextOf(
        recorder,
        rootEventId,
        new Map([[definition.effectActionDefinitionId, definition]]),
      ),
      rootEventId,
    );

    const applied = recorder.getEvents().find((e) => e.eventType === "ContinuousDamageApplied")!
      .payload as unknown as Record<string, number>;
    expect(applied).toMatchObject({
      calculatedDamage: 100,
      typedShieldAbsorbed: 30,
      untypedShieldAbsorbed: 0,
      subUnitAbsorbed: 50,
      discardedDamage: 0,
      hitPointDamage: 20,
      hpBefore: 500,
      hpAfter: 480,
    });
    expect(
      applied["typedShieldAbsorbed"]! +
        applied["untypedShieldAbsorbed"]! +
        applied["subUnitAbsorbed"]! +
        applied["hitPointDamage"]! +
        applied["discardedDamage"]!,
    ).toBe(applied["calculatedDamage"]);
    expect(
      recorder
        .getEvents()
        .filter((e) => e.eventType === "SubUnitDamaged")
        .map((e) => (e.payload as Record<string, unknown>)["reason"]),
    ).toEqual(["CONTINUOUS_DAMAGE_ABSORPTION"]);
  });

  it("UT-R-DOT-02-004: sub units never absorb BURN or POISON continuous damage (R-SUB-01第2項)", () => {
    const definition = dotDefinition("ACT_BURN", "BURN", { kind: "CONSTANT", value: 50 });
    const effect = dotEffect(definition.effectActionDefinitionId, "BURN", 50, 100);
    const holder = unit("ally:1", {
      currentHp: 500,
      effects: [subUnitEffect(999), effect],
    });
    const { recorder, rootEventId } = seedRecorder();

    applyOneContinuousDamage(
      effect,
      definition,
      holder,
      undefined,
      [holder],
      contextOf(
        recorder,
        rootEventId,
        new Map([[definition.effectActionDefinitionId, definition]]),
      ),
      rootEventId,
    );

    const applied = recorder.getEvents().find((e) => e.eventType === "ContinuousDamageApplied")!
      .payload as Record<string, unknown>;
    expect(applied).toMatchObject({ subUnitAbsorbed: 0, hitPointDamage: 50, hpAfter: 450 });
    expect(recorder.getEvents().some((e) => e.eventType === "SubUnitDamaged")).toBe(false);
  });
});
