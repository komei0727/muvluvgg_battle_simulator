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
import { createEffectInstanceId, createSkillUseId } from "../../shared/event-ids.js";
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
          sourceUnitId: createBattleUnitId("ACTOR"),
          targetUnitId: createBattleUnitId("ENEMY"),
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
          sourceUnitId: createBattleUnitId("ENEMY"),
          targetUnitId: createBattleUnitId("ENEMY"),
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
          sourceUnitId: createBattleUnitId("ACTOR"),
          targetUnitId: createBattleUnitId("ENEMY"),
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
          sourceUnitId: createBattleUnitId("ENEMY"),
          targetUnitId: createBattleUnitId("ENEMY"),
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
      sourceUnitId: actor.battleUnitId,
      targetUnitId: actor.battleUnitId,
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

  it("UT-R-EFF-07-017 [R-EFF-07]: a multi-hit attack consumes only the oldest of several OLDEST_ONLY instances, not one per hit", () => {
    const actor = unit("ACTOR", "ALLY");
    const attack = damageAction("ACT_ATTACK", 4);
    const setBuffId = createEffectActionDefinitionId("ACT_SET_BUFF");
    const setBuffDuration: DurationDefinition = {
      dispellable: true,
      linkedEffectGroupId: null,
      consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1, instancePolicy: "OLDEST_ONLY" },
    };
    const setBuff: EffectActionDefinition = {
      kind: "APPLY_STAT_MOD",
      effectActionDefinitionId: setBuffId,
      metadata: { tags: [] },
      payload: {
        stat: "DEFENSE",
        valueType: "FIXED",
        formula: { kind: "CONSTANT", value: 0 },
        stacking: { mode: "STACKABLE", max: null },
        duration: setBuffDuration,
      },
    };
    const setInstance = (id: string): AppliedEffect => ({
      effectInstanceId: createEffectInstanceId(id),
      effectActionDefinitionId: setBuffId,
      kindKey: effectKindKeyFromDefinitionId(setBuffId),
      duplicate: true,
      sourceUnitId: createBattleUnitId("ENEMY"),
      targetUnitId: createBattleUnitId("ENEMY"),
      magnitude: 0,
      categories: ["BUFF"],
      duration: { definition: setBuffDuration, consumptionRemaining: 1 },
      appliedTurnNumber: 1,
    });
    const enemy = unit("ENEMY", "ENEMY", {
      appliedEffects: [setInstance("set-1"), setInstance("set-2"), setInstance("set-3")],
    });
    const effectActions = new Map([
      [attack.effectActionDefinitionId, attack],
      [setBuff.effectActionDefinitionId, setBuff],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const fourHitStep: EffectSequencePlan["steps"][number] = {
      planKind: "ACTION_PLAN",
      stepIndex: 0,
      stepKind: "ACTION",
      conditionKind: "TRUE",
      satisfied: true,
      actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
      applications: [
        {
          targetUnitId: enemy.battleUnitId,
          effectActionDefinitionId: attack.effectActionDefinitionId,
          includeDefeated: false,
          hits: [1, 2, 3, 4].map((hitIndex) => ({
            targetUnitId: enemy.battleUnitId,
            effectActionDefinitionId: attack.effectActionDefinitionId,
            hitIndex,
          })),
        },
      ],
    };
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [fourHitStep],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const confirmedHits = recorder.getEvents().filter((e) => e.eventType === "HitConfirmed");
    expect(confirmedHits).toHaveLength(4);
    const finalEnemy = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(finalEnemy.appliedEffects.map((e) => e.effectInstanceId)).toEqual([
      createEffectInstanceId("set-2"),
      createEffectInstanceId("set-3"),
    ]);
    const expired = recorder.getEvents().filter((e) => e.eventType === "EffectExpired");
    expect(expired.map((e) => e.payload.effectInstanceId)).toEqual([
      createEffectInstanceId("set-1"),
    ]);
  });

  it("UT-R-EFF-09-035 [R-EFF-07][R-EFF-09]: a multi-hit attack on a holder of three shield+buff sets removes only the oldest set's shield and its SKILL_USE-linked buff", () => {
    const actor = unit("ACTOR", "ALLY");
    const attack = damageAction("ACT_ATTACK", 4);
    const shieldId = createEffectActionDefinitionId("ACT_SET_SHIELD");
    const buffId = createEffectActionDefinitionId("ACT_SET_CRIT_UP");
    const shieldDuration: DurationDefinition = {
      dispellable: true,
      linkedEffectGroupId: "GROUP_SET",
      linkedEffectGroupRole: "PARENT",
      linkedEffectGroupScope: "SKILL_USE",
      consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1, instancePolicy: "OLDEST_ONLY" },
    };
    const buffDuration: DurationDefinition = {
      dispellable: false,
      linkedEffectGroupId: "GROUP_SET",
      linkedEffectGroupRole: "CHILD",
      linkedEffectGroupScope: "SKILL_USE",
    };
    const shield: EffectActionDefinition = {
      kind: "APPLY_SHIELD",
      effectActionDefinitionId: shieldId,
      metadata: { tags: [] },
      payload: { formula: { kind: "CONSTANT", value: 1000 }, duration: shieldDuration },
    };
    const buff: EffectActionDefinition = {
      kind: "APPLY_STAT_MOD",
      effectActionDefinitionId: buffId,
      metadata: { tags: [] },
      payload: {
        stat: "CRITICAL_RATE",
        valueType: "FIXED",
        formula: { kind: "CONSTANT", value: 0 },
        stacking: { mode: "STACKABLE", max: null },
        duration: buffDuration,
      },
    };
    const holderId = createBattleUnitId("ENEMY");
    const setMembers = (n: number): AppliedEffect[] => [
      {
        effectInstanceId: createEffectInstanceId(`shield-${n}`),
        effectActionDefinitionId: shieldId,
        kindKey: effectKindKeyFromDefinitionId(shieldId),
        duplicate: true,
        sourceUnitId: holderId,
        targetUnitId: holderId,
        magnitude: 1000,
        categories: ["SHIELD"],
        shield: { shieldType: null, remaining: 1000 },
        duration: {
          definition: shieldDuration,
          consumptionRemaining: 1,
          linkedGroupSkillUseId: createSkillUseId(`use-${n}`),
        },
        appliedTurnNumber: 1,
      },
      {
        effectInstanceId: createEffectInstanceId(`buff-${n}`),
        effectActionDefinitionId: buffId,
        kindKey: effectKindKeyFromDefinitionId(buffId),
        duplicate: true,
        sourceUnitId: holderId,
        targetUnitId: holderId,
        magnitude: 0,
        categories: ["BUFF"],
        duration: {
          definition: buffDuration,
          linkedGroupSkillUseId: createSkillUseId(`use-${n}`),
        },
        appliedTurnNumber: 1,
      },
    ];
    const enemy = unit("ENEMY", "ENEMY", {
      appliedEffects: [...setMembers(1), ...setMembers(2), ...setMembers(3)],
    });
    const effectActions = new Map([
      [attack.effectActionDefinitionId, attack],
      [shield.effectActionDefinitionId, shield],
      [buff.effectActionDefinitionId, buff],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        {
          planKind: "ACTION_PLAN",
          stepIndex: 0,
          stepKind: "ACTION",
          conditionKind: "TRUE",
          satisfied: true,
          actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
          applications: [
            {
              targetUnitId: enemy.battleUnitId,
              effectActionDefinitionId: attack.effectActionDefinitionId,
              includeDefeated: false,
              hits: [1, 2, 3, 4].map((hitIndex) => ({
                targetUnitId: enemy.battleUnitId,
                effectActionDefinitionId: attack.effectActionDefinitionId,
                hitIndex,
              })),
            },
          ],
        },
      ],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const finalEnemy = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(finalEnemy.appliedEffects.map((e) => e.effectInstanceId)).toEqual([
      createEffectInstanceId("shield-2"),
      createEffectInstanceId("buff-2"),
      createEffectInstanceId("shield-3"),
      createEffectInstanceId("buff-3"),
    ]);
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
      targetUnitId: holderId,
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
