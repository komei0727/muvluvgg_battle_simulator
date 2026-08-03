import { describe, expect, it } from "vitest";
import { applyEffectActionGroups } from "./effect-action-group-resolver.js";
import type { BattleUnit } from "../model/battle-unit.js";
import { createHitPoint } from "../model/resource-gauge.js";
import {
  effectKindKeyFromDefinitionId,
  SUBUNIT_PROVIDER_ATTACK_KEY,
  type AppliedEffect,
} from "../model/applied-effect.js";
import type { EffectSequencePlan } from "../skill/skill-resolution-service.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import { createEffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";
import {
  unit,
  damageAction,
  statModAction,
  contextFor,
  seedRecorder,
  singleActionStep,
} from "../../../testing/fixtures/effect-sequence-plan.js";

describe("applyEffectActionGroups", () => {
  it("UT-R-STS-03-014 (Issue #183, full stack): a DAMAGE ACTION step against a frozen target wired with a linked-group sibling cascades the sibling away through the real effect-action-group-resolver.ts -> damage-application-service.ts -> removeFreezeEffect injection", () => {
    const actor = unit("ACTOR", "ALLY", {
      combatStats: { ...unit("A", "ALLY").combatStats, attack: 30 },
    });
    const statMod = statModAction("ACT_LINK");
    const freezeEffectId = createEffectInstanceId("freeze-1");
    const siblingEffectId = createEffectInstanceId("sibling-1");
    // `unit()`'s baseline attack is 20; simulate the sibling's +20% ATTACK
    // already contributing (as `grantEffect`/`recalculateCombatStats` would
    // have left it: 20 * 1.2 = 24) so its cascade removal produces a
    // detectable `before !== after` change.
    const enemy = unit("ENEMY", "ENEMY", {
      combatStats: { ...unit("E", "ENEMY").combatStats, defense: 10, attack: 24 },
      appliedEffects: [
        {
          effectInstanceId: freezeEffectId,
          effectActionDefinitionId: createEffectActionDefinitionId("ACT_FREEZE"),
          kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId("ACT_FREEZE")),
          duplicate: true,
          sourceId: createBattleUnitId("ACTOR"),
          targetId: createBattleUnitId("ENEMY"),
          magnitude: 0,
          categories: ["DEBUFF", "STATUS"],
          statusKind: "FREEZE",
          statusDetails: { damageAmplificationOnBreak: 0.5 },
          duration: {
            definition: { dispellable: true, linkedEffectGroupId: "GROUP_A" },
          },
          appliedTurnNumber: 1,
        },
        {
          effectInstanceId: siblingEffectId,
          effectActionDefinitionId: statMod.effectActionDefinitionId,
          kindKey: effectKindKeyFromDefinitionId(statMod.effectActionDefinitionId),
          duplicate: true,
          sourceId: createBattleUnitId("ENEMY"),
          targetId: createBattleUnitId("ENEMY"),
          magnitude: 0.2,
          categories: ["BUFF"],
          duration: {
            definition: { dispellable: true, linkedEffectGroupId: "GROUP_A" },
          },
          appliedTurnNumber: 1,
        },
      ],
    });
    const dmg = damageAction("ACT_ATTACK");
    const effectActions = new Map([
      [dmg.effectActionDefinitionId, dmg],
      [statMod.effectActionDefinitionId, statMod],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, dmg.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const updatedEnemy = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(updatedEnemy.appliedEffects).toHaveLength(0);
    // The linked stat mod's +20% ATTACK is gone once cascaded away (back to
    // the 20 baseline).
    expect(updatedEnemy.combatStats.attack).toBe(20);

    const events = recorder.getEvents();
    const cascadeExpired = events.find(
      (ev) => ev.eventType === "EffectExpired" && ev.payload.effectInstanceId === siblingEffectId,
    );
    const freezeRemoved = events.find((ev) => ev.eventType === "FreezeRemoved");
    const combatStatChanged = events.find((ev) => ev.eventType === "CombatStatChanged");
    expect(cascadeExpired).toBeDefined();
    expect(cascadeExpired!.payload).toMatchObject({
      reason: "LINKED_GROUP_CASCADE",
      cascaded: true,
    });
    expect(freezeRemoved).toBeDefined();
    // Base damage 30 - 10 = 20, amplified by the freeze's +50% = 30.
    expect(freezeRemoved!.payload).toMatchObject({
      effectInstanceId: freezeEffectId,
      triggeringDamage: 30,
    });
    expect(combatStatChanged).toBeDefined();
    expect(events.indexOf(cascadeExpired!)).toBeLessThan(events.indexOf(freezeRemoved!));
  });

  it("UT-R-STS-03-016 (Issue #183, full stack): the cascaded sibling's EffectExpired reaches onFactEventForPassiveChain before FreezeRemoved is recorded at all, through the real removeFreezeEffect injection", () => {
    const actor = unit("ACTOR", "ALLY", {
      combatStats: { ...unit("A", "ALLY").combatStats, attack: 30 },
    });
    const statMod = statModAction("ACT_LINK");
    const freezeEffectId = createEffectInstanceId("freeze-1");
    const siblingEffectId = createEffectInstanceId("sibling-1");
    const enemy = unit("ENEMY", "ENEMY", {
      combatStats: { ...unit("E", "ENEMY").combatStats, defense: 10, attack: 24 },
      appliedEffects: [
        {
          effectInstanceId: freezeEffectId,
          effectActionDefinitionId: createEffectActionDefinitionId("ACT_FREEZE"),
          kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId("ACT_FREEZE")),
          duplicate: true,
          sourceId: createBattleUnitId("ACTOR"),
          targetId: createBattleUnitId("ENEMY"),
          magnitude: 0,
          categories: ["DEBUFF", "STATUS"],
          statusKind: "FREEZE",
          statusDetails: { damageAmplificationOnBreak: 0.5 },
          duration: {
            definition: { dispellable: true, linkedEffectGroupId: "GROUP_A" },
          },
          appliedTurnNumber: 1,
        },
        {
          effectInstanceId: siblingEffectId,
          effectActionDefinitionId: statMod.effectActionDefinitionId,
          kindKey: effectKindKeyFromDefinitionId(statMod.effectActionDefinitionId),
          duplicate: true,
          sourceId: createBattleUnitId("ENEMY"),
          targetId: createBattleUnitId("ENEMY"),
          magnitude: 0.2,
          categories: ["BUFF"],
          duration: {
            definition: { dispellable: true, linkedEffectGroupId: "GROUP_A" },
          },
          appliedTurnNumber: 1,
        },
      ],
    });
    const dmg = damageAction("ACT_ATTACK");
    const effectActions = new Map([
      [dmg.effectActionDefinitionId, dmg],
      [statMod.effectActionDefinitionId, statMod],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    // Observer simulating a PS reacting to each notified event: records
    // whether FreezeRemoved is already present in the recorder at that
    // moment, to prove the cascade's EffectExpired is resolved strictly
    // before FreezeRemoved is even recorded (not just before HP applies).
    const observations: { eventType: string; freezeRemovedAlreadyRecorded: boolean }[] = [];
    const context = contextFor(actor, effectActions, recorder, rootEventId, (event, units) => {
      observations.push({
        eventType: event.eventType,
        freezeRemovedAlreadyRecorded: recorder
          .getEvents()
          .some((ev) => ev.eventType === "FreezeRemoved" && ev.eventId !== event.eventId),
      });
      return units;
    });
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, dmg.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    applyEffectActionGroups(plan, [actor, enemy], context);

    const cascadeExpiredObservation = observations.find((o) => o.eventType === "EffectExpired");
    expect(cascadeExpiredObservation).toBeDefined();
    expect(cascadeExpiredObservation!.freezeRemovedAlreadyRecorded).toBe(false);
    const freezeRemovedObservation = observations.find((o) => o.eventType === "FreezeRemoved");
    expect(freezeRemovedObservation).toBeDefined();
  });

  it("UT-R-EFF-07-013 (実Catalog ACT_MERU_FLATSPIN_PS1_ATK_UP相当): a NEXT_OUTGOING_ATTACK-consumed ATTACK buff still boosts the damage of the very attack that consumes it, then is actually removed afterward", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const attack = damageAction("ACT_ATTACK");
    // 実Catalog `ACT_MERU_FLATSPIN_PS1_ATK_UP` 相当: ATTACK +40%(RATIO)、
    // NEXT_OUTGOING_ATTACK消費(maxCount 1)。
    const consumedAtkBuffId = createEffectActionDefinitionId("ACT_ATK_BUFF_CONSUMED");
    const consumedAtkBuffDuration: DurationDefinition = {
      dispellable: true,
      linkedEffectGroupId: null,
      consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
    };
    const consumedAtkBuff: EffectActionDefinition = {
      kind: "APPLY_STAT_MOD",
      effectActionDefinitionId: consumedAtkBuffId,
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        stat: "ATTACK",
        valueType: "RATIO",
        formula: { kind: "CONSTANT", value: 0.4 },
        stacking: { mode: "STACKABLE", max: null },
        duration: consumedAtkBuffDuration,
      },
    };
    // `grantEffect`/`recalculateCombatStats`が既に適用済みの状態を模す
    // （`attack: 20`の基準値に対し+40%で28）。
    const buffInstance: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("buff-1"),
      effectActionDefinitionId: consumedAtkBuffId,
      kindKey: effectKindKeyFromDefinitionId(consumedAtkBuffId),
      duplicate: true,
      sourceId: actor.battleUnitId,
      targetId: actor.battleUnitId,
      magnitude: 0.4,
      categories: ["BUFF"],
      duration: {
        definition: consumedAtkBuffDuration,
        consumptionRemaining: 1,
      },
      appliedTurnNumber: 1,
    };
    const actorWithBuff: BattleUnit = {
      ...actor,
      combatStats: { ...actor.combatStats, attack: 28 },
      appliedEffects: [buffInstance],
    };
    const effectActions = new Map([
      [attack.effectActionDefinitionId, attack],
      [consumedAtkBuff.effectActionDefinitionId, consumedAtkBuff],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actorWithBuff, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, attack.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actorWithBuff, enemy], context);

    // 消費させた本人の攻撃自身が、まだ除去されていないバフの補正込みの
    // attack(28)を使って計算されている。
    const damageCalculated = recorder
      .getEvents()
      .find((e) => e.eventType === "DamageCalculated") as Extract<
      BattleDomainEvent,
      { eventType: "DamageCalculated" }
    >;
    expect(damageCalculated.payload.attackerAttack).toBe(28);

    // その後、当該EffectActionの解決完了までにバフは実際に除去され、
    // combatStatsも基準値(20)へ戻る。
    const finalActor = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(finalActor.appliedEffects).toHaveLength(0);
    expect(finalActor.combatStats.attack).toBe(20);

    const eventTypes = recorder.getEvents().map((e) => e.eventType);
    expect(eventTypes).toContain("EffectExpired");
    expect(eventTypes).toContain("CombatStatChanged");
    expect(eventTypes.indexOf("DamageApplied")).toBeLessThan(eventTypes.indexOf("EffectExpired"));
    expect(result.outcome.status).toBe("COMPLETED");
  });
});

/**
 * DMG-005（Issue #190）: R-SUB-02のサブユニット追加ヒットは
 * `application.hits`に含まれないため、その解決中に使用者が戦闘不能になっても
 * `interruptedCount`は0のままになる。中断が`ApplyDamageActionResult.interrupted`として
 * 外側へ伝わり、`EffectActionCompleted`が`INTERRUPTED`になって後続stepへ進まないことを、
 * 実resolver経路で固定する。
 */
describe("sub-unit additional damage interruption (R-SUB-02 / R-SKL-01)", () => {
  const OWNER_SUBUNIT_ID = createEffectActionDefinitionId("ACT_OWNER_SUBUNIT");
  const TARGET_SUBUNIT_ID = createEffectActionDefinitionId("ACT_TARGET_SUBUNIT");

  function subUnitEffect(
    instanceId: string,
    definitionId: EffectActionDefinition["effectActionDefinitionId"],
    holderId: BattleUnit["battleUnitId"],
    durability: number,
  ): AppliedEffect {
    return {
      effectInstanceId: createEffectInstanceId(instanceId),
      effectActionDefinitionId: definitionId,
      kindKey: effectKindKeyFromDefinitionId(definitionId),
      duplicate: true,
      targetId: holderId,
      magnitude: durability,
      categories: ["SUBUNIT"],
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
      snapshot: { [SUBUNIT_PROVIDER_ATTACK_KEY]: 100 },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
  }

  it("UT-R-SUB-02-016: a SubUnitDamaged chain that defeats the actor during the additional hit reports INTERRUPTED and never starts the next step", () => {
    const actorBase = unit("ACTOR", "ALLY");
    // 使用者がサブユニットを持つので、通常ヒットの後に追加ヒットが1回発生する。
    const actor: BattleUnit = {
      ...actorBase,
      appliedEffects: [subUnitEffect("OWNER_SUB", OWNER_SUBUNIT_ID, actorBase.battleUnitId, 50)],
    };
    // 対象もサブユニットを持つので、追加ヒットが`SubUnitDamaged`を発行する。
    // 耐久力200のサブユニットが通常ヒット(10)も追加ヒット(20 + 100×0.5 - 10 = 60)も
    // 吸収しきるため、対象は戦闘不能にならず中断要因が使用者側だけに絞られる。
    const enemyBase = unit("ENEMY", "ENEMY");
    const enemy: BattleUnit = {
      ...enemyBase,
      appliedEffects: [subUnitEffect("TARGET_SUB", TARGET_SUBUNIT_ID, enemyBase.battleUnitId, 200)],
    };
    const attack = damageAction("ACT_ATTACK");
    const second = damageAction("ACT_SECOND");
    const effectActions = new Map([
      [attack.effectActionDefinitionId, attack],
      [second.effectActionDefinitionId, second],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    // 追加ヒット（`effectActionDefinitionId`が使用者のサブユニット定義）の
    // `SubUnitDamaged`にだけ反応して使用者を倒す。通常ヒット側の`SubUnitDamaged`
    // （`ACT_ATTACK`）では発火しないため、中断は追加ヒットの最中に起きる。
    const context = contextFor(actor, effectActions, recorder, rootEventId, (event, units) => {
      if (
        event.eventType !== "SubUnitDamaged" ||
        event.payload.effectActionDefinitionId !== OWNER_SUBUNIT_ID
      ) {
        return units;
      }
      return units.map((u) =>
        u.battleUnitId === actor.battleUnitId ? { ...u, currentHp: createHitPoint(0, 100) } : u,
      );
    });
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        singleActionStep(0, true, enemy.battleUnitId, attack.effectActionDefinitionId),
        singleActionStep(1, true, enemy.battleUnitId, second.effectActionDefinitionId),
      ],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    // 追加ヒットの`SubUnitDamaged`連鎖が使用者を倒したので、この解決は中断扱いになる。
    expect(result.outcome.status).toBe("INTERRUPTED");
    const completed = recorder
      .getEvents()
      .filter((e) => e.eventType === "EffectActionCompleted")
      .map((e) => e.payload.resultKind);
    expect(completed).toEqual(["INTERRUPTED"]);
    // 後続stepのEffectActionは一度も開始されない（R-SKL-01「未解決効果を中断する」）。
    expect(
      recorder
        .getEvents()
        .some(
          (e) =>
            e.eventType === "EffectActionStarting" &&
            e.payload.effectActionDefinitionId === second.effectActionDefinitionId,
        ),
    ).toBe(false);
    expect(recorder.getEvents().filter((e) => e.eventType === "EffectStepCompleted")).toEqual([]);
  });
});
