import { describe, expect, it } from "vitest";
import {
  createCapabilityDefinition,
  type CapabilityDefinition,
} from "../capability/capability-definition.js";
import {
  buildCatalogIndex,
  CatalogIntegrityError,
  type CatalogDefinitions,
} from "./catalog-integrity.js";
import type { EffectActionDefinition } from "../definitions/effect-action-definition.js";
import { createEffectActionDefinition } from "../definitions/effect-action-definition-factory.js";
import { createMemoryDefinition } from "../definitions/memory-definition.js";
import { createSkillDefinition, type SkillDefinition } from "../definitions/skill-definition.js";
import type { TargetReferenceInput } from "../definitions/references.js";
import type { TargetSelectorDefinitionInput } from "../definitions/target-selector-definition.js";
import { createUnitDefinition, type UnitDefinition } from "../definitions/unit-definition.js";
import type { ConditionDefinitionInput } from "../definitions/condition-definition.js";
import type { EffectStepDefinitionInput } from "../definitions/effect-sequence.js";

function damageAction(id: string): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "DAMAGE",
      payload: { damageType: "PHYSICAL", formula: { kind: "SKILL_POWER", power: 1 } },
      requiredCapabilities: [],
    },
    "effectAction",
  );
}

/**
 * M7-006（Issue #179、R-MEM-04）: Memory の `triggeredEffects` は使用者BattleUnitを
 * 持たないため、`DAMAGE`のように発生源を必要とするEffectActionを参照できない
 * （`MEMORY_REQUIRES_SOURCE_UNIT`）。Memory用fixtureはこの静的なmodifierを使う。
 */
function memoryModifierAction(id: string): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "APPLY_DAMAGE_MOD",
      payload: {
        direction: "INCOMING",
        damageType: null,
        formula: { kind: "CONSTANT", value: 0.1 },
        stacking: { mode: "STACKABLE" },
        duration: { dispellable: true, timeLimit: { unit: "BATTLE", count: 1 } },
      },
      requiredCapabilities: [],
    },
    "effectAction",
  );
}

/**
 * M7-006 レビュー[P2]（PR #260）: Memoryの`triggeredEffects`が「使用者BattleUnitを
 * 必要とする」構成を宣言したケースを組み立てるためのfixture群。
 */
function memoryWithTrigger(
  memoryDefinitionId: string,
  condition: ConditionDefinitionInput,
  effectActionDefinitionId = "ACT_MEMORY_STAT_MOD",
) {
  return createMemoryDefinition({
    memoryDefinitionId,
    triggeredEffects: [
      {
        trigger: {
          eventType: "BattleStarted",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition,
        },
        effectSequence: {
          targetBindings: [
            {
              targetBindingId: "TGT_ALL_ALLIES",
              selector: { kind: "SELECT", side: "ALLY", count: "ALL" },
            },
          ],
          steps: [
            {
              kind: "ACTION",
              target: { kind: "BINDING", targetBindingId: "TGT_ALL_ALLIES" },
              actions: [{ effectActionDefinitionId }],
            },
          ],
        },
      },
    ],
    requiredCapabilities: ["CAP_MEMORY_TRIGGERED_EFFECT", "CAP_PASSIVE_ACTIVATION_CONDITION"],
    metadata: { displayName: memoryDefinitionId },
  });
}

function memoryUsing(memoryDefinitionId: string, effectActionDefinitionId: string) {
  return createMemoryDefinition({
    memoryDefinitionId,
    triggeredEffects: [
      {
        trigger: {
          eventType: "BattleStarted",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
        },
        effectSequence: {
          targetBindings: [
            {
              targetBindingId: "TGT_ALL_ALLIES",
              selector: { kind: "SELECT", side: "ALLY", count: "ALL" },
            },
          ],
          steps: [
            {
              kind: "ACTION",
              target: { kind: "BINDING", targetBindingId: "TGT_ALL_ALLIES" },
              actions: [{ effectActionDefinitionId }],
            },
          ],
        },
      },
    ],
    requiredCapabilities: ["CAP_MEMORY_TRIGGERED_EFFECT"],
    metadata: { displayName: memoryDefinitionId },
  });
}

function effectImmunityAction(
  id: string,
  referencedEffectActionIds: readonly string[],
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "EFFECT_IMMUNITY",
      payload: {
        categories: ["SPECIFIC_EFFECT"],
        effectActionDefinitionIds: referencedEffectActionIds,
        duration: { timeLimit: { unit: "ACTION", count: 1 }, dispellable: true },
        maxBlocks: null,
      },
      requiredCapabilities: [],
    },
    "effectAction",
  );
}

function removeEffectsAction(
  id: string,
  referencedEffectActionIds: readonly string[],
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "REMOVE_EFFECTS",
      payload: {
        categories: ["SPECIFIC_EFFECT"],
        effectActionDefinitionIds: referencedEffectActionIds,
      },
      requiredCapabilities: [],
    },
    "effectAction",
  );
}

/** M7-001B（Issue #243、EFFECT_IMMUNITY_STATUS_GRANULARITY、R-EFF-03）。 */
function statusScopedImmunityAction(
  id: string,
  requiredCapabilities: readonly string[] = [],
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "EFFECT_IMMUNITY",
      payload: {
        categories: ["STATUS"],
        statusKinds: ["STUN"],
        duration: { timeLimit: { unit: "ACTION", count: 1 }, dispellable: true },
        maxBlocks: null,
      },
      requiredCapabilities,
    },
    "effectAction",
  );
}

function removeEffectsCategoryAction(
  id: string,
  categories: readonly ("BUFF" | "DEBUFF" | "STATUS" | "DAMAGE_MOD" | "SHIELD" | "SUBUNIT")[],
  requiredCapabilities: readonly string[] = [],
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "REMOVE_EFFECTS",
      payload: { categories },
      requiredCapabilities,
    },
    "effectAction",
  );
}

function asSkill(id: string, targetActionId: string): SkillDefinition {
  return createSkillDefinition({
    skillDefinitionId: id,
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [
        {
          targetBindingId: "TGT_PRIMARY",
          selector: { kind: "SELECT", side: "ENEMY", count: 1, order: ["DEFAULT"] },
        },
      ],
      steps: [
        {
          kind: "ACTION",
          target: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
          actions: [{ effectActionDefinitionId: targetActionId }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 1 },
    traits: {},
    requiredCapabilities: [],
    metadata: { displayName: "AS" },
  });
}

/**
 * M7-016（Issue #270）: `resolution.kind: CHARGE`の最小スキル。開始側・解放側とも
 * 敵1体を対象にし、`CAP_CHARGE_RESTRICTION`宣言の有無だけを切り替えられる。
 */
function chargeSkill(id: string, requiredCapabilities: readonly string[]): SkillDefinition {
  return createSkillDefinition({
    skillDefinitionId: id,
    skillType: "AS",
    cost: { resource: "AP", amount: 2 },
    resolution: {
      kind: "CHARGE",
      targetBindings: [
        {
          targetBindingId: "TGT_START",
          selector: { kind: "SELECT", side: "ENEMY", count: 1, order: ["DEFAULT"] },
        },
      ],
      // M7-016（Issue #270 レビュー[P1]）: CHARGE開始側は効果を解決しないため
      // `steps`は常に空でなければならない。
      steps: [],
      chargeRelease: {
        targetBindings: [
          {
            targetBindingId: "TGT_RELEASE",
            selector: { kind: "SELECT", side: "ENEMY", count: 1, order: ["DEFAULT"] },
          },
        ],
        steps: [
          {
            kind: "ACTION",
            target: { kind: "BINDING", targetBindingId: "TGT_RELEASE" },
            actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
          },
        ],
      },
    },
    cooldown: { unit: "ACTION", count: 2 },
    traits: {},
    requiredCapabilities,
    metadata: { displayName: "Charge AS" },
  });
}

function branchSkill(id: string, requiredCapabilities: readonly string[]): SkillDefinition {
  return createSkillDefinition({
    skillDefinitionId: id,
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    resolution: {
      kind: "IMMEDIATE",
      steps: [
        {
          kind: "BRANCH",
          condition: { kind: "TRUE" },
          thenSteps: [
            {
              kind: "ACTION",
              target: { kind: "SELF" },
              actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
            },
          ],
          elseSteps: [],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 1 },
    traits: {},
    requiredCapabilities,
    metadata: { displayName: "BRANCH AS" },
  });
}

function conditionalActionSkill(
  id: string,
  requiredCapabilities: readonly string[],
): SkillDefinition {
  return createSkillDefinition({
    skillDefinitionId: id,
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    resolution: {
      kind: "IMMEDIATE",
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TURN_NUMBER", op: "GTE", value: 1 },
          target: { kind: "SELF" },
          actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 1 },
    traits: {},
    requiredCapabilities,
    metadata: { displayName: "Conditional AS" },
  });
}

function setConditionActionSkill(
  id: string,
  requiredCapabilities: readonly string[],
): SkillDefinition {
  return createSkillDefinition({
    skillDefinitionId: id,
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    resolution: {
      kind: "IMMEDIATE",
      steps: [
        {
          kind: "ACTION",
          stepCondition: {
            kind: "TARGET_SET_COUNT",
            target: { kind: "SELF" },
            op: "GTE",
            value: 1,
          },
          target: { kind: "SELF" },
          actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 1 },
    traits: {},
    requiredCapabilities,
    metadata: { displayName: "Set-condition AS" },
  });
}

/** CAP_TRIGGER_PAYLOAD_IN_RESOLUTION（Issue #247 M7-001D）: `stepCondition`にEVENT_PAYLOADを含むACTION step。 */
function eventPayloadActionSkill(
  id: string,
  requiredCapabilities: readonly string[],
  skillType: "AS" | "EX" = "AS",
): SkillDefinition {
  return createSkillDefinition({
    skillDefinitionId: id,
    skillType,
    cost: skillType === "AS" ? { resource: "AP", amount: 1 } : { resource: "EX_GAUGE", amount: 7 },
    resolution: {
      kind: "IMMEDIATE",
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "EVENT_PAYLOAD", field: "calculatedDamage", op: "LTE", value: 10 },
          target: { kind: "SELF" },
          actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: skillType === "AS" ? 1 : 0 },
    traits: {},
    requiredCapabilities,
    metadata: { displayName: `Event-payload-condition ${skillType}` },
  });
}

/** CAP_TRIGGER_PAYLOAD_IN_RESOLUTION（Issue #247 M7-001D）: `stepCondition`にEVENT_PAYLOADを含むPSスキル（唯一の合法なskillType）。 */
function eventPayloadPassiveSkill(
  id: string,
  requiredCapabilities: readonly string[],
): SkillDefinition {
  return createSkillDefinition({
    skillDefinitionId: id,
    skillType: "PS",
    cost: { resource: "PP", amount: 1 },
    triggers: [
      {
        eventType: "DamageApplied",
        category: "FACT",
        sourceSelector: "SELF",
        targetSelector: "ENEMY",
      },
    ],
    resolution: {
      kind: "IMMEDIATE",
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "EVENT_PAYLOAD", field: "calculatedDamage", op: "LTE", value: 10 },
          target: { kind: "SELF" },
          actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {},
    requiredCapabilities,
    metadata: { displayName: "Event-payload-condition PS" },
  });
}

function randomBranchSkill(id: string, requiredCapabilities: readonly string[]): SkillDefinition {
  return createSkillDefinition({
    skillDefinitionId: id,
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    resolution: {
      kind: "IMMEDIATE",
      steps: [
        {
          kind: "RANDOM_BRANCH",
          mode: "WEIGHTED_ONE",
          branches: [
            {
              weight: 1,
              steps: [
                {
                  kind: "ACTION",
                  target: { kind: "SELF" },
                  actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
                },
              ],
            },
          ],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 1 },
    traits: {},
    requiredCapabilities,
    metadata: { displayName: "RANDOM_BRANCH AS" },
  });
}

function targetingSkill(
  selector: TargetSelectorDefinitionInput,
  requiredCapabilities: readonly string[],
  target: TargetReferenceInput = { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
  activationCondition?: ConditionDefinitionInput,
  skillType: "AS" | "PS" | "EX" = "AS",
): SkillDefinition {
  return createSkillDefinition({
    skillDefinitionId: skillType === "PS" ? "SKL_PS1" : skillType === "EX" ? "SKL_EX1" : "SKL_AS1",
    skillType,
    cost: {
      resource: skillType === "PS" ? "PP" : skillType === "EX" ? "EX_GAUGE" : "AP",
      amount: skillType === "EX" ? 7 : 1,
    },
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [{ targetBindingId: "TGT_PRIMARY", selector }],
      steps: [
        {
          kind: "ACTION",
          target,
          actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 1 },
    ...(activationCondition === undefined ? {} : { activationCondition }),
    ...(skillType === "PS"
      ? {
          triggers: [
            {
              eventType: "TurnStarted",
              category: "FACT",
              sourceSelector: "SELF",
              targetSelector: "SELF",
            },
          ],
        }
      : {}),
    traits: {},
    requiredCapabilities,
    metadata: { displayName: "Targeting AS" },
  });
}

function branchMemory(requiredCapabilities: readonly string[]) {
  return createMemoryDefinition({
    memoryDefinitionId: "MEM_BRANCH",
    triggeredEffects: [
      {
        trigger: {
          eventType: "BattleStarted",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
        },
        effectSequence: {
          // R-MEM-04（Issue #179）: Memoryは使用者BattleUnitを持たないため、
          // `SELF`対象参照や発生源を必要とするEffectActionは宣言できない。
          targetBindings: [
            {
              targetBindingId: "TGT_ALL_ALLIES",
              selector: { kind: "SELECT", side: "ALLY", count: "ALL" },
            },
          ],
          steps: [
            {
              kind: "BRANCH",
              condition: { kind: "TRUE" },
              thenSteps: [
                {
                  kind: "ACTION",
                  target: { kind: "BINDING", targetBindingId: "TGT_ALL_ALLIES" },
                  actions: [{ effectActionDefinitionId: "ACT_MEMORY_STAT_MOD" }],
                },
              ],
              elseSteps: [],
            },
          ],
        },
      },
    ],
    requiredCapabilities,
    metadata: { displayName: "Branch Memory" },
  });
}

function triggeredMemory(requiredCapabilities: readonly string[]) {
  return createMemoryDefinition({
    memoryDefinitionId: "MEM_TRIGGERED",
    triggeredEffects: [
      {
        trigger: {
          eventType: "BattleStarted",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
        },
        effectSequence: {
          // R-MEM-04（Issue #179）: Memoryは使用者BattleUnitを持たないため、
          // `SELF`対象参照や発生源を必要とするEffectActionは宣言できない。
          targetBindings: [
            {
              targetBindingId: "TGT_ALL_ALLIES",
              selector: { kind: "SELECT", side: "ALLY", count: "ALL" },
            },
          ],
          steps: [
            {
              kind: "ACTION",
              target: { kind: "BINDING", targetBindingId: "TGT_ALL_ALLIES" },
              actions: [{ effectActionDefinitionId: "ACT_MEMORY_STAT_MOD" }],
            },
          ],
        },
      },
    ],
    requiredCapabilities,
    metadata: { displayName: "Triggered Memory" },
  });
}

function triggerContextMemory(requiredCapabilities: readonly string[]) {
  return createMemoryDefinition({
    memoryDefinitionId: "MEM_TRIGGER_CONTEXT",
    triggeredEffects: [
      {
        trigger: {
          eventType: "HitPointReduced",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "SELF",
        },
        effectSequence: {
          // R-MEM-04（Issue #179）: Memoryは使用者BattleUnitを持たないため、
          // `SELF`対象参照や発生源を必要とするEffectActionは宣言できない。
          targetBindings: [
            {
              targetBindingId: "TGT_ALL_ALLIES",
              selector: { kind: "SELECT", side: "ALLY", count: "ALL" },
            },
          ],
          steps: [
            {
              kind: "ACTION",
              target: { kind: "BINDING", targetBindingId: "TGT_ALL_ALLIES" },
              actions: [{ effectActionDefinitionId: "ACT_MEMORY_STAT_MOD" }],
            },
          ],
        },
      },
    ],
    requiredCapabilities,
    metadata: { displayName: "Trigger Context Memory" },
  });
}

function psSkill(
  id: string,
  eventType: string,
  category: string,
  requiredCapabilities: readonly string[] = [],
): SkillDefinition {
  return createSkillDefinition({
    skillDefinitionId: id,
    skillType: "PS",
    cost: { resource: "PP", amount: 1 },
    triggers: [{ eventType, category, sourceSelector: "SELF", targetSelector: "SELF" }],
    resolution: {
      kind: "IMMEDIATE",
      steps: [
        {
          kind: "ACTION",
          target: { kind: "SELF" },
          actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {},
    requiredCapabilities,
    metadata: { displayName: "PS" },
  });
}

function runtimeCounterSkill(requiredCapabilities: readonly string[]): SkillDefinition {
  return createSkillDefinition({
    skillDefinitionId: "SKL_PS1",
    skillType: "PS",
    cost: { resource: "PP", amount: 1 },
    triggers: [
      {
        eventType: "TurnStarted",
        category: "FACT",
        sourceSelector: "ANY",
        targetSelector: "SELF",
      },
    ],
    counterUpdates: [
      {
        kind: "INCREMENT",
        counter: "SKL_PS1_ACTIVATIONS",
        scope: "SKILL_RUNTIME",
        trigger: {
          eventType: "PassiveActivated",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "SELF",
        },
        amount: 1,
      },
    ],
    resolution: {
      kind: "IMMEDIATE",
      steps: [
        {
          kind: "ACTION",
          target: { kind: "SELF" },
          actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {},
    requiredCapabilities,
    metadata: { displayName: "Runtime counter PS" },
  });
}

function effectSequenceRuntimeCounterSkill(
  id: string,
  requiredCapabilities: readonly string[],
): SkillDefinition {
  return createSkillDefinition({
    skillDefinitionId: id,
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    resolution: {
      kind: "IMMEDIATE",
      steps: [
        {
          kind: "ACTION",
          target: { kind: "SELF" },
          actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
        },
      ],
      counterUpdates: [
        {
          kind: "INCREMENT",
          counter: "RUNTIME_COUNTER_SEQ_HITS",
          scope: "EFFECT_SEQUENCE",
          trigger: {
            eventType: "EffectActionCompleted",
            category: "FACT",
            sourceSelector: "SELF",
            targetSelector: "ANY",
          },
          amount: 1,
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {},
    requiredCapabilities,
    metadata: { displayName: "EffectSequence runtime counter AS" },
  });
}

function runtimeCounterSkillWithTrigger(
  eventType: string,
  category: string,
  requiredCapabilities: readonly string[],
): SkillDefinition {
  return createSkillDefinition({
    skillDefinitionId: "SKL_PS1",
    skillType: "PS",
    cost: { resource: "PP", amount: 1 },
    triggers: [
      {
        eventType: "TurnStarted",
        category: "FACT",
        sourceSelector: "ANY",
        targetSelector: "SELF",
      },
    ],
    counterUpdates: [
      {
        kind: "INCREMENT",
        counter: "SKL_PS1_ACTIVATIONS",
        scope: "SKILL_RUNTIME",
        trigger: {
          eventType,
          category,
          sourceSelector: "SELF",
          targetSelector: "SELF",
        },
        amount: 1,
      },
    ],
    resolution: {
      kind: "IMMEDIATE",
      steps: [
        {
          kind: "ACTION",
          target: { kind: "SELF" },
          actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {},
    requiredCapabilities,
    metadata: { displayName: "Runtime counter PS" },
  });
}

function exSkill(id: string, amount: number): SkillDefinition {
  return createSkillDefinition({
    skillDefinitionId: id,
    skillType: "EX",
    cost: { resource: "EX_GAUGE", amount },
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [
        {
          targetBindingId: "TGT_PRIMARY",
          selector: { kind: "SELECT", side: "ENEMY", count: 1, order: ["DEFAULT"] },
        },
      ],
      steps: [
        {
          kind: "ACTION",
          target: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
          actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {},
    requiredCapabilities: [],
    metadata: { displayName: "EX" },
  });
}

function cooldownManipulationAction(
  id: string,
  targetSkillDefinitionId: string,
  operation: "RESET" | "REDUCE" = "RESET",
  requiredCapabilities: readonly string[] = ["CAP_COOLDOWN_MANIPULATION"],
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "COOLDOWN_MANIPULATION",
      payload: { targetSkillDefinitionId, operation },
      requiredCapabilities,
    },
    "effectAction",
  );
}

function statModAction(
  id: string,
  requiredCapabilities: readonly string[] = ["CAP_STAT_MOD"],
  linkedEffectGroupId: string | null = null,
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "APPLY_STAT_MOD",
      payload: {
        stat: "ATTACK",
        valueType: "FIXED",
        formula: { kind: "CONSTANT", value: 20 },
        stacking: { mode: "STACKABLE" },
        duration: { timeLimit: { unit: "TURN", count: 2 }, dispellable: true, linkedEffectGroupId },
      },
      requiredCapabilities,
    },
    "effectAction",
  );
}

/** DMG-005（Issue #190、R-SUB-01/02）: `APPLY_SUBUNIT`のfixture。 */
function subunitAction(
  id: string,
  options: { readonly debuffId?: string } = {},
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "APPLY_SUBUNIT",
      payload: {
        durability: {
          formula: { kind: "MAX_HP_RATIO", source: { kind: "SKILL_SOURCE" }, ratio: 0.25 },
        },
        additionalDamage: {
          formula: {
            kind: "SUBUNIT_ADDITIONAL_DAMAGE",
            ownerAttack: "CURRENT_ATTACK",
            providerAttack: "SOURCE_SNAPSHOT_ATTACK",
            skillMultiplier: 0.3,
            targetDefense: "TARGET_CURRENT_DEFENSE",
          },
          ...(options.debuffId !== undefined
            ? { debuff: { effectActionDefinitionId: options.debuffId } }
            : {}),
        },
        duration: { timeLimit: { unit: "ACTION", count: 3 }, dispellable: true },
      },
      requiredCapabilities: ["CAP_SUBUNIT"],
    },
    "effectAction",
  );
}

function modifyResourceDistributeAction(
  id: string,
  requiredCapabilities: readonly string[] = ["CAP_RESOURCE_MUTATION", "CAP_RESOURCE_DISTRIBUTE"],
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "MODIFY_RESOURCE",
      payload: {
        resource: "EX_GAUGE",
        operation: "DISTRIBUTE",
        formula: { kind: "CONSTANT", value: 8 },
        bounds: { min: 0, max: "CURRENT_MAX" },
      },
      requiredCapabilities,
    },
    "effectAction",
  );
}

function modifyResourceCapacityAction(
  id: string,
  requiredCapabilities: readonly string[] = ["CAP_RESOURCE_CAPACITY_MOD"],
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "MODIFY_RESOURCE_CAPACITY",
      payload: {
        resource: "AP",
        operation: "ADD",
        formula: { kind: "CONSTANT", value: 1 },
        duration: { timeLimit: { unit: "BATTLE", count: 1 }, dispellable: false },
      },
      requiredCapabilities,
    },
    "effectAction",
  );
}

function sumDamageHealAction(
  id: string,
  requiredCapabilities: readonly string[] = ["CAP_HEAL", "CAP_SUM_DAMAGE_RESULT"],
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "HEAL",
      payload: {
        // Nested under SUM/CLAMP so the walker's recursion is exercised too.
        formula: {
          kind: "CLAMP",
          formula: {
            kind: "SUM",
            formulas: [
              { kind: "CONSTANT", value: 1 },
              { kind: "DAMAGE_DEALT_RATIO", sourceResult: "SUM_DAMAGE_DEALT", ratio: 0.7 },
            ],
          },
          min: 0,
          max: 9999,
        },
        overheal: "DISCARD",
      },
      requiredCapabilities,
    },
    "effectAction",
  );
}

/**
 * M7-015（Issue #269、R-NUM-04）: `MARKER_COUNT_SCALE`を`damageModifiers`の中に
 * 置き、さらに`SUM`/`CLAMP`で入れ子にして、`sumDamageHealAction`と同じく
 * walkerの再帰と`DAMAGE`の`damageModifiers`収集の両方を通す。
 */
function markerCountScaleDamageAction(
  id: string,
  requiredCapabilities: readonly string[] = ["CAP_MARKER_STACK_FORMULA"],
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "DAMAGE",
      payload: {
        damageType: "PHYSICAL",
        formula: { kind: "SKILL_POWER", power: 1 },
        damageModifiers: [
          {
            kind: "CLAMP",
            formula: {
              kind: "SUM",
              formulas: [
                { kind: "CONSTANT", value: 0 },
                {
                  kind: "MARKER_COUNT_SCALE",
                  target: { kind: "TARGET" },
                  markerId: "MARKER_TEST",
                  perStack: 0.15,
                  max: 0.45,
                },
              ],
            },
            min: 0,
            max: 1,
          },
        ],
      },
      requiredCapabilities,
    },
    "effectAction",
  );
}

function healingLinkAction(
  id: string,
  transferTo: { kind: string; targetBindingId?: string } = { kind: "SELF" },
  requiredCapabilities: readonly string[] = ["CAP_HEALING_LINK"],
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "APPLY_HEALING_LINK",
      payload: {
        transferTo,
        transferRate: 1,
        duration: {
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
      requiredCapabilities,
    },
    "effectAction",
  );
}

function continuousHealAction(
  id: string,
  timing: { eventType: string; targetSelector: string } = {
    eventType: "ActionStarted",
    targetSelector: "EFFECT_OWNER",
  },
  requiredCapabilities: readonly string[] = ["CAP_CONTINUOUS_HEAL"],
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "APPLY_CONTINUOUS_HEAL",
      payload: {
        formula: { kind: "MAX_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.1 },
        timing,
        duration: {
          timeLimit: { unit: "ACTION", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
      requiredCapabilities,
    },
    "effectAction",
  );
}

function markerAction(
  id: string,
  linkedEffectGroupId: string | null = null,
  requiredCapabilities: readonly string[] = ["CAP_MARKER"],
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "APPLY_MARKER",
      payload: {
        markerId: "MARKER_TEST",
        stack: { policy: "ADD", max: null },
        duration: { dispellable: true, linkedEffectGroupId },
      },
      requiredCapabilities,
    },
    "effectAction",
  );
}

const hitCounterUpdate = {
  kind: "INCREMENT" as const,
  counter: "RUNTIME_COUNTER_HIT_COUNT",
  scope: "APPLIED_EFFECT" as const,
  trigger: {
    eventType: "HitPointReduced",
    category: "FACT" as const,
    sourceSelector: "ENEMY" as const,
    targetSelector: "SELF" as const,
  },
  amount: 1,
};

function markerActionWithCounterUpdates(id: string): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "APPLY_MARKER",
      payload: {
        markerId: "MARKER_TEST",
        stack: { policy: "ADD", max: null },
        duration: {
          dispellable: true,
          linkedEffectGroupId: null,
          counterUpdates: [hitCounterUpdate],
        },
      },
      requiredCapabilities: ["CAP_MARKER"],
    },
    "effectAction",
  );
}

function statModActionWithCounterUpdates(
  id: string,
  requiredCapabilities: readonly string[] = ["CAP_STAT_MOD"],
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "APPLY_STAT_MOD",
      payload: {
        stat: "ATTACK",
        valueType: "FIXED",
        formula: { kind: "CONSTANT", value: 20 },
        stacking: { mode: "STACKABLE" },
        duration: {
          timeLimit: { unit: "TURN", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
          counterUpdates: [hitCounterUpdate],
        },
      },
      requiredCapabilities,
    },
    "effectAction",
  );
}

function unit(
  id: string,
  overrides: {
    active?: readonly string[];
    passive?: readonly string[];
    extra?: string;
    extraGaugeMaximum?: number;
    requiredCapabilities?: readonly string[];
  } = {},
): UnitDefinition {
  return createUnitDefinition({
    unitDefinitionId: id,
    attribute: "COMICAL",
    unitType: "AGILE",
    role: "CONTROL",
    positionAptitudes: ["FRONT"],
    baseStats: {
      maximumHp: 1000,
      attack: 100,
      defense: 50,
      criticalRate: 0.1,
      actionSpeed: 100,
      maximumAp: 4,
      maximumPp: 4,
    },
    extraGaugeMaximum: overrides.extraGaugeMaximum ?? 7,
    activeSkillDefinitionIds: overrides.active ?? ["SKL_AS1"],
    passiveSkillDefinitionIds: overrides.passive ?? [],
    extraSkillDefinitionId: overrides.extra ?? "SKL_EX1",
    requiredCapabilities: overrides.requiredCapabilities ?? [],
    metadata: { displayName: "Unit", characterName: "Character", characterId: "CHAR_1" },
  });
}

function capability(id: string, status = "PLANNED"): CapabilityDefinition {
  return createCapabilityDefinition({
    capabilityId: id,
    schemaStatus: "SUPPORTED",
    runtimeStatus: status,
    implementationTaskId: "TEST-001",
    description: "d",
    verification: { productionDefinitionIds: [], testCaseIds: [] },
  });
}

/**
 * DMG-006（Issue #188、R-INT-01/R-INT-02）: production定義
 * （`ACT_KARINA_DOWNER_PS1_REDIRECT`／`ACT_EVIE_ECO_PS1_COVER`）と同じ形の防御介入定義。
 * 実装済みの形（`SELF`・`["DAMAGE"]`・`damageShareRate: 1`）を既定にし、テストごとに
 * 未実装の形へ差し替える。
 */
function targetRedirectAction(
  id: string,
  overrides: {
    redirectTo?: { kind: string };
    actionKinds?: readonly string[];
    requiredCapabilities?: readonly string[];
  } = {},
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "APPLY_TARGET_REDIRECT",
      payload: {
        redirectTo: overrides.redirectTo ?? { kind: "SELF" },
        appliesTo: { actionKinds: overrides.actionKinds ?? ["DAMAGE"] },
        duration: {
          timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
      requiredCapabilities: overrides.requiredCapabilities ?? ["CAP_TARGET_REDIRECT"],
    },
    "effectAction",
  );
}

function coverAction(
  id: string,
  overrides: {
    coverer?: { kind: string };
    damageShareRate?: number;
    actionKinds?: readonly string[];
    requiredCapabilities?: readonly string[];
  } = {},
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "APPLY_COVER",
      payload: {
        coverer: overrides.coverer ?? { kind: "SELF" },
        damageShareRate: overrides.damageShareRate ?? 1,
        guardRate: 0.5,
        appliesTo: { actionKinds: overrides.actionKinds ?? ["DAMAGE"] },
        duration: {
          timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
      requiredCapabilities: overrides.requiredCapabilities ?? ["CAP_COVER_DAMAGE"],
    },
    "effectAction",
  );
}

/**
 * DMG-007（Issue #187、R-LNK-01〜03）: リンクダメージ状態の最小定義。既定は
 * production `ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK` と同じ`linkTo: SELF`・50%。
 */
function damageLinkAction(
  id: string,
  overrides: {
    linkTo?: { kind: string; targetBindingId?: string };
    linkRate?: number;
    requiredCapabilities?: readonly string[];
  } = {},
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "APPLY_DAMAGE_LINK",
      payload: {
        linkTo: overrides.linkTo ?? { kind: "SELF" },
        linkRate: overrides.linkRate ?? 0.5,
        polarity: "BUFF",
        duration: {
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
          dispellable: false,
          linkedEffectGroupId: null,
        },
      },
      requiredCapabilities: overrides.requiredCapabilities ?? ["CAP_DAMAGE_LINK_STATE"],
    },
    "effectAction",
  );
}

function reflectAction(
  id: string,
  overrides: {
    reflectTo?: { kind: string };
    allowRecursiveReflect?: boolean;
    requiredCapabilities?: readonly string[];
  } = {},
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "APPLY_REFLECT",
      payload: {
        reflectTo: overrides.reflectTo ?? { kind: "TRIGGER_SOURCE" },
        formula: {
          kind: "DAMAGE_RECEIVED_RATIO",
          sourceResult: "LAST_DAMAGE_RECEIVED",
          ratio: 0.75,
        },
        timing: "AFTER_DAMAGE_APPLIED",
        allowRecursiveReflect: overrides.allowRecursiveReflect ?? false,
        duration: {
          timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
      requiredCapabilities: overrides.requiredCapabilities ?? ["CAP_REFLECT_DAMAGE"],
    },
    "effectAction",
  );
}

function deathSurvivalAction(
  id: string,
  overrides: { lethalDamageOnly?: boolean; requiredCapabilities?: readonly string[] } = {},
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "APPLY_DEATH_SURVIVAL",
      payload: {
        trigger: { lethalDamageOnly: overrides.lethalDamageOnly ?? true },
        survivalHp: { kind: "CONSTANT", value: 1 },
        healAfterSurvival: null,
        duration: {
          timeLimit: { unit: "BATTLE", count: 1 },
          consumption: { kind: "LETHAL_DAMAGE", maxCount: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
      requiredCapabilities: overrides.requiredCapabilities ?? ["CAP_DEATH_SURVIVAL"],
    },
    "effectAction",
  );
}

/**
 * PR #299レビュー[P2]: `TARGET_HAS_EFFECT`を置ける4か所（PS trigger／
 * `counterUpdates[].trigger`／`activationCondition`／ACTION stepの`targetCondition`）へ
 * 同じ条件を差し込める最小のPS。
 */
function psSkillWithCondition(
  id: string,
  where: {
    trigger?: ConditionDefinitionInput;
    counterUpdateTrigger?: ConditionDefinitionInput;
    activationCondition?: ConditionDefinitionInput;
    targetCondition?: ConditionDefinitionInput;
  },
): SkillDefinition {
  const trigger = {
    eventType: "TurnStarted",
    category: "FACT",
    sourceSelector: "SELF",
    targetSelector: "SELF",
    ...(where.trigger !== undefined ? { condition: where.trigger } : {}),
  };
  return createSkillDefinition({
    skillDefinitionId: id,
    skillType: "PS",
    cost: { resource: "PP", amount: 1 },
    triggers: [trigger],
    ...(where.activationCondition !== undefined
      ? { activationCondition: where.activationCondition }
      : {}),
    ...(where.counterUpdateTrigger !== undefined
      ? {
          counterUpdates: [
            {
              kind: "INCREMENT",
              counter: `${id}_COUNT`,
              scope: "SKILL_RUNTIME",
              trigger: {
                eventType: "TurnStarted",
                category: "FACT",
                sourceSelector: "SELF",
                targetSelector: "SELF",
                condition: where.counterUpdateTrigger,
              },
              amount: 1,
            },
          ],
        }
      : {}),
    resolution: {
      kind: "IMMEDIATE",
      steps: [
        {
          kind: "ACTION",
          target: { kind: "SELF" },
          ...(where.targetCondition !== undefined
            ? { targetCondition: where.targetCondition }
            : {}),
          actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {},
    requiredCapabilities: [
      "CAP_TARGET_EFFECT_QUERY",
      ...(where.counterUpdateTrigger !== undefined ? ["CAP_SKILL_RUNTIME_COUNTER"] : []),
      ...(where.activationCondition !== undefined ? ["CAP_PASSIVE_ACTIVATION_CONDITION"] : []),
      ...(where.targetCondition !== undefined ? ["CAP_EFFECT_STEP_CONDITION_SCOPE"] : []),
    ],
    metadata: { displayName: id },
  });
}

function baseDefinitions(): CatalogDefinitions {
  return {
    units: [unit("UNIT_001")],
    skills: [asSkill("SKL_AS1", "ACT_DAMAGE_1"), exSkill("SKL_EX1", 7)],
    effectActions: [damageAction("ACT_DAMAGE_1")],
    memories: [],
    capabilities: [],
  };
}

describe("buildCatalogIndex", () => {
  it("UT-CAT-IDX-001: indexes a valid minimal catalog without violations", () => {
    const index = buildCatalogIndex(baseDefinitions());
    expect(index.units.get("UNIT_001" as never)).toBeDefined();
    expect(index.skills.size).toBe(2);
    expect(index.effectActions.size).toBe(1);
  });

  it("UT-CAT-IDX-002: rejects duplicate ids within the same definition type", () => {
    const defs = baseDefinitions();
    const withDup: CatalogDefinitions = {
      ...defs,
      effectActions: [...defs.effectActions, damageAction("ACT_DAMAGE_1")],
    };
    expect(() => buildCatalogIndex(withDup)).toThrow(CatalogIntegrityError);
    try {
      buildCatalogIndex(withDup);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogIntegrityError);
      const err = error as CatalogIntegrityError;
      expect(err.violations).toHaveLength(1);
      expect(err.violations[0]?.targetId).toBe("ACT_DAMAGE_1");
      expect(err.violations[0]?.rule).toBe("DUPLICATE_ID");
    }
  });

  it("UT-CAT-IDX-003: rejects a Unit's activeSkillDefinitionIds referencing a missing Skill", () => {
    const defs = baseDefinitions();
    const withDangling: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { active: ["SKL_MISSING"] })],
    };
    expect(() => buildCatalogIndex(withDangling)).toThrow(CatalogIntegrityError);
    try {
      buildCatalogIndex(withDangling);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("DANGLING_REFERENCE");
      expect(err.violations[0]?.targetId).toBe("UNIT_001");
    }
  });

  it("UT-CAT-IDX-004: rejects a Unit referencing a Skill of the wrong skillType", () => {
    const defs = baseDefinitions();
    const withWrongType: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { active: ["SKL_EX1"] })],
    };
    expect(() => buildCatalogIndex(withWrongType)).toThrow(CatalogIntegrityError);
    try {
      buildCatalogIndex(withWrongType);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("TYPE_MISMATCH");
    }
  });

  it("UT-CAT-IDX-005: rejects an EX skill whose cost.amount does not match the Unit's extraGaugeMaximum", () => {
    const defs = baseDefinitions();
    const mismatched: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { extraGaugeMaximum: 9 })],
    };
    expect(() => buildCatalogIndex(mismatched)).toThrow(CatalogIntegrityError);
    try {
      buildCatalogIndex(mismatched);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("EX_COST_MISMATCH");
    }
  });

  it("UT-CAT-IDX-006: rejects a Skill effectSequence referencing a missing EffectActionDefinition", () => {
    const defs = baseDefinitions();
    const withDangling: CatalogDefinitions = {
      ...defs,
      skills: [asSkill("SKL_AS1", "ACT_MISSING"), exSkill("SKL_EX1", 7)],
    };
    expect(() => buildCatalogIndex(withDangling)).toThrow(CatalogIntegrityError);
    try {
      buildCatalogIndex(withDangling);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("DANGLING_REFERENCE");
      expect(err.violations[0]?.targetId).toBe("SKL_AS1");
    }
  });

  it("UT-CAT-IDX-007: rejects a Memory triggeredEffect referencing a missing EffectActionDefinition", () => {
    const defs = baseDefinitions();
    const withDangling: CatalogDefinitions = {
      ...defs,
      memories: [
        createMemoryDefinition({
          memoryDefinitionId: "MEM_001",
          triggeredEffects: [
            {
              trigger: {
                eventType: "BattleStarted",
                category: "FACT",
                sourceSelector: "SELF",
                targetSelector: "ALLY",
              },
              effectSequence: {
                targetBindings: [
                  {
                    targetBindingId: "TGT_ALL_ALLIES",
                    selector: { kind: "SELECT", side: "ALLY", count: "ALL" },
                  },
                ],
                steps: [
                  {
                    kind: "ACTION",
                    target: { kind: "BINDING", targetBindingId: "TGT_ALL_ALLIES" },
                    actions: [{ effectActionDefinitionId: "ACT_MISSING" }],
                  },
                ],
              },
            },
          ],
          requiredCapabilities: ["CAP_MEMORY_TRIGGERED_EFFECT"],
          metadata: { displayName: "Memory" },
        }),
      ],
      capabilities: [capability("CAP_MEMORY_TRIGGERED_EFFECT")],
    };
    expect(() => buildCatalogIndex(withDangling)).toThrow(CatalogIntegrityError);
    try {
      buildCatalogIndex(withDangling);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("DANGLING_REFERENCE");
      expect(err.violations[0]?.targetId).toBe("MEM_001");
    }
  });

  it("UT-CAT-IDX-008: rejects requiredCapabilities that are not defined in capabilities.json", () => {
    const defs = baseDefinitions();
    const withUnknownCap: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { requiredCapabilities: ["CAP_UNKNOWN"] })],
    };
    expect(() => buildCatalogIndex(withUnknownCap)).toThrow(CatalogIntegrityError);
    try {
      buildCatalogIndex(withUnknownCap);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("UNKNOWN_CAPABILITY");
      expect(err.violations[0]?.targetId).toBe("UNIT_001");
    }
  });

  it("UT-CAT-IDX-009: accepts requiredCapabilities that are defined in capabilities.json", () => {
    const defs = baseDefinitions();
    const withCap: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { requiredCapabilities: ["CAP_HEAL"] })],
      capabilities: [capability("CAP_HEAL", "PLANNED")],
    };
    const index = buildCatalogIndex(withCap);
    expect(index.capabilities.get("CAP_HEAL" as never)?.runtimeStatus).toBe("PLANNED");
  });

  it("UT-CAT-IDX-010: rejects a PS trigger referencing an unknown eventType", () => {
    const defs = baseDefinitions();
    const withUnknownEvent: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { passive: ["SKL_PS1"] })],
      skills: [...defs.skills, psSkill("SKL_PS1", "NotARealEvent", "FACT")],
    };
    expect(() => buildCatalogIndex(withUnknownEvent)).toThrow(CatalogIntegrityError);
    try {
      buildCatalogIndex(withUnknownEvent);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("UNKNOWN_EVENT_TYPE");
      expect(err.violations[0]?.targetId).toBe("SKL_PS1");
    }
  });

  it("UT-CAT-IDX-011: rejects a PS trigger whose declared category mismatches the eventType's documented category", () => {
    const defs = baseDefinitions();
    const withMismatch: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { passive: ["SKL_PS1"] })],
      // UnitBeingAttacked is documented as TIMING, not FACT.
      skills: [
        ...defs.skills,
        psSkill("SKL_PS1", "UnitBeingAttacked", "FACT", ["CAP_TRIGGER_CONTEXT"]),
      ],
      capabilities: [capability("CAP_TRIGGER_CONTEXT")],
    };
    expect(() => buildCatalogIndex(withMismatch)).toThrow(CatalogIntegrityError);
    try {
      buildCatalogIndex(withMismatch);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("EVENT_CATEGORY_MISMATCH");
    }
  });

  it("UT-CAT-IDX-012: accepts the documented EffectApplied (FACT) trigger", () => {
    const defs = baseDefinitions();
    const withEffectApplied: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { passive: ["SKL_PS1"] })],
      skills: [
        ...defs.skills,
        psSkill("SKL_PS1", "EffectApplied", "FACT", ["CAP_TRIGGER_CONTEXT"]),
      ],
      capabilities: [capability("CAP_TRIGGER_CONTEXT")],
    };
    const index = buildCatalogIndex(withEffectApplied);
    expect(index.skills.get("SKL_PS1" as never)).toBeDefined();
  });

  it("UT-CAT-IDX-013: rejects a Unit that lists the same Skill id twice in activeSkillDefinitionIds", () => {
    const defs = baseDefinitions();
    const withDupRef: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS1"] })],
    };
    expect(() => buildCatalogIndex(withDupRef)).toThrow(CatalogIntegrityError);
    try {
      buildCatalogIndex(withDupRef);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("DUPLICATE_SKILL_REFERENCE");
      expect(err.violations[0]?.targetId).toBe("UNIT_001");
    }
  });

  it("UT-CAT-IDX-014: collects multiple violations in a single pass", () => {
    const defs = baseDefinitions();
    const multi: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { active: ["SKL_MISSING"], requiredCapabilities: ["CAP_UNKNOWN"] })],
    };
    try {
      buildCatalogIndex(multi);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("UT-CAT-IDX-015: rejects an EFFECT_IMMUNITY payload.effectActionDefinitionIds referencing a missing EffectActionDefinition", () => {
    const defs = baseDefinitions();
    const withDangling: CatalogDefinitions = {
      ...defs,
      effectActions: [
        ...defs.effectActions,
        effectImmunityAction("ACT_IMMUNITY_1", ["ACT_MISSING"]),
      ],
    };
    expect(() => buildCatalogIndex(withDangling)).toThrow(CatalogIntegrityError);
    try {
      buildCatalogIndex(withDangling);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("DANGLING_REFERENCE");
      expect(err.violations[0]?.targetId).toBe("ACT_IMMUNITY_1");
    }
  });

  it("UT-CAT-IDX-016: rejects a REMOVE_EFFECTS payload.effectActionDefinitionIds referencing a missing EffectActionDefinition (Issue #44 G-04 follow-up)", () => {
    const defs = baseDefinitions();
    const withDangling: CatalogDefinitions = {
      ...defs,
      effectActions: [...defs.effectActions, removeEffectsAction("ACT_REMOVE_1", ["ACT_MISSING"])],
    };
    expect(() => buildCatalogIndex(withDangling)).toThrow(CatalogIntegrityError);
    try {
      buildCatalogIndex(withDangling);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations[0]?.rule).toBe("DANGLING_REFERENCE");
      expect(err.violations[0]?.targetId).toBe("ACT_REMOVE_1");
    }
  });

  it("UT-CAT-IDX-071 (M7-001, Issue #181, 再々レビュー[P2]): rejects a REMOVE_EFFECTS with the SHIELD category missing the required CAP_SHIELD declaration", () => {
    const defs = baseDefinitions();
    const withMissingCapability: CatalogDefinitions = {
      ...defs,
      effectActions: [
        ...defs.effectActions,
        removeEffectsCategoryAction("ACT_REMOVE_SHIELD", ["SHIELD"], ["CAP_REMOVE_EFFECTS"]),
      ],
      capabilities: [capability("CAP_REMOVE_EFFECTS")],
    };
    try {
      buildCatalogIndex(withMissingCapability);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations.some(
          (v) => v.rule === "MISSING_REQUIRED_CAPABILITY" && v.targetId === "ACT_REMOVE_SHIELD",
        ),
      ).toBe(true);
    }
  });

  it("UT-CAT-IDX-072 (M7-001, Issue #181, 再々レビュー[P2]): accepts a REMOVE_EFFECTS with the SHIELD category that declares both CAP_REMOVE_EFFECTS and CAP_SHIELD, even though CAP_SHIELD itself is PLANNED (Catalog build only checks declaration, not implementation status)", () => {
    const defs = baseDefinitions();
    const withCapability: CatalogDefinitions = {
      ...defs,
      effectActions: [
        ...defs.effectActions,
        removeEffectsCategoryAction(
          "ACT_REMOVE_SHIELD",
          ["SHIELD"],
          ["CAP_REMOVE_EFFECTS", "CAP_SHIELD"],
        ),
      ],
      capabilities: [capability("CAP_REMOVE_EFFECTS"), capability("CAP_SHIELD", "PLANNED")],
    };

    const index = buildCatalogIndex(withCapability);

    expect(index.effectActions.get("ACT_REMOVE_SHIELD" as never)).toBeDefined();
  });

  it("UT-CAT-IDX-073 (M7-001, Issue #181, 再々レビュー[P2]): rejects a REMOVE_EFFECTS with the SUBUNIT category missing the required CAP_SUBUNIT declaration", () => {
    const defs = baseDefinitions();
    const withMissingCapability: CatalogDefinitions = {
      ...defs,
      effectActions: [
        ...defs.effectActions,
        removeEffectsCategoryAction("ACT_REMOVE_SUBUNIT", ["SUBUNIT"], ["CAP_REMOVE_EFFECTS"]),
      ],
      capabilities: [capability("CAP_REMOVE_EFFECTS")],
    };
    try {
      buildCatalogIndex(withMissingCapability);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations.some(
          (v) => v.rule === "MISSING_REQUIRED_CAPABILITY" && v.targetId === "ACT_REMOVE_SUBUNIT",
        ),
      ).toBe(true);
    }
  });

  it("UT-CAT-IDX-074 (M7-001, Issue #181, 再々レビュー[P2]): accepts a REMOVE_EFFECTS with the SUBUNIT category that declares both CAP_REMOVE_EFFECTS and CAP_SUBUNIT", () => {
    const defs = baseDefinitions();
    const withCapability: CatalogDefinitions = {
      ...defs,
      effectActions: [
        ...defs.effectActions,
        removeEffectsCategoryAction(
          "ACT_REMOVE_SUBUNIT",
          ["SUBUNIT"],
          ["CAP_REMOVE_EFFECTS", "CAP_SUBUNIT"],
        ),
      ],
      capabilities: [capability("CAP_REMOVE_EFFECTS"), capability("CAP_SUBUNIT", "PLANNED")],
    };

    const index = buildCatalogIndex(withCapability);

    expect(index.effectActions.get("ACT_REMOVE_SUBUNIT" as never)).toBeDefined();
  });

  it("UT-CAT-IDX-098 (DMG-005, Issue #190, R-SUB-02): rejects an APPLY_SUBUNIT whose additionalDamage.debuff references a missing EffectActionDefinition", () => {
    const defs = baseDefinitions();
    const withDangling: CatalogDefinitions = {
      ...defs,
      effectActions: [
        ...defs.effectActions,
        subunitAction("ACT_SUBUNIT_DANGLING", { debuffId: "ACT_MISSING_DEBUFF" }),
      ],
      capabilities: [capability("CAP_SUBUNIT")],
    };
    try {
      buildCatalogIndex(withDangling);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations.some(
          (v) => v.rule === "DANGLING_REFERENCE" && v.targetId === "ACT_SUBUNIT_DANGLING",
        ),
      ).toBe(true);
    }
  });

  it("UT-CAT-IDX-099 (DMG-005, Issue #190, R-SUB-02): rejects an APPLY_SUBUNIT whose additionalDamage.debuff references a non-APPLY_STAT_MOD EffectAction", () => {
    const defs = baseDefinitions();
    const withNonGrantable: CatalogDefinitions = {
      ...defs,
      effectActions: [
        ...defs.effectActions,
        subunitAction("ACT_SUBUNIT_BAD_DEBUFF", { debuffId: "ACT_DAMAGE_1" }),
      ],
      capabilities: [capability("CAP_SUBUNIT")],
    };
    try {
      buildCatalogIndex(withNonGrantable);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations.some(
          (v) => v.rule === "TYPE_MISMATCH" && v.targetId === "ACT_SUBUNIT_BAD_DEBUFF",
        ),
      ).toBe(true);
    }
  });

  it("UT-CAT-IDX-100 (DMG-005, Issue #190, R-SUB-02): accepts an APPLY_SUBUNIT whose additionalDamage.debuff references a grantable EffectAction", () => {
    const defs = baseDefinitions();
    const withDebuff: CatalogDefinitions = {
      ...defs,
      effectActions: [
        ...defs.effectActions,
        statModAction("ACT_SPEED_DOWN"),
        subunitAction("ACT_SUBUNIT_WITH_DEBUFF", { debuffId: "ACT_SPEED_DOWN" }),
      ],
      capabilities: [capability("CAP_SUBUNIT"), capability("CAP_STAT_MOD")],
    };

    const index = buildCatalogIndex(withDebuff);

    expect(index.effectActions.get("ACT_SUBUNIT_WITH_DEBUFF" as never)).toBeDefined();
  });

  it("UT-CAT-IDX-101 (M7-016, Issue #270, R-SKL-05/R-HIT-02/R-PS-04): rejects a resolution.kind CHARGE skill that does not declare CAP_CHARGE_RESTRICTION", () => {
    const defs = baseDefinitions();
    const withUndeclaredCharge: CatalogDefinitions = {
      ...defs,
      skills: [...defs.skills, chargeSkill("SKL_CHARGE_1", [])],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_CHARGE_1"] })],
    };
    try {
      buildCatalogIndex(withUndeclaredCharge);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations.some(
          (v) => v.rule === "MISSING_REQUIRED_CAPABILITY" && v.targetId === "SKL_CHARGE_1",
        ),
      ).toBe(true);
    }
  });

  it("UT-CAT-IDX-102 (M7-016, Issue #270, R-SKL-05/R-HIT-02/R-PS-04): accepts a resolution.kind CHARGE skill that declares CAP_CHARGE_RESTRICTION", () => {
    const defs = baseDefinitions();
    const withDeclaredCharge: CatalogDefinitions = {
      ...defs,
      skills: [...defs.skills, chargeSkill("SKL_CHARGE_1", ["CAP_CHARGE_RESTRICTION"])],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_CHARGE_1"] })],
      capabilities: [capability("CAP_CHARGE_RESTRICTION")],
    };

    const index = buildCatalogIndex(withDeclaredCharge);

    expect(index.skills.get("SKL_CHARGE_1" as never)).toBeDefined();
  });

  it("UT-CAT-IDX-075 (Issue #181, 再々々レビュー[P2]): rejects ANY REMOVE_EFFECTS missing CAP_REMOVE_EFFECTS, regardless of categories (e.g. STATUS, which needs no other capability)", () => {
    const defs = baseDefinitions();
    const withMissingCapability: CatalogDefinitions = {
      ...defs,
      effectActions: [
        ...defs.effectActions,
        removeEffectsCategoryAction("ACT_REMOVE_STATUS", ["STATUS"], []),
      ],
    };
    try {
      buildCatalogIndex(withMissingCapability);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations.some(
          (v) => v.rule === "MISSING_REQUIRED_CAPABILITY" && v.targetId === "ACT_REMOVE_STATUS",
        ),
      ).toBe(true);
    }
  });

  it("UT-CAT-IDX-076 (M7-001B, Issue #243, EFFECT_IMMUNITY_STATUS_GRANULARITY): rejects an EFFECT_IMMUNITY with statusKinds missing the required CAP_SPECIFIC_IMMUNITY declaration", () => {
    const defs = baseDefinitions();
    const withMissingCapability: CatalogDefinitions = {
      ...defs,
      effectActions: [...defs.effectActions, statusScopedImmunityAction("ACT_STUN_IMMUNITY", [])],
    };
    try {
      buildCatalogIndex(withMissingCapability);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations.some(
          (v) => v.rule === "MISSING_REQUIRED_CAPABILITY" && v.targetId === "ACT_STUN_IMMUNITY",
        ),
      ).toBe(true);
    }
  });

  it("UT-CAT-IDX-077 (M7-001B, Issue #243, EFFECT_IMMUNITY_STATUS_GRANULARITY): accepts an EFFECT_IMMUNITY with statusKinds that declares CAP_SPECIFIC_IMMUNITY", () => {
    const defs = baseDefinitions();
    const withCapability: CatalogDefinitions = {
      ...defs,
      effectActions: [
        ...defs.effectActions,
        statusScopedImmunityAction("ACT_STUN_IMMUNITY", ["CAP_SPECIFIC_IMMUNITY"]),
      ],
      capabilities: [capability("CAP_SPECIFIC_IMMUNITY")],
    };

    const index = buildCatalogIndex(withCapability);

    expect(index.effectActions.get("ACT_STUN_IMMUNITY" as never)).toBeDefined();
  });

  it("UT-CAT-IDX-017: rejects a COOLDOWN_MANIPULATION payload.targetSkillDefinitionId referencing a missing SkillDefinition (Issue #129)", () => {
    const defs = baseDefinitions();
    const withDangling: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_CD_RESET")],
      effectActions: [
        ...defs.effectActions,
        cooldownManipulationAction("ACT_CD_RESET", "SKL_MISSING"),
      ],
    };
    try {
      buildCatalogIndex(withDangling);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations.some(
          (v) => v.rule === "DANGLING_REFERENCE" && v.targetId === "ACT_CD_RESET",
        ),
      ).toBe(true);
    }
  });

  it("UT-CAT-IDX-018: rejects a COOLDOWN_MANIPULATION targeting a SkillDefinition owned by a different Unit (Issue #129)", () => {
    const defs = baseDefinitions();
    const withUnowned: CatalogDefinitions = {
      ...defs,
      units: [
        unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] }),
        unit("UNIT_002", { active: ["SKL_U2_AS1"], extra: "SKL_U2_EX1" }),
      ],
      skills: [
        ...defs.skills,
        asSkill("SKL_AS2", "ACT_CD_RESET"),
        asSkill("SKL_U2_AS1", "ACT_DAMAGE_1"),
        exSkill("SKL_U2_EX1", 7),
      ],
      effectActions: [
        ...defs.effectActions,
        cooldownManipulationAction("ACT_CD_RESET", "SKL_U2_AS1"),
      ],
    };
    try {
      buildCatalogIndex(withUnowned);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations.some(
          (v) => v.rule === "UNOWNED_SKILL_REFERENCE" && v.targetId === "UNIT_001",
        ),
      ).toBe(true);
    }
  });

  it("UT-CAT-IDX-019: accepts a COOLDOWN_MANIPULATION targeting a SkillDefinition owned by the same Unit (Issue #129)", () => {
    const defs = baseDefinitions();
    const withOwned: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_CD_RESET")],
      effectActions: [...defs.effectActions, cooldownManipulationAction("ACT_CD_RESET", "SKL_AS1")],
      capabilities: [capability("CAP_COOLDOWN_MANIPULATION")],
    };

    const index = buildCatalogIndex(withOwned);

    expect(index.effectActions.get("ACT_CD_RESET" as never)).toBeDefined();
  });

  it("UT-CAT-IDX-020: rejects a COOLDOWN_MANIPULATION missing the required CAP_COOLDOWN_MANIPULATION capability (Issue #129 review)", () => {
    const defs = baseDefinitions();
    const withMissingCapability: CatalogDefinitions = {
      ...defs,
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_CD_RESET")],
      effectActions: [
        ...defs.effectActions,
        cooldownManipulationAction("ACT_CD_RESET", "SKL_AS1", "RESET", []),
      ],
      capabilities: [capability("CAP_COOLDOWN_MANIPULATION")],
    };

    try {
      buildCatalogIndex(withMissingCapability);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations.some(
          (v) => v.rule === "MISSING_REQUIRED_CAPABILITY" && v.targetId === "ACT_CD_RESET",
        ),
      ).toBe(true);
    }
  });

  it("UT-R-EFF-01-025 (PR #207レビュー[P1]): accepts an APPLY_STAT_MOD that declares the required CAP_STAT_MOD capability", () => {
    const defs = baseDefinitions();
    const withStatMod: CatalogDefinitions = {
      ...defs,
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_STAT_MOD")],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      effectActions: [...defs.effectActions, statModAction("ACT_STAT_MOD")],
      capabilities: [capability("CAP_STAT_MOD")],
    };

    const index = buildCatalogIndex(withStatMod);

    expect(index.effectActions.get("ACT_STAT_MOD" as never)).toBeDefined();
  });

  it("UT-R-EFF-01-026 (PR #207レビュー[P1]): rejects an APPLY_STAT_MOD missing the required CAP_STAT_MOD capability, so an incomplete resolver path can't be reached from custom Catalog data", () => {
    const defs = baseDefinitions();
    const withMissingCapability: CatalogDefinitions = {
      ...defs,
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_STAT_MOD")],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      effectActions: [...defs.effectActions, statModAction("ACT_STAT_MOD", [])],
      capabilities: [capability("CAP_STAT_MOD")],
    };

    try {
      buildCatalogIndex(withMissingCapability);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations.some(
          (v) => v.rule === "MISSING_REQUIRED_CAPABILITY" && v.targetId === "ACT_STAT_MOD",
        ),
      ).toBe(true);
    }
  });

  it("UT-R-ACTN-02-012 (PRレビュー[P2] PR #254): accepts a MODIFY_RESOURCE(operation: DISTRIBUTE) that declares the required CAP_RESOURCE_DISTRIBUTE capability", () => {
    const defs = baseDefinitions();
    const withDistribute: CatalogDefinitions = {
      ...defs,
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_DISTRIBUTE")],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      effectActions: [...defs.effectActions, modifyResourceDistributeAction("ACT_DISTRIBUTE")],
      capabilities: [capability("CAP_RESOURCE_MUTATION"), capability("CAP_RESOURCE_DISTRIBUTE")],
    };

    const index = buildCatalogIndex(withDistribute);

    expect(index.effectActions.get("ACT_DISTRIBUTE" as never)).toBeDefined();
  });

  it("UT-R-ACTN-02-013 (PRレビュー[P2] PR #254): rejects a MODIFY_RESOURCE(operation: DISTRIBUTE) missing the required CAP_RESOURCE_DISTRIBUTE capability, so the unsupported operation is caught at Catalog load time rather than only inside battle resolution", () => {
    const defs = baseDefinitions();
    const withMissingCapability: CatalogDefinitions = {
      ...defs,
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_DISTRIBUTE")],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      effectActions: [
        ...defs.effectActions,
        modifyResourceDistributeAction("ACT_DISTRIBUTE", ["CAP_RESOURCE_MUTATION"]),
      ],
      capabilities: [capability("CAP_RESOURCE_MUTATION"), capability("CAP_RESOURCE_DISTRIBUTE")],
    };

    try {
      buildCatalogIndex(withMissingCapability);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations.some(
          (v) => v.rule === "MISSING_REQUIRED_CAPABILITY" && v.targetId === "ACT_DISTRIBUTE",
        ),
      ).toBe(true);
    }
  });

  it("UT-R-ACTN-03-017 (G-09, M7-002A Issue #255): accepts a MODIFY_RESOURCE_CAPACITY that declares the required CAP_RESOURCE_CAPACITY_MOD capability", () => {
    const defs = baseDefinitions();
    const withCapacity: CatalogDefinitions = {
      ...defs,
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_MAX_AP_UP")],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      effectActions: [...defs.effectActions, modifyResourceCapacityAction("ACT_MAX_AP_UP")],
      capabilities: [capability("CAP_RESOURCE_CAPACITY_MOD")],
    };

    const index = buildCatalogIndex(withCapacity);

    expect(index.effectActions.get("ACT_MAX_AP_UP" as never)).toBeDefined();
  });

  it("UT-R-ACTN-03-018 (G-09, M7-002A Issue #255): rejects a MODIFY_RESOURCE_CAPACITY missing the required CAP_RESOURCE_CAPACITY_MOD capability, so an undeclared capacity change is caught at Catalog load time", () => {
    const defs = baseDefinitions();
    const withMissingCapability: CatalogDefinitions = {
      ...defs,
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_MAX_AP_UP")],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      effectActions: [...defs.effectActions, modifyResourceCapacityAction("ACT_MAX_AP_UP", [])],
      capabilities: [capability("CAP_RESOURCE_CAPACITY_MOD")],
    };

    try {
      buildCatalogIndex(withMissingCapability);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations.some(
          (v) => v.rule === "MISSING_REQUIRED_CAPABILITY" && v.targetId === "ACT_MAX_AP_UP",
        ),
      ).toBe(true);
    }
  });

  it("UT-R-HEAL-01-009 (RES-003A, Issue #257): accepts a HEAL referencing SUM_DAMAGE_DEALT when it declares the required CAP_SUM_DAMAGE_RESULT capability", () => {
    const defs = baseDefinitions();
    const withSum: CatalogDefinitions = {
      ...defs,
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_SUM_HEAL")],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      effectActions: [...defs.effectActions, sumDamageHealAction("ACT_SUM_HEAL")],
      capabilities: [capability("CAP_HEAL"), capability("CAP_SUM_DAMAGE_RESULT")],
    };

    const index = buildCatalogIndex(withSum);

    expect(index.effectActions.get("ACT_SUM_HEAL" as never)).toBeDefined();
  });

  it("UT-R-HEAL-01-010 (RES-003A, Issue #257, NEGATIVE): rejects a HEAL referencing SUM_DAMAGE_DEALT without CAP_SUM_DAMAGE_RESULT, keeping the Capability registry's productionDefinitionIds aligned with the definitions that actually reference the accumulation", () => {
    const defs = baseDefinitions();
    const withMissingCapability: CatalogDefinitions = {
      ...defs,
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_SUM_HEAL")],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      effectActions: [...defs.effectActions, sumDamageHealAction("ACT_SUM_HEAL", ["CAP_HEAL"])],
      capabilities: [capability("CAP_HEAL"), capability("CAP_SUM_DAMAGE_RESULT")],
    };

    try {
      buildCatalogIndex(withMissingCapability);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations.some(
          (v) => v.rule === "MISSING_REQUIRED_CAPABILITY" && v.targetId === "ACT_SUM_HEAL",
        ),
      ).toBe(true);
    }
  });

  it("UT-R-NUM-04-032 (M7-015, Issue #269): accepts a DAMAGE whose damageModifiers reference MARKER_COUNT_SCALE when it declares the required CAP_MARKER_STACK_FORMULA capability", () => {
    const defs = baseDefinitions();
    const withMarkerScale: CatalogDefinitions = {
      ...defs,
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_MARKER_SCALE_DAMAGE")],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      effectActions: [
        ...defs.effectActions,
        markerCountScaleDamageAction("ACT_MARKER_SCALE_DAMAGE"),
      ],
      capabilities: [capability("CAP_MARKER_STACK_FORMULA")],
    };

    const index = buildCatalogIndex(withMarkerScale);

    expect(index.effectActions.get("ACT_MARKER_SCALE_DAMAGE" as never)).toBeDefined();
  });

  it("UT-R-NUM-04-033 (M7-015, Issue #269, NEGATIVE): rejects a DAMAGE whose damageModifiers reference MARKER_COUNT_SCALE without CAP_MARKER_STACK_FORMULA, keeping every definition that reads MarkerState.stackCount self-declared", () => {
    const defs = baseDefinitions();
    const withMissingCapability: CatalogDefinitions = {
      ...defs,
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_MARKER_SCALE_DAMAGE")],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      effectActions: [
        ...defs.effectActions,
        markerCountScaleDamageAction("ACT_MARKER_SCALE_DAMAGE", []),
      ],
      capabilities: [capability("CAP_MARKER_STACK_FORMULA")],
    };

    try {
      buildCatalogIndex(withMissingCapability);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations.some(
          (v) =>
            v.rule === "MISSING_REQUIRED_CAPABILITY" && v.targetId === "ACT_MARKER_SCALE_DAMAGE",
        ),
      ).toBe(true);
    }
  });

  it("UT-R-HEAL-03-003 (M7-005 Issue #184): accepts an APPLY_CONTINUOUS_HEAL whose timing is the implemented ActionStarted/EFFECT_OWNER combination", () => {
    const defs = baseDefinitions();
    const withHot: CatalogDefinitions = {
      ...defs,
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_HOT")],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      effectActions: [...defs.effectActions, continuousHealAction("ACT_HOT")],
      capabilities: [capability("CAP_CONTINUOUS_HEAL")],
    };

    const index = buildCatalogIndex(withHot);

    expect(index.effectActions.get("ACT_HOT" as never)).toBeDefined();
  });

  it("UT-R-HEAL-03-004 (M7-005 Issue #184, NEGATIVE): rejects an APPLY_CONTINUOUS_HEAL whose timing is not the implemented ActionStarted/EFFECT_OWNER combination, so an unfired continuous heal is caught at Catalog load time rather than silently never healing", () => {
    const defs = baseDefinitions();
    const withUnsupportedTiming: CatalogDefinitions = {
      ...defs,
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_HOT")],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      effectActions: [
        ...defs.effectActions,
        continuousHealAction("ACT_HOT", {
          eventType: "TurnStarted",
          targetSelector: "EFFECT_OWNER",
        }),
      ],
      capabilities: [capability("CAP_CONTINUOUS_HEAL")],
    };

    try {
      buildCatalogIndex(withUnsupportedTiming);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations.some(
          (v) => v.rule === "UNSUPPORTED_CONTINUOUS_HEAL_TIMING" && v.targetId === "ACT_HOT",
        ),
      ).toBe(true);
    }
  });

  it("UT-R-HEAL-04-001 (M7-005-HEAL-LINK Issue #229): accepts an APPLY_HEALING_LINK transferring to SELF, the only destination heal-application-service.ts can resolve", () => {
    const defs = baseDefinitions();
    const withLink: CatalogDefinitions = {
      ...defs,
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_LINK")],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      effectActions: [...defs.effectActions, healingLinkAction("ACT_LINK")],
      capabilities: [capability("CAP_HEALING_LINK")],
    };

    const index = buildCatalogIndex(withLink);

    expect(index.effectActions.get("ACT_LINK" as never)).toBeDefined();
  });

  it("UT-R-HEAL-04-002 (M7-005-HEAL-LINK Issue #229, NEGATIVE): rejects an APPLY_HEALING_LINK whose transferTo is not SELF, so a link that would be granted without a resolvable destination is caught at Catalog load time", () => {
    const defs = baseDefinitions();
    const withUnsupportedDestination: CatalogDefinitions = {
      ...defs,
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_LINK")],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      effectActions: [
        ...defs.effectActions,
        healingLinkAction("ACT_LINK", { kind: "TRIGGER_SOURCE" }),
      ],
      capabilities: [capability("CAP_HEALING_LINK")],
    };

    try {
      buildCatalogIndex(withUnsupportedDestination);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations.some(
          (v) => v.rule === "UNSUPPORTED_HEALING_LINK_TRANSFER_TARGET" && v.targetId === "ACT_LINK",
        ),
      ).toBe(true);
    }
  });

  it("UT-R-HEAL-04-003 (M7-005-HEAL-LINK Issue #229, NEGATIVE): rejects an APPLY_HEALING_LINK that omits CAP_HEALING_LINK from requiredCapabilities (same declaration-gate as CAP_COOLDOWN_MANIPULATION)", () => {
    const defs = baseDefinitions();
    const withMissingCapability: CatalogDefinitions = {
      ...defs,
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_LINK")],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      effectActions: [...defs.effectActions, healingLinkAction("ACT_LINK", { kind: "SELF" }, [])],
      capabilities: [capability("CAP_HEALING_LINK")],
    };

    try {
      buildCatalogIndex(withMissingCapability);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations.some(
          (v) => v.rule === "MISSING_REQUIRED_CAPABILITY" && v.targetId === "ACT_LINK",
        ),
      ).toBe(true);
    }
  });

  it("UT-R-INT-01-020 (DMG-006 Issue #188): accepts the production shape of every defensive intervention kind (SELF destination, DAMAGE-only appliesTo, full damageShareRate, non-recursive reflect, lethal-only survival)", () => {
    const defs = baseDefinitions();
    const withInterventions: CatalogDefinitions = {
      ...defs,
      skills: [
        ...defs.skills,
        asSkill("SKL_AS2", "ACT_REDIRECT"),
        asSkill("SKL_AS3", "ACT_COVER"),
        asSkill("SKL_AS4", "ACT_REFLECT"),
        asSkill("SKL_AS5", "ACT_SURVIVAL"),
      ],
      units: [
        unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2", "SKL_AS3", "SKL_AS4", "SKL_AS5"] }),
      ],
      effectActions: [
        ...defs.effectActions,
        targetRedirectAction("ACT_REDIRECT"),
        coverAction("ACT_COVER"),
        reflectAction("ACT_REFLECT"),
        deathSurvivalAction("ACT_SURVIVAL"),
      ],
      capabilities: [
        capability("CAP_TARGET_REDIRECT"),
        capability("CAP_COVER_DAMAGE"),
        capability("CAP_REFLECT_DAMAGE"),
        capability("CAP_DEATH_SURVIVAL"),
      ],
    };

    const index = buildCatalogIndex(withInterventions);

    expect(index.effectActions.get("ACT_REDIRECT" as never)).toBeDefined();
    expect(index.effectActions.get("ACT_COVER" as never)).toBeDefined();
    expect(index.effectActions.get("ACT_REFLECT" as never)).toBeDefined();
    expect(index.effectActions.get("ACT_SURVIVAL" as never)).toBeDefined();
  });

  it("UT-R-INT-01-021 (DMG-006 Issue #188, PR #298レビュー[P2], NEGATIVE): rejects an APPLY_TARGET_REDIRECT/APPLY_COVER whose appliesTo.actionKinds reaches beyond DAMAGE, so a declaration that would never take effect is caught at Catalog load time", () => {
    const defs = baseDefinitions();

    /** `damage-application-service.ts`はDAMAGEでしか介入解決を呼ばないため、どちらもsilent no-opになる。 */
    for (const [actionId, action] of [
      ["ACT_REDIRECT", targetRedirectAction("ACT_REDIRECT", { actionKinds: ["DEBUFF"] })],
      ["ACT_REDIRECT", targetRedirectAction("ACT_REDIRECT", { actionKinds: ["ANY"] })],
      ["ACT_REDIRECT", targetRedirectAction("ACT_REDIRECT", { actionKinds: ["DAMAGE", "DEBUFF"] })],
      ["ACT_COVER", coverAction("ACT_COVER", { actionKinds: ["ANY"] })],
    ] as const) {
      const withUnimplementedAppliesTo: CatalogDefinitions = {
        ...defs,
        skills: [...defs.skills, asSkill("SKL_AS2", actionId)],
        units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
        effectActions: [...defs.effectActions, action],
        capabilities: [capability("CAP_TARGET_REDIRECT"), capability("CAP_COVER_DAMAGE")],
      };

      try {
        buildCatalogIndex(withUnimplementedAppliesTo);
        expect.unreachable();
      } catch (error) {
        const err = error as CatalogIntegrityError;
        expect(
          err.violations.some(
            (v) => v.rule === "UNSUPPORTED_DEFENSIVE_INTERVENTION" && v.targetId === actionId,
          ),
        ).toBe(true);
      }
    }
  });

  it("UT-R-INT-02-020 (DMG-006 Issue #188, NEGATIVE): rejects the defensive intervention payload shapes the runtime does not implement (non-SELF destination, partial damageShareRate, non-TRIGGER_SOURCE reflect, recursive reflect, non-lethal-only survival)", () => {
    const defs = baseDefinitions();

    for (const [actionId, action] of [
      [
        "ACT_REDIRECT",
        targetRedirectAction("ACT_REDIRECT", { redirectTo: { kind: "TRIGGER_SOURCE" } }),
      ],
      ["ACT_COVER", coverAction("ACT_COVER", { coverer: { kind: "TRIGGER_SOURCE" } })],
      ["ACT_COVER", coverAction("ACT_COVER", { damageShareRate: 0.5 })],
      ["ACT_REFLECT", reflectAction("ACT_REFLECT", { reflectTo: { kind: "SELF" } })],
      ["ACT_REFLECT", reflectAction("ACT_REFLECT", { allowRecursiveReflect: true })],
      ["ACT_SURVIVAL", deathSurvivalAction("ACT_SURVIVAL", { lethalDamageOnly: false })],
    ] as const) {
      const withUnimplementedShape: CatalogDefinitions = {
        ...defs,
        skills: [...defs.skills, asSkill("SKL_AS2", actionId)],
        units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
        effectActions: [...defs.effectActions, action],
        capabilities: [
          capability("CAP_TARGET_REDIRECT"),
          capability("CAP_COVER_DAMAGE"),
          capability("CAP_REFLECT_DAMAGE"),
          capability("CAP_DEATH_SURVIVAL"),
        ],
      };

      try {
        buildCatalogIndex(withUnimplementedShape);
        expect.unreachable();
      } catch (error) {
        const err = error as CatalogIntegrityError;
        expect(
          err.violations.some(
            (v) => v.rule === "UNSUPPORTED_DEFENSIVE_INTERVENTION" && v.targetId === actionId,
          ),
        ).toBe(true);
      }
    }
  });

  it("UT-R-INT-02-021 (DMG-006 Issue #188, NEGATIVE): rejects a defensive intervention that omits its Capability from requiredCapabilities (same declaration-gate as CAP_HEALING_LINK)", () => {
    const defs = baseDefinitions();

    for (const [actionId, action] of [
      ["ACT_REDIRECT", targetRedirectAction("ACT_REDIRECT", { requiredCapabilities: [] })],
      ["ACT_COVER", coverAction("ACT_COVER", { requiredCapabilities: [] })],
      ["ACT_REFLECT", reflectAction("ACT_REFLECT", { requiredCapabilities: [] })],
      ["ACT_SURVIVAL", deathSurvivalAction("ACT_SURVIVAL", { requiredCapabilities: [] })],
    ] as const) {
      const withMissingCapability: CatalogDefinitions = {
        ...defs,
        skills: [...defs.skills, asSkill("SKL_AS2", actionId)],
        units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
        effectActions: [...defs.effectActions, action],
        capabilities: [
          capability("CAP_TARGET_REDIRECT"),
          capability("CAP_COVER_DAMAGE"),
          capability("CAP_REFLECT_DAMAGE"),
          capability("CAP_DEATH_SURVIVAL"),
        ],
      };

      try {
        buildCatalogIndex(withMissingCapability);
        expect.unreachable();
      } catch (error) {
        const err = error as CatalogIntegrityError;
        expect(
          err.violations.some(
            (v) => v.rule === "MISSING_REQUIRED_CAPABILITY" && v.targetId === actionId,
          ),
        ).toBe(true);
      }
    }
  });

  it("UT-R-LNK-03-034 (DMG-007 Issue #187, NEGATIVE): rejects TARGET_HAS_EFFECT.grantedBy outside a trigger condition, where no evaluating unit exists", () => {
    const defs = baseDefinitions();
    const skill = createSkillDefinition({
      skillDefinitionId: "SKL_AS2",
      skillType: "AS",
      cost: { resource: "AP", amount: 1 },
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [
          {
            targetBindingId: "TGT_PRIMARY",
            selector: { kind: "SELECT", side: "ENEMY", count: 1, order: ["DEFAULT"] },
          },
        ],
        steps: [
          {
            kind: "ACTION",
            target: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
            targetCondition: {
              kind: "TARGET_HAS_EFFECT",
              target: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
              categories: ["DEBUFF"],
              grantedBy: "SELF",
            },
            actions: [{ effectActionDefinitionId: "ACT_DAMAGE" }],
          },
        ],
      },
      cooldown: { unit: "ACTION", count: 1 },
      traits: {},
      requiredCapabilities: [],
      metadata: { displayName: "AS" },
    });
    const withMisscopedGrantedBy: CatalogDefinitions = {
      ...defs,
      skills: [...defs.skills, skill],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
    };

    try {
      buildCatalogIndex(withMisscopedGrantedBy);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations.some((v) => v.rule === "GRANTED_BY_OUTSIDE_TRIGGER")).toBe(true);
    }
  });

  it("UT-R-LNK-03-035 (PR #299レビュー[P2], NEGATIVE): rejects a TARGET_HAS_EFFECT.effectActionDefinitionIds that references an undefined EffectActionDefinition, in every condition placement", () => {
    const query = (id: string): ConditionDefinitionInput => ({
      kind: "TARGET_HAS_EFFECT",
      target: { kind: "SELF" },
      categories: ["DEBUFF"],
      effectActionDefinitionIds: [id],
    });
    // trigger / counterUpdates[].trigger / activationCondition / step条件のいずれに
    // 置いても、参照先が存在しなければ条件は常に偽になる（silent no-op）。
    const placements: readonly (readonly [string, SkillDefinition])[] = [
      ["trigger", psSkillWithCondition("SKL_PS_TRIGGER", { trigger: query("ACT_MISSING") })],
      [
        "counterUpdates[].trigger",
        psSkillWithCondition("SKL_PS_COUNTER", { counterUpdateTrigger: query("ACT_MISSING") }),
      ],
      [
        "activationCondition",
        psSkillWithCondition("SKL_PS_ACTIVATION", { activationCondition: query("ACT_MISSING") }),
      ],
      [
        "targetCondition",
        psSkillWithCondition("SKL_PS_TARGET", { targetCondition: query("ACT_MISSING") }),
      ],
    ];

    for (const [placement, skill] of placements) {
      const defs = baseDefinitions();
      const withDanglingQuery: CatalogDefinitions = {
        ...defs,
        skills: [...defs.skills, skill],
        units: [unit("UNIT_001", { passive: [skill.skillDefinitionId] })],
        capabilities: [
          capability("CAP_TARGET_EFFECT_QUERY"),
          capability("CAP_SKILL_RUNTIME_COUNTER"),
          capability("CAP_PASSIVE_ACTIVATION_CONDITION"),
          capability("CAP_EFFECT_STEP_CONDITION_SCOPE"),
        ],
      };

      try {
        buildCatalogIndex(withDanglingQuery);
        expect.unreachable();
      } catch (error) {
        const err = error as CatalogIntegrityError;
        expect(
          err.violations.some((v) => v.rule === "DANGLING_REFERENCE"),
          `${placement} must report DANGLING_REFERENCE`,
        ).toBe(true);
      }
    }
  });

  it("UT-R-LNK-03-037 (PR #299再レビュー[P2], NEGATIVE): rejects a dangling TARGET_HAS_EFFECT.effectActionDefinitionIds inside a DurationDefinition (expiration.conditions / counterUpdates[].trigger.condition)", () => {
    const danglingQuery = {
      kind: "TARGET_HAS_EFFECT",
      target: { kind: "SELF" },
      categories: ["DEBUFF"],
      effectActionDefinitionIds: ["ACT_MISSING"],
    } as const;
    // `DurationDefinition`もSkill/Memoryの条件とまったく同じ`ConditionDefinition`を
    // 2か所に持つ。どちらも走査しなければ、存在しないIDを指す条件が実行時に一切
    // 一致しないまま（silent no-op）ロードを通ってしまう。
    const durations = [
      ["expiration.conditions", { expiration: { conditions: [danglingQuery] } }],
      [
        "counterUpdates[].trigger.condition",
        {
          counterUpdates: [
            {
              kind: "INCREMENT",
              counter: "EFF_TEST_COUNT",
              scope: "APPLIED_EFFECT",
              trigger: {
                eventType: "TurnStarted",
                category: "FACT",
                sourceSelector: "SELF",
                targetSelector: "SELF",
                condition: danglingQuery,
              },
              amount: 1,
            },
          ],
        },
      ],
    ] as const;

    for (const [placement, durationExtra] of durations) {
      const action = createEffectActionDefinition(
        {
          effectActionDefinitionId: "ACT_DURATION_QUERY",
          kind: "APPLY_STAT_MOD",
          payload: {
            stat: "ATTACK",
            valueType: "FIXED",
            formula: { kind: "CONSTANT", value: 20 },
            stacking: { mode: "STACKABLE" },
            duration: {
              timeLimit: { unit: "BATTLE", count: 1 },
              dispellable: true,
              ...durationExtra,
            },
          },
          requiredCapabilities: [
            "CAP_STAT_MOD",
            "CAP_COMPLEX_EXPIRATION",
            "CAP_TARGET_EFFECT_QUERY",
          ],
        },
        "effectAction",
      );
      const defs = baseDefinitions();
      const withDanglingDurationQuery: CatalogDefinitions = {
        ...defs,
        skills: [...defs.skills, asSkill("SKL_AS2", "ACT_DURATION_QUERY")],
        units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
        effectActions: [...defs.effectActions, action],
        capabilities: [
          capability("CAP_STAT_MOD"),
          capability("CAP_COMPLEX_EXPIRATION"),
          capability("CAP_TARGET_EFFECT_QUERY"),
          capability("CAP_EFFECT_RUNTIME_COUNTER"),
        ],
      };

      try {
        buildCatalogIndex(withDanglingDurationQuery);
        expect.unreachable();
      } catch (error) {
        const err = error as CatalogIntegrityError;
        expect(
          err.violations.some(
            (v) => v.rule === "DANGLING_REFERENCE" && v.targetId === "ACT_DURATION_QUERY",
          ),
          `${placement} must report DANGLING_REFERENCE`,
        ).toBe(true);
      }
    }
  });

  it("UT-R-LNK-03-036 (PR #299レビュー[P2], NEGATIVE): rejects TARGET_HAS_EFFECT.grantedBy inside a Memory trigger, whose evaluator has no owning BattleUnit", () => {
    const defs = baseDefinitions();
    const withMemoryGrantedBy: CatalogDefinitions = {
      ...defs,
      effectActions: [...defs.effectActions, memoryModifierAction("ACT_MEMORY_STAT_MOD")],
      memories: [
        memoryWithTrigger("MEM_GRANTED_BY", {
          kind: "TARGET_HAS_EFFECT",
          target: { kind: "SELF" },
          categories: ["DEBUFF"],
          grantedBy: "SELF",
        }),
      ],
      capabilities: [
        capability("CAP_MEMORY_TRIGGERED_EFFECT"),
        capability("CAP_PASSIVE_ACTIVATION_CONDITION"),
        capability("CAP_TARGET_EFFECT_QUERY"),
        capability("CAP_STAT_MOD"),
      ],
    };

    try {
      buildCatalogIndex(withMemoryGrantedBy);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations.some((v) => v.rule === "GRANTED_BY_OUTSIDE_TRIGGER")).toBe(true);
    }
  });

  it("UT-R-LNK-02-030 (DMG-007 Issue #187): accepts an APPLY_DAMAGE_LINK whose linkTo is SELF and whose binding reference is declared by the using skill", () => {
    const defs = baseDefinitions();
    const withLinks: CatalogDefinitions = {
      ...defs,
      skills: [
        ...defs.skills,
        asSkill("SKL_AS2", "ACT_LINK_SELF"),
        asSkill("SKL_AS3", "ACT_LINK_BINDING"),
      ],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2", "SKL_AS3"] })],
      effectActions: [
        ...defs.effectActions,
        damageLinkAction("ACT_LINK_SELF"),
        damageLinkAction("ACT_LINK_BINDING", {
          // `asSkill`が宣言するbinding。
          linkTo: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
        }),
      ],
      capabilities: [capability("CAP_DAMAGE_LINK_STATE")],
    };

    const index = buildCatalogIndex(withLinks);

    expect(index.effectActions.get("ACT_LINK_SELF" as never)).toBeDefined();
    expect(index.effectActions.get("ACT_LINK_BINDING" as never)).toBeDefined();
  });

  it("UT-R-LNK-02-031 (DMG-007 Issue #187, NEGATIVE): rejects a linkTo kind the runtime cannot resolve at grant time", () => {
    for (const linkTo of [{ kind: "TRIGGER_SOURCE" }, { kind: "LAST_DAMAGED_TARGETS" }]) {
      const defs = baseDefinitions();
      const withUnsupportedLink: CatalogDefinitions = {
        ...defs,
        skills: [...defs.skills, asSkill("SKL_AS2", "ACT_LINK")],
        units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
        effectActions: [...defs.effectActions, damageLinkAction("ACT_LINK", { linkTo })],
        capabilities: [capability("CAP_DAMAGE_LINK_STATE")],
      };

      try {
        buildCatalogIndex(withUnsupportedLink);
        expect.unreachable();
      } catch (error) {
        const err = error as CatalogIntegrityError;
        expect(
          err.violations.some(
            (v) => v.rule === "UNSUPPORTED_DEFENSIVE_INTERVENTION" && v.targetId === "ACT_LINK",
          ),
        ).toBe(true);
      }
    }
  });

  it("UT-R-LNK-02-032 (DMG-007 Issue #187, NEGATIVE): rejects an APPLY_DAMAGE_LINK that omits CAP_DAMAGE_LINK_STATE from requiredCapabilities", () => {
    const defs = baseDefinitions();
    const withMissingCapability: CatalogDefinitions = {
      ...defs,
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_LINK")],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      effectActions: [
        ...defs.effectActions,
        damageLinkAction("ACT_LINK", { requiredCapabilities: [] }),
      ],
      capabilities: [capability("CAP_DAMAGE_LINK_STATE")],
    };

    try {
      buildCatalogIndex(withMissingCapability);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations.some(
          (v) => v.rule === "MISSING_REQUIRED_CAPABILITY" && v.targetId === "ACT_LINK",
        ),
      ).toBe(true);
    }
  });

  it("UT-R-LNK-02-033 (DMG-007 Issue #187, NEGATIVE): rejects a BINDING linkTo that the using skill never declares (silent no-op at grant time)", () => {
    const defs = baseDefinitions();
    const withUnboundBinding: CatalogDefinitions = {
      ...defs,
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_LINK")],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      effectActions: [
        ...defs.effectActions,
        damageLinkAction("ACT_LINK", {
          linkTo: { kind: "BINDING", targetBindingId: "TGT_NOT_DECLARED" },
        }),
      ],
      capabilities: [capability("CAP_DAMAGE_LINK_STATE")],
    };

    try {
      buildCatalogIndex(withUnboundBinding);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(err.violations.some((v) => v.rule === "DAMAGE_LINK_UNBOUNDED_BINDING")).toBe(true);
    }
  });

  it("UT-R-EFF-10-015 (R-EFF-10, PR #210レビュー[P2]): accepts an APPLY_MARKER with linkedEffectGroupId: null", () => {
    const defs = baseDefinitions();
    const withMarker: CatalogDefinitions = {
      ...defs,
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_MARKER")],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      effectActions: [...defs.effectActions, markerAction("ACT_MARKER", null)],
      capabilities: [capability("CAP_MARKER")],
    };

    const index = buildCatalogIndex(withMarker);

    expect(index.effectActions.get("ACT_MARKER" as never)).toBeDefined();
  });

  it("UT-R-EFF-10-016 (R-EFF-10, PR #210再レビュー[P2]): accepts two APPLY_MARKER definitions sharing a linkedEffectGroupId (Marker-to-Marker cascade is implemented, linked-effect-group.ts)", () => {
    const defs = baseDefinitions();
    const withLinkedMarkers: CatalogDefinitions = {
      ...defs,
      skills: [
        ...defs.skills,
        asSkill("SKL_AS2", "ACT_MARKER_1"),
        asSkill("SKL_AS3", "ACT_MARKER_2"),
      ],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2", "SKL_AS3"] })],
      effectActions: [
        ...defs.effectActions,
        markerAction("ACT_MARKER_1", "GROUP_1"),
        markerAction("ACT_MARKER_2", "GROUP_1"),
      ],
      capabilities: [capability("CAP_MARKER")],
    };

    const index = buildCatalogIndex(withLinkedMarkers);

    expect(index.effectActions.get("ACT_MARKER_1" as never)).toBeDefined();
    expect(index.effectActions.get("ACT_MARKER_2" as never)).toBeDefined();
  });

  it("UT-R-EFF-10-017 (R-EFF-10/R-EFF-09 cross-type, M7-013): accepts an APPLY_MARKER sharing a linkedEffectGroupId with a non-Marker EffectActionDefinition now that the AppliedEffect<->MarkerState cascade is implemented", () => {
    const defs = baseDefinitions();
    const withCrossTypeGroup: CatalogDefinitions = {
      ...defs,
      skills: [
        ...defs.skills,
        asSkill("SKL_AS2", "ACT_MARKER"),
        asSkill("SKL_AS3", "ACT_STAT_MOD"),
      ],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2", "SKL_AS3"] })],
      effectActions: [
        ...defs.effectActions,
        markerAction("ACT_MARKER", "GROUP_1"),
        statModAction("ACT_STAT_MOD", ["CAP_STAT_MOD"], "GROUP_1"),
      ],
      capabilities: [capability("CAP_MARKER"), capability("CAP_STAT_MOD")],
    };

    const index = buildCatalogIndex(withCrossTypeGroup);

    expect(index.effectActions.get("ACT_MARKER" as never)).toBeDefined();
    expect(index.effectActions.get("ACT_STAT_MOD" as never)).toBeDefined();
  });

  it("UT-R-EFF-10-018 (R-EFF-10, PR #210再レビュー[P2]): rejects an APPLY_MARKER with duration.consumption, duration.expiration, or a HIT/SKILL_USE timeLimit unit, since Marker consumption/special-expiration/per-hit-or-use decrement are not implemented (marker-duration.ts)", () => {
    const withConsumptionPatched = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_MARKER_CONSUMPTION",
        kind: "APPLY_MARKER",
        payload: {
          markerId: "MARKER_TEST",
          stack: { policy: "ADD", max: null },
          duration: {
            dispellable: true,
            linkedEffectGroupId: null,
            consumption: { kind: "INCOMING_HIT", maxCount: 1 },
          },
        },
        requiredCapabilities: ["CAP_MARKER"],
      },
      "effectAction",
    );
    const withExpirationPatched = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_MARKER_EXPIRATION",
        kind: "APPLY_MARKER",
        payload: {
          markerId: "MARKER_TEST",
          stack: { policy: "ADD", max: null },
          duration: {
            dispellable: true,
            linkedEffectGroupId: null,
            expiration: { conditions: [{ kind: "TRUE" }] },
          },
        },
        requiredCapabilities: ["CAP_MARKER"],
      },
      "effectAction",
    );
    const withHitUnitPatched = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_MARKER_HIT_UNIT",
        kind: "APPLY_MARKER",
        payload: {
          markerId: "MARKER_TEST",
          stack: { policy: "ADD", max: null },
          duration: {
            dispellable: true,
            linkedEffectGroupId: null,
            timeLimit: { unit: "HIT", count: 1 },
          },
        },
        requiredCapabilities: ["CAP_MARKER"],
      },
      "effectAction",
    );

    const defs = baseDefinitions();
    const withUnsupportedDurations: CatalogDefinitions = {
      ...defs,
      skills: [
        ...defs.skills,
        asSkill("SKL_AS2", "ACT_MARKER_CONSUMPTION"),
        asSkill("SKL_AS3", "ACT_MARKER_EXPIRATION"),
        asSkill("SKL_AS4", "ACT_MARKER_HIT_UNIT"),
      ],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2", "SKL_AS3", "SKL_AS4"] })],
      effectActions: [
        ...defs.effectActions,
        withConsumptionPatched,
        withExpirationPatched,
        withHitUnitPatched,
      ],
      capabilities: [capability("CAP_MARKER")],
    };

    try {
      buildCatalogIndex(withUnsupportedDurations);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations
          .filter((v) => v.rule === "UNSUPPORTED_MARKER_DURATION")
          .map((v) => v.targetId),
      ).toEqual(
        expect.arrayContaining([
          "ACT_MARKER_CONSUMPTION",
          "ACT_MARKER_EXPIRATION",
          "ACT_MARKER_HIT_UNIT",
        ]),
      );
    }
  });

  it("UT-R-EFF-10-021 (R-EFF-10 M7-020 Issue #279): accepts duration.removeOnSourceDefeated on APPLY_MARKER", () => {
    const markerWithSourceDefeatRemoval = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_MARKER_SOURCE_DEFEAT",
        kind: "APPLY_MARKER",
        payload: {
          markerId: "MARKER_TEST",
          stack: { policy: "ADD", max: null },
          duration: {
            dispellable: true,
            linkedEffectGroupId: null,
            timeLimit: { unit: "BATTLE", count: 1 },
            removeOnSourceDefeated: true,
          },
        },
        requiredCapabilities: ["CAP_MARKER"],
      },
      "effectAction",
    );

    const defs = baseDefinitions();
    const index = buildCatalogIndex({
      ...defs,
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_MARKER_SOURCE_DEFEAT")],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      effectActions: [...defs.effectActions, markerWithSourceDefeatRemoval],
      capabilities: [capability("CAP_MARKER")],
    });

    expect(index.effectActions.get("ACT_MARKER_SOURCE_DEFEAT" as never)).toBeDefined();
  });

  it("UT-R-EFF-10-022 (R-EFF-10 M7-020 Issue #279): rejects duration.removeOnSourceDefeated on a non-APPLY_MARKER kind, since only MarkerState carries the granter identity that the removal trigger reads", () => {
    const statModWithSourceDefeatRemoval = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_STAT_MOD_SOURCE_DEFEAT",
        kind: "APPLY_STAT_MOD",
        payload: {
          stat: "ATTACK",
          valueType: "FIXED",
          formula: { kind: "CONSTANT", value: 20 },
          stacking: { mode: "STACKABLE" },
          duration: {
            timeLimit: { unit: "TURN", count: 2 },
            dispellable: true,
            linkedEffectGroupId: null,
            removeOnSourceDefeated: true,
          },
        },
        requiredCapabilities: ["CAP_STAT_MOD"],
      },
      "effectAction",
    );

    const defs = baseDefinitions();
    try {
      buildCatalogIndex({
        ...defs,
        skills: [...defs.skills, asSkill("SKL_AS2", "ACT_STAT_MOD_SOURCE_DEFEAT")],
        units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
        effectActions: [...defs.effectActions, statModWithSourceDefeatRemoval],
        capabilities: [capability("CAP_MARKER"), capability("CAP_STAT_MOD")],
      });
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations
          .filter((v) => v.rule === "UNSUPPORTED_SOURCE_DEFEATED_REMOVAL")
          .map((v) => v.targetId),
      ).toEqual(["ACT_STAT_MOD_SOURCE_DEFEAT"]);
    }
  });

  it("UT-CAT-IDX-021: rejects a production definition that uses a schema-unsupported Capability", () => {
    const defs = baseDefinitions();
    const schemaPlanned = createCapabilityDefinition({
      capabilityId: "CAP_FUTURE_SCHEMA",
      schemaStatus: "PLANNED",
      runtimeStatus: "PLANNED",
      implementationTaskId: "TEST-001",
      description: "future schema",
      verification: { productionDefinitionIds: [], testCaseIds: [] },
    });

    expect(() =>
      buildCatalogIndex({
        ...defs,
        units: [unit("UNIT_001", { requiredCapabilities: ["CAP_FUTURE_SCHEMA"] })],
        capabilities: [schemaPlanned],
      }),
    ).toThrowError(/UNSUPPORTED_SCHEMA_CAPABILITY/);
  });

  it("UT-CAT-IDX-022: rejects IMPLEMENTED evidence pointing to a missing production definition", () => {
    const defs = baseDefinitions();
    const implemented = createCapabilityDefinition({
      capabilityId: "CAP_READY",
      schemaStatus: "SUPPORTED",
      runtimeStatus: "IMPLEMENTED",
      implementationTaskId: "TEST-001",
      description: "ready",
      verification: {
        productionDefinitionIds: ["ACT_MISSING"],
        testCaseIds: ["TEST-001"],
      },
    });

    expect(() => buildCatalogIndex({ ...defs, capabilities: [implemented] })).toThrowError(
      /INVALID_CAPABILITY_VERIFICATION/,
    );
  });

  it("UT-CAT-IDX-023: rejects IMPLEMENTED evidence whose production definition does not declare the Capability", () => {
    const defs = baseDefinitions();
    const implemented = createCapabilityDefinition({
      capabilityId: "CAP_READY",
      schemaStatus: "SUPPORTED",
      runtimeStatus: "IMPLEMENTED",
      implementationTaskId: "TEST-001",
      description: "ready",
      verification: {
        productionDefinitionIds: ["ACT_DAMAGE_1"],
        testCaseIds: ["TEST-001"],
      },
    });

    expect(() => buildCatalogIndex({ ...defs, capabilities: [implemented] })).toThrowError(
      /does not declare capability/,
    );
  });

  it("UT-CAT-IDX-024: rejects BRANCH/REPEAT skills without CAP_RESOLUTION_BRANCH_REPEAT", () => {
    const defs = baseDefinitions();
    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [branchSkill("SKL_AS1", []), exSkill("SKL_EX1", 7)],
        capabilities: [capability("CAP_RESOLUTION_BRANCH_REPEAT")],
      }),
    ).toThrowError(/must declare "CAP_RESOLUTION_BRANCH_REPEAT"/);

    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [branchSkill("SKL_AS1", ["CAP_RESOLUTION_BRANCH_REPEAT"]), exSkill("SKL_EX1", 7)],
        capabilities: [capability("CAP_RESOLUTION_BRANCH_REPEAT")],
      }),
    ).not.toThrow();
  });

  it("UT-CAT-IDX-025: rejects runtime-owned trigger events without CAP_TRIGGER_CONTEXT", () => {
    const defs = baseDefinitions();
    expect(() =>
      buildCatalogIndex({
        ...defs,
        units: [unit("UNIT_001", { passive: ["SKL_PS1"] })],
        skills: [...defs.skills, psSkill("SKL_PS1", "HitPointReduced", "FACT")],
        capabilities: [capability("CAP_TRIGGER_CONTEXT")],
      }),
    ).toThrowError(/must declare "CAP_TRIGGER_CONTEXT"/);
  });

  it("UT-CAT-IDX-072 (R-DMG-05 #4、DMG-001/Issue #195): treats DamageWillBeApplied as a runtime-owned trigger event, so a PS reacting to it must declare CAP_TRIGGER_CONTEXT", () => {
    const defs = baseDefinitions();
    expect(() =>
      buildCatalogIndex({
        ...defs,
        units: [unit("UNIT_001", { passive: ["SKL_PS1"] })],
        skills: [...defs.skills, psSkill("SKL_PS1", "DamageWillBeApplied", "TIMING")],
        capabilities: [capability("CAP_TRIGGER_CONTEXT")],
      }),
    ).toThrowError(/must declare "CAP_TRIGGER_CONTEXT"/);

    expect(() =>
      buildCatalogIndex({
        ...defs,
        units: [unit("UNIT_001", { passive: ["SKL_PS1"] })],
        skills: [
          ...defs.skills,
          psSkill("SKL_PS1", "DamageWillBeApplied", "TIMING", ["CAP_TRIGGER_CONTEXT"]),
        ],
        capabilities: [capability("CAP_TRIGGER_CONTEXT")],
      }),
    ).not.toThrow();
  });

  it("UT-CAT-IDX-026: rejects BRANCH/REPEAT memories without CAP_RESOLUTION_BRANCH_REPEAT", () => {
    const defs = baseDefinitions();
    expect(() =>
      buildCatalogIndex({
        ...defs,
        effectActions: [...defs.effectActions, memoryModifierAction("ACT_MEMORY_STAT_MOD")],
        memories: [branchMemory(["CAP_MEMORY_TRIGGERED_EFFECT"])],
        capabilities: [
          capability("CAP_MEMORY_TRIGGERED_EFFECT"),
          capability("CAP_RESOLUTION_BRANCH_REPEAT"),
        ],
      }),
    ).toThrowError(/must declare "CAP_RESOLUTION_BRANCH_REPEAT"/);

    expect(() =>
      buildCatalogIndex({
        ...defs,
        effectActions: [...defs.effectActions, memoryModifierAction("ACT_MEMORY_STAT_MOD")],
        memories: [branchMemory(["CAP_MEMORY_TRIGGERED_EFFECT", "CAP_RESOLUTION_BRANCH_REPEAT"])],
        capabilities: [
          capability("CAP_MEMORY_TRIGGERED_EFFECT"),
          capability("CAP_RESOLUTION_BRANCH_REPEAT"),
        ],
      }),
    ).not.toThrow();
  });

  it("UT-CAT-IDX-027: rejects runtime-owned Memory triggers without CAP_TRIGGER_CONTEXT", () => {
    const defs = baseDefinitions();
    expect(() =>
      buildCatalogIndex({
        ...defs,
        effectActions: [...defs.effectActions, memoryModifierAction("ACT_MEMORY_STAT_MOD")],
        memories: [triggerContextMemory(["CAP_MEMORY_TRIGGERED_EFFECT"])],
        capabilities: [
          capability("CAP_MEMORY_TRIGGERED_EFFECT"),
          capability("CAP_TRIGGER_CONTEXT"),
        ],
      }),
    ).toThrowError(/must declare "CAP_TRIGGER_CONTEXT"/);

    expect(() =>
      buildCatalogIndex({
        ...defs,
        effectActions: [...defs.effectActions, memoryModifierAction("ACT_MEMORY_STAT_MOD")],
        memories: [triggerContextMemory(["CAP_MEMORY_TRIGGERED_EFFECT", "CAP_TRIGGER_CONTEXT"])],
        capabilities: [
          capability("CAP_MEMORY_TRIGGERED_EFFECT"),
          capability("CAP_TRIGGER_CONTEXT"),
        ],
      }),
    ).not.toThrow();
  });

  it.each([
    {
      capabilityId: "CAP_TARGET_FILTER_ORDER",
      selector: {
        kind: "SELECT",
        side: "ENEMY",
        count: 1,
        filters: [{ kind: "POSITION_ROW", row: "FRONT" }],
      },
    },
    {
      capabilityId: "CAP_TARGET_DERIVED_AREA",
      selector: {
        kind: "BINDING_DERIVED",
        base: { kind: "SELF" },
        area: { kind: "SAME_ROW_AS_BASE", includeBase: false },
      },
    },
    {
      capabilityId: "CAP_TARGET_BINDING_FALLBACK",
      selector: {
        kind: "SELECT",
        side: "ENEMY",
        count: 1,
        fallback: { kind: "SELECT", side: "ENEMY", count: 1 },
      },
    },
  ])(
    "UT-CAT-IDX-028: rejects $capabilityId-owned target structure without its Capability",
    ({ capabilityId, selector }) => {
      const defs = baseDefinitions();
      expect(() =>
        buildCatalogIndex({
          ...defs,
          skills: [targetingSkill(selector, []), exSkill("SKL_EX1", 7)],
          capabilities: [capability(capabilityId)],
        }),
      ).toThrowError(new RegExp(`must declare "${capabilityId}"`));

      expect(() =>
        buildCatalogIndex({
          ...defs,
          skills: [targetingSkill(selector, [capabilityId]), exSkill("SKL_EX1", 7)],
          capabilities: [capability(capabilityId)],
        }),
      ).not.toThrow();
    },
  );

  it("UT-CAT-IDX-029: rejects TRIGGER_SOURCE/TRIGGER_TARGET EffectStep references without CAP_TRIGGER_CONTEXT", () => {
    const defs = baseDefinitions();
    const selector = { kind: "SELECT", side: "ENEMY", count: 1 } as const;
    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [targetingSkill(selector, [], { kind: "TRIGGER_TARGET" }), exSkill("SKL_EX1", 7)],
        capabilities: [capability("CAP_TRIGGER_CONTEXT")],
      }),
    ).toThrowError(/must declare "CAP_TRIGGER_CONTEXT"/);

    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [
          targetingSkill(selector, ["CAP_TRIGGER_CONTEXT"], { kind: "TRIGGER_SOURCE" }),
          exSkill("SKL_EX1", 7),
        ],
        capabilities: [capability("CAP_TRIGGER_CONTEXT")],
      }),
    ).not.toThrow();
  });

  /**
   * PRレビュー[P2]（Issue #227）: `TargetReference`の走査は従来ACTIONの
   * `step.target`だけを見ており、`condition`（`TARGET_SET_COUNT`等）に埋め込まれた
   * `TargetReference`を見ていなかった。この2つのテストは、その走査が`condition`側
   * まで及ぶことを確認する。
   */
  function conditionTargetRefSkill(
    conditionTarget: TargetReferenceInput,
    requiredCapabilities: readonly string[],
    withPrecedingAction = false,
  ): SkillDefinition {
    const conditionStep = {
      kind: "ACTION",
      stepCondition: { kind: "TARGET_SET_COUNT", target: conditionTarget, op: "GTE", value: 1 },
      target: { kind: "SELF" },
      actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
    } as const;
    return createSkillDefinition({
      skillDefinitionId: "SKL_AS1",
      skillType: "AS",
      cost: { resource: "AP", amount: 1 },
      resolution: {
        kind: "IMMEDIATE",
        steps: withPrecedingAction
          ? [
              {
                kind: "ACTION",
                target: { kind: "SELF" },
                actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
              },
              conditionStep,
            ]
          : [conditionStep],
      },
      cooldown: { unit: "ACTION", count: 1 },
      traits: {},
      requiredCapabilities,
      metadata: { displayName: "Set-condition TargetReference AS" },
    });
  }

  it("UT-CAT-IDX-057（PRレビュー[P2]、Issue #227）: rejects a TARGET_SET_COUNT condition referencing TRIGGER_TARGET without CAP_TRIGGER_CONTEXT", () => {
    const defs = baseDefinitions();
    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [
          conditionTargetRefSkill({ kind: "TRIGGER_TARGET" }, [
            "CAP_EFFECT_STEP_CONDITION",
            "CAP_EFFECT_STEP_SET_CONDITION",
          ]),
          exSkill("SKL_EX1", 7),
        ],
        capabilities: [
          capability("CAP_EFFECT_STEP_CONDITION"),
          capability("CAP_EFFECT_STEP_SET_CONDITION"),
          capability("CAP_TRIGGER_CONTEXT"),
        ],
      }),
    ).toThrowError(/must declare "CAP_TRIGGER_CONTEXT"/);

    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [
          conditionTargetRefSkill({ kind: "TRIGGER_TARGET" }, [
            "CAP_EFFECT_STEP_CONDITION",
            "CAP_EFFECT_STEP_SET_CONDITION",
            "CAP_TRIGGER_CONTEXT",
          ]),
          exSkill("SKL_EX1", 7),
        ],
        capabilities: [
          capability("CAP_EFFECT_STEP_CONDITION"),
          capability("CAP_EFFECT_STEP_SET_CONDITION"),
          capability("CAP_TRIGGER_CONTEXT"),
        ],
      }),
    ).not.toThrow();
  });

  it("UT-CAT-IDX-058（PRレビュー[P2]、Issue #227）: rejects a TARGET_SET_COUNT condition referencing LAST_ACTION_TARGETS with no preceding EffectAction result (MISSING_PRECEDING_RESULT)", () => {
    const defs = baseDefinitions();
    const caps = [
      "CAP_EFFECT_STEP_CONDITION",
      "CAP_EFFECT_STEP_SET_CONDITION",
      "CAP_RESOLUTION_BRANCH_REPEAT",
    ];
    const capabilities = [
      capability("CAP_EFFECT_STEP_CONDITION"),
      capability("CAP_EFFECT_STEP_SET_CONDITION"),
      capability("CAP_RESOLUTION_BRANCH_REPEAT"),
    ];

    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [
          conditionTargetRefSkill({ kind: "LAST_ACTION_TARGETS" }, caps, false),
          exSkill("SKL_EX1", 7),
        ],
        capabilities,
      }),
    ).toThrowError(/MISSING_PRECEDING_RESULT/);

    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [
          conditionTargetRefSkill({ kind: "LAST_ACTION_TARGETS" }, caps, true),
          exSkill("SKL_EX1", 7),
        ],
        capabilities,
      }),
    ).not.toThrow();
  });

  // UT-CAT-IDX-059/060/061（Issue #227）はACTION自身のconditionツリーへ
  // TARGET_SET_COUNTとTARGET_STATE/TARGET_HAS_MARKERを混在させる構成の
  // 拒否を検証していたが、Issue #230でACTIONの`condition`は`stepCondition`/
  // `targetCondition`という独立したスキーマフィールドへ分離され、この種の
  // 混在は型・Catalogスキーマの両方で構築不可能になった（`assertKnownKeys`が
  // ACTIONの`condition`キー自体を拒否する）。同等のscope制約は
  // `effect-sequence.test.ts`（`createEffectStepDefinition`のACTIONケース）が
  // 検証する。BRANCH自身のconditionは今も単一フィールドのままのため、
  // BRANCHについての同種の混在拒否はUT-CAT-IDX-062が引き続き検証する。

  it("UT-CAT-IDX-062（PRレビュー[P2]再々々々指摘、Issue #227）: rejects the same mix inside a BRANCH's own condition, which also evaluates with no per-target context at runtime", () => {
    const defs = baseDefinitions();
    const caps = ["CAP_EFFECT_STEP_CONDITION", "CAP_EFFECT_STEP_SET_CONDITION"];
    const capabilities = [
      capability("CAP_EFFECT_STEP_CONDITION"),
      capability("CAP_EFFECT_STEP_SET_CONDITION"),
    ];

    const branchMixedSkill = createSkillDefinition({
      skillDefinitionId: "SKL_AS1",
      skillType: "AS",
      cost: { resource: "AP", amount: 1 },
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [
          {
            targetBindingId: "TGT_OTHER",
            selector: {
              kind: "SELECT",
              side: "ALLY",
              count: "ALL",
              filters: [],
              order: ["DEFAULT"],
              includeDefeated: false,
            },
          },
        ],
        steps: [
          {
            kind: "BRANCH",
            condition: {
              kind: "AND",
              conditions: [
                {
                  kind: "TARGET_STATE",
                  target: { kind: "SELF" },
                  field: "IS_ALIVE",
                  op: "EQ",
                  value: true,
                },
                {
                  kind: "TARGET_SET_COUNT",
                  target: { kind: "BINDING", targetBindingId: "TGT_OTHER" },
                  op: "GTE",
                  value: 1,
                },
              ],
            },
            thenSteps: [
              {
                kind: "ACTION",
                target: { kind: "SELF" },
                actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
              },
            ],
            elseSteps: [],
          },
        ],
      },
      cooldown: { unit: "ACTION", count: 1 },
      traits: {},
      requiredCapabilities: [...caps, "CAP_RESOLUTION_BRANCH_REPEAT"],
      metadata: { displayName: "Branch-condition mixed AS" },
    });

    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [branchMixedSkill, exSkill("SKL_EX1", 7)],
        capabilities: [...capabilities, capability("CAP_RESOLUTION_BRANCH_REPEAT")],
      }),
    ).toThrowError(/MIXED_STEP_TARGET_SET_CONDITION/);
  });

  describe("BRANCH_TARGET_STATE_UNBOUNDED_REFERENCE（Issue #230 PRレビュー[P1]）: BRANCHのcondition内のTARGET_STATE/TARGET_HAS_MARKERは高々1体に解決される参照だけを許可する", () => {
    const caps = [
      "CAP_EFFECT_STEP_CONDITION",
      "CAP_TRIGGER_CONTEXT",
      "CAP_RESOLUTION_BRANCH_REPEAT",
    ];
    const capabilities = [
      capability("CAP_EFFECT_STEP_CONDITION"),
      capability("CAP_TRIGGER_CONTEXT"),
      capability("CAP_RESOLUTION_BRANCH_REPEAT"),
    ];

    function branchConditionSkill(
      condition: ConditionDefinitionInput,
      multiBindingSelector?: TargetSelectorDefinitionInput,
      extraCapabilities: readonly string[] = [],
    ): SkillDefinition {
      return createSkillDefinition({
        skillDefinitionId: "SKL_AS1",
        skillType: "AS",
        cost: { resource: "AP", amount: 1 },
        resolution: {
          kind: "IMMEDIATE",
          targetBindings:
            multiBindingSelector !== undefined
              ? [{ targetBindingId: "TGT_OTHER", selector: multiBindingSelector }]
              : [],
          steps: [
            {
              kind: "BRANCH",
              condition,
              thenSteps: [
                {
                  kind: "ACTION",
                  target: { kind: "SELF" },
                  actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
                },
              ],
              elseSteps: [],
            },
          ],
        },
        cooldown: { unit: "ACTION", count: 1 },
        traits: {},
        requiredCapabilities: [...caps, ...extraCapabilities],
        metadata: { displayName: "Branch target-state scope AS" },
      });
    }

    it("UT-CAT-IDX-064: rejects a BRANCH condition whose TARGET_STATE references TRIGGER_TARGET (not guaranteed to resolve to at most one unit)", () => {
      const defs = baseDefinitions();
      const skill = branchConditionSkill({
        kind: "TARGET_STATE",
        target: { kind: "TRIGGER_TARGET" },
        field: "IS_ALIVE",
        op: "EQ",
        value: true,
      });
      expect(() =>
        buildCatalogIndex({ ...defs, skills: [skill, exSkill("SKL_EX1", 7)], capabilities }),
      ).toThrowError(/BRANCH_TARGET_STATE_UNBOUNDED_REFERENCE/);
    });

    it("UT-CAT-IDX-065: rejects a BRANCH condition whose TARGET_HAS_MARKER references a BINDING whose selector.count is not 1 (ALL or a number > 1)", () => {
      const defs = baseDefinitions();
      const allSkill = branchConditionSkill(
        {
          kind: "TARGET_HAS_MARKER",
          target: { kind: "BINDING", targetBindingId: "TGT_OTHER" },
          markerId: "MARKER_X",
        },
        { kind: "SELECT", side: "ENEMY", count: "ALL", order: ["DEFAULT"] },
      );
      expect(() =>
        buildCatalogIndex({ ...defs, skills: [allSkill, exSkill("SKL_EX1", 7)], capabilities }),
      ).toThrowError(/BRANCH_TARGET_STATE_UNBOUNDED_REFERENCE/);

      const twoSkill = branchConditionSkill(
        {
          kind: "TARGET_HAS_MARKER",
          target: { kind: "BINDING", targetBindingId: "TGT_OTHER" },
          markerId: "MARKER_X",
        },
        { kind: "SELECT", side: "ENEMY", count: 2, order: ["DEFAULT"] },
      );
      expect(() =>
        buildCatalogIndex({ ...defs, skills: [twoSkill, exSkill("SKL_EX1", 7)], capabilities }),
      ).toThrowError(/BRANCH_TARGET_STATE_UNBOUNDED_REFERENCE/);
    });

    it("UT-CAT-IDX-066: rejects a BRANCH condition whose TARGET_STATE references a BINDING_DERIVED selector (area-filtered, unbounded 0..N)", () => {
      const defs = baseDefinitions();
      const skill = branchConditionSkill(
        {
          kind: "TARGET_STATE",
          target: { kind: "BINDING", targetBindingId: "TGT_OTHER" },
          field: "IS_ALIVE",
          op: "EQ",
          value: true,
        },
        {
          kind: "BINDING_DERIVED",
          base: { kind: "SELF" },
          area: { kind: "ADJACENT_ORTHOGONAL" },
        },
      );
      expect(() =>
        buildCatalogIndex({ ...defs, skills: [skill, exSkill("SKL_EX1", 7)], capabilities }),
      ).toThrowError(/BRANCH_TARGET_STATE_UNBOUNDED_REFERENCE/);
    });

    it("UT-CAT-IDX-067: accepts a BRANCH condition whose TARGET_STATE/TARGET_HAS_MARKER references SELF, TRIGGER_SOURCE, or a count:1 BINDING", () => {
      const defs = baseDefinitions();
      const selfSkill = branchConditionSkill({
        kind: "TARGET_STATE",
        target: { kind: "SELF" },
        field: "IS_ALIVE",
        op: "EQ",
        value: true,
      });
      expect(() =>
        buildCatalogIndex({ ...defs, skills: [selfSkill, exSkill("SKL_EX1", 7)], capabilities }),
      ).not.toThrow();

      const triggerSourceSkill = branchConditionSkill({
        kind: "TARGET_STATE",
        target: { kind: "TRIGGER_SOURCE" },
        field: "IS_ALIVE",
        op: "EQ",
        value: true,
      });
      expect(() =>
        buildCatalogIndex({
          ...defs,
          skills: [triggerSourceSkill, exSkill("SKL_EX1", 7)],
          capabilities,
        }),
      ).not.toThrow();

      const bindingSkill = branchConditionSkill(
        {
          kind: "TARGET_HAS_MARKER",
          target: { kind: "BINDING", targetBindingId: "TGT_OTHER" },
          markerId: "MARKER_X",
        },
        { kind: "SELECT", side: "ENEMY", count: 1, order: ["DEFAULT"] },
      );
      expect(() =>
        buildCatalogIndex({ ...defs, skills: [bindingSkill, exSkill("SKL_EX1", 7)], capabilities }),
      ).not.toThrow();
    });

    it("UT-CAT-IDX-068: detects the same unbounded reference nested inside REPEAT > RANDOM_BRANCH > BRANCH", () => {
      const defs = baseDefinitions();
      const unboundedCondition: ConditionDefinitionInput = {
        kind: "TARGET_STATE",
        target: { kind: "TRIGGER_TARGET" },
        field: "IS_ALIVE",
        op: "EQ",
        value: true,
      };
      const withNestedBranch = createSkillDefinition({
        skillDefinitionId: "SKL_AS1",
        skillType: "AS",
        cost: { resource: "AP", amount: 1 },
        resolution: {
          kind: "IMMEDIATE",
          targetBindings: [],
          steps: [
            {
              kind: "REPEAT",
              count: 1,
              steps: [
                {
                  kind: "RANDOM_BRANCH",
                  mode: "INDEPENDENT",
                  branches: [
                    {
                      probability: 1,
                      steps: [
                        {
                          kind: "BRANCH",
                          condition: unboundedCondition,
                          thenSteps: [],
                          elseSteps: [],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        cooldown: { unit: "ACTION", count: 1 },
        traits: {},
        requiredCapabilities: [
          "CAP_TRIGGER_CONTEXT",
          "CAP_RESOLUTION_BRANCH_REPEAT",
          "CAP_RANDOM_BRANCH",
        ],
        metadata: { displayName: "Nested branch target-state scope AS" },
      });
      expect(() =>
        buildCatalogIndex({
          ...defs,
          skills: [withNestedBranch, exSkill("SKL_EX1", 7)],
          capabilities: [...capabilities, capability("CAP_RANDOM_BRANCH")],
        }),
      ).toThrowError(/BRANCH_TARGET_STATE_UNBOUNDED_REFERENCE/);
    });

    it("UT-CAT-IDX-069（PRレビュー[P2]再指摘）: rejects a BRANCH condition referencing a BINDING whose primary selector is count:1 but whose fallback can resolve to more than one unit", () => {
      const defs = baseDefinitions();
      const skill = branchConditionSkill(
        {
          kind: "TARGET_STATE",
          target: { kind: "BINDING", targetBindingId: "TGT_OTHER" },
          field: "IS_ALIVE",
          op: "EQ",
          value: true,
        },
        {
          kind: "SELECT",
          side: "ENEMY",
          count: 1,
          order: ["DEFAULT"],
          fallback: { kind: "SELECT", side: "ENEMY", count: "ALL", order: ["DEFAULT"] },
        },
      );
      expect(() =>
        buildCatalogIndex({ ...defs, skills: [skill, exSkill("SKL_EX1", 7)], capabilities }),
      ).toThrowError(/BRANCH_TARGET_STATE_UNBOUNDED_REFERENCE/);
    });

    /**
     * PR #287レビュー[P2]（Issue #248）: AS/EXの`activationCondition`は
     * `evaluateActivationCondition`（`lifecycle/activation-condition-evaluator.ts`）が
     * 解決済みbindingを`TargetSetResolver`として渡して評価するため、BRANCHと
     * まったく同じ「高々1体」制約が実行時に効く。Catalogロード側にこの制約が
     * 無いと、`count: "ALL"`のbindingを参照する定義が正常にロードされたまま
     * 行動選択中に`DomainValidationError`で落ちる。
     */
    function activationConditionSkill(
      condition: ConditionDefinitionInput,
      selector: TargetSelectorDefinitionInput,
      skillType: "AS" | "EX" | "PS" = "AS",
    ): SkillDefinition {
      return createSkillDefinition({
        skillDefinitionId:
          skillType === "EX" ? "SKL_EX1" : skillType === "PS" ? "SKL_PS1" : "SKL_AS1",
        skillType,
        cost: {
          resource: skillType === "EX" ? "EX_GAUGE" : skillType === "PS" ? "PP" : "AP",
          amount: 1,
        },
        activationCondition: condition,
        ...(skillType === "PS"
          ? {
              triggers: [
                {
                  eventType: "DamageApplied",
                  category: "FACT",
                  sourceSelector: "ENEMY",
                  targetSelector: "SELF",
                },
              ],
            }
          : {}),
        resolution: {
          kind: "IMMEDIATE",
          targetBindings: [{ targetBindingId: "TGT_OTHER", selector }],
          steps: [
            {
              kind: "ACTION",
              target: { kind: "BINDING", targetBindingId: "TGT_OTHER" },
              actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
            },
          ],
        },
        cooldown: { unit: "ACTION", count: 1 },
        traits: {},
        requiredCapabilities:
          skillType === "PS"
            ? ["CAP_PASSIVE_ACTIVATION_CONDITION", "CAP_TARGET_EFFECT_QUERY"]
            : ["CAP_ACTION_ACTIVATION_CONDITION", "CAP_TARGET_EFFECT_QUERY"],
        metadata: { displayName: "Activation condition scope AS" },
      });
    }

    const ACTIVATION_CAPABILITIES = [
      capability("CAP_ACTION_ACTIVATION_CONDITION"),
      capability("CAP_TARGET_EFFECT_QUERY"),
      capability("CAP_CHARGE_RESTRICTION"),
    ];

    it("UT-CAT-IDX-092 (PR #287レビュー[P2], Issue #248): rejects an AS activationCondition whose TARGET_HAS_EFFECT references a BINDING that can resolve to more than one unit", () => {
      const defs = baseDefinitions();
      const skill = activationConditionSkill(
        {
          kind: "TARGET_HAS_EFFECT",
          target: { kind: "BINDING", targetBindingId: "TGT_OTHER" },
          categories: ["DEBUFF"],
        },
        { kind: "SELECT", side: "ENEMY", count: "ALL", order: ["DEFAULT"] },
      );
      expect(() =>
        buildCatalogIndex({
          ...defs,
          skills: [skill, exSkill("SKL_EX1", 7)],
          capabilities: ACTIVATION_CAPABILITIES,
        }),
      ).toThrowError(/ACTIVATION_CONDITION_UNBOUNDED_REFERENCE/);
    });

    it("UT-CAT-IDX-093 (PR #287レビュー[P2], Issue #248): applies the same rule to TARGET_STATE/TARGET_HAS_MARKER, which share the AS/EX activationCondition evaluation path", () => {
      const defs = baseDefinitions();
      const multiSelector: TargetSelectorDefinitionInput = {
        kind: "SELECT",
        side: "ENEMY",
        count: "ALL",
        order: ["DEFAULT"],
      };
      for (const condition of [
        {
          kind: "TARGET_STATE",
          target: { kind: "BINDING", targetBindingId: "TGT_OTHER" },
          field: "IS_ALIVE",
          op: "EQ",
          value: true,
        },
        {
          kind: "TARGET_HAS_MARKER",
          target: { kind: "BINDING", targetBindingId: "TGT_OTHER" },
          markerId: "MARKER_TEST",
        },
      ] satisfies ConditionDefinitionInput[]) {
        expect(() =>
          buildCatalogIndex({
            ...defs,
            skills: [activationConditionSkill(condition, multiSelector), exSkill("SKL_EX1", 7)],
            capabilities: ACTIVATION_CAPABILITIES,
          }),
        ).toThrowError(/ACTIVATION_CONDITION_UNBOUNDED_REFERENCE/);
      }
    });

    it("UT-CAT-IDX-094 (PR #287レビュー[P2], Issue #248): accepts a count:1 BINDING on an AS activationCondition", () => {
      const defs = baseDefinitions();
      expect(() =>
        buildCatalogIndex({
          ...defs,
          skills: [
            activationConditionSkill(
              {
                kind: "TARGET_HAS_EFFECT",
                target: { kind: "BINDING", targetBindingId: "TGT_OTHER" },
                categories: ["DEBUFF"],
              },
              { kind: "SELECT", side: "ENEMY", count: 1, order: ["DEFAULT"] },
            ),
            exSkill("SKL_EX1", 7),
          ],
          capabilities: ACTIVATION_CAPABILITIES,
        }),
      ).not.toThrow();
    });

    it("UT-CAT-IDX-095 (PR #287 再レビュー[P2], Issue #248): rejects an AS/EX activationCondition referencing a TargetReference kind that evaluateActivationCondition cannot resolve (only SELF/BINDING exist at action-selection time)", () => {
      const defs = baseDefinitions();
      const singleSelector: TargetSelectorDefinitionInput = {
        kind: "SELECT",
        side: "ENEMY",
        count: 1,
        order: ["DEFAULT"],
      };
      // `TRIGGER_SOURCE`は常に1体なのでcardinalityだけを見る検証は通過してしまうが、
      // 行動選択時にはトリガーイベントが存在しないため実行時に必ず落ちる。
      for (const referenceKind of ["TRIGGER_SOURCE", "TRIGGER_TARGET"] as const) {
        expect(() =>
          buildCatalogIndex({
            ...defs,
            skills: [
              activationConditionSkill(
                {
                  kind: "TARGET_HAS_EFFECT",
                  target: { kind: referenceKind },
                  categories: ["DEBUFF"],
                },
                singleSelector,
              ),
              exSkill("SKL_EX1", 7),
            ],
            capabilities: [...ACTIVATION_CAPABILITIES, capability("CAP_TRIGGER_CONTEXT")],
          }),
        ).toThrowError(/ACTIVATION_CONDITION_UNSUPPORTED_REFERENCE/);
      }
    });

    it("UT-CAT-IDX-096 (PR #287 再レビュー[P2], Issue #248): rejects a PS activationCondition referencing a BINDING, which evaluateTriggerCondition cannot resolve, while still accepting its own trigger-context kinds", () => {
      const defs = baseDefinitions();
      const psCapabilities = [
        ...ACTIVATION_CAPABILITIES,
        capability("CAP_PASSIVE_ACTIVATION_CONDITION"),
        capability("CAP_TRIGGER_CONTEXT"),
      ];
      const psSkill = (target: TargetReferenceInput, selector: TargetSelectorDefinitionInput) =>
        activationConditionSkill(
          { kind: "TARGET_HAS_EFFECT", target, categories: ["DEBUFF"] },
          selector,
          "PS",
        );
      const anySelector: TargetSelectorDefinitionInput = {
        kind: "SELECT",
        side: "ENEMY",
        count: 1,
        order: ["DEFAULT"],
      };

      expect(() =>
        buildCatalogIndex({
          ...defs,
          skills: [
            psSkill({ kind: "BINDING", targetBindingId: "TGT_OTHER" }, anySelector),
            asSkill("SKL_AS1", "ACT_DAMAGE_1"),
            exSkill("SKL_EX1", 7),
          ],
          capabilities: psCapabilities,
        }),
      ).toThrowError(/ACTIVATION_CONDITION_UNSUPPORTED_REFERENCE/);

      // PSは解決済みid集合へ存在量化するため、TRIGGER_TARGETが複数対象でも受理する。
      for (const target of [
        { kind: "SELF" },
        { kind: "TRIGGER_SOURCE" },
        { kind: "TRIGGER_TARGET" },
      ] satisfies TargetReferenceInput[]) {
        expect(() =>
          buildCatalogIndex({
            ...defs,
            skills: [
              psSkill(target, anySelector),
              asSkill("SKL_AS1", "ACT_DAMAGE_1"),
              exSkill("SKL_EX1", 7),
            ],
            capabilities: psCapabilities,
          }),
        ).not.toThrow();
      }
    });

    it("UT-CAT-IDX-097 (PR #287 再レビュー[P2], Issue #248): scopes a CHARGE skill's activationCondition validation to the charge-start targetBindings only — the release-side bindings are not resolved at action-selection time", () => {
      const defs = baseDefinitions();
      const chargeSkill = (
        activationCondition: ConditionDefinitionInput,
        startSelector: TargetSelectorDefinitionInput,
        releaseSelector: TargetSelectorDefinitionInput = {
          kind: "SELECT",
          side: "ENEMY",
          count: 1,
          order: ["DEFAULT"],
        },
        releaseBindingId = "TGT_RELEASE_ONLY",
      ): SkillDefinition =>
        createSkillDefinition({
          skillDefinitionId: "SKL_AS1",
          skillType: "AS",
          cost: { resource: "AP", amount: 1 },
          activationCondition,
          resolution: {
            kind: "CHARGE",
            targetBindings: [{ targetBindingId: "TGT_START", selector: startSelector }],
            // M7-016（Issue #270 レビュー[P1]）: 開始側`steps`は空。`targetBindings`は
            // `activationCondition`のスコープとして引き続き意味を持つ。
            steps: [],
            chargeRelease: {
              targetBindings: [{ targetBindingId: releaseBindingId, selector: releaseSelector }],
              steps: [
                {
                  kind: "ACTION",
                  target: { kind: "BINDING", targetBindingId: releaseBindingId },
                  actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
                },
              ],
            },
          },
          cooldown: { unit: "ACTION", count: 1 },
          traits: {},
          // M7-016（Issue #270）: `resolution.kind: CHARGE`は`CAP_CHARGE_RESTRICTION`
          // の宣言が必須（`validateSkill`）。
          requiredCapabilities: [
            "CAP_ACTION_ACTIVATION_CONDITION",
            "CAP_TARGET_EFFECT_QUERY",
            "CAP_CHARGE_RESTRICTION",
          ],
          metadata: { displayName: "Charge activation condition AS" },
        });
      const startSelector: TargetSelectorDefinitionInput = {
        kind: "SELECT",
        side: "ENEMY",
        count: 1,
        order: ["DEFAULT"],
      };

      // 解放側にしか存在しないbindingは、それ自体がcount:1でも行動選択時には
      // 解決できない（未解決参照で落ちる）。解放側を検証対象へ混ぜていると、
      // 単一対象なので通過してしまう。
      expect(() =>
        buildCatalogIndex({
          ...defs,
          skills: [
            chargeSkill(
              {
                kind: "TARGET_HAS_EFFECT",
                target: { kind: "BINDING", targetBindingId: "TGT_RELEASE_ONLY" },
                categories: ["DEBUFF"],
              },
              startSelector,
            ),
            exSkill("SKL_EX1", 7),
          ],
          capabilities: ACTIVATION_CAPABILITIES,
        }),
      ).toThrowError(/ACTIVATION_CONDITION_UNBOUNDED_REFERENCE/);

      // 開始側のcount:1 bindingはそのまま受理する。開始側と解放側が同じbinding IDを
      // 使い、解放側だけがcount:"ALL"であっても、開始側の単一対象性を上書きしない。
      expect(() =>
        buildCatalogIndex({
          ...defs,
          skills: [
            chargeSkill(
              {
                kind: "TARGET_HAS_EFFECT",
                target: { kind: "BINDING", targetBindingId: "TGT_START" },
                categories: ["DEBUFF"],
              },
              startSelector,
              { kind: "SELECT", side: "ENEMY", count: "ALL", order: ["DEFAULT"] },
              "TGT_START",
            ),
            exSkill("SKL_EX1", 7),
          ],
          capabilities: ACTIVATION_CAPABILITIES,
        }),
      ).not.toThrow();
    });

    it("UT-CAT-IDX-070（PRレビュー[P2]再指摘）: accepts a BRANCH condition referencing a BINDING whose fallback chain is entirely count:1 (every reachable path resolves to at most one unit)", () => {
      const defs = baseDefinitions();
      const skill = branchConditionSkill(
        {
          kind: "TARGET_STATE",
          target: { kind: "BINDING", targetBindingId: "TGT_OTHER" },
          field: "IS_ALIVE",
          op: "EQ",
          value: true,
        },
        {
          kind: "SELECT",
          side: "ENEMY",
          count: 1,
          order: ["DEFAULT"],
          fallback: { kind: "SELECT", side: "ENEMY", count: 1, order: ["DEFAULT"] },
        },
        ["CAP_TARGET_BINDING_FALLBACK"],
      );
      expect(() =>
        buildCatalogIndex({
          ...defs,
          skills: [skill, exSkill("SKL_EX1", 7)],
          capabilities: [...capabilities, capability("CAP_TARGET_BINDING_FALLBACK")],
        }),
      ).not.toThrow();
    });
  });

  /**
   * UT-CAT-IDX-030 (Issue #217 follow-up): `targetingSkill`'s single-ACTION-step
   * shape can't be reused here once `MISSING_PRECEDING_RESULT` (design point E)
   * exists — a bare `LAST_ACTION_TARGETS`/`LAST_DAMAGED_TARGETS` step with no
   * preceding EffectAction result is now *also* independently invalid. This
   * variant adds an unconditional preceding ACTION step so the capability
   * check under test stays isolated from that separate invariant.
   */
  function targetingSkillWithPrecedingAction(
    selector: TargetSelectorDefinitionInput,
    requiredCapabilities: readonly string[],
    target: TargetReferenceInput,
  ): SkillDefinition {
    return createSkillDefinition({
      skillDefinitionId: "SKL_AS1",
      skillType: "AS",
      cost: { resource: "AP", amount: 1 },
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [{ targetBindingId: "TGT_PRIMARY", selector }],
        steps: [
          {
            kind: "ACTION",
            target: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
            actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
          },
          {
            kind: "ACTION",
            target,
            actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
          },
        ],
      },
      cooldown: { unit: "ACTION", count: 1 },
      traits: {},
      requiredCapabilities,
      metadata: { displayName: "Targeting AS" },
    });
  }

  it.each(["LAST_ACTION_TARGETS", "LAST_DAMAGED_TARGETS"] as const)(
    "UT-CAT-IDX-030: rejects %s EffectStep references without CAP_RESOLUTION_BRANCH_REPEAT",
    (kind) => {
      const defs = baseDefinitions();
      const selector = { kind: "SELECT", side: "ENEMY", count: 1 } as const;
      expect(() =>
        buildCatalogIndex({
          ...defs,
          skills: [
            targetingSkillWithPrecedingAction(selector, [], { kind }),
            exSkill("SKL_EX1", 7),
          ],
          capabilities: [capability("CAP_RESOLUTION_BRANCH_REPEAT")],
        }),
      ).toThrowError(/must declare "CAP_RESOLUTION_BRANCH_REPEAT"/);

      expect(() =>
        buildCatalogIndex({
          ...defs,
          skills: [
            targetingSkillWithPrecedingAction(selector, ["CAP_RESOLUTION_BRANCH_REPEAT"], { kind }),
            exSkill("SKL_EX1", 7),
          ],
          capabilities: [capability("CAP_RESOLUTION_BRANCH_REPEAT")],
        }),
      ).not.toThrow();
    },
  );

  it.each([
    { skillType: "AS" as const, capabilityId: "CAP_ACTION_ACTIVATION_CONDITION" },
    { skillType: "EX" as const, capabilityId: "CAP_ACTION_ACTIVATION_CONDITION" },
    { skillType: "PS" as const, capabilityId: "CAP_PASSIVE_ACTIVATION_CONDITION" },
  ])(
    "UT-CAT-IDX-031: rejects a non-TRUE $skillType activationCondition without $capabilityId",
    ({ skillType, capabilityId }) => {
      const defs = baseDefinitions();
      const selector = { kind: "SELECT", side: "ENEMY", count: 1 } as const;
      const activationCondition = { kind: "TURN_NUMBER", op: "GTE", value: 2 } as const;
      const units = skillType === "PS" ? [unit("UNIT_001", { passive: ["SKL_PS1"] })] : defs.units;
      const skillsWithActivationCondition = (requiredCapabilities: readonly string[]) => {
        const activationSkill = targetingSkill(
          selector,
          requiredCapabilities,
          undefined,
          activationCondition,
          skillType,
        );
        if (skillType === "PS") {
          return [...defs.skills, activationSkill];
        }
        return skillType === "EX"
          ? [asSkill("SKL_AS1", "ACT_DAMAGE_1"), activationSkill]
          : [activationSkill, exSkill("SKL_EX1", 7)];
      };
      expect(() =>
        buildCatalogIndex({
          ...defs,
          units,
          skills: skillsWithActivationCondition([]),
          capabilities: [capability(capabilityId)],
        }),
      ).toThrowError(new RegExp(`must declare "${capabilityId}"`));

      expect(() =>
        buildCatalogIndex({
          ...defs,
          units,
          skills: skillsWithActivationCondition([capabilityId]),
          capabilities: [capability(capabilityId)],
        }),
      ).not.toThrow();
    },
  );

  it("UT-CAT-IDX-032: rejects RANDOM_BRANCH skills without CAP_RANDOM_BRANCH", () => {
    const defs = baseDefinitions();
    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [randomBranchSkill("SKL_AS1", []), exSkill("SKL_EX1", 7)],
        capabilities: [capability("CAP_RANDOM_BRANCH")],
      }),
    ).toThrowError(/must declare "CAP_RANDOM_BRANCH"/);

    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [randomBranchSkill("SKL_AS1", ["CAP_RANDOM_BRANCH"]), exSkill("SKL_EX1", 7)],
        capabilities: [capability("CAP_RANDOM_BRANCH")],
      }),
    ).not.toThrow();
  });

  it("UT-CAT-IDX-033: rejects triggeredEffects memories without CAP_MEMORY_TRIGGERED_EFFECT", () => {
    const defs = baseDefinitions();
    expect(() =>
      buildCatalogIndex({
        ...defs,
        effectActions: [...defs.effectActions, memoryModifierAction("ACT_MEMORY_STAT_MOD")],
        memories: [triggeredMemory([])],
        capabilities: [capability("CAP_MEMORY_TRIGGERED_EFFECT")],
      }),
    ).toThrowError(/must declare "CAP_MEMORY_TRIGGERED_EFFECT"/);

    expect(() =>
      buildCatalogIndex({
        ...defs,
        effectActions: [...defs.effectActions, memoryModifierAction("ACT_MEMORY_STAT_MOD")],
        memories: [triggeredMemory(["CAP_MEMORY_TRIGGERED_EFFECT"])],
        capabilities: [capability("CAP_MEMORY_TRIGGERED_EFFECT")],
      }),
    ).not.toThrow();
  });

  it("UT-CAT-IDX-034: rejects Skill counterUpdates without CAP_SKILL_RUNTIME_COUNTER", () => {
    const defs = baseDefinitions();
    const units = [unit("UNIT_001", { passive: ["SKL_PS1"] })];
    const capabilities = [capability("CAP_SKILL_RUNTIME_COUNTER")];

    expect(() =>
      buildCatalogIndex({
        ...defs,
        units,
        skills: [...defs.skills, runtimeCounterSkill([])],
        capabilities,
      }),
    ).toThrowError(/must declare "CAP_SKILL_RUNTIME_COUNTER"/);

    expect(() =>
      buildCatalogIndex({
        ...defs,
        units,
        skills: [...defs.skills, runtimeCounterSkill(["CAP_SKILL_RUNTIME_COUNTER"])],
        capabilities,
      }),
    ).not.toThrow();
  });

  it("UT-CAT-IDX-035: rejects EffectStep non-TRUE conditions without CAP_EFFECT_STEP_CONDITION", () => {
    const defs = baseDefinitions();
    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [conditionalActionSkill("SKL_AS1", []), exSkill("SKL_EX1", 7)],
        capabilities: [capability("CAP_EFFECT_STEP_CONDITION")],
      }),
    ).toThrowError(/must declare "CAP_EFFECT_STEP_CONDITION"/);

    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [
          conditionalActionSkill("SKL_AS1", ["CAP_EFFECT_STEP_CONDITION"]),
          exSkill("SKL_EX1", 7),
        ],
        capabilities: [capability("CAP_EFFECT_STEP_CONDITION")],
      }),
    ).not.toThrow();
  });

  it("UT-CAT-IDX-056 (RES-004集合条件, Issue #227): rejects EffectStep TARGET_SET_COUNT conditions without CAP_EFFECT_STEP_SET_CONDITION, even when CAP_EFFECT_STEP_CONDITION is already declared", () => {
    const defs = baseDefinitions();
    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [
          setConditionActionSkill("SKL_AS1", ["CAP_EFFECT_STEP_CONDITION"]),
          exSkill("SKL_EX1", 7),
        ],
        capabilities: [
          capability("CAP_EFFECT_STEP_CONDITION"),
          capability("CAP_EFFECT_STEP_SET_CONDITION"),
        ],
      }),
    ).toThrowError(/must declare "CAP_EFFECT_STEP_SET_CONDITION"/);

    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [
          setConditionActionSkill("SKL_AS1", [
            "CAP_EFFECT_STEP_CONDITION",
            "CAP_EFFECT_STEP_SET_CONDITION",
          ]),
          exSkill("SKL_EX1", 7),
        ],
        capabilities: [
          capability("CAP_EFFECT_STEP_CONDITION"),
          capability("CAP_EFFECT_STEP_SET_CONDITION"),
        ],
      }),
    ).not.toThrow();
  });

  it("UT-CAT-IDX-078 (Issue #247 M7-001D): rejects EffectStep EVENT_PAYLOAD stepCondition without CAP_TRIGGER_PAYLOAD_IN_RESOLUTION, even when CAP_EFFECT_STEP_CONDITION is already declared", () => {
    const defs = baseDefinitions();
    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [
          eventPayloadActionSkill("SKL_AS1", ["CAP_EFFECT_STEP_CONDITION"]),
          exSkill("SKL_EX1", 7),
        ],
        capabilities: [
          capability("CAP_EFFECT_STEP_CONDITION"),
          capability("CAP_TRIGGER_PAYLOAD_IN_RESOLUTION"),
        ],
      }),
    ).toThrowError(/must declare "CAP_TRIGGER_PAYLOAD_IN_RESOLUTION"/);
  });

  it("UT-CAT-IDX-079 (Issue #247 M7-001D): accepts EffectStep EVENT_PAYLOAD stepCondition on a PS skill once both CAP_EFFECT_STEP_CONDITION and CAP_TRIGGER_PAYLOAD_IN_RESOLUTION are declared", () => {
    const defs = baseDefinitions();
    expect(() =>
      buildCatalogIndex({
        ...defs,
        units: [unit("UNIT_001", { active: ["SKL_AS1"], passive: ["SKL_PS1"] })],
        skills: [
          asSkill("SKL_AS1", "ACT_DAMAGE_1"),
          eventPayloadPassiveSkill("SKL_PS1", [
            "CAP_EFFECT_STEP_CONDITION",
            "CAP_TRIGGER_PAYLOAD_IN_RESOLUTION",
          ]),
          exSkill("SKL_EX1", 7),
        ],
        capabilities: [
          capability("CAP_EFFECT_STEP_CONDITION"),
          capability("CAP_TRIGGER_PAYLOAD_IN_RESOLUTION"),
        ],
      }),
    ).not.toThrow();
  });

  it.each([{ skillType: "AS" as const }, { skillType: "EX" as const }])(
    "UT-CAT-IDX-080 (Issue #247 M7-001D, PRレビュー[P2]): rejects EffectStep EVENT_PAYLOAD stepCondition on a $skillType skill even when CAP_EFFECT_STEP_CONDITION and CAP_TRIGGER_PAYLOAD_IN_RESOLUTION are both declared — the triggering event's payload only exists during a PS activation",
    ({ skillType }) => {
      const defs = baseDefinitions();
      expect(() =>
        buildCatalogIndex({
          ...defs,
          skills: [
            eventPayloadActionSkill(
              "SKL_ACTIVE1",
              ["CAP_EFFECT_STEP_CONDITION", "CAP_TRIGGER_PAYLOAD_IN_RESOLUTION"],
              skillType,
            ),
            exSkill("SKL_EX1", 7),
          ],
          capabilities: [
            capability("CAP_EFFECT_STEP_CONDITION"),
            capability("CAP_TRIGGER_PAYLOAD_IN_RESOLUTION"),
          ],
        }),
      ).toThrowError(/EVENT_PAYLOAD condition requires a PS Skill/);
    },
  );

  it("UT-CAT-IDX-063（Issue #230 RES-004-CONDITION-SCOPE）: accepts an ACTION step combining a non-TRUE stepCondition (TARGET_SET_COUNT) with a non-TRUE targetCondition (own-target TARGET_STATE) once both CAP_EFFECT_STEP_CONDITION and CAP_EFFECT_STEP_SET_CONDITION are declared — the exact combination MIXED_STEP_TARGET_SET_CONDITION used to reject outright before the schema split", () => {
    const defs = baseDefinitions();
    const combinedSkill = (requiredCapabilities: readonly string[]): SkillDefinition =>
      createSkillDefinition({
        skillDefinitionId: "SKL_AS1",
        skillType: "AS",
        cost: { resource: "AP", amount: 1 },
        resolution: {
          kind: "IMMEDIATE",
          targetBindings: [
            {
              targetBindingId: "TGT_PRIMARY",
              selector: {
                kind: "SELECT",
                side: "ENEMY",
                count: 1,
                filters: [],
                order: ["DEFAULT"],
                includeDefeated: false,
              },
            },
            {
              targetBindingId: "TGT_OTHER",
              selector: {
                kind: "SELECT",
                side: "ALLY",
                count: "ALL",
                filters: [],
                order: ["DEFAULT"],
                includeDefeated: false,
              },
            },
          ],
          steps: [
            {
              kind: "ACTION",
              stepCondition: {
                kind: "TARGET_SET_COUNT",
                target: { kind: "BINDING", targetBindingId: "TGT_OTHER" },
                op: "GTE",
                value: 1,
              },
              targetCondition: {
                kind: "TARGET_STATE",
                target: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
                field: "IS_ALIVE",
                op: "EQ",
                value: true,
              },
              target: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
              actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
            },
          ],
        },
        cooldown: { unit: "ACTION", count: 1 },
        traits: {},
        requiredCapabilities,
        metadata: { displayName: "Combined step/target condition AS" },
      });

    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [combinedSkill(["CAP_EFFECT_STEP_CONDITION"]), exSkill("SKL_EX1", 7)],
        capabilities: [
          capability("CAP_EFFECT_STEP_CONDITION"),
          capability("CAP_EFFECT_STEP_SET_CONDITION"),
        ],
      }),
    ).toThrowError(/must declare "CAP_EFFECT_STEP_SET_CONDITION"/);

    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [combinedSkill(["CAP_EFFECT_STEP_SET_CONDITION"]), exSkill("SKL_EX1", 7)],
        capabilities: [
          capability("CAP_EFFECT_STEP_CONDITION"),
          capability("CAP_EFFECT_STEP_SET_CONDITION"),
        ],
      }),
    ).toThrowError(/must declare "CAP_EFFECT_STEP_CONDITION"/);

    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [
          combinedSkill(["CAP_EFFECT_STEP_CONDITION", "CAP_EFFECT_STEP_SET_CONDITION"]),
          exSkill("SKL_EX1", 7),
        ],
        capabilities: [
          capability("CAP_EFFECT_STEP_CONDITION"),
          capability("CAP_EFFECT_STEP_SET_CONDITION"),
        ],
      }),
    ).not.toThrow();
  });

  it("UT-CAT-IDX-036: rejects a Skill counterUpdates trigger referencing an unknown eventType", () => {
    const defs = baseDefinitions();
    const units = [unit("UNIT_001", { passive: ["SKL_PS1"] })];

    expect(() =>
      buildCatalogIndex({
        ...defs,
        units,
        skills: [
          ...defs.skills,
          runtimeCounterSkillWithTrigger("NotARealEvent", "FACT", ["CAP_SKILL_RUNTIME_COUNTER"]),
        ],
        capabilities: [capability("CAP_SKILL_RUNTIME_COUNTER")],
      }),
    ).toThrowError(/references unknown eventType "NotARealEvent"/);
  });

  it("UT-CAT-IDX-037: rejects a Skill counterUpdates trigger whose declared category mismatches the eventType's documented category", () => {
    const defs = baseDefinitions();
    const units = [unit("UNIT_001", { passive: ["SKL_PS1"] })];

    expect(() =>
      buildCatalogIndex({
        ...defs,
        units,
        skills: [
          ...defs.skills,
          // UnitBeingAttacked is documented as TIMING, not FACT (see UT-CAT-IDX-011).
          runtimeCounterSkillWithTrigger("UnitBeingAttacked", "FACT", [
            "CAP_SKILL_RUNTIME_COUNTER",
            "CAP_TRIGGER_CONTEXT",
          ]),
        ],
        capabilities: [capability("CAP_SKILL_RUNTIME_COUNTER"), capability("CAP_TRIGGER_CONTEXT")],
      }),
    ).toThrowError(/is documented as category/);
  });

  it("UT-CAT-IDX-038 (EFF-005 Issue #162): rejects APPLY_MARKER duration.counterUpdates (Marker RuntimeCounter is not implemented)", () => {
    const defs = baseDefinitions();
    const withCounterUpdates: CatalogDefinitions = {
      ...defs,
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_MARKER_COUNTER")],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      effectActions: [...defs.effectActions, markerActionWithCounterUpdates("ACT_MARKER_COUNTER")],
      capabilities: [capability("CAP_MARKER"), capability("CAP_EFFECT_RUNTIME_COUNTER")],
    };

    try {
      buildCatalogIndex(withCounterUpdates);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations
          .filter((v) => v.rule === "UNSUPPORTED_MARKER_DURATION")
          .map((v) => v.targetId),
      ).toEqual(["ACT_MARKER_COUNTER"]);
    }
  });

  it("UT-CAT-IDX-039 (EFF-005 Issue #162): rejects APPLY_STAT_MOD duration.counterUpdates without CAP_EFFECT_RUNTIME_COUNTER", () => {
    const defs = baseDefinitions();
    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [...defs.skills, asSkill("SKL_AS2", "ACT_STAT_MOD_COUNTER")],
        units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
        effectActions: [
          ...defs.effectActions,
          statModActionWithCounterUpdates("ACT_STAT_MOD_COUNTER", ["CAP_STAT_MOD"]),
        ],
        capabilities: [capability("CAP_STAT_MOD")],
      }),
    ).toThrowError(/must declare "CAP_EFFECT_RUNTIME_COUNTER"/);
  });

  it("UT-CAT-IDX-040 (EFF-005 Issue #162): accepts APPLY_STAT_MOD duration.counterUpdates that declares CAP_EFFECT_RUNTIME_COUNTER", () => {
    const defs = baseDefinitions();
    const index = buildCatalogIndex({
      ...defs,
      skills: [...defs.skills, asSkill("SKL_AS2", "ACT_STAT_MOD_COUNTER")],
      units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
      effectActions: [
        ...defs.effectActions,
        statModActionWithCounterUpdates("ACT_STAT_MOD_COUNTER", [
          "CAP_STAT_MOD",
          "CAP_EFFECT_RUNTIME_COUNTER",
        ]),
      ],
      capabilities: [capability("CAP_STAT_MOD"), capability("CAP_EFFECT_RUNTIME_COUNTER")],
    });

    expect(index.effectActions.get("ACT_STAT_MOD_COUNTER" as never)).toBeDefined();
  });

  it("UT-CAT-IDX-041 (EFF-006 Issue #212): rejects EffectSequence counterUpdates without CAP_EFFECT_SEQUENCE_RUNTIME_COUNTER", () => {
    const defs = baseDefinitions();

    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [...defs.skills, effectSequenceRuntimeCounterSkill("SKL_AS2", [])],
        units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
        capabilities: [capability("CAP_EFFECT_SEQUENCE_RUNTIME_COUNTER")],
      }),
    ).toThrowError(/must declare "CAP_EFFECT_SEQUENCE_RUNTIME_COUNTER"/);

    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [
          ...defs.skills,
          effectSequenceRuntimeCounterSkill("SKL_AS2", ["CAP_EFFECT_SEQUENCE_RUNTIME_COUNTER"]),
        ],
        units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
        capabilities: [capability("CAP_EFFECT_SEQUENCE_RUNTIME_COUNTER")],
      }),
    ).not.toThrow();
  });

  describe("MISSING_PRECEDING_RESULT: LAST_RESULT/LAST_*_TARGETS definite-assignment (Issue #217 design point E)", () => {
    function skillWithSteps(steps: readonly EffectStepDefinitionInput[]): SkillDefinition {
      return createSkillDefinition({
        skillDefinitionId: "SKL_AS2",
        skillType: "AS",
        cost: { resource: "AP", amount: 1 },
        resolution: { kind: "IMMEDIATE", steps },
        cooldown: { unit: "ACTION", count: 1 },
        traits: {},
        requiredCapabilities: [
          "CAP_EFFECT_STEP_CONDITION",
          "CAP_RESOLUTION_BRANCH_REPEAT",
          "CAP_RANDOM_BRANCH",
        ],
        metadata: { displayName: "LAST_RESULT dataflow AS" },
      });
    }

    const CAPS = [
      capability("CAP_EFFECT_STEP_CONDITION"),
      capability("CAP_RESOLUTION_BRANCH_REPEAT"),
      capability("CAP_RANDOM_BRANCH"),
    ];

    const selfAction = {
      kind: "ACTION",
      target: { kind: "SELF" },
      actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
    } as const;
    const lastResultBranch = {
      kind: "BRANCH",
      condition: { kind: "LAST_RESULT", field: "resultKind", op: "EQ", value: "APPLIED" },
      thenSteps: [],
      elseSteps: [],
    } as const;

    function buildWith(steps: readonly EffectStepDefinitionInput[]) {
      const defs = baseDefinitions();
      return () =>
        buildCatalogIndex({
          ...defs,
          skills: [...defs.skills, skillWithSteps(steps)],
          units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
          capabilities: CAPS,
        });
    }

    it("UT-CAT-IDX-042: rejects a first ACTION step whose condition references LAST_RESULT (nothing precedes it)", () => {
      expect(
        buildWith([
          {
            ...selfAction,
            stepCondition: { kind: "LAST_RESULT", field: "resultKind", op: "EQ", value: "APPLIED" },
          },
        ]),
      ).toThrowError(/MISSING_PRECEDING_RESULT/);
    });

    it("UT-CAT-IDX-043: rejects a first BRANCH step whose own condition references LAST_RESULT", () => {
      expect(buildWith([lastResultBranch])).toThrowError(/MISSING_PRECEDING_RESULT/);
    });

    it("UT-CAT-IDX-044: accepts a LAST_RESULT condition once a preceding always-true ACTION step exists", () => {
      expect(buildWith([selfAction, lastResultBranch])).not.toThrow();
    });

    it("UT-CAT-IDX-045: rejects LAST_RESULT after a BRANCH where only one side (thenSteps) produces a result", () => {
      const branch = {
        kind: "BRANCH",
        condition: { kind: "TRUE" },
        thenSteps: [selfAction],
        elseSteps: [],
      } as const;
      expect(buildWith([branch, lastResultBranch])).toThrowError(/MISSING_PRECEDING_RESULT/);
    });

    it("UT-CAT-IDX-046: accepts LAST_RESULT after a BRANCH where both then/elseSteps produce a result", () => {
      const branch = {
        kind: "BRANCH",
        condition: { kind: "TRUE" },
        thenSteps: [selfAction],
        elseSteps: [selfAction],
      } as const;
      expect(buildWith([branch, lastResultBranch])).not.toThrow();
    });

    it("UT-CAT-IDX-047: rejects LAST_RESULT after RANDOM_BRANCH WEIGHTED_ONE where one reachable branch is missing a result", () => {
      const randomBranch = {
        kind: "RANDOM_BRANCH",
        mode: "WEIGHTED_ONE",
        branches: [
          { weight: 1, steps: [selfAction] },
          { weight: 1, steps: [] },
        ],
      } as const;
      expect(buildWith([randomBranch, lastResultBranch])).toThrowError(/MISSING_PRECEDING_RESULT/);
    });

    it("UT-CAT-IDX-048: a weight-0 (unreachable) WEIGHTED_ONE branch missing a result does not block LAST_RESULT afterward", () => {
      const randomBranch = {
        kind: "RANDOM_BRANCH",
        mode: "WEIGHTED_ONE",
        branches: [
          { weight: 1, steps: [selfAction] },
          { weight: 0, steps: [] },
        ],
      } as const;
      expect(buildWith([randomBranch, lastResultBranch])).not.toThrow();
    });

    it("UT-CAT-IDX-049: rejects LAST_RESULT after RANDOM_BRANCH INDEPENDENT relying solely on branch-interior ACTIONs (0-branch-success path is always live)", () => {
      const randomBranch = {
        kind: "RANDOM_BRANCH",
        mode: "INDEPENDENT",
        branches: [
          { probability: 1, steps: [selfAction] },
          { probability: 1, steps: [selfAction] },
        ],
      } as const;
      expect(buildWith([randomBranch, lastResultBranch])).toThrowError(/MISSING_PRECEDING_RESULT/);
    });

    it("UT-CAT-IDX-050: accepts LAST_RESULT after RANDOM_BRANCH INDEPENDENT when already definitely-assigned beforehand", () => {
      const randomBranch = {
        kind: "RANDOM_BRANCH",
        mode: "INDEPENDENT",
        branches: [{ probability: 1, steps: [] }],
      } as const;
      expect(buildWith([selfAction, randomBranch, lastResultBranch])).not.toThrow();
    });

    it("UT-CAT-IDX-051: rejects LAST_RESULT after a REPEAT whose body only conditionally produces a result", () => {
      const repeat = {
        kind: "REPEAT",
        count: 2,
        steps: [{ ...selfAction, stepCondition: { kind: "TURN_NUMBER", op: "GTE", value: 1 } }],
      } as const;
      expect(buildWith([repeat, lastResultBranch])).toThrowError(/MISSING_PRECEDING_RESULT/);
    });

    it("UT-CAT-IDX-052: accepts LAST_RESULT after a REPEAT whose body unconditionally produces a result", () => {
      const repeat = { kind: "REPEAT", count: 2, steps: [selfAction] } as const;
      expect(buildWith([repeat, lastResultBranch])).not.toThrow();
    });

    it("UT-CAT-IDX-053: rejects a nested BRANCH (inside thenSteps) whose own condition references LAST_RESULT with nothing preceding it", () => {
      const outer = {
        kind: "BRANCH",
        condition: { kind: "TRUE" },
        thenSteps: [lastResultBranch],
        elseSteps: [],
      } as const;
      expect(buildWith([outer])).toThrowError(/MISSING_PRECEDING_RESULT/);
    });

    it("UT-CAT-IDX-054: rejects a first ACTION step targeting LAST_ACTION_TARGETS/LAST_DAMAGED_TARGETS", () => {
      for (const kind of ["LAST_ACTION_TARGETS", "LAST_DAMAGED_TARGETS"] as const) {
        expect(
          buildWith([
            {
              kind: "ACTION",
              target: { kind },
              actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
            },
          ]),
        ).toThrowError(/MISSING_PRECEDING_RESULT/);
      }
    });

    it("UT-CAT-IDX-055: violation carries the Catalog path and rule id", () => {
      try {
        buildWith([lastResultBranch])();
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(CatalogIntegrityError);
        const err = error as CatalogIntegrityError;
        const violation = err.violations.find((v) => v.rule === "MISSING_PRECEDING_RESULT");
        expect(violation?.targetId).toBe("SKL_AS2");
        expect(violation?.message).toContain("steps[0].condition");
      }
    });
  });
  it("UT-CAT-IDX-081 (R-MEM-04): rejects a Memory triggeredEffect whose EffectAction needs a source BattleUnit", () => {
    const defs = baseDefinitions();
    expect(() =>
      buildCatalogIndex({
        ...defs,
        effectActions: [...defs.effectActions, damageAction("ACT_MEMORY_DAMAGE")],
        memories: [
          createMemoryDefinition({
            memoryDefinitionId: "MEM_DAMAGE",
            triggeredEffects: [
              {
                trigger: {
                  eventType: "BattleStarted",
                  category: "FACT",
                  sourceSelector: "ANY",
                  targetSelector: "ANY",
                },
                effectSequence: {
                  targetBindings: [
                    {
                      targetBindingId: "TGT_ENEMIES",
                      selector: { kind: "SELECT", side: "ENEMY", count: "ALL" },
                    },
                  ],
                  steps: [
                    {
                      kind: "ACTION",
                      target: { kind: "BINDING", targetBindingId: "TGT_ENEMIES" },
                      actions: [{ effectActionDefinitionId: "ACT_MEMORY_DAMAGE" }],
                    },
                  ],
                },
              },
            ],
            requiredCapabilities: ["CAP_MEMORY_TRIGGERED_EFFECT"],
            metadata: { displayName: "Damage Memory" },
          }),
        ],
        capabilities: [capability("CAP_MEMORY_TRIGGERED_EFFECT")],
      }),
    ).toThrowError(/requires a source BattleUnit/);
  });

  it("UT-CAT-IDX-082 (R-MEM-04): rejects a Memory triggeredEffect that references SELF as a target", () => {
    const defs = baseDefinitions();
    expect(() =>
      buildCatalogIndex({
        ...defs,
        effectActions: [...defs.effectActions, memoryModifierAction("ACT_MEMORY_STAT_MOD")],
        memories: [
          createMemoryDefinition({
            memoryDefinitionId: "MEM_SELF",
            triggeredEffects: [
              {
                trigger: {
                  eventType: "BattleStarted",
                  category: "FACT",
                  sourceSelector: "ANY",
                  targetSelector: "ANY",
                },
                effectSequence: {
                  steps: [
                    {
                      kind: "ACTION",
                      target: { kind: "SELF" },
                      actions: [{ effectActionDefinitionId: "ACT_MEMORY_STAT_MOD" }],
                    },
                  ],
                },
              },
            ],
            requiredCapabilities: ["CAP_MEMORY_TRIGGERED_EFFECT"],
            metadata: { displayName: "Self Memory" },
          }),
        ],
        capabilities: [capability("CAP_MEMORY_TRIGGERED_EFFECT")],
      }),
    ).toThrowError(/cannot use the "SELF" target reference/);
  });

  it("UT-CAT-IDX-083 (R-MEM-04): rejects a Memory targetBinding ordered relative to the source unit", () => {
    const defs = baseDefinitions();
    expect(() =>
      buildCatalogIndex({
        ...defs,
        effectActions: [...defs.effectActions, memoryModifierAction("ACT_MEMORY_STAT_MOD")],
        memories: [
          createMemoryDefinition({
            memoryDefinitionId: "MEM_NEAREST",
            triggeredEffects: [
              {
                trigger: {
                  eventType: "BattleStarted",
                  category: "FACT",
                  sourceSelector: "ANY",
                  targetSelector: "ANY",
                },
                effectSequence: {
                  targetBindings: [
                    {
                      targetBindingId: "TGT_NEAREST_ENEMY",
                      selector: {
                        kind: "SELECT",
                        side: "ENEMY",
                        count: 1,
                        order: ["NEAREST"],
                      },
                    },
                  ],
                  steps: [
                    {
                      kind: "ACTION",
                      target: { kind: "BINDING", targetBindingId: "TGT_NEAREST_ENEMY" },
                      actions: [{ effectActionDefinitionId: "ACT_MEMORY_STAT_MOD" }],
                    },
                  ],
                },
              },
            ],
            requiredCapabilities: ["CAP_MEMORY_TRIGGERED_EFFECT", "CAP_TARGET_FILTER_ORDER"],
            metadata: { displayName: "Nearest Memory" },
          }),
        ],
        capabilities: [
          capability("CAP_MEMORY_TRIGGERED_EFFECT"),
          capability("CAP_TARGET_FILTER_ORDER"),
        ],
      }),
    ).toThrowError(/resolves relative to the source unit/);
  });
  it("UT-CAT-IDX-084 (R-MEM-04): rejects a Memory EffectAction whose Formula references SKILL_SOURCE", () => {
    const defs = baseDefinitions();
    const skillSourceStatMod = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_MEMORY_SKILL_SOURCE",
        kind: "APPLY_STAT_MOD",
        payload: {
          stat: "ATTACK",
          valueType: "FIXED",
          // 使用者の攻撃力を基準にするFormula（Memoryには使用者が存在しない）。
          formula: {
            kind: "SUM",
            formulas: [
              { kind: "CONSTANT", value: 10 },
              { kind: "STAT_RATIO", source: { kind: "SKILL_SOURCE" }, stat: "ATTACK", ratio: 0.1 },
            ],
          },
          stacking: { mode: "STACKABLE" },
          duration: { timeLimit: { unit: "BATTLE", count: 1 }, dispellable: true },
        },
        requiredCapabilities: ["CAP_STAT_MOD"],
      },
      "effectAction",
    );
    expect(() =>
      buildCatalogIndex({
        ...defs,
        effectActions: [...defs.effectActions, skillSourceStatMod],
        memories: [memoryUsing("MEM_SKILL_SOURCE", "ACT_MEMORY_SKILL_SOURCE")],
        capabilities: [capability("CAP_MEMORY_TRIGGERED_EFFECT"), capability("CAP_STAT_MOD")],
      }),
    ).toThrowError(/references the source BattleUnit/);
  });

  it("UT-CAT-IDX-085 (R-MEM-04): rejects a Memory EffectAction payload that targets the source unit (APPLY_HEALING_LINK transferTo SELF)", () => {
    const defs = baseDefinitions();
    const healingLink = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_MEMORY_HEALING_LINK",
        kind: "APPLY_HEALING_LINK",
        payload: {
          transferTo: { kind: "SELF" },
          transferRate: 0.5,
          duration: { timeLimit: { unit: "BATTLE", count: 1 }, dispellable: true },
        },
        requiredCapabilities: ["CAP_HEALING_LINK"],
      },
      "effectAction",
    );
    expect(() =>
      buildCatalogIndex({
        ...defs,
        effectActions: [...defs.effectActions, healingLink],
        memories: [memoryUsing("MEM_HEALING_LINK", "ACT_MEMORY_HEALING_LINK")],
        capabilities: [capability("CAP_MEMORY_TRIGGERED_EFFECT"), capability("CAP_HEALING_LINK")],
      }),
    ).toThrowError(/references the source BattleUnit/);
  });

  it("UT-CAT-IDX-086 (R-MEM-04): rejects Memory trigger conditions that need an owner BattleUnit", () => {
    const defs = baseDefinitions();
    const withMemory = (memory: ReturnType<typeof memoryWithTrigger>) => ({
      ...defs,
      effectActions: [...defs.effectActions, memoryModifierAction("ACT_MEMORY_STAT_MOD")],
      memories: [memory],
      capabilities: [
        capability("CAP_MEMORY_TRIGGERED_EFFECT"),
        capability("CAP_PASSIVE_ACTIVATION_CONDITION"),
      ],
    });

    expect(() =>
      buildCatalogIndex(
        withMemory(
          memoryWithTrigger("MEM_POSITION", {
            kind: "POSITION_RELATION",
            target: { kind: "TRIGGER_SOURCE" },
            relation: "IN_FRONT_OF",
          }),
        ),
      ),
    ).toThrowError(/trigger condition/);

    expect(() =>
      buildCatalogIndex(
        withMemory(
          memoryWithTrigger("MEM_COUNTER", {
            kind: "RUNTIME_COUNTER",
            counter: "CNT_1",
            op: "GTE",
            value: 1,
          }),
        ),
      ),
    ).toThrowError(/trigger condition/);

    expect(() =>
      buildCatalogIndex(
        withMemory(
          memoryWithTrigger("MEM_EXCLUDE_SELF", {
            kind: "AND",
            conditions: [
              { kind: "TRUE" },
              {
                kind: "ALIVE_UNIT_COUNT",
                side: "ALLY",
                excludeSelf: true,
                op: "GTE",
                value: 1,
              },
            ],
          }),
        ),
      ),
    ).toThrowError(/trigger condition/);

    expect(() =>
      buildCatalogIndex(
        withMemory(
          memoryWithTrigger("MEM_SELF_STATE", {
            kind: "TARGET_STATE",
            target: { kind: "SELF" },
            field: "IS_ALIVE",
            op: "EQ",
            value: true,
          }),
        ),
      ),
    ).toThrowError(/trigger condition/);

    // 使用者に依存しない条件（イベントpayload参照）は従来どおり受理する。
    expect(() =>
      buildCatalogIndex(
        withMemory(
          memoryWithTrigger("MEM_PAYLOAD", {
            kind: "ALIVE_UNIT_COUNT",
            side: "ALLY",
            op: "GTE",
            value: 1,
          }),
        ),
      ),
    ).not.toThrow();
  });
  it("UT-CAT-IDX-087 (PR #260再レビュー[P2]): accepts a Memory effect whose expiration.conditions reference SELF (the effect holder, not the Memory source)", () => {
    const defs = baseDefinitions();
    // `DurationDefinition.expiration.conditions`の`SELF`は効果保持者を指す
    // （`effect-expiration-condition-service.ts`が保持者を`context.owner`として渡す）。
    // Memoryの使用者参照ではないため拒否してはならない。
    const holderScopedExpiry = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_MEMORY_HOLDER_EXPIRY",
        kind: "APPLY_STAT_MOD",
        payload: {
          stat: "ATTACK",
          valueType: "FIXED",
          formula: { kind: "CONSTANT", value: 20 },
          stacking: { mode: "STACKABLE" },
          duration: {
            timeLimit: { unit: "BATTLE", count: 1 },
            dispellable: true,
            expiration: {
              conditions: [
                {
                  kind: "TARGET_STATE",
                  target: { kind: "SELF" },
                  field: "HP_RATIO",
                  op: "LTE",
                  value: 0.5,
                },
              ],
            },
          },
        },
        requiredCapabilities: ["CAP_STAT_MOD"],
      },
      "effectAction",
    );

    expect(() =>
      buildCatalogIndex({
        ...defs,
        effectActions: [...defs.effectActions, holderScopedExpiry],
        memories: [memoryUsing("MEM_HOLDER_EXPIRY", "ACT_MEMORY_HOLDER_EXPIRY")],
        capabilities: [capability("CAP_MEMORY_TRIGGERED_EFFECT"), capability("CAP_STAT_MOD")],
      }),
    ).not.toThrow();
  });

  it("UT-CAT-IDX-088 (PR #260再レビュー[P2], R-MEM-04): rejects a Memory EffectAction whose Formula reads a preceding DAMAGE result", () => {
    const defs = baseDefinitions();
    // `LAST_DAMAGE_*`/`SUM_DAMAGE_*`は使用者ごとの直前DAMAGE結果であり、
    // 使用者を持たないMemoryの解決では`lastResults`自体が評価contextへ渡らない。
    const lastDamageStatMod = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_MEMORY_LAST_DAMAGE",
        kind: "APPLY_STAT_MOD",
        payload: {
          stat: "ATTACK",
          valueType: "FIXED",
          formula: {
            kind: "CLAMP",
            formula: {
              kind: "DAMAGE_DEALT_RATIO",
              sourceResult: "LAST_DAMAGE_DEALT",
              ratio: 0.1,
            },
            min: 0,
            max: 100,
          },
          stacking: { mode: "STACKABLE" },
          duration: { timeLimit: { unit: "BATTLE", count: 1 }, dispellable: true },
        },
        requiredCapabilities: ["CAP_STAT_MOD", "CAP_SUM_DAMAGE_RESULT"],
      },
      "effectAction",
    );

    expect(() =>
      buildCatalogIndex({
        ...defs,
        effectActions: [...defs.effectActions, lastDamageStatMod],
        memories: [memoryUsing("MEM_LAST_DAMAGE", "ACT_MEMORY_LAST_DAMAGE")],
        capabilities: [
          capability("CAP_MEMORY_TRIGGERED_EFFECT"),
          capability("CAP_STAT_MOD"),
          capability("CAP_SUM_DAMAGE_RESULT"),
        ],
      }),
    ).toThrowError(/references the source BattleUnit/);
  });
  it("UT-CAT-IDX-089 (PR #260再レビュー[P2], R-MEM-04): rejects a Memory effect whose timeLimit.owner is the granting unit", () => {
    const defs = baseDefinitions();
    // `EFFECT_SOURCE`は「付与者の行動・ターン完了で減算する」意味であり、
    // 付与者を持たないMemoryでは減算契機を特定できない。
    const sourceOwnedDuration = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_MEMORY_SOURCE_OWNED",
        kind: "APPLY_STAT_MOD",
        payload: {
          stat: "ATTACK",
          valueType: "FIXED",
          formula: { kind: "CONSTANT", value: 20 },
          stacking: { mode: "STACKABLE" },
          duration: {
            timeLimit: { unit: "TURN", count: 2, owner: "EFFECT_SOURCE" },
            dispellable: true,
          },
        },
        requiredCapabilities: ["CAP_STAT_MOD"],
      },
      "effectAction",
    );

    expect(() =>
      buildCatalogIndex({
        ...defs,
        effectActions: [...defs.effectActions, sourceOwnedDuration],
        memories: [memoryUsing("MEM_SOURCE_OWNED", "ACT_MEMORY_SOURCE_OWNED")],
        capabilities: [capability("CAP_MEMORY_TRIGGERED_EFFECT"), capability("CAP_STAT_MOD")],
      }),
    ).toThrowError(/timeLimit.owner "EFFECT_SOURCE"/);
  });

  it("UT-CAT-IDX-090 (R-EFF-12, M7-014 Issue #268): rejects an APPLY_MARKER with duration.reapply, since MarkerState grant does not resolve it", () => {
    const defs = baseDefinitions();
    // `marker-apply-service.ts`は`stack.policy`（ADD/REFRESH/KEEP_EXISTING/
    // REPLACE、R-EFF-10）で再付与を解決し、`resolveDurationOnReapply`を通らない。
    // 宣言できてしまうと`MarkerApplied`は成功するのに期間だけ差し替わらない
    // silent partial implementationになるため、`UNSUPPORTED_MARKER_DURATION`と
    // 同じくCatalogロード時点で拒否する。
    const markerWithReapply = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_MARKER_REAPPLY",
        kind: "APPLY_MARKER",
        payload: {
          markerId: "MARKER_TEST",
          stack: { policy: "ADD", max: null },
          duration: {
            dispellable: true,
            linkedEffectGroupId: null,
            timeLimit: { unit: "ACTION", count: 1 },
            reapply: { existingRemaining: { op: "EQ", value: 1 }, count: 2 },
          },
        },
        requiredCapabilities: ["CAP_MARKER"],
      },
      "effectAction",
    );

    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [...defs.skills, asSkill("SKL_AS2", "ACT_MARKER_REAPPLY")],
        units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
        effectActions: [...defs.effectActions, markerWithReapply],
        capabilities: [capability("CAP_MARKER")],
      }),
    ).toThrowError(/duration\.reapply is not/);
  });

  it("UT-CAT-IDX-091 (R-EFF-12/R-STS-03, M7-014 Issue #268): rejects a FREEZE APPLY_STATUS with duration.reapply, since freeze re-grant is a no-op", () => {
    const defs = baseDefinitions();
    // R-STS-03「再付与時に期間延長や増幅率加算を行わない」により
    // `grantFreezeStatus`は既存インスタンスをそのまま返す。`reapply`を宣言しても
    // 一度も評価されないため、宣言自体を拒否する。
    const freezeWithReapply = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_FREEZE_REAPPLY",
        kind: "APPLY_STATUS",
        payload: {
          status: "FREEZE",
          duration: {
            dispellable: true,
            linkedEffectGroupId: null,
            timeLimit: { unit: "ACTION", count: 1 },
            reapply: { existingRemaining: { op: "EQ", value: 1 }, count: 2 },
          },
        },
        requiredCapabilities: [],
      },
      "effectAction",
    );

    expect(() =>
      buildCatalogIndex({
        ...defs,
        skills: [...defs.skills, asSkill("SKL_AS2", "ACT_FREEZE_REAPPLY")],
        units: [unit("UNIT_001", { active: ["SKL_AS1", "SKL_AS2"] })],
        effectActions: [...defs.effectActions, freezeWithReapply],
      }),
    ).toThrowError(/duration\.reapply is not/);
  });
});
