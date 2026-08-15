import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "./action-skill-use-resolver.js";
import { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { createHitPoint } from "../model/resource-gauge.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import type { BattleUnit } from "../model/battle-unit.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import { testBattleUnit } from "../../../testing/fixtures/battle-actors.js";
import { testUnitDefinition } from "../../../testing/fixtures/unit-definitions.js";
import { createActionId } from "../../shared/event-ids.js";

/**
 * R-FUP-01（Issue #474）: AS/EXスキル使用単位の追撃解決。追撃が全step解決後・
 * `SkillUseCompleted`発行前に1回だけ発生し、元攻撃が1発も命中しなければ発生しない
 * こと、ライダーが「次の攻撃1回」で失効することを、`resolveSkillUse`の実経路で固定する。
 */
describe("resolveFollowUpAttacksAfterSkillUse via resolveSkillUse (R-FUP-01)", () => {
  const AS_ID = "SKL_TEST_FUP_AS";
  const AS_DAMAGE_ID = "ACT_TEST_FUP_AS_DAMAGE";
  const RIDER_ID = "ACT_TEST_FUP_RIDER";
  const SPEED_DOWN_ID = "ACT_TEST_FUP_SPEED_DOWN";

  function asDamageAction(): EffectActionDefinition {
    return {
      kind: "DAMAGE",
      effectActionDefinitionId: createEffectActionDefinitionId(AS_DAMAGE_ID),
      metadata: { tags: [] },
      payload: {
        damageType: "PHYSICAL",
        formula: { kind: "SKILL_POWER", power: 1 },
        hitCount: 1,
        critical: { mode: "PREVENTED" },
        accuracy: { mode: "NORMAL" },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
        damageModifiers: [],
        link: { enabled: false },
      },
    };
  }

  function speedDownAction(): EffectActionDefinition {
    return {
      kind: "APPLY_STAT_MOD",
      effectActionDefinitionId: createEffectActionDefinitionId(SPEED_DOWN_ID),
      metadata: { tags: [] },
      payload: {
        stat: "ACTION_SPEED",
        valueType: "FIXED",
        formula: { kind: "CONSTANT", value: -200 },
        stacking: { mode: "STACKABLE", max: null },
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
  }

  function riderDefinition(): EffectActionDefinition {
    return {
      kind: "APPLY_FOLLOW_UP_ATTACK",
      effectActionDefinitionId: createEffectActionDefinitionId(RIDER_ID),
      metadata: { tags: [] },
      payload: {
        damage: { damageType: "EN", formula: { kind: "SKILL_POWER", power: 0.5 } },
        onHitEffect: { effectActionDefinitionId: createEffectActionDefinitionId(SPEED_DOWN_ID) },
        duration: {
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
  }

  function attackSkill(
    actionIds: readonly string[] = [AS_DAMAGE_ID],
    skillId: string = AS_ID,
  ): SkillDefinition {
    const binding = createTargetBindingId("TGT_TEST_FUP");
    return {
      skillDefinitionId: createSkillDefinitionId(skillId),
      skillType: "AS",
      cost: { resource: "AP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [],
      counterUpdates: [],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [
          {
            targetBindingId: binding,
            selector: {
              kind: "SELECT",
              side: "ENEMY",
              count: 1,
              filters: [],
              order: ["DEFAULT"],
              includeDefeated: false,
            },
          },
        ],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: binding },
            actions: actionIds.map((actionId) => ({
              effectActionDefinitionId: createEffectActionDefinitionId(actionId),
            })),
          },
        ],
      },
      cooldown: { unit: "ACTION", count: 0 },
      traits: {
        priorityAttack: false,
        simultaneousActivationLimited: false,
        exclusiveActivationGroupId: null,
        accuracy: { guaranteedHit: false },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      },
      metadata: { displayName: skillId, tags: [] },
    };
  }

  function riderEffect(holderId: string, instanceId = "RIDER_1"): AppliedEffect {
    const definitionId = createEffectActionDefinitionId(RIDER_ID);
    return {
      effectInstanceId: createEffectInstanceId(instanceId),
      effectActionDefinitionId: definitionId,
      kindKey: effectKindKeyFromDefinitionId(definitionId),
      duplicate: true,
      sourceUnitId: createBattleUnitId("ally:grantor"),
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

  function definitions(extraSkills: readonly SkillDefinition[] = []): BattleDefinitions {
    const skill = attackSkill();
    const attackerDefinition = testUnitDefinition("UNIT_TEST_ATTACKER");
    const enemyDefinition = testUnitDefinition("UNIT_TEST_ENEMY");
    return {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: new Map(
        [asDamageAction(), speedDownAction(), riderDefinition()].map((action) => [
          action.effectActionDefinitionId,
          action,
        ]),
      ),
      unitDefinitions: new Map([
        [attackerDefinition.unitDefinitionId, attackerDefinition],
        [enemyDefinition.unitDefinitionId, enemyDefinition],
      ]),
      skillDefinitions: new Map(
        [skill, ...extraSkills].map((definition) => [definition.skillDefinitionId, definition]),
      ),
    };
  }

  function board(
    options: {
      readonly enemyEffects?: readonly AppliedEffect[];
      readonly attackerEffects?: readonly AppliedEffect[];
      readonly attackerHp?: number;
    } = {},
  ): {
    attacker: BattleUnit;
    enemy: BattleUnit;
  } {
    const attackerBase = testBattleUnit({
      battleUnitId: "ally:attacker",
      unitDefinitionId: "UNIT_TEST_ATTACKER",
      combatStats: { attack: 100, defense: 10, maximumHp: 1000, criticalRate: 0 },
      overrides: {},
    });
    const attacker: BattleUnit = {
      ...attackerBase,
      currentAp: 2,
      appliedEffects: options.attackerEffects ?? [riderEffect("ally:attacker")],
      ...(options.attackerHp !== undefined
        ? { currentHp: createHitPoint(options.attackerHp, attackerBase.combatStats.maximumHp) }
        : {}),
    };
    const enemyBase = testBattleUnit({
      battleUnitId: "enemy:1",
      unitDefinitionId: "UNIT_TEST_ENEMY",
      side: "ENEMY",
      combatStats: { attack: 50, defense: 20, maximumHp: 1000 },
    });
    const enemy: BattleUnit = {
      ...enemyBase,
      ...(options.enemyEffects !== undefined ? { appliedEffects: options.enemyEffects } : {}),
    };
    return { attacker, enemy };
  }

  function useSkill(
    attacker: BattleUnit,
    enemy: BattleUnit,
    battleDefinitions: BattleDefinitions,
    skillId: string,
    battleId: string,
  ): { result: ReturnType<typeof resolveSkillUse>; recorder: EventRecorder } {
    const recorder = new EventRecorder(createBattleId(battleId));
    const result = resolveSkillUse(
      attacker,
      battleDefinitions.skillDefinitions.get(createSkillDefinitionId(skillId))!,
      "AS",
      "AS",
      [attacker, enemy],
      battleDefinitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId(`${battleId}:action:1`),
      recorder.nextResolutionScopeId(),
    );
    return { result, recorder };
  }

  function followUpDamageEvents(recorder: EventRecorder): readonly BattleDomainEvent[] {
    return recorder
      .getEvents()
      .filter(
        (event) =>
          event.eventType === "DamageCalculated" &&
          (event.payload as { effectActionDefinitionId?: string }).effectActionDefinitionId ===
            RIDER_ID,
      );
  }

  it("UT-R-FUP-01-008: resolves the follow-up once after all steps and before SkillUseCompleted, grants the onHitEffect, and expires the rider", () => {
    const { attacker, enemy } = board();
    const recorder = new EventRecorder(createBattleId("B_FUP"));
    const result = resolveSkillUse(
      attacker,
      definitions().skillDefinitions.get(createSkillDefinitionId(AS_ID))!,
      "AS",
      "AS",
      [attacker, enemy],
      definitions(),
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_FUP:action:1"),
      recorder.nextResolutionScopeId(),
    );

    const enemyAfter = result.units.find((unit) => unit.battleUnitId === enemy.battleUnitId)!;
    // AS本体: (100 - 20) x 1.0 = 80。追撃: (100 - 20) x 0.5 = 40（非会心継承・必中）。
    expect(enemyAfter.currentHp).toBe(1000 - 80 - 40);
    // onHitEffect（速度-200）が追撃ヒット対象へ付与される。
    expect(
      enemyAfter.appliedEffects.some(
        (effect) =>
          effect.effectActionDefinitionId === createEffectActionDefinitionId(SPEED_DOWN_ID),
      ),
    ).toBe(true);
    // ライダーは「次の攻撃1回」で消費・失効する。
    const attackerAfter = result.units.find((unit) => unit.battleUnitId === attacker.battleUnitId)!;
    expect(attackerAfter.appliedEffects.some((effect) => effect.isFollowUpAttack)).toBe(false);

    // 追撃の`DamageCalculated`は、AS本体の全stepの後・`SkillUseCompleted`の前に1回だけ。
    const events = recorder.getEvents();
    const followUpDamageIndices = events
      .map((event, index) => ({ event, index }))
      .filter(
        ({ event }) =>
          event.eventType === "DamageCalculated" &&
          (event.payload as { effectActionDefinitionId?: string }).effectActionDefinitionId ===
            RIDER_ID,
      )
      .map(({ index }) => index);
    expect(followUpDamageIndices).toHaveLength(1);
    const lastEffectActionCompleted = events.reduce(
      (last, event, index) => (event.eventType === "EffectActionCompleted" ? index : last),
      -1,
    );
    const skillUseCompleted = events.findIndex((event) => event.eventType === "SkillUseCompleted");
    expect(followUpDamageIndices[0]!).toBeGreaterThan(lastEffectActionCompleted);
    expect(skillUseCompleted).toBeGreaterThan(followUpDamageIndices[0]!);
  });

  it("UT-R-FUP-01-008B: when every hit of the original attack misses, no follow-up occurs and the rider is still consumed", () => {
    const evasion: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("EVADE_1"),
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_TEST_FUP_EVASION"),
      kindKey: effectKindKeyFromDefinitionId(
        createEffectActionDefinitionId("ACT_TEST_FUP_EVASION"),
      ),
      duplicate: true,
      targetUnitId: createBattleUnitId("enemy:1"),
      magnitude: 0,
      categories: ["BUFF"],
      statusKind: "EVASION",
      statusDetails: { probability: 1 },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
    const { attacker, enemy } = board({ enemyEffects: [evasion] });
    const recorder = new EventRecorder(createBattleId("B_FUP_MISS"));
    const result = resolveSkillUse(
      attacker,
      definitions().skillDefinitions.get(createSkillDefinitionId(AS_ID))!,
      "AS",
      "AS",
      [attacker, enemy],
      definitions(),
      // 回避確率1の判定1回分。
      new SequenceRandomSource([0]),
      recorder,
      1,
      0,
      createActionId("B_FUP_MISS:action:1"),
      recorder.nextResolutionScopeId(),
    );

    const enemyAfter = result.units.find((unit) => unit.battleUnitId === enemy.battleUnitId)!;
    expect(enemyAfter.currentHp).toBe(1000);
    expect(
      enemyAfter.appliedEffects.some(
        (effect) =>
          effect.effectActionDefinitionId === createEffectActionDefinitionId(SPEED_DOWN_ID),
      ),
    ).toBe(false);
    expect(
      recorder
        .getEvents()
        .filter(
          (event) =>
            event.eventType === "DamageCalculated" &&
            (event.payload as { effectActionDefinitionId?: string }).effectActionDefinitionId ===
              RIDER_ID,
        ),
    ).toHaveLength(0);
    // 消費は命中判定到達時点（R-EFF-07）— 全ヒットMISSでもライダーは失効している。
    const attackerAfter = result.units.find((unit) => unit.battleUnitId === attacker.battleUnitId)!;
    expect(attackerAfter.appliedEffects.some((effect) => effect.isFollowUpAttack)).toBe(false);
  });

  it("UT-R-FUP-01-009: a skill with multiple DAMAGE actions still resolves the follow-up exactly once, after the last DAMAGE action", () => {
    const MULTI_AS_ID = "SKL_TEST_FUP_AS_MULTI";
    const battleDefinitions = definitions([attackSkill([AS_DAMAGE_ID, AS_DAMAGE_ID], MULTI_AS_ID)]);
    const { attacker, enemy } = board();

    const { result, recorder } = useSkill(
      attacker,
      enemy,
      battleDefinitions,
      MULTI_AS_ID,
      "B_FUP_MULTI",
    );

    // AS本体: (100 - 20) x 2 action = 160。追撃はスキル末尾に1回だけ（40）。
    const enemyAfter = result.units.find((unit) => unit.battleUnitId === enemy.battleUnitId)!;
    expect(enemyAfter.currentHp).toBe(1000 - 80 - 80 - 40);
    const followUps = followUpDamageEvents(recorder);
    expect(followUps).toHaveLength(1);
    // 追撃は2つ目のDAMAGE actionの後 — AS本体の`DamageCalculated`2件より後に位置する。
    const events = recorder.getEvents();
    const asDamageIndices = events
      .map((event, index) => ({ event, index }))
      .filter(
        ({ event }) =>
          event.eventType === "DamageCalculated" &&
          (event.payload as { effectActionDefinitionId?: string }).effectActionDefinitionId ===
            AS_DAMAGE_ID,
      )
      .map(({ index }) => index);
    expect(asDamageIndices).toHaveLength(2);
    expect(events.indexOf(followUps[0]!)).toBeGreaterThan(asDamageIndices[1]!);
  });

  it("UT-R-FUP-01-010: each of two rider instances adds its own follow-up hit", () => {
    const { attacker, enemy } = board({
      attackerEffects: [
        riderEffect("ally:attacker", "RIDER_1"),
        riderEffect("ally:attacker", "RIDER_2"),
      ],
    });
    const battleDefinitions = definitions();

    const { result, recorder } = useSkill(attacker, enemy, battleDefinitions, AS_ID, "B_FUP_TWO");

    const enemyAfter = result.units.find((unit) => unit.battleUnitId === enemy.battleUnitId)!;
    expect(enemyAfter.currentHp).toBe(1000 - 80 - 40 - 40);
    const followUps = followUpDamageEvents(recorder);
    expect(followUps.map((event) => (event.payload as { hitIndex?: number }).hitIndex)).toEqual([
      0, 1,
    ]);
    const attackerAfter = result.units.find((unit) => unit.battleUnitId === attacker.battleUnitId)!;
    expect(attackerAfter.appliedEffects.some((effect) => effect.isFollowUpAttack)).toBe(false);
  });

  it("UT-R-FUP-01-011: a skill without any DAMAGE action neither consumes the rider nor triggers a follow-up", () => {
    const BUFF_AS_ID = "SKL_TEST_FUP_BUFF_AS";
    const battleDefinitions = definitions([attackSkill([SPEED_DOWN_ID], BUFF_AS_ID)]);
    const { attacker, enemy } = board();

    const { result, recorder } = useSkill(
      attacker,
      enemy,
      battleDefinitions,
      BUFF_AS_ID,
      "B_FUP_BUFF",
    );

    expect(followUpDamageEvents(recorder)).toHaveLength(0);
    // 攻撃を含まないスキルは`NEXT_OUTGOING_ATTACK`の消費点を持たない（R-EFF-07・Q-FUP-05）。
    const attackerAfter = result.units.find((unit) => unit.battleUnitId === attacker.battleUnitId)!;
    const rider = attackerAfter.appliedEffects.find((effect) => effect.isFollowUpAttack);
    expect(rider?.duration?.consumptionRemaining).toBe(1);
    expect(recorder.getEvents().some((event) => event.eventType === "SkillUseCompleted")).toBe(
      true,
    );
  });

  it("UT-R-FUP-01-012: when the actor is defeated during a follow-up hit, the remaining riders stay unresolved and the skill use reports SkillUseInterrupted", () => {
    // 敵の反射（受けたダメージの100%）で、AS本体の反射80は耐え（HP100→20）、
    // 1件目の追撃40の反射で使用者が戦闘不能になる。2件目のライダーは未解決のまま
    // 中断され、完了契機PS・SKILL_USE期間減算を誤って走らせないため
    // `SkillUseCompleted`ではなく`SkillUseInterrupted`を発行する（R-SKL-01／R-FUP-01 #6）。
    const reflectDefinitionId = createEffectActionDefinitionId("ACT_TEST_FUP_REFLECT");
    const reflect: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("REFLECT_1"),
      effectActionDefinitionId: reflectDefinitionId,
      kindKey: effectKindKeyFromDefinitionId(reflectDefinitionId),
      duplicate: true,
      targetUnitId: createBattleUnitId("enemy:1"),
      magnitude: 0,
      categories: ["BUFF"],
      reflect: {
        formula: { kind: "DAMAGE_RECEIVED_RATIO", sourceResult: "LAST_DAMAGE_RECEIVED", ratio: 1 },
        allowRecursiveReflect: false,
      },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
    const { attacker, enemy } = board({
      attackerEffects: [
        riderEffect("ally:attacker", "RIDER_1"),
        riderEffect("ally:attacker", "RIDER_2"),
      ],
      attackerHp: 100,
      enemyEffects: [reflect],
    });
    const battleDefinitions = definitions();

    const { result, recorder } = useSkill(attacker, enemy, battleDefinitions, AS_ID, "B_FUP_INT");

    const attackerAfter = result.units.find((unit) => unit.battleUnitId === attacker.battleUnitId)!;
    expect(attackerAfter.currentHp).toBe(0);
    // 1件目の追撃までは解決され、2件目は未解決のまま中断される。
    expect(followUpDamageEvents(recorder)).toHaveLength(1);
    const eventTypes = recorder.getEvents().map((event) => event.eventType);
    expect(eventTypes).not.toContain("SkillUseCompleted");
    expect(eventTypes).toContain("SkillUseInterrupted");
  });
});
