import type { BattleUnit } from "../model/battle-unit.js";
import { resolveTargets } from "../targeting/target-selection-policy.js";
import { evaluateEffectStepCondition } from "./effect-step-condition-evaluator.js";
import type {
  EffectSequence,
  EffectStepDefinition,
} from "../../catalog/definitions/effect-sequence.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { ConditionKind } from "../../catalog/definitions/condition-definition.js";
import type { TargetReference } from "../../catalog/definitions/references.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type {
  EffectActionDefinitionId,
  TargetBindingId,
} from "../../catalog/definitions/catalog-ids.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnitId } from "../../shared/ids.js";

export interface ResolvedEffectApplication {
  readonly targetBattleUnitId: BattleUnitId;
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly hitIndex: number;
}

/** R-SKL-06 #4: 1つの対象へ1つのEffectActionを適用する単位（複数ヒットを含みうる、R-SKL-03）。 */
export interface EffectActionApplication {
  readonly targetBattleUnitId: BattleUnitId;
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly hits: readonly ResolvedEffectApplication[];
  /**
   * R-ACTN-01 #2 (RES-002 review finding [P2], PR #215): the
   * `TargetSelectorDefinition.includeDefeated` that resolved this target.
   * `effect-action-group-resolver.ts` carries this per application so it can
   * decide whether an already-defeated target should still be skipped, or
   * whether an explicit selector override permits applying to it anyway.
   * A `SELF` reference (no selector involved) is always `false` - if the
   * actor itself were defeated, the actor-defeated interrupt check runs
   * before this decision is ever reached.
   */
  readonly includeDefeated: boolean;
}

/** R-SKL-06 #1〜#2: ACTION stepの条件評価結果と、満たされた場合の適用一覧。 */
export interface EffectStepPlan {
  readonly stepIndex: number;
  readonly stepKind: "ACTION";
  readonly conditionKind: ConditionKind;
  readonly satisfied: boolean;
  /** `satisfied`が`false`の場合は空配列（stepをスキップし、実効果を持たない）。 */
  readonly applications: readonly EffectActionApplication[];
}

/** R-SKL-01: `EffectSequence`全体の解決計画。stepの定義順を保つ。 */
export interface EffectSequencePlan {
  readonly steps: readonly EffectStepPlan[];
  /** 全stepの対象を初出順に重複排除したもの（`TargetsSelected`/`ChargeReleased`のtargetUnitIds用）。 */
  readonly targetUnitIds: readonly BattleUnitId[];
}

/** R-SKL-01の`resolveTargets`結果に、選択元selectorの`includeDefeated`（R-ACTN-01 #2）を添えたもの。 */
interface ResolvedBinding {
  readonly units: readonly BattleUnit[];
  readonly includeDefeated: boolean;
}

function resolveReference(
  reference: TargetReference,
  resolvedBindings: ReadonlyMap<TargetBindingId, ResolvedBinding>,
  actor: BattleUnit,
): ResolvedBinding {
  if (reference.kind === "SELF") {
    return { units: [actor], includeDefeated: false };
  }
  if (reference.kind === "BINDING") {
    const resolved = resolvedBindings.get(reference.targetBindingId as TargetBindingId);
    if (resolved === undefined) {
      throw new DomainValidationError(
        "target.targetBindingId",
        `targetBindingId "${reference.targetBindingId}" was not resolved from targetBindings`,
      );
    }
    return resolved;
  }
  throw new DomainValidationError(
    "target.kind",
    `kind "${reference.kind}" is not supported by this basic SkillResolutionService (M6/M7 scope)`,
  );
}

/** R-SKL-03: DAMAGEのhitCountだけが複数ヒットを持つ。それ以外の種別は常に1ヒット。 */
function hitCountOf(
  effectActionDefinitionId: EffectActionDefinitionId,
  effectAction: EffectActionDefinition | undefined,
): number {
  if (effectAction === undefined) {
    throw new DomainValidationError(
      "action.effectActionDefinitionId",
      `effectActionDefinitionId "${effectActionDefinitionId}" was not found in the given effectActions (Catalog preflight should already guarantee this reference exists)`,
    );
  }
  return effectAction.kind === "DAMAGE" ? effectAction.payload.hitCount : 1;
}

/** R-SKL-06 #3〜#4: 対象集合を取得し、対象順・actions定義順に`EffectActionApplication`を組み立てる。 */
function resolveActionStepApplications(
  step: Extract<EffectStepDefinition, { kind: "ACTION" }>,
  resolvedBindings: ReadonlyMap<TargetBindingId, ResolvedBinding>,
  actor: BattleUnit,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
): readonly EffectActionApplication[] {
  const { units: targets, includeDefeated } = resolveReference(
    step.target,
    resolvedBindings,
    actor,
  );
  const applications: EffectActionApplication[] = [];

  // R-SKL-02: 対象は束縛順に処理する。
  for (const target of targets) {
    // EffectStep ACTION: EffectActionDefinitionを定義順に適用する（05_ドメインモデル.md）。
    for (const actionRef of step.actions) {
      const effectAction = effectActions.get(actionRef.effectActionDefinitionId);
      const hitCount = hitCountOf(actionRef.effectActionDefinitionId, effectAction);
      // R-SKL-03: 各ヒットを独立して定義順に処理する。
      const hits: ResolvedEffectApplication[] = [];
      for (let hitIndex = 1; hitIndex <= hitCount; hitIndex++) {
        hits.push({
          targetBattleUnitId: target.battleUnitId,
          effectActionDefinitionId: actionRef.effectActionDefinitionId,
          hitIndex,
        });
      }
      applications.push({
        targetBattleUnitId: target.battleUnitId,
        effectActionDefinitionId: actionRef.effectActionDefinitionId,
        includeDefeated,
        hits,
      });
    }
  }
  return applications;
}

/**
 * `SkillResolutionService` (`05_ドメインモデル.md`)。R-SKL-01（targetBindings→
 * stepsの定義順評価、conditionによるstep単位のskip）、R-SKL-02（複数対象の定義順
 * 処理）、R-SKL-03（複数ヒットの定義順処理）、R-SKL-06（ACTION stepのcondition
 * 評価・対象取得・action定義順適用の計画）を、実際のダメージ計算やPS/Memory連鎖
 * なしで解決する。ダメージ適用自体、およびstep/action単位のイベント発行と
 * PS即時連鎖は呼び出し側（`effect-action-group-resolver.ts`）が担う。
 * ACTION以外のstep種別、CHARGEスキル、TRUE/AND/OR/NOT以外のstep.conditionは
 * 対象外（ConditionEvaluatorのTARGET_STATE等はM7スコープ）。参照先が
 * `effectActions` に存在しないEffectActionDefinitionIdは、Catalog preflightの
 * 不変条件違反として例外を投げる（1ヒット成功として扱わない）。
 */
function resolveEffectSequence(
  sequence: EffectSequence,
  actor: BattleUnit,
  allUnits: readonly BattleUnit[],
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
): EffectSequencePlan {
  // R-SKL-01 #1: targetBindingsを定義順に一度だけ評価する。
  const resolvedBindings = new Map<TargetBindingId, ResolvedBinding>();
  for (const binding of sequence.targetBindings) {
    resolvedBindings.set(binding.targetBindingId, {
      units: resolveTargets(binding.selector, actor, allUnits),
      includeDefeated: binding.selector.includeDefeated,
    });
  }

  const steps: EffectStepPlan[] = [];
  const targetUnitIds: BattleUnitId[] = [];
  const seenTargetUnitIds = new Set<BattleUnitId>();

  // R-SKL-01 #2: stepsを定義順に解決する。
  sequence.steps.forEach((step, stepIndex) => {
    if (step.kind !== "ACTION") {
      throw new DomainValidationError(
        "step.kind",
        `kind "${step.kind}" is not supported by this basic SkillResolutionService (BRANCH/RANDOM_BRANCH/REPEAT are M6/M7 scope)`,
      );
    }
    // R-SKL-06 #1〜#2: conditionを評価し、falseならstep全体をスキップする。
    const satisfied = evaluateEffectStepCondition(step.condition);
    if (!satisfied) {
      steps.push({
        stepIndex,
        stepKind: "ACTION",
        conditionKind: step.condition.kind,
        satisfied: false,
        applications: [],
      });
      return;
    }
    const applications = resolveActionStepApplications(
      step,
      resolvedBindings,
      actor,
      effectActions,
    );
    for (const application of applications) {
      if (!seenTargetUnitIds.has(application.targetBattleUnitId)) {
        seenTargetUnitIds.add(application.targetBattleUnitId);
        targetUnitIds.push(application.targetBattleUnitId);
      }
    }
    steps.push({
      stepIndex,
      stepKind: "ACTION",
      conditionKind: step.condition.kind,
      satisfied: true,
      applications,
    });
  });

  return { steps, targetUnitIds };
}

/** テスト・呼び出し側がstep構造を無視して、旧来のヒット単位の平坦な順序だけを見たい場合に使う。 */
export function flattenEffectSequencePlan(
  plan: EffectSequencePlan,
): readonly ResolvedEffectApplication[] {
  const result: ResolvedEffectApplication[] = [];
  for (const step of plan.steps) {
    for (const application of step.applications) {
      result.push(...application.hits);
    }
  }
  return result;
}

export function resolveSkillOrder(
  skill: SkillDefinition,
  actor: BattleUnit,
  allUnits: readonly BattleUnit[],
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
): EffectSequencePlan {
  if (skill.resolution.kind !== "IMMEDIATE") {
    throw new DomainValidationError(
      "skill.resolution.kind",
      `kind "${skill.resolution.kind}" is not supported by this basic SkillResolutionService (charge start/release is handled separately, see resolveChargeReleaseOrder)`,
    );
  }
  return resolveEffectSequence(skill.resolution, actor, allUnits, effectActions);
}

/**
 * R-SKL-05: チャージ効果発動時、`SkillResolutionDefinition`の`chargeRelease`
 * EffectSequence（CHARGE開始時の`steps`とは独立）を、`resolveSkillOrder`と
 * 同じ定義順解決（R-SKL-01〜03、R-SKL-06の基本形）で処理する。
 */
export function resolveChargeReleaseOrder(
  skill: SkillDefinition,
  actor: BattleUnit,
  allUnits: readonly BattleUnit[],
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
): EffectSequencePlan {
  if (skill.resolution.kind !== "CHARGE") {
    throw new DomainValidationError(
      "skill.resolution.kind",
      `kind "${skill.resolution.kind}" has no chargeRelease sequence (only CHARGE skills do)`,
    );
  }
  return resolveEffectSequence(skill.resolution.chargeRelease, actor, allUnits, effectActions);
}
