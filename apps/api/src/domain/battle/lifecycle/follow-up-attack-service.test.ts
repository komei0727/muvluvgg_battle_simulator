import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "./action-skill-use-resolver.js";
import { EventRecorder } from "../events/event-recorder.js";
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

  function attackSkill(): SkillDefinition {
    const binding = createTargetBindingId("TGT_TEST_FUP");
    return {
      skillDefinitionId: createSkillDefinitionId(AS_ID),
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
            actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(AS_DAMAGE_ID) }],
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
      metadata: { displayName: AS_ID, tags: [] },
    };
  }

  function riderEffect(holderId: string): AppliedEffect {
    const definitionId = createEffectActionDefinitionId(RIDER_ID);
    return {
      effectInstanceId: createEffectInstanceId("RIDER_1"),
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

  function definitions(): BattleDefinitions {
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
      skillDefinitions: new Map([[skill.skillDefinitionId, skill]]),
    };
  }

  function board(options: { readonly enemyEffects?: readonly AppliedEffect[] } = {}): {
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
      appliedEffects: [riderEffect("ally:attacker")],
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
});
