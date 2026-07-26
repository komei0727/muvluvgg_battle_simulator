import type { BattleUnit } from "../model/battle-unit.js";
import { resolveTargets } from "../targeting/target-selection-policy.js";
import { evaluateEffectStepCondition } from "../skill/effect-step-condition-evaluator.js";
import type {
  SkillDefinitionId,
  TargetBindingId,
  UnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import type { ConditionDefinition } from "../../catalog/definitions/condition-definition.js";
import type { TargetReference } from "../../catalog/definitions/references.js";
import { DomainValidationError } from "../../shared/errors.js";

export type ActionSelectionResult =
  | { readonly kind: "SKILL"; readonly skill: SkillDefinition }
  | { readonly kind: "WAIT" };

interface TargetBindingResolution {
  readonly bindings: ReadonlyMap<TargetBindingId, readonly BattleUnit[]>;
  readonly allResolvable: boolean;
}

/**
 * R-TGT-01 #4: 各targetBindingが1体以上の候補を持つかどうかで判定する。
 * R-TGT-09/10: `base: BINDING`が先行bindingを参照できるよう、定義順に解決した
 * bindingを積み上げながら判定する（後続bindingが不成立でも先行分は評価済み）。
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
    if (units.length === 0) {
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
 * R-ACT-02「発動条件を満たす」（CAP_ACTION_ACTIVATION_CONDITION、Issue #180）:
 * AS/EXの`activationCondition`を、行動選択時にTargetBinding/Area/TargetFilterで
 * 絞り込んだ最新の生存対象集合に対して評価する。`evaluateEffectStepCondition`
 * （ACTION stepの`stepCondition`/BRANCHの`condition`と共通の評価器）をそのまま
 * 再利用し、`TargetReference`は`SELF`（使用者自身）と`BINDING`（この呼び出し
 * より前に解決済みのtargetBindings）だけを解決する — AS/EX選択はPS/Memoryの
 * ようなトリガーイベントや直前結果を持たないため、`TRIGGER_SOURCE`/
 * `TRIGGER_TARGET`/`LAST_ACTION_TARGETS`/`LAST_DAMAGED_TARGETS`はCatalog-authoring
 * errorとして明確な例外を投げる。
 */
function evaluateActivationCondition(
  condition: ConditionDefinition,
  actor: BattleUnit,
  resolvedBindings: ReadonlyMap<TargetBindingId, readonly BattleUnit[]>,
  unitDefinitions?: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
): boolean {
  const resolveTargetSet = (reference: TargetReference): readonly BattleUnit[] => {
    if (reference.kind === "SELF") {
      return [actor];
    }
    if (reference.kind === "BINDING" && reference.targetBindingId !== undefined) {
      const units = resolvedBindings.get(reference.targetBindingId);
      if (units === undefined) {
        throw new DomainValidationError(
          "skill.activationCondition",
          `references an unresolved TargetBindingId "${reference.targetBindingId}"`,
        );
      }
      return units;
    }
    throw new DomainValidationError(
      "skill.activationCondition",
      `TargetReference kind "${reference.kind}" is not supported by AS/EX activationCondition evaluation (no triggering event or prior action exists at action-selection time)`,
    );
  };
  return evaluateEffectStepCondition(
    condition,
    undefined,
    undefined,
    resolveTargetSet,
    unitDefinitions,
  );
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
): ActionSelectionResult {
  for (const skill of activeSkills) {
    if (isUsable(skill, actor, allUnits, unitDefinitions)) {
      return { kind: "SKILL", skill };
    }
  }
  return { kind: "WAIT" };
}

/**
 * R-ACT-01 #5（EX予約）: EXはコスト（AP・クールタイム）判定を持たず（`R-ACT-03`
 * 「EX: EXゲージ全量、APは消費しない」、予約時点でゲージは既に満タン確定）、
 * 対象候補の有無だけが発動可否を左右する（`Q-BTL-06`「EXを使用できない場合は
 * EXゲージを全量消費して待機する」）。
 */
export function isExUsable(
  exSkill: SkillDefinition,
  actor: BattleUnit,
  allUnits: readonly BattleUnit[],
  unitDefinitions?: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
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
