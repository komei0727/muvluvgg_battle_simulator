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

  it("UT-R-EFF-10-016 (R-EFF-10, PR #210再レビュー[P2]): accepts two APPLY_MARKER definitions sharing a linkedEffectGroupId (Marker-to-Marker cascade is implemented, marker-linked-group.ts)", () => {
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

  it("UT-R-EFF-10-017 (R-EFF-10, PR #210再レビュー[P2]): rejects an APPLY_MARKER sharing a linkedEffectGroupId with a non-Marker EffectActionDefinition (AppliedEffect<->MarkerState cross-type cascade, R-EFF-09, is not yet implemented)", () => {
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

    try {
      buildCatalogIndex(withCrossTypeGroup);
      expect.unreachable();
    } catch (error) {
      const err = error as CatalogIntegrityError;
      expect(
        err.violations.some(
          (v) => v.rule === "UNSUPPORTED_MARKER_LINKED_GROUP" && v.targetId === "ACT_MARKER",
        ),
      ).toBe(true);
    }
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
});
