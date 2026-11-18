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
import {
  createActionId,
  createEffectInstanceId,
  createSkillUseId,
} from "../../shared/event-ids.js";
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

  it("UT-R-EFF-07-017 [R-EFF-07]: a multi-hit attack consumes every stacked NEXT_INCOMING_ATTACK instance exactly once", () => {
    const actor = unit("ACTOR", "ALLY");
    const attack = damageAction("ACT_ATTACK", 4);
    const setBuff = consumedStatMod("ACT_SET_BUFF", "DEFENSE", 0, {
      kind: "NEXT_INCOMING_ATTACK",
      maxCount: 1,
    });
    const enemy = unit("ENEMY", "ENEMY", {
      appliedEffects: ["set-1", "set-2", "set-3"].map((id) =>
        consumedInstance(id, setBuff, createBattleUnitId("ENEMY"), 1),
      ),
    });
    const { recorder, result } = resolveAttackSteps(
      [actor, enemy],
      [attack, setBuff],
      [attackStep(0, [attack], [enemy.battleUnitId], 4)],
    );

    expect(recorder.getEvents().filter((e) => e.eventType === "HitConfirmed")).toHaveLength(4);
    expect(consumptionChanges(recorder)).toEqual([
      ["set-1", 1, 0],
      ["set-2", 1, 0],
      ["set-3", 1, 0],
    ]);
    const finalEnemy = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(finalEnemy.appliedEffects).toEqual([]);
  });

  it("UT-R-EFF-09-035 [R-EFF-07][R-EFF-09]: one multi-hit attack removes every stacked shield set together with its SKILL_USE-linked buff", () => {
    const actor = unit("ACTOR", "ALLY");
    const attack = damageAction("ACT_ATTACK", 4);
    const shieldId = createEffectActionDefinitionId("ACT_SET_SHIELD");
    const buffId = createEffectActionDefinitionId("ACT_SET_CRIT_UP");
    const shieldDuration: DurationDefinition = {
      dispellable: true,
      linkedEffectGroupId: "GROUP_SET",
      linkedEffectGroupRole: "PARENT",
      linkedEffectGroupScope: "SKILL_USE",
      consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
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
    const unrelatedShield = {
      ...setMembers(9)[0]!,
      effectInstanceId: createEffectInstanceId("unrelated-shield"),
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    };
    const enemy = unit("ENEMY", "ENEMY", {
      appliedEffects: [...setMembers(1), ...setMembers(2), ...setMembers(3), unrelatedShield],
    });
    const { result } = resolveAttackSteps(
      [actor, enemy],
      [attack, shield, buff],
      [attackStep(0, [attack], [enemy.battleUnitId], 4)],
    );

    const finalEnemy = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(finalEnemy.appliedEffects.map((e) => e.effectInstanceId)).toEqual([
      createEffectInstanceId("unrelated-shield"),
    ]);
  });

  it("UT-R-EFF-07-018 [R-EFF-07][R-DMG-05]: a NEXT_OUTGOING_ATTACK buff boosts every target of the attack and is consumed once after all of them", () => {
    const atkBuff = consumedStatMod("ACT_ATK_BUFF", "ATTACK", 0.4, {
      kind: "NEXT_OUTGOING_ATTACK",
      maxCount: 1,
    });
    const actor = unit("ACTOR", "ALLY", {
      combatStats: { ...unit("A", "ALLY").combatStats, attack: 28 },
      appliedEffects: [consumedInstance("buff-1", atkBuff, createBattleUnitId("ACTOR"), 1)],
    });
    const front = unit("FRONT", "ENEMY");
    const back = unit("BACK", "ENEMY");
    const attack = damageAction("ACT_ATTACK", 2);
    const { recorder, result } = resolveAttackSteps(
      [actor, front, back],
      [attack, atkBuff],
      [attackStep(0, [attack], [front.battleUnitId, back.battleUnitId], 2)],
    );

    const attackerAttacks = recorder
      .getEvents()
      .filter((e) => e.eventType === "DamageCalculated")
      .map((e) => (e.payload as { attackerAttack: number }).attackerAttack);
    expect(attackerAttacks).toEqual([28, 28, 28, 28]);
    expect(consumptionChanges(recorder)).toEqual([["buff-1", 1, 0]]);
    const events = recorder.getEvents();
    const expiredIndex = events.findIndex((e) => e.eventType === "EffectExpired");
    const lastDamageIndex = events.map((e) => e.eventType).lastIndexOf("DamageApplied");
    expect(expiredIndex).toBeGreaterThan(lastDamageIndex);
    const finalActor = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(finalActor.appliedEffects).toEqual([]);
    expect(finalActor.combatStats.attack).toBe(20);
  });

  it("UT-R-EFF-07-019 [R-EFF-07]: each DAMAGE EffectAction is one attack — a 4-hit attack takes one count and a second DAMAGE takes the next", () => {
    const actor = unit("ACTOR", "ALLY");
    const vuln = consumedStatMod("ACT_VULN", "DEFENSE", 0, {
      kind: "NEXT_INCOMING_ATTACK",
      maxCount: 2,
    });
    const enemy = unit("ENEMY", "ENEMY", {
      appliedEffects: [consumedInstance("vuln-1", vuln, createBattleUnitId("ENEMY"), 2)],
    });
    const first = damageAction("ACT_FIRST", 4);
    const second = damageAction("ACT_SECOND", 4);

    const afterOne = resolveAttackSteps(
      [actor, enemy],
      [first, vuln],
      [attackStep(0, [first], [enemy.battleUnitId], 4)],
    );
    expect(consumptionChanges(afterOne.recorder)).toEqual([["vuln-1", 2, 1]]);
    expect(
      afterOne.result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!.appliedEffects,
    ).toHaveLength(1);

    const afterTwo = resolveAttackSteps(
      [actor, enemy],
      [first, second, vuln],
      [attackStep(0, [first, second], [enemy.battleUnitId], 4)],
    );
    expect(consumptionChanges(afterTwo.recorder)).toEqual([
      ["vuln-1", 2, 1],
      ["vuln-1", 1, 0],
    ]);
    expect(
      afterTwo.result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!.appliedEffects,
    ).toEqual([]);
  });

  it("UT-R-EFF-07-020 [R-EFF-07]: consumption.damageType limits which attacks consume the effect", () => {
    const actor = unit("ACTOR", "ALLY");
    const enGuard = consumedStatMod("ACT_EN_GUARD", "DEFENSE", 0, {
      kind: "NEXT_INCOMING_ATTACK",
      maxCount: 1,
      damageType: "EN",
    });
    const enemy = unit("ENEMY", "ENEMY", {
      appliedEffects: [consumedInstance("guard-1", enGuard, createBattleUnitId("ENEMY"), 1)],
    });
    const physical = damageAction("ACT_PHYSICAL", 2);
    const en = enDamageAction("ACT_EN", 2);

    const afterPhysical = resolveAttackSteps(
      [actor, enemy],
      [physical, enGuard],
      [attackStep(0, [physical], [enemy.battleUnitId], 2)],
    );
    expect(consumptionChanges(afterPhysical.recorder)).toEqual([]);

    const afterEn = resolveAttackSteps(
      [actor, enemy],
      [en, enGuard],
      [attackStep(0, [en], [enemy.battleUnitId], 2)],
    );
    expect(consumptionChanges(afterEn.recorder)).toEqual([["guard-1", 1, 0]]);
    expect(
      afterEn.result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!.appliedEffects,
    ).toEqual([]);
  });

  it("UT-R-EFF-07-023 [R-EFF-07]: with two DAMAGE actions over two targets, an outgoing next-attack buff used by the first DAMAGE boosts it on both targets but never the second DAMAGE", () => {
    const atkBuff = consumedStatMod("ACT_ATK_BUFF", "ATTACK", 0.4, {
      kind: "NEXT_OUTGOING_ATTACK",
      maxCount: 1,
    });
    const actor = unit("ACTOR", "ALLY", {
      combatStats: { ...unit("A", "ALLY").combatStats, attack: 28 },
      appliedEffects: [consumedInstance("buff-1", atkBuff, createBattleUnitId("ACTOR"), 1)],
    });
    const front = unit("FRONT", "ENEMY");
    const back = unit("BACK", "ENEMY");
    const first = damageAction("ACT_FIRST", 1);
    const second = damageAction("ACT_SECOND", 1);
    const { recorder, result } = resolveAttackSteps(
      [actor, front, back],
      [first, second, atkBuff],
      [attackStep(0, [first, second], [front.battleUnitId, back.battleUnitId], 1)],
    );

    // 対象ごとに定義順（FRONT: 1つ目→2つ目、BACK: 1つ目→2つ目）で解決する。
    const attackerAttacks = recorder
      .getEvents()
      .filter((e) => e.eventType === "DamageCalculated")
      .map((e) => (e.payload as { attackerAttack: number }).attackerAttack);
    expect(attackerAttacks).toEqual([28, 20, 28, 20]);
    expect(consumptionChanges(recorder)).toEqual([["buff-1", 1, 0]]);
    const finalActor = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(finalActor.appliedEffects).toEqual([]);
    expect(finalActor.combatStats.attack).toBe(20);
  });

  it("UT-R-EFF-07-024 [R-EFF-07]: with two DAMAGE actions over two targets, a target's incoming next-attack debuff used by the first DAMAGE does not carry into the second DAMAGE on that target", () => {
    const defenseDown = consumedStatMod("ACT_DEF_DOWN", "DEFENSE", -0.5, {
      kind: "NEXT_INCOMING_ATTACK",
      maxCount: 1,
    });
    const actor = unit("ACTOR", "ALLY");
    const front = unit("FRONT", "ENEMY", {
      combatStats: { ...unit("E", "ENEMY").combatStats, defense: 5 },
      appliedEffects: [consumedInstance("down-1", defenseDown, createBattleUnitId("FRONT"), 1)],
    });
    const back = unit("BACK", "ENEMY");
    const first = damageAction("ACT_FIRST", 1);
    const second = damageAction("ACT_SECOND", 1);
    const { recorder } = resolveAttackSteps(
      [actor, front, back],
      [first, second, defenseDown],
      [attackStep(0, [first, second], [front.battleUnitId, back.battleUnitId], 1)],
    );

    const defenderDefenses = recorder
      .getEvents()
      .filter((e) => e.eventType === "DamageCalculated")
      .map((e) => (e.payload as { defenderDefense: number }).defenderDefense);
    expect(defenderDefenses).toEqual([5, 10, 10, 10]);
    expect(consumptionChanges(recorder)).toEqual([["down-1", 1, 0]]);
  });

  it("UT-R-EFF-07-025 [R-EFF-07][R-INT-02]: a unit covering two targets of the same DAMAGE keeps its one-attack shield for both covered applications", () => {
    const shieldId = createEffectActionDefinitionId("ACT_ONE_ATTACK_SHIELD");
    const shieldDuration: DurationDefinition = {
      dispellable: true,
      linkedEffectGroupId: null,
      consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
    };
    const shield: EffectActionDefinition = {
      kind: "APPLY_SHIELD",
      effectActionDefinitionId: shieldId,
      metadata: { tags: [] },
      payload: { formula: { kind: "CONSTANT", value: 1000 }, duration: shieldDuration },
    };
    const coverId = createEffectActionDefinitionId("ACT_TEST_COVER");
    const coverer = unit("COVERER", "ENEMY", {
      appliedEffects: [
        {
          effectInstanceId: createEffectInstanceId("shield-1"),
          effectActionDefinitionId: shieldId,
          kindKey: effectKindKeyFromDefinitionId(shieldId),
          duplicate: true,
          sourceUnitId: createBattleUnitId("COVERER"),
          targetUnitId: createBattleUnitId("COVERER"),
          magnitude: 1000,
          categories: ["SHIELD"],
          shield: { shieldType: null, remaining: 1000 },
          duration: { definition: shieldDuration, consumptionRemaining: 1 },
          appliedTurnNumber: 1,
        },
      ],
    });
    // 攻撃者の攻撃を`COVERER`が全量肩代わりする（R-INT-02）。
    const actor = unit("ACTOR", "ALLY", {
      appliedEffects: [
        {
          effectInstanceId: createEffectInstanceId("cover-1"),
          effectActionDefinitionId: coverId,
          kindKey: effectKindKeyFromDefinitionId(coverId),
          duplicate: true,
          sourceUnitId: createBattleUnitId("COVERER"),
          targetUnitId: createBattleUnitId("ACTOR"),
          magnitude: 0,
          categories: ["DEBUFF"],
          cover: {
            covererUnitId: createBattleUnitId("COVERER"),
            damageShareRate: 1,
            guardRate: 0,
            actionKinds: ["DAMAGE"],
          },
          duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
          appliedTurnNumber: 1,
        },
      ],
    });
    const front = unit("FRONT", "ENEMY");
    const back = unit("BACK", "ENEMY");
    const attack = damageAction("ACT_ATTACK", 1);
    const { recorder, result } = resolveAttackSteps(
      [actor, front, back, coverer],
      [attack, shield],
      [attackStep(0, [attack], [front.battleUnitId, back.battleUnitId], 1)],
    );

    const absorbed = recorder
      .getEvents()
      .filter((e) => e.eventType === "ShieldConsumed")
      .map((e) => (e.payload as { absorbed: number }).absorbed);
    expect(absorbed).toEqual([10, 10]);
    expect(consumptionChanges(recorder)).toEqual([["shield-1", 1, 0]]);
    const finalCoverer = result.units.find((u) => u.battleUnitId === coverer.battleUnitId)!;
    expect(finalCoverer.currentHp).toEqual(coverer.currentHp);
    expect(finalCoverer.appliedEffects).toEqual([]);
  });

  it("UT-R-EFF-07-026 [R-EFF-07]: an outgoing buff with two uses, used once by each of two DAMAGE actions, still covers every target of both", () => {
    const atkBuff = consumedStatMod("ACT_ATK_BUFF", "ATTACK", 0.4, {
      kind: "NEXT_OUTGOING_ATTACK",
      maxCount: 2,
    });
    const actor = unit("ACTOR", "ALLY", {
      combatStats: { ...unit("A", "ALLY").combatStats, attack: 28 },
      appliedEffects: [consumedInstance("buff-1", atkBuff, createBattleUnitId("ACTOR"), 2)],
    });
    const front = unit("FRONT", "ENEMY");
    const back = unit("BACK", "ENEMY");
    const first = damageAction("ACT_FIRST", 1);
    const second = damageAction("ACT_SECOND", 1);
    const { recorder, result } = resolveAttackSteps(
      [actor, front, back],
      [first, second, atkBuff],
      [attackStep(0, [first, second], [front.battleUnitId, back.battleUnitId], 1)],
    );

    const attackerAttacks = recorder
      .getEvents()
      .filter((e) => e.eventType === "DamageCalculated")
      .map((e) => (e.payload as { attackerAttack: number }).attackerAttack);
    expect(attackerAttacks).toEqual([28, 28, 28, 28]);
    expect(consumptionChanges(recorder)).toEqual([
      ["buff-1", 2, 1],
      ["buff-1", 1, 0],
    ]);
    const finalActor = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(finalActor.appliedEffects).toEqual([]);
  });

  it("UT-R-EFF-07-027 [R-EFF-07][R-DMG-06]: a bonus attack hit is part of its own DAMAGE — an outgoing next-attack modifier used by the first DAMAGE does not reach the second DAMAGE's bonus hits", () => {
    const damageUpId = createEffectActionDefinitionId("ACT_DMG_UP");
    const damageUpDuration: DurationDefinition = {
      dispellable: true,
      linkedEffectGroupId: null,
      consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
    };
    const damageUp: EffectActionDefinition = {
      kind: "APPLY_DAMAGE_MOD",
      effectActionDefinitionId: damageUpId,
      metadata: { tags: [] },
      payload: {
        direction: "OUTGOING",
        damageType: null,
        formula: { kind: "CONSTANT", value: 1 },
        stacking: { mode: "STACKABLE" },
        duration: damageUpDuration,
      },
    };
    const bonusId = createEffectActionDefinitionId("ACT_ATTACK_DAMAGE_BONUS");
    const bonus: EffectActionDefinition = {
      kind: "APPLY_ATTACK_DAMAGE_BONUS",
      effectActionDefinitionId: bonusId,
      metadata: { tags: [] },
      payload: {
        formula: { kind: "CONSTANT", value: 5 },
        duration: {
          timeLimit: { unit: "BATTLE", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const actorUnitId = createBattleUnitId("ACTOR");
    const actor = unit("ACTOR", "ALLY", {
      appliedEffects: [
        {
          effectInstanceId: createEffectInstanceId("dmg-up-1"),
          effectActionDefinitionId: damageUpId,
          kindKey: effectKindKeyFromDefinitionId(damageUpId),
          duplicate: true,
          sourceUnitId: actorUnitId,
          targetUnitId: actorUnitId,
          magnitude: 1,
          categories: ["BUFF"],
          damageModifier: { direction: "OUTGOING", damageType: null },
          duration: { definition: damageUpDuration, consumptionRemaining: 1 },
          appliedTurnNumber: 1,
        },
        {
          effectInstanceId: createEffectInstanceId("bonus-1"),
          effectActionDefinitionId: bonusId,
          kindKey: effectKindKeyFromDefinitionId(bonusId),
          duplicate: true,
          sourceUnitId: actorUnitId,
          targetUnitId: actorUnitId,
          magnitude: 5,
          categories: ["BUFF"],
          isAttackDamageBonus: true,
          duration: {
            definition: {
              timeLimit: { unit: "BATTLE", count: 1 },
              dispellable: true,
              linkedEffectGroupId: null,
            },
            timeLimitRemaining: 1,
          },
          appliedTurnNumber: 1,
        },
      ],
    });
    const front = unit("FRONT", "ENEMY");
    const back = unit("BACK", "ENEMY");
    const first = damageAction("ACT_FIRST", 1);
    const second = damageAction("ACT_SECOND", 1);
    const { recorder } = resolveAttackSteps(
      [actor, front, back],
      [first, second, damageUp, bonus],
      [attackStep(0, [first, second], [front.battleUnitId, back.battleUnitId], 1)],
    );

    const bonusDamages = recorder
      .getEvents()
      .filter(
        (e) =>
          e.eventType === "DamageCalculated" &&
          (e.payload as { effectActionDefinitionId: string }).effectActionDefinitionId === bonusId,
      )
      .map((e) => (e.payload as { finalDamage: number }).finalDamage);
    expect(bonusDamages).toEqual([10, 5, 10, 5]);
  });

  it("UT-R-EFF-07-028 [R-EFF-07][R-DMG-05]: the DamageWillBeApplied snapshot records only the modifiers effective for its own DAMAGE, matching DamageCalculated", () => {
    const damageUpId = createEffectActionDefinitionId("ACT_DMG_UP");
    const damageUpDuration: DurationDefinition = {
      dispellable: true,
      linkedEffectGroupId: null,
      consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
    };
    const damageUp: EffectActionDefinition = {
      kind: "APPLY_DAMAGE_MOD",
      effectActionDefinitionId: damageUpId,
      metadata: { tags: [] },
      payload: {
        direction: "OUTGOING",
        damageType: null,
        formula: { kind: "CONSTANT", value: 1 },
        stacking: { mode: "STACKABLE" },
        duration: damageUpDuration,
      },
    };
    const actorUnitId = createBattleUnitId("ACTOR");
    const actor = unit("ACTOR", "ALLY", {
      appliedEffects: [
        {
          effectInstanceId: createEffectInstanceId("dmg-up-1"),
          effectActionDefinitionId: damageUpId,
          kindKey: effectKindKeyFromDefinitionId(damageUpId),
          duplicate: true,
          sourceUnitId: actorUnitId,
          targetUnitId: actorUnitId,
          magnitude: 1,
          categories: ["BUFF"],
          damageModifier: { direction: "OUTGOING", damageType: null },
          duration: { definition: damageUpDuration, consumptionRemaining: 1 },
          appliedTurnNumber: 1,
        },
      ],
    });
    const front = unit("FRONT", "ENEMY");
    const back = unit("BACK", "ENEMY");
    const first = damageAction("ACT_FIRST", 1);
    const second = damageAction("ACT_SECOND", 1);
    const { recorder } = resolveAttackSteps(
      [actor, front, back],
      [first, second, damageUp],
      [attackStep(0, [first, second], [front.battleUnitId, back.battleUnitId], 1)],
    );

    const outgoingOf = (eventType: "DamageWillBeApplied" | "DamageCalculated") =>
      recorder
        .getEvents()
        .filter((e) => e.eventType === eventType)
        .map((e) => (e.payload as { outgoingDamageMultiplier: number }).outgoingDamageMultiplier);
    expect(outgoingOf("DamageCalculated")).toEqual([2, 1, 2, 1]);
    expect(outgoingOf("DamageWillBeApplied")).toEqual([2, 1, 2, 1]);
  });

  it("UT-R-EFF-07-021 [R-EFF-07]: an ACTION-scoped consumption stays (at 0) through later attacks of the same action instead of expiring at the end of the first attack", () => {
    const atkBuff = consumedStatMod("ACT_ATK_BUFF", "ATTACK", 0.4, {
      kind: "NEXT_OUTGOING_ATTACK",
      maxCount: 1,
      scope: "ACTION",
    });
    const actor = unit("ACTOR", "ALLY", {
      combatStats: { ...unit("A", "ALLY").combatStats, attack: 28 },
      appliedEffects: [consumedInstance("buff-1", atkBuff, createBattleUnitId("ACTOR"), 1)],
    });
    const enemy = unit("ENEMY", "ENEMY");
    const first = damageAction("ACT_FIRST", 1);
    const second = damageAction("ACT_SECOND", 1);
    const { recorder, result } = resolveAttackSteps(
      [actor, enemy],
      [first, second, atkBuff],
      [
        attackStep(0, [first], [enemy.battleUnitId], 1),
        attackStep(1, [second], [enemy.battleUnitId], 1),
      ],
      { actionId: createActionId("action-1") },
    );

    const attackerAttacks = recorder
      .getEvents()
      .filter((e) => e.eventType === "DamageCalculated")
      .map((e) => (e.payload as { attackerAttack: number }).attackerAttack);
    expect(attackerAttacks).toEqual([28, 28]);
    expect(consumptionChanges(recorder)).toEqual([["buff-1", 1, 0]]);
    expect(recorder.getEvents().some((e) => e.eventType === "EffectExpired")).toBe(false);
    const finalActor = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(finalActor.appliedEffects.map((e) => e.duration.consumptionRemaining)).toEqual([0]);
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

function consumedStatMod(
  id: string,
  stat: "ATTACK" | "DEFENSE",
  value: number,
  consumption: NonNullable<DurationDefinition["consumption"]>,
): EffectActionDefinition {
  return {
    kind: "APPLY_STAT_MOD",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    metadata: { tags: [] },
    payload: {
      stat,
      valueType: "RATIO",
      formula: { kind: "CONSTANT", value },
      stacking: { mode: "STACKABLE", max: null },
      duration: { dispellable: true, linkedEffectGroupId: null, consumption },
    },
  };
}

function consumedInstance(
  id: string,
  definition: EffectActionDefinition,
  holderId: BattleUnit["battleUnitId"],
  consumptionRemaining: number,
): AppliedEffect {
  if (definition.kind !== "APPLY_STAT_MOD") {
    throw new Error("consumedInstance expects an APPLY_STAT_MOD definition");
  }
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: definition.effectActionDefinitionId,
    kindKey: effectKindKeyFromDefinitionId(definition.effectActionDefinitionId),
    duplicate: true,
    sourceUnitId: holderId,
    targetUnitId: holderId,
    magnitude:
      definition.payload.formula.kind === "CONSTANT" ? definition.payload.formula.value : 0,
    categories: ["BUFF"],
    duration: { definition: definition.payload.duration, consumptionRemaining },
    appliedTurnNumber: 1,
  };
}

function enDamageAction(id: string, hitCount: number): EffectActionDefinition {
  const base = damageAction(id, hitCount);
  if (base.kind !== "DAMAGE") {
    throw new Error("damageAction must build a DAMAGE definition");
  }
  return { ...base, payload: { ...base.payload, damageType: "EN" } };
}

/** 対象ごとに`actions`を定義順で並べる（`buildApplications`と同じ並び）。 */
function attackStep(
  stepIndex: number,
  actions: readonly EffectActionDefinition[],
  targetUnitIds: readonly BattleUnit["battleUnitId"][],
  hitCount: number,
): EffectSequencePlan["steps"][number] {
  return {
    planKind: "ACTION_PLAN",
    stepIndex,
    stepKind: "ACTION",
    conditionKind: "TRUE",
    satisfied: true,
    actions: actions.map((a) => ({ effectActionDefinitionId: a.effectActionDefinitionId })),
    applications: targetUnitIds.flatMap((targetUnitId) =>
      actions.map((a) => ({
        targetUnitId,
        effectActionDefinitionId: a.effectActionDefinitionId,
        includeDefeated: false,
        hits: Array.from({ length: hitCount }, (_, i) => ({
          targetUnitId,
          effectActionDefinitionId: a.effectActionDefinitionId,
          hitIndex: i + 1,
        })),
      })),
    ),
  };
}

function resolveAttackSteps(
  units: readonly BattleUnit[],
  definitions: readonly EffectActionDefinition[],
  steps: EffectSequencePlan["steps"],
  contextOverrides: Partial<ReturnType<typeof contextFor>> = {},
): {
  readonly recorder: ReturnType<typeof seedRecorder>["recorder"];
  readonly result: ReturnType<typeof applyEffectActionGroups>;
} {
  const { recorder, rootEventId } = seedRecorder();
  const context = {
    ...contextFor(
      units[0]!,
      new Map(definitions.map((d) => [d.effectActionDefinitionId, d])),
      recorder,
      rootEventId,
    ),
    ...contextOverrides,
  };
  const plan: EffectSequencePlan = {
    stealthConsumptions: [],
    steps,
    targetUnitIds: units.slice(1).map((u) => u.battleUnitId),
    resolvedBindings: new Map(),
  };
  return { recorder, result: applyEffectActionGroups(plan, units, context) };
}

/** `EffectConsumptionChanged`を「インスタンスID, before, after」で並べる。 */
function consumptionChanges(
  recorder: ReturnType<typeof seedRecorder>["recorder"],
): (string | number)[][] {
  return recorder
    .getEvents()
    .filter((e) => e.eventType === "EffectConsumptionChanged")
    .map((e) => {
      const payload = e.payload as { effectInstanceId: string; before: number; after: number };
      return [payload.effectInstanceId, payload.before, payload.after];
    });
}
