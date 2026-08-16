import type { BattleUnit } from "../model/battle-unit.js";
import { resolveTargets } from "../targeting/target-selection-policy.js";
import type {
  SkillDefinitionId,
  TargetBindingId,
  UnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import type { ConditionDefinition } from "../../catalog/definitions/condition-definition.js";
import { DomainValidationError } from "../../shared/errors.js";

export type ActionSelectionResult =
  | { readonly kind: "SKILL"; readonly skill: SkillDefinition }
  | { readonly kind: "WAIT" };

interface TargetBindingResolution {
  readonly bindings: ReadonlyMap<TargetBindingId, readonly BattleUnit[]>;
  readonly allResolvable: boolean;
}

/**
 * R-ACT-02「発動条件を満たす」（CAP_ACTION_ACTIVATION_CONDITION、Issue #180）:
 * `activationCondition`を、行動選択時にTargetBinding/Area/TargetFilterで
 * 絞り込んだ最新の生存対象集合（`resolvedBindings`）に対して評価する関数の型。
 * `domain/battle/action`は`domain/battle/skill`へ依存できない（モジュール境界、
 * eslint.config.mjs — actionとskillは並列でどちらも他方へ依存できない）ため、
 * 実際の評価器（`evaluateEffectStepCondition`を再利用する実装）は依存可能な層
 * （`domain/battle/lifecycle`）が持ち、ここへ注入する。
 */
export type ActivationConditionEvaluator = (
  condition: ConditionDefinition,
  actor: BattleUnit,
  resolvedBindings: ReadonlyMap<TargetBindingId, readonly BattleUnit[]>,
  unitDefinitions?: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
) => boolean;

/**
 * 評価器が注入されない呼び出し（実装済み層が渡さない旧来の呼び出し、または
 * テスト）向けの既定動作: `TRUE`だけを受理し、それ以外はCatalog-authoring
 * errorとして明確な例外を投げる（Issue #180以前の挙動そのまま）。
 */
const defaultActivationConditionEvaluator: ActivationConditionEvaluator = (condition) => {
  if (condition.kind === "TRUE") {
    return true;
  }
  throw new DomainValidationError(
    "skill.activationCondition",
    `kind "${condition.kind}" is not supported without an injected ActivationConditionEvaluator (CAP_ACTION_ACTIVATION_CONDITION, domain/battle/lifecycle supplies the real evaluator)`,
  );
};

/**
 * R-ACT-02「必要な対象候補が1体以上存在する」/ R-TGT-01 #4: `optional: true`を持たない
 * targetBindingが1体以上の候補を持つかどうかで判定する。`optional`な binding（隣接
 * splashのような補助対象）は0件でも失格理由にしない — 効果解決層は対象0件のstepを
 * 元から素通りするため、ここで失格させるとスキルごと発動しなくなる。
 * R-TGT-09/10: `base: BINDING`が先行bindingを参照できるよう、定義順に解決した
 * bindingを積み上げながら判定する（後続bindingが不成立でも先行分は評価済み）。
 * 空の binding も`resolvedBindingUnits`へ登録するため、`activationCondition`の
 * `TARGET_SET_COUNT`は0件として評価できる。
 * `unitDefinitions`はTGT-002（CAP_TARGET_FILTER_ORDER）のUNIT_TYPE系filter/order
 * （UNIT_TYPE_PRIORITYなど）を含むselectorにだけ要る。CAP_ACTION_ACTIVATION_CONDITION
 * （Issue #180）: `activationCondition`のTARGET_SET_COUNT/TARGET_STATE/TARGET_HAS_MARKER
 * がBINDING参照を評価できるよう、解決済みbindingを呼び出し側へ返す。
 */
function resolveAllTargetBindings(
  skill: SkillDefinition,
  actor: BattleUnit,
  allUnits: readonly BattleUnit[],
  unitDefinitions?: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
): TargetBindingResolution {
  const resolvedBindingUnits = new Map<TargetBindingId, readonly BattleUnit[]>();
  for (const binding of skill.resolution.targetBindings) {
    const units = resolveTargets(
      binding.selector,
      actor,
      allUnits,
      resolvedBindingUnits,
      undefined,
      unitDefinitions,
    );
    resolvedBindingUnits.set(binding.targetBindingId, units);
    if (units.length === 0 && binding.optional !== true) {
      return { bindings: resolvedBindingUnits, allResolvable: false };
    }
  }
  return { bindings: resolvedBindingUnits, allResolvable: true };
}

export function hasResolvableTargets(
  skill: SkillDefinition,
  actor: BattleUnit,
  allUnits: readonly BattleUnit[],
  unitDefinitions?: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
): boolean {
  return resolveAllTargetBindings(skill, actor, allUnits, unitDefinitions).allResolvable;
}

/**
 * R-ACT-02「クールタイムが0」: 指定スキルの残数が1以上（COOLING）かどうかを
 * 判定する。未登録（READY/未使用）のスキルは残数0として扱う。M6のPS発動直前
 * 再確認（`06_戦闘状態遷移.md`）でも同じ判定を再利用できるよう、
 * `ActionSelectionPolicy`から独立した関数として公開する。
 */
export function isCoolingDown(actor: BattleUnit, skillDefinitionId: SkillDefinitionId): boolean {
  return (actor.cooldowns[skillDefinitionId]?.remaining ?? 0) >= 1;
}

/**
 * R-ACT-02（基本形）: クールタイム、AP、発動条件（CAP_ACTION_ACTIVATION_CONDITION）、
 * 対象候補の有無を評価する。気絶・凍結による使用禁止（R-ACT-01/R-ACT-02の
 * 「気絶、凍結などによって使用を禁止されていない」）は、`resolveOneAction`
 * （`action-phase-resolver.ts`）のR-ACT-01優先順が気絶・凍結中は`selectAsCandidate`
 * 自体を呼び出さないことで構造的に満たすため、ここでは判定しない。
 */
function isUsable(
  skill: SkillDefinition,
  actor: BattleUnit,
  allUnits: readonly BattleUnit[],
  unitDefinitions?: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
  evaluateActivationCondition: ActivationConditionEvaluator = defaultActivationConditionEvaluator,
): boolean {
  if (isCoolingDown(actor, skill.skillDefinitionId)) {
    return false;
  }
  if (skill.cost.amount > actor.currentAp) {
    return false;
  }
  const resolution = resolveAllTargetBindings(skill, actor, allUnits, unitDefinitions);
  if (!resolution.allResolvable) {
    return false;
  }
  return evaluateActivationCondition(
    skill.activationCondition,
    actor,
    resolution.bindings,
    unitDefinitions,
  );
}

/**
 * `ActionSelectionPolicy` 基本形 (`05_ドメインモデル.md`)。R-ACT-02: ASを
 * 定義順に評価し、最初に使用可能なものを選ぶ。候補がなければ待機する。
 */
export function selectAsCandidate(
  activeSkills: readonly SkillDefinition[],
  actor: BattleUnit,
  allUnits: readonly BattleUnit[],
  unitDefinitions?: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
  evaluateActivationCondition?: ActivationConditionEvaluator,
): ActionSelectionResult {
  for (const skill of activeSkills) {
    if (isUsable(skill, actor, allUnits, unitDefinitions, evaluateActivationCondition)) {
      return { kind: "SKILL", skill };
    }
  }
  return { kind: "WAIT" };
}

/**
 * R-ACT-01 #4（EX予約）: EXはコスト（AP・クールタイム）判定を持たず（`R-ACT-03`
 * 「EX: EXゲージ全量、APは消費しない」、予約時点でゲージは既に満タン確定）、
 * 対象候補の有無だけが発動可否を左右する。使用できない場合の待機で何を消費するか
 * （AP残量による二択、`Q-BTL-06`）は呼び出し側の`action-phase-resolver.ts`が決める。
 */
export function isExUsable(
  exSkill: SkillDefinition,
  actor: BattleUnit,
  allUnits: readonly BattleUnit[],
  unitDefinitions?: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
  evaluateActivationCondition: ActivationConditionEvaluator = defaultActivationConditionEvaluator,
): boolean {
  const resolution = resolveAllTargetBindings(exSkill, actor, allUnits, unitDefinitions);
  if (!resolution.allResolvable) {
    return false;
  }
  return evaluateActivationCondition(
    exSkill.activationCondition,
    actor,
    resolution.bindings,
    unitDefinitions,
  );
}
