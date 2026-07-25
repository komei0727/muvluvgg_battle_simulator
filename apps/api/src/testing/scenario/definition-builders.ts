import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
  type CapabilityId,
  type SkillDefinitionId,
  type UnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { TargetSelectorDefinition } from "../../domain/catalog/definitions/target-selector-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import type {
  SimulateBattleCommand,
  LogLevel,
} from "../../application/simulation/simulate-battle-command.js";

/**
 * Battle Scenario Harness 用の定義Builder（`12_テスト戦略.md`「テストデータ設計」）。
 * 既定値は「最小で妥当・特殊効果なし」とし、テスト対象以外の要因を減らす。各Builderは
 * `Partial`のoverridesを受け取り、テスト意図に関係する値だけを明示できるようにする。
 *
 * これらは `simulate-battle-use-case.test.ts` / `state-restoration.test.ts` などへ
 * インライン重複していたfixtureを共通化したもの。ドメインルールテストをproduction
 * Catalogの具体ユニットへ依存させないための合成Catalog素材を提供する。
 */

/** 参照される既定EXスキルのID。`CatalogBuilder`が未登録時に自動補完する。 */
export const DEFAULT_EX_SKILL_ID = "SKL_EX_DEFAULT";

/** すべての敵を対象にする最小のターゲットセレクタ。 */
export const ENEMY_ALL: TargetSelectorDefinition = {
  kind: "SELECT",
  side: "ENEMY",
  count: "ALL",
  filters: [],
  order: ["DEFAULT"],
  includeDefeated: false,
};

export interface UnitDefinitionOverrides {
  readonly attribute?: UnitDefinition["attribute"];
  readonly unitType?: UnitDefinition["unitType"];
  readonly role?: UnitDefinition["role"];
  readonly positionAptitudes?: UnitDefinition["positionAptitudes"];
  readonly baseStats?: Partial<UnitDefinition["baseStats"]>;
  readonly extraGaugeMaximum?: number;
  readonly activeSkillDefinitionIds?: readonly SkillDefinitionId[];
  readonly passiveSkillDefinitionIds?: readonly SkillDefinitionId[];
  readonly extraSkillDefinitionId?: SkillDefinitionId;
  readonly requiredCapabilities?: readonly CapabilityId[];
}

/** 「PSを持たない・特殊効果なし」の最小妥当なUnit定義。 */
export function unitDefinition(
  id: string,
  overrides: UnitDefinitionOverrides = {},
): UnitDefinition {
  return {
    unitDefinitionId: createUnitDefinitionId(id),
    attribute: overrides.attribute ?? "AGGRESSIVE",
    unitType: overrides.unitType ?? "PHYSICAL",
    role: overrides.role ?? "PHYSICAL_ATTACKER",
    positionAptitudes: overrides.positionAptitudes ?? ["FRONT", "BACK"],
    baseStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
      actionSpeed: 10,
      maximumAp: 3,
      maximumPp: 3,
      ...overrides.baseStats,
    },
    extraGaugeMaximum: overrides.extraGaugeMaximum ?? 100,
    activeSkillDefinitionIds: overrides.activeSkillDefinitionIds ?? [],
    passiveSkillDefinitionIds: overrides.passiveSkillDefinitionIds ?? [],
    extraSkillDefinitionId:
      overrides.extraSkillDefinitionId ?? createSkillDefinitionId(DEFAULT_EX_SKILL_ID),
    requiredCapabilities: overrides.requiredCapabilities ?? [],
    metadata: {
      displayName: id,
      characterName: id,
      characterId: id,
      affiliations: [],
      tags: [],
    },
  };
}

/** EXゲージが満タンにならない限り使われない、副作用のない最小のEXスキル。 */
export function exSkillDefinition(id: string = DEFAULT_EX_SKILL_ID): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "EX",
    cost: { resource: "EX_GAUGE", amount: 100 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    requiredCapabilities: [],
    metadata: { displayName: id, tags: [] },
  };
}

/** 敵全体に1つのEffectActionを適用する最小のASスキル。 */
export function attackSkill(id: string, effectActionId: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [{ targetBindingId: createTargetBindingId("TGT_1"), selector: ENEMY_ALL }],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(effectActionId) }],
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
    requiredCapabilities: [],
    metadata: { displayName: "Attack", tags: [] },
  };
}

/** スキル威力ぶんの物理ダメージを与える最小のEffectAction。 */
export function damageEffectAction(id: string, power = 1): EffectActionDefinition {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power },
      hitCount: 1,
      critical: { mode: "NORMAL" },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

type FormationSlot = SimulateBattleCommand["allyFormation"]["slots"][number];

/** 編成スロット。列と前後列を指定する（既定はFRONT）。 */
export function formationSlot(
  unitId: string,
  column: 0 | 1 | 2,
  row: "FRONT" | "REAR" = "FRONT",
): FormationSlot {
  return { unitDefinitionId: createUnitDefinitionId(unitId), position: { column, row } };
}

export interface BattleCommandOverrides {
  readonly allyFormation?: SimulateBattleCommand["allyFormation"];
  readonly enemyFormation?: SimulateBattleCommand["enemyFormation"];
  readonly turnLimit?: number;
  readonly logLevel?: LogLevel;
}

/** 1対1・memoryなしの最小のSimulateBattleCommand。 */
export function battleCommand(overrides: BattleCommandOverrides = {}): SimulateBattleCommand {
  return {
    allyFormation: overrides.allyFormation ?? {
      slots: [formationSlot("UNIT_ALLY", 0)],
      memoryDefinitionIds: [],
    },
    enemyFormation: overrides.enemyFormation ?? {
      slots: [formationSlot("UNIT_ENEMY", 0)],
      memoryDefinitionIds: [],
    },
    turnLimit: overrides.turnLimit ?? 3,
    logLevel: overrides.logLevel ?? "DETAILED",
  };
}

export type { UnitDefinitionId };
