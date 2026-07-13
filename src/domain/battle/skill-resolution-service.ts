import type { BattleUnit } from "./battle-unit.js";
import { resolveTargets } from "./target-selection-policy.js";
import type { EffectStepDefinition } from "../catalog/effect-sequence.js";
import type { EffectActionDefinition } from "../catalog/effect-action-definition.js";
import type { TargetReference } from "../catalog/references.js";
import type { SkillDefinition } from "../catalog/skill-definition.js";
import type { EffectActionDefinitionId, TargetBindingId } from "../catalog/catalog-ids.js";
import { DomainValidationError } from "../shared/errors.js";
import type { BattleUnitId } from "../shared/ids.js";

export interface ResolvedEffectApplication {
  readonly targetBattleUnitId: BattleUnitId;
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly hitIndex: number;
}

function resolveReference(
  reference: TargetReference,
  resolvedBindings: ReadonlyMap<TargetBindingId, readonly BattleUnit[]>,
  actor: BattleUnit,
): readonly BattleUnit[] {
  if (reference.kind === "SELF") {
    return [actor];
  }
  if (reference.kind === "BINDING") {
    const targets = resolvedBindings.get(reference.targetBindingId as TargetBindingId);
    if (targets === undefined) {
      throw new DomainValidationError(
        "target.targetBindingId",
        `targetBindingId "${reference.targetBindingId}" was not resolved from targetBindings`,
      );
    }
    return targets;
  }
  throw new DomainValidationError(
    "target.kind",
    `kind "${reference.kind}" is not supported by this basic SkillResolutionService (M6/M7 scope)`,
  );
}

/** R-SKL-03: DAMAGEのhitCountだけが複数ヒットを持つ。それ以外の種別は常に1ヒット。 */
function hitCountOf(effectAction: EffectActionDefinition | undefined): number {
  return effectAction?.kind === "DAMAGE" ? effectAction.payload.hitCount : 1;
}

function resolveActionStep(
  step: Extract<EffectStepDefinition, { kind: "ACTION" }>,
  resolvedBindings: ReadonlyMap<TargetBindingId, readonly BattleUnit[]>,
  actor: BattleUnit,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
): readonly ResolvedEffectApplication[] {
  const targets = resolveReference(step.target, resolvedBindings, actor);
  const results: ResolvedEffectApplication[] = [];

  // R-SKL-02: 対象は束縛順に処理する。
  for (const target of targets) {
    // EffectStep ACTION: EffectActionDefinitionを定義順に適用する（05_ドメインモデル.md）。
    for (const actionRef of step.actions) {
      const effectAction = effectActions.get(actionRef.effectActionDefinitionId);
      const hitCount = hitCountOf(effectAction);
      // R-SKL-03: 各ヒットを独立して定義順に処理する。
      for (let hitIndex = 1; hitIndex <= hitCount; hitIndex++) {
        results.push({
          targetBattleUnitId: target.battleUnitId,
          effectActionDefinitionId: actionRef.effectActionDefinitionId,
          hitIndex,
        });
      }
    }
  }
  return results;
}

/**
 * `SkillResolutionService` 基本形 (`05_ドメインモデル.md`)。R-SKL-01（効果順の
 * 一部: targetBindings→stepsの定義順評価）、R-SKL-02（複数対象の定義順処理）、
 * R-SKL-03（複数ヒットの定義順処理）を、実際のダメージ計算やPS/Memory連鎖
 * なしで解決する。ダメージ適用自体は#9（HitPolicy/CriticalPolicy/
 * DamageCalculator）が担う。ACTION以外のstep種別とCHARGEスキルは対象外
 * （M5〜M8で拡張）。
 */
export function resolveSkillOrder(
  skill: SkillDefinition,
  actor: BattleUnit,
  allUnits: readonly BattleUnit[],
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
): readonly ResolvedEffectApplication[] {
  if (skill.resolution.kind !== "IMMEDIATE") {
    throw new DomainValidationError(
      "skill.resolution.kind",
      `kind "${skill.resolution.kind}" is not supported by this basic SkillResolutionService (charge behavior is M7 scope)`,
    );
  }

  // R-SKL-01 #1: targetBindingsを定義順に一度だけ評価する。
  const resolvedBindings = new Map<TargetBindingId, readonly BattleUnit[]>();
  for (const binding of skill.resolution.targetBindings) {
    resolvedBindings.set(
      binding.targetBindingId,
      resolveTargets(binding.selector, actor, allUnits),
    );
  }

  const results: ResolvedEffectApplication[] = [];
  // R-SKL-01 #2: stepsを定義順に解決する。
  for (const step of skill.resolution.steps) {
    if (step.kind !== "ACTION") {
      throw new DomainValidationError(
        "step.kind",
        `kind "${step.kind}" is not supported by this basic SkillResolutionService (BRANCH/RANDOM_BRANCH/REPEAT are M6/M7 scope)`,
      );
    }
    results.push(...resolveActionStep(step, resolvedBindings, actor, effectActions));
  }
  return results;
}
