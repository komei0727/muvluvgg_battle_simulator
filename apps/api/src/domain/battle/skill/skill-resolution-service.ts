import type { BattleUnit } from "../model/battle-unit.js";
import { resolveTargets } from "../targeting/target-selection-policy.js";
import { evaluateEffectStepCondition } from "./effect-step-condition-evaluator.js";
import type {
  EffectActionReference,
  EffectSequence,
  EffectStepDefinition,
} from "../../catalog/definitions/effect-sequence.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { ConditionDefinition } from "../../catalog/definitions/condition-definition.js";
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
   * before this decision is ever reached. `LAST_ACTION_TARGETS`/
   * `LAST_DAMAGED_TARGETS` (R-SKL-08) have no selector of their own either,
   * and default to `false` for the same reason.
   */
  readonly includeDefeated: boolean;
}

/** R-SKL-06 #1〜#2: ACTION stepの条件評価結果と、満たされた場合の適用一覧（即時解決済み）。 */
export interface ActionStepPlan {
  readonly planKind: "ACTION_PLAN";
  readonly stepIndex: number;
  readonly stepKind: "ACTION";
  readonly conditionKind: ConditionDefinition["kind"];
  readonly satisfied: boolean;
  /**
   * R-SKL-08/Catalog preflight（`MISSING_PRECEDING_RESULT`）: `satisfied`が
   * `true`かつ`applications`が空（bindingが0対象に解決された場合）に、
   * `effect-action-group-resolver.ts`が「対象0件のSKIPPED結果」を合成する
   * ために必要な、定義順の元の`actions`。
   */
  readonly actions: readonly EffectActionReference[];
  /** `satisfied`が`false`の場合は空配列（stepをスキップし、実効果を持たない）。 */
  readonly applications: readonly EffectActionApplication[];
}

/**
 * R-SKL-07（Issue #217設計方針A）: `BRANCH`/`RANDOM_BRANCH`/`REPEAT`と、
 * `LAST_RESULT`/`LAST_ACTION_TARGETS`/`LAST_DAMAGED_TARGETS`を参照する
 * `ACTION`は、実際にその位置まで解決が進むまでcondition・対象を確定できない
 * ため、生の`EffectStepDefinition`のまま持ち越す。`effect-action-group-resolver.ts`
 * がこの定義を直接解釈しながら実行する（`resolvedBindings`を通じて`BINDING`
 * 参照を解決する）。この計画自体は副作用もPS/Memory連鎖もbranch選択も行わない
 * — 「まだ解決していない」という事実だけを表す。
 */
export interface DeferredStepPlan {
  readonly planKind: "DEFERRED";
  readonly stepIndex: number;
  readonly stepKind: EffectStepDefinition["kind"];
  readonly definition: EffectStepDefinition;
}

export type EffectStepPlan = ActionStepPlan | DeferredStepPlan;

/** R-SKL-01の`resolveTargets`結果に、選択元selectorの`includeDefeated`（R-ACTN-01 #2）を添えたもの。 */
export interface ResolvedBinding {
  readonly units: readonly BattleUnit[];
  readonly includeDefeated: boolean;
}

/**
 * R-SKL-08: 同じ解決スコープ内で直前に確定した`EffectAction`結果が持つ対象を、
 * `LAST_ACTION_TARGETS`/`LAST_DAMAGED_TARGETS` TargetReferenceが参照するために
 * 必要な文脈。`effect-action-group-resolver.ts`の`LastResultState`から、実際に
 * 適用が確定した対象idの一覧だけを渡す（未実行の結果は含まない）。
 */
export interface LastResultTargetContext {
  readonly allUnits: readonly BattleUnit[];
  readonly lastActionTargetUnitIds: readonly BattleUnitId[];
  readonly lastDamagedTargetUnitIds: readonly BattleUnitId[];
}

/** R-SKL-01: `EffectSequence`全体の解決計画。stepの定義順を保つ。 */
export interface EffectSequencePlan {
  readonly steps: readonly EffectStepPlan[];
  /** 全stepの対象を初出順に重複排除したもの（`TargetsSelected`/`ChargeReleased`のtargetUnitIds用）。 */
  readonly targetUnitIds: readonly BattleUnitId[];
  /**
   * R-SKL-01 #1で一度だけ評価した`targetBindings`。`DeferredStepPlan`が持つ
   * 生の定義中の`BINDING`参照を、`effect-action-group-resolver.ts`がJITで
   * 解決する際に再利用する（再評価はしない、R-SKL-01「binding の評価後に
   * 戦闘状態が変化しても、同じ sequence 内の当該 binding は再評価しない」）。
   */
  readonly resolvedBindings: ReadonlyMap<TargetBindingId, ResolvedBinding>;
}

export function resolveReference(
  reference: TargetReference,
  resolvedBindings: ReadonlyMap<TargetBindingId, ResolvedBinding>,
  actor: BattleUnit,
  lastResultTargets?: LastResultTargetContext,
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
  if (reference.kind === "LAST_ACTION_TARGETS" || reference.kind === "LAST_DAMAGED_TARGETS") {
    if (lastResultTargets === undefined) {
      throw new DomainValidationError(
        "target.kind",
        `kind "${reference.kind}" requires a LastResultTargetContext (only available once a preceding EffectAction result exists in this resolution scope)`,
      );
    }
    const ids =
      reference.kind === "LAST_ACTION_TARGETS"
        ? lastResultTargets.lastActionTargetUnitIds
        : lastResultTargets.lastDamagedTargetUnitIds;
    const units = ids.map((id) => {
      const unit = lastResultTargets.allUnits.find((candidate) => candidate.battleUnitId === id);
      if (unit === undefined) {
        throw new DomainValidationError(
          "target.kind",
          `kind "${reference.kind}" referenced battleUnitId "${id}" that is not present in allUnits`,
        );
      }
      return unit;
    });
    return { units, includeDefeated: false };
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

/**
 * R-SKL-06 #3〜#4: 対象集合を取得し、対象順・actions定義順に`EffectActionApplication`を
 * 組み立てる。`lastResultTargets`（R-SKL-08）は`LAST_ACTION_TARGETS`/
 * `LAST_DAMAGED_TARGETS`を対象に持つ`ACTION`をJITで解決する場合にだけ必要。
 */
export function resolveActionStepApplications(
  step: Extract<EffectStepDefinition, { kind: "ACTION" }>,
  resolvedBindings: ReadonlyMap<TargetBindingId, ResolvedBinding>,
  actor: BattleUnit,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  lastResultTargets?: LastResultTargetContext,
): readonly EffectActionApplication[] {
  const { units: targets, includeDefeated } = resolveReference(
    step.target,
    resolvedBindings,
    actor,
    lastResultTargets,
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

/** R-SKL-08: conditionのどこかに`LAST_RESULT`が含まれるかどうか（AND/OR/NOTを再帰的に見る）。 */
function conditionReferencesLastResult(condition: ConditionDefinition): boolean {
  switch (condition.kind) {
    case "LAST_RESULT":
      return true;
    case "AND":
    case "OR":
      return condition.conditions.some((c) => conditionReferencesLastResult(c));
    case "NOT":
      return conditionReferencesLastResult(condition.condition);
    default:
      return false;
  }
}

/**
 * Issue #217設計方針A: この`ACTION`stepが、対象・conditionを今すぐ（`targetBindings`
 * 評価直後の時点で）確定できるかどうか。`LAST_RESULT`/`LAST_ACTION_TARGETS`/
 * `LAST_DAMAGED_TARGETS`は、実際に解決がその位置まで進んではじめて値を持つ
 * ため、これらを参照する`ACTION`は`BRANCH`/`RANDOM_BRANCH`/`REPEAT`と同様に
 * `DeferredStepPlan`へ回す。
 */
function isEagerActionStep(
  step: EffectStepDefinition,
): step is Extract<EffectStepDefinition, { kind: "ACTION" }> {
  return (
    step.kind === "ACTION" &&
    !conditionReferencesLastResult(step.condition) &&
    step.target.kind !== "LAST_ACTION_TARGETS" &&
    step.target.kind !== "LAST_DAMAGED_TARGETS"
  );
}

function collectStructuralCandidateTargetUnitIdsForList(
  steps: readonly EffectStepDefinition[],
  resolvedBindings: ReadonlyMap<TargetBindingId, ResolvedBinding>,
  actor: BattleUnit,
): readonly BattleUnitId[] {
  return steps.flatMap((step) =>
    collectStructuralCandidateTargetUnitIds(step, resolvedBindings, actor),
  );
}

/**
 * Issue #217設計方針A: `DeferredStepPlan`となったstep（自身、またはその内側）が
 * 参照し得る対象idを、条件評価や乱数消費を一切行わずに構造だけから列挙する
 * （`TargetsSelected`/`SkillUseStarting`が解決前に`targetUnitIds`を公開できる
 * ようにするための候補集合であり、実際に適用される対象と一致するとは限らない）。
 * `LAST_ACTION_TARGETS`/`LAST_DAMAGED_TARGETS`は計画時点では未確定のため、
 * 何も寄与しない。
 */
function collectStructuralCandidateTargetUnitIds(
  definition: EffectStepDefinition,
  resolvedBindings: ReadonlyMap<TargetBindingId, ResolvedBinding>,
  actor: BattleUnit,
): readonly BattleUnitId[] {
  switch (definition.kind) {
    case "ACTION": {
      if (definition.target.kind === "SELF") {
        return [actor.battleUnitId];
      }
      if (definition.target.kind === "BINDING") {
        const resolved = resolvedBindings.get(definition.target.targetBindingId as TargetBindingId);
        return resolved === undefined ? [] : resolved.units.map((unit) => unit.battleUnitId);
      }
      return [];
    }
    case "BRANCH":
      return [
        ...collectStructuralCandidateTargetUnitIdsForList(
          definition.thenSteps,
          resolvedBindings,
          actor,
        ),
        ...collectStructuralCandidateTargetUnitIdsForList(
          definition.elseSteps,
          resolvedBindings,
          actor,
        ),
      ];
    case "RANDOM_BRANCH":
      return definition.branches.flatMap((branch) =>
        collectStructuralCandidateTargetUnitIdsForList(branch.steps, resolvedBindings, actor),
      );
    case "REPEAT":
      return collectStructuralCandidateTargetUnitIdsForList(
        definition.steps,
        resolvedBindings,
        actor,
      );
  }
}

/**
 * `SkillResolutionService` (`05_ドメインモデル.md`)。R-SKL-01（targetBindings→
 * stepsの定義順評価、conditionによるstep単位のskip）、R-SKL-02（複数対象の定義順
 * 処理）、R-SKL-03（複数ヒットの定義順処理）、R-SKL-06（ACTION stepのcondition
 * 評価・対象取得・action定義順適用の計画）を、実際のダメージ計算やPS/Memory連鎖
 * なしで解決する。`BRANCH`/`RANDOM_BRANCH`/`REPEAT`（R-SKL-07）と`LAST_RESULT`/
 * `LAST_*_TARGETS`に依存する`ACTION`（R-SKL-08）は`DeferredStepPlan`として
 * 生の定義のまま持ち越し、`effect-action-group-resolver.ts`が実行時にJITで
 * 解決する（Issue #217: 実行状態を二重に解釈しないための唯一の情報源）。
 * ダメージ適用自体、およびstep/action単位のイベント発行とPS即時連鎖は
 * 呼び出し側が担う。参照先が`effectActions`に存在しないEffectActionDefinitionIdは、
 * Catalog preflightの不変条件違反として例外を投げる（1ヒット成功として扱わない）。
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
  const addTargetUnitId = (id: BattleUnitId): void => {
    if (!seenTargetUnitIds.has(id)) {
      seenTargetUnitIds.add(id);
      targetUnitIds.push(id);
    }
  };

  // R-SKL-01 #2: stepsを定義順に解決する。
  sequence.steps.forEach((step, stepIndex) => {
    if (!isEagerActionStep(step)) {
      for (const id of collectStructuralCandidateTargetUnitIds(step, resolvedBindings, actor)) {
        addTargetUnitId(id);
      }
      steps.push({ planKind: "DEFERRED", stepIndex, stepKind: step.kind, definition: step });
      return;
    }

    // R-SKL-06 #1〜#2: conditionを評価し、falseならstep全体をスキップする。
    const satisfied = evaluateEffectStepCondition(step.condition);
    if (!satisfied) {
      steps.push({
        planKind: "ACTION_PLAN",
        stepIndex,
        stepKind: "ACTION",
        conditionKind: step.condition.kind,
        satisfied: false,
        actions: step.actions,
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
      addTargetUnitId(application.targetBattleUnitId);
    }
    steps.push({
      planKind: "ACTION_PLAN",
      stepIndex,
      stepKind: "ACTION",
      conditionKind: step.condition.kind,
      satisfied: true,
      actions: step.actions,
      applications,
    });
  });

  return { steps, targetUnitIds, resolvedBindings };
}

/** テスト・呼び出し側がstep構造を無視して、旧来のヒット単位の平坦な順序だけを見たい場合に使う。 */
export function flattenEffectSequencePlan(
  plan: EffectSequencePlan,
): readonly ResolvedEffectApplication[] {
  const result: ResolvedEffectApplication[] = [];
  for (const step of plan.steps) {
    if (step.planKind !== "ACTION_PLAN") {
      continue;
    }
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
 * 同じ定義順解決（R-SKL-01〜03、R-SKL-06〜08の基本形）で処理する。
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
