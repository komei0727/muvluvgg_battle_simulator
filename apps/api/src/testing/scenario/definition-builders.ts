import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
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
    metadata: { displayName: id, tags: [] },
  };
}

/**
 * 敵全体に1つのEffectActionを適用する最小のASスキル。`guaranteedHit` は
 * R-STS-04（暗闇は必中を無視してMISS判定を行う）を検証するときだけ立てる。
 */
export function attackSkill(
  id: string,
  effectActionId: string,
  options: { readonly guaranteedHit?: boolean } = {},
): SkillDefinition {
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
      accuracy: { guaranteedHit: options.guaranteedHit ?? false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    metadata: { displayName: "Attack", tags: [] },
  };
}

/**
 * スキル威力ぶんのダメージを与える最小のEffectAction。既定は物理ダメージ。
 * `criticalMode: "PREVENTED"` にすると会心判定が RandomSource を消費しないため、
 * 乱数消費数を数えずに完走させたい property/長さ可変シナリオで使える。
 * `damageType` は `R-SHD-02`「ダメージタイプに対応するタイプありシールド」の
 * 物理／EN両経路をシナリオから指定するために開けてある。
 */
export function damageEffectAction(
  id: string,
  power = 1,
  criticalMode: "NORMAL" | "GUARANTEED" | "PREVENTED" = "NORMAL",
  damageType: "PHYSICAL" | "EN" = "PHYSICAL",
): EffectActionDefinition {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    metadata: { tags: [] },
    payload: {
      damageType,
      formula: { kind: "SKILL_POWER", power },
      hitCount: 1,
      critical: { mode: criticalMode },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

/**
 * 自分以外の味方1体を対象にするセレクタ。味方が使用者だけの盤面では候補0体になり、
 * `R-TGT-01` #4 によりそのスキルは発動不能になる（`Q-BTL-06`「EXを使用できない場合」の
 * 前提を、戦闘不能者を用意せずに作れる唯一の形）。
 */
export const OTHER_ALLY_ONE: TargetSelectorDefinition = {
  kind: "SELECT",
  side: "ALLY",
  count: 1,
  filters: [{ kind: "EXCLUDE_RESOLVED_UNIT", reference: { kind: "SELF" } }],
  order: ["DEFAULT"],
  includeDefeated: false,
};

/** 使用者自身へEffectActionを1件だけ適用する最小のASスキル。 */
export function selfEffectSkill(
  id: string,
  effectActionIds: readonly string[],
  overrides: { readonly apCost?: number } = {},
): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "AS",
    cost: { resource: "AP", amount: overrides.apCost ?? 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "SELF" },
          actions: effectActionIds.map((effectActionId) => ({
            effectActionDefinitionId: createEffectActionDefinitionId(effectActionId),
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
    metadata: { displayName: id, tags: [] },
  };
}

/**
 * 敵全体へ1つのEffectActionを適用する `resolution.kind: CHARGE` のスキル
 * （`R-SKL-05`）。開始側の `steps` は空にする — 「チャージ開始側はEffectSequenceを
 * 一つも解決しない」という契約そのものをシナリオから観測できるようにするため。
 */
export function chargeSkill(id: string, releaseEffectActionId: string): SkillDefinition {
  const binding = createTargetBindingId("TGT_CHARGE");
  return {
    ...selfEffectSkill(id, []),
    resolution: {
      kind: "CHARGE",
      targetBindings: [],
      steps: [],
      chargeRelease: {
        targetBindings: [{ targetBindingId: binding, selector: ENEMY_ALL }],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: binding },
            actions: [
              {
                effectActionDefinitionId: createEffectActionDefinitionId(releaseEffectActionId),
              },
            ],
          },
        ],
      },
    },
  };
}

export interface StatModOverrides {
  readonly stat?: "ATTACK" | "DEFENSE" | "ACTION_SPEED" | "CRITICAL_RATE";
  readonly value?: number;
  readonly stackingMode?: "STACKABLE" | "NON_STACKABLE";
  readonly timeLimit?: { readonly unit: "ACTION" | "TURN" | "BATTLE"; readonly count: number };
}

/**
 * 固定値のステータス補正を付与する最小のEffectAction。効果量を `FIXED` にするのは、
 * 期間・重複の検証で「実効値が何件ぶん乗っているか」を割合合成なしに読めるようにするため。
 */
export function statModEffectAction(
  id: string,
  overrides: StatModOverrides = {},
): EffectActionDefinition {
  return {
    kind: "APPLY_STAT_MOD",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    metadata: { tags: [] },
    payload: {
      stat: overrides.stat ?? "ATTACK",
      valueType: "FIXED",
      formula: { kind: "CONSTANT", value: overrides.value ?? 5 },
      stacking: { mode: overrides.stackingMode ?? "STACKABLE", max: null },
      duration: {
        timeLimit: overrides.timeLimit ?? { unit: "ACTION", count: 1 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
    },
  };
}

/**
 * 使用者の現在HPに比例したステータス補正を付与するEffectAction。**同じ定義から
 * 効果量の違うインスタンスを作れる**唯一の形として、`R-EFF-05` の重複あり／重複なし
 * 検証で使う。`EffectKindKey` は定義IDそのもの（`applied-effect.ts`）なので、
 * 別定義2件は「同種」にならず `stacking.mode` の違いが観測に一切現れない —
 * 同種であることを担保できるのは同じ定義を2回適用する形だけである。
 */
export function hpScaledStatModEffectAction(
  id: string,
  overrides: {
    readonly ratio?: number;
    readonly count?: number;
    readonly stackingMode?: "STACKABLE" | "NON_STACKABLE";
  } = {},
): EffectActionDefinition {
  return {
    kind: "APPLY_STAT_MOD",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    metadata: { tags: [] },
    payload: {
      stat: "ATTACK",
      valueType: "FIXED",
      formula: {
        kind: "CURRENT_HP_RATIO",
        source: { kind: "SKILL_SOURCE" },
        ratio: overrides.ratio ?? 0.1,
      },
      stacking: { mode: overrides.stackingMode ?? "NON_STACKABLE", max: null },
      duration: {
        timeLimit: { unit: "ACTION", count: overrides.count ?? 2 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
    },
  };
}

/** 使用者の現在HPを割合で支払うEffectAction（`R-ACTN-02`、`bounds.min: 0`）。 */
export function hpCostEffectAction(id: string, ratio = 0.5): EffectActionDefinition {
  return {
    kind: "MODIFY_RESOURCE",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    metadata: { tags: [] },
    payload: {
      resource: "HP",
      operation: "ADD",
      formula: { kind: "CURRENT_HP_RATIO", source: { kind: "SKILL_SOURCE" }, ratio: -ratio },
      bounds: { min: 0, max: "CURRENT_MAX" },
    },
  };
}

/** 状態異常を付与する最小のEffectAction（`R-STS-02`〜`R-STS-04`）。 */
export function statusEffectAction(
  id: string,
  status: "STUN" | "FREEZE" | "BLIND",
  count = 1,
  probability?: number,
): EffectActionDefinition {
  return {
    kind: "APPLY_STATUS",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    metadata: { tags: [] },
    payload: {
      status,
      duration: {
        timeLimit: { unit: "ACTION", count },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      ...(probability === undefined ? {} : { probability }),
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
