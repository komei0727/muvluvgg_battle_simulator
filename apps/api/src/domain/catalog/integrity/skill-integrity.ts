import type { EffectActionDefinitionId } from "../definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../definitions/effect-action-definition.js";
import type { TargetReference } from "../definitions/references.js";
import type { SkillDefinition } from "../definitions/skill-definition.js";
import type {
  TargetFilterDefinition,
  TargetSelectorDefinition,
} from "../definitions/target-selector-definition.js";
import type { EffectStepDefinition } from "../definitions/effect-sequence.js";
import { collectEffectActionReferences } from "../definitions/effect-step-walk.js";
import type { CatalogIntegrityViolation } from "./catalog-integrity-violation.js";
import {
  actionSelectionUnevaluableKindsIn,
  collectConditionEffectActionReferences,
  collectConditionTargetReferencePaths,
  collectTargetStateOrMarkerReferences,
  conditionContainsSelectedTargetState,
  triggerScopedConditionKindIn,
  conditionContainsTriggerSkillUseHit,
  conditionContainsTriggerSkillUseDamage,
} from "./condition-inspection.js";
import {
  collectStepConditionEffectActionReferences,
  triggerScopedConditionKindInSteps,
  stepsContainEventPayloadCondition,
  stepsSomeCondition,
} from "./effect-step-inspection.js";
import {
  validateBranchTargetStateUnboundedReference,
  validateConditionEffectActionReferences,
  validateDamageLinkBindingReferences,
  validateSkillUseAnyHolderParents,
  validateEffectActionReferences,
  validateHitConditionReferences,
  validateGrantedByScope,
  validateMixedStepTargetSetCondition,
} from "./effect-sequence-integrity.js";
import { validateLastResultDataFlow } from "./last-result-data-flow.js";
import {
  buildBindingSelectors,
  targetReferenceIsSingleUnit,
} from "./target-reference-cardinality.js";
import { validateTrigger } from "./trigger-integrity.js";

/**
 * `activationCondition`が参照できる`TargetReference`の種別は、評価する側の実装で
 * skill typeごとに異なる。
 *
 * - AS/EX: `evaluateActivationCondition`（`lifecycle/activation-condition-evaluator.ts`）が
 *   使用者自身（`SELF`）と行動選択時点で解決済みの`BINDING`だけを解決する。行動選択には
 *   トリガーイベントも直前結果も存在しないため、それ以外は実行時に必ず例外になる。
 * - PS: `evaluateTriggerCondition`（`triggering/trigger-condition-evaluator.ts`）の
 *   `resolveTargetReferenceIds`が`SELF`/`TRIGGER_SOURCE`/`TRIGGER_TARGET`/
 *   `TRIGGER_PRIMARY_TARGET`だけを解決する。
 *   `BINDING`はEffectSequence文脈を前提とするため候補判定時には解決できない。
 */
const ACTIVATION_CONDITION_REFERENCE_KINDS: Readonly<
  Record<"ACTION" | "PASSIVE", ReadonlySet<TargetReference["kind"]>>
> = {
  ACTION: new Set(["SELF", "BINDING"]),
  PASSIVE: new Set(["SELF", "TRIGGER_SOURCE", "TRIGGER_TARGET", "TRIGGER_PRIMARY_TARGET"]),
};

/**
 * `activationCondition`のCatalog契約を、実際に評価する側の契約と一致させる
 * （Issue #248）。2つの独立した制約を課す。
 *
 * 1. 参照kind（skill typeごと、`ACTIVATION_CONDITION_REFERENCE_KINDS`）。評価器が
 *    解決できない種別は、Catalogを通過しても行動選択・候補判定の時点で必ず
 *    `DomainValidationError`になる。
 * 2. 対象数（AS/EXのみ）。`evaluateActivationCondition`は`evaluateEffectStepCondition`を
 *    再利用するため、BRANCHの`condition`とまったく同じ「高々1体」制約が効く
 *    （量化規則を発明せずに済む範囲へ意図的に限定している）。PSは
 *    `evaluateTriggerCondition`が解決済み`BattleUnitId`集合へ存在量化するため
 *    複数対象でも評価でき、この制約の対象外とする。
 *
 * 対象数の制約は対象ごとに真偽が変わる4 kind（`TARGET_STATE`/`TARGET_HAS_MARKER`/
 * `TARGET_HAS_EFFECT`/`TARGET_EFFECT_COUNT`。最後はIssue #649が追加した
 * `TARGET_HAS_EFFECT`の個数版）にだけ課す — `TARGET_SET_COUNT`は集合全体を1回だけ
 * 数えるkindであり、複数対象のbindingを参照するのが本来の用途である
 * （production例: `SKL_LYDIA_GENIUS_AS1`/`SKL_ELENA_MOODMAKER_AS1`）。
 */
function validateActivationConditionReferences(
  skill: SkillDefinition,
  violations: CatalogIntegrityViolation[],
): void {
  const activationCondition = skill.activationCondition;
  if (activationCondition === undefined) {
    return;
  }
  const scope = skill.skillType === "PS" ? "PASSIVE" : "ACTION";
  const allowedKinds = ACTIVATION_CONDITION_REFERENCE_KINDS[scope];
  // CHARGEの`activationCondition`は行動選択時に評価されるため、解決される
  // `targetBindings`は開始側（`skill.resolution.targetBindings`、
  // `action-selection-policy.ts`の`resolveAllTargetBindings`が見るもの）だけである。
  // `chargeRelease`側のbindingを混ぜると、解放側にしか無いbindingの参照を通してしまい、
  // 同じIDが両側にある場合は解放側のselectorが開始側の単一対象性を上書きしてしまう。
  const bindingSelectors: ReadonlyMap<string, TargetSelectorDefinition> = buildBindingSelectors(
    skill.resolution.targetBindings,
  );

  for (const { reference, path } of collectConditionTargetReferencePaths(
    activationCondition,
    "activationCondition",
  )) {
    if (!allowedKinds.has(reference.kind)) {
      violations.push({
        targetId: skill.skillDefinitionId,
        rule: "ACTIVATION_CONDITION_UNSUPPORTED_REFERENCE",
        message: `${path}: a ${skill.skillType} activationCondition references TargetReference kind "${reference.kind}", which its evaluator cannot resolve (allowed: ${[...allowedKinds].join("/")} — AS/EX are evaluated at action-selection time with no triggering event, PS candidate detection has no resolved TargetBinding, Issue #248)`,
      });
    }
  }

  if (scope === "PASSIVE") {
    return;
  }
  for (const { reference, path } of collectConditionTargetReferencePaths(
    activationCondition,
    "activationCondition",
  )) {
    if (
      reference.kind === "BINDING" &&
      reference.targetBindingId !== undefined &&
      bindingDraws(reference.targetBindingId, bindingSelectors)
    ) {
      violations.push({
        targetId: skill.skillDefinitionId,
        rule: "ACTIVATION_CONDITION_RANDOM_BINDING",
        message: `${path}: an AS/EX activationCondition references BINDING "${reference.targetBindingId}", which draws its units with order RANDOM — action selection resolves it without drawing (R-TGT-11), so the condition would judge different units than the skill actually targets. Gate on a separate binding that does not draw`,
      });
    }
  }
  for (const { reference, path } of collectTargetStateOrMarkerReferences(
    activationCondition,
    "activationCondition",
  )) {
    if (!targetReferenceIsSingleUnit(reference, bindingSelectors)) {
      violations.push({
        targetId: skill.skillDefinitionId,
        rule: "ACTIVATION_CONDITION_UNBOUNDED_REFERENCE",
        message: `${path}: an AS/EX activationCondition evaluates TARGET_STATE/TARGET_HAS_MARKER/TARGET_HAS_EFFECT/TARGET_EFFECT_COUNT against a TargetReference that is not guaranteed to resolve to at most one unit (only SELF, or a charge-start BINDING whose selector has kind SELECT and count 1, are supported — action-selection evaluation has no per-target context to quantify over multiple units, Issue #248, TARGET_EFFECT_COUNT added by Issue #649)`,
      });
    }
  }
}

/** セレクタが参照する他の束縛（`base`、`EXCLUDE_RESOLVED_UNIT`フィルタ、`fallback`の分も含む）。 */
function referencedBindingIds(selector: TargetSelectorDefinition): readonly string[] {
  const fromFilter = (filter: TargetFilterDefinition): readonly string[] => {
    switch (filter.kind) {
      case "EXCLUDE_RESOLVED_UNIT":
        return filter.reference.kind === "BINDING" && filter.reference.targetBindingId !== undefined
          ? [filter.reference.targetBindingId]
          : [];
      case "AND":
      case "OR":
        return filter.conditions.flatMap(fromFilter);
      case "NOT":
        return fromFilter(filter.condition);
      default:
        return [];
    }
  };
  return [
    ...(selector.base?.kind === "BINDING" && selector.base.targetBindingId !== undefined
      ? [selector.base.targetBindingId]
      : []),
    ...selector.filters.flatMap(fromFilter),
    ...(selector.fallback === undefined ? [] : referencedBindingIds(selector.fallback)),
  ];
}

function selectorOrFallbackDraws(selector: TargetSelectorDefinition): boolean {
  return (
    selector.order.includes("RANDOM") ||
    (selector.fallback !== undefined && selectorOrFallbackDraws(selector.fallback))
  );
}

/**
 * R-TGT-11: その束縛が依存する他の束縛（推移的）のどれかが抽選するか。
 * 自身の抽選は含めない — 自身の候補集合は抽選に依らないため。
 */
function bindingDependsOnDraw(
  targetBindingId: string,
  bindingSelectors: ReadonlyMap<string, TargetSelectorDefinition>,
  visited: ReadonlySet<string> = new Set(),
): boolean {
  const selector = bindingSelectors.get(targetBindingId);
  if (selector === undefined || visited.has(targetBindingId)) {
    return false;
  }
  const nextVisited = new Set([...visited, targetBindingId]);
  return referencedBindingIds(selector).some((referenced) =>
    bindingDraws(referenced, bindingSelectors, nextVisited),
  );
}

/**
 * R-TGT-11: その束縛の結果が抽選に左右されるか。自身（fallback含む）が`RANDOM`を
 * 持つか、参照する束縛（`BINDING_DERIVED`の基準・`EXCLUDE_RESOLVED_UNIT`・推移的）が
 * 抽選する場合に真。
 */
function bindingDraws(
  targetBindingId: string,
  bindingSelectors: ReadonlyMap<string, TargetSelectorDefinition>,
  visited: ReadonlySet<string> = new Set(),
): boolean {
  const selector = bindingSelectors.get(targetBindingId);
  if (selector === undefined || visited.has(targetBindingId)) {
    return false;
  }
  return (
    selectorOrFallbackDraws(selector) ||
    bindingDependsOnDraw(targetBindingId, bindingSelectors, visited)
  );
}

/**
 * R-TGT-11 / R-TGT-10: AS/EXの必須束縛（`optional`でない）は、行動選択が「候補が
 * 1体以上いるか」で発動可否を決める（R-TGT-01 #4）。行動選択は抽選しないため、
 * 抽選する束縛に候補が依存する必須束縛は、判定と実際の解決で候補の有無が食い違い
 * うる。抽選する束縛自身は候補集合が抽選に依らないため対象外とする。CHARGEは行動選択
 * が開始側の束縛だけを見るため、解放側は対象外。
 */
function validateRandomDependentRequiredBindings(
  skill: SkillDefinition,
  violations: CatalogIntegrityViolation[],
): void {
  if (skill.skillType !== "AS" && skill.skillType !== "EX") {
    return;
  }
  const bindingSelectors = buildBindingSelectors(skill.resolution.targetBindings);
  for (const binding of skill.resolution.targetBindings) {
    if (binding.optional === true) {
      continue;
    }
    if (bindingDependsOnDraw(binding.targetBindingId, bindingSelectors)) {
      violations.push({
        targetId: skill.skillDefinitionId,
        rule: "RANDOM_DEPENDENT_REQUIRED_BINDING",
        message: `targetBindings "${binding.targetBindingId}": a required ${skill.skillType} binding depends on a binding that draws with order RANDOM — action selection resolves without drawing (R-TGT-11), so whether it has candidates can differ from the real resolution. Declare it optional: true`,
      });
    }
  }
}

export function validateSkill(
  skill: SkillDefinition,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  violations: CatalogIntegrityViolation[],
): void {
  validateEffectActionReferences(
    skill.resolution.steps,
    effectActions,
    skill.skillDefinitionId,
    violations,
  );
  if (skill.resolution.kind === "CHARGE") {
    validateEffectActionReferences(
      skill.resolution.chargeRelease.steps,
      effectActions,
      skill.skillDefinitionId,
      violations,
    );
  }
  const sequences =
    skill.resolution.kind === "CHARGE"
      ? [skill.resolution, skill.resolution.chargeRelease]
      : [skill.resolution];
  for (const sequence of sequences) {
    validateLastResultDataFlow(sequence.steps, skill.skillDefinitionId, violations);
    validateHitConditionReferences(
      sequence.steps,
      effectActions,
      skill.skillDefinitionId,
      violations,
      { hasTriggeringSkillUse: skill.skillType === "PS" },
    );
    validateMixedStepTargetSetCondition(sequence.steps, skill.skillDefinitionId, violations);
    validateBranchTargetStateUnboundedReference(sequence, skill.skillDefinitionId, violations);
    validateDamageLinkBindingReferences(
      sequence,
      skill.skillDefinitionId,
      effectActions,
      violations,
    );
    validateSkillUseAnyHolderParents(sequence, skill.skillDefinitionId, effectActions, violations);
    validateGrantedByScope(
      sequence,
      skill.activationCondition,
      skill.skillDefinitionId,
      violations,
    );
    validateConditionEffectActionReferences(
      collectStepConditionEffectActionReferences(sequence.steps),
      effectActions,
      skill.skillDefinitionId,
      violations,
    );
  }
  // 条件を置ける残りの位置（`activationCondition`とtrigger群）も同じ規則で走査する。
  if (skill.activationCondition !== undefined) {
    validateConditionEffectActionReferences(
      collectConditionEffectActionReferences(skill.activationCondition),
      effectActions,
      skill.skillDefinitionId,
      violations,
    );
  }
  validateActivationConditionReferences(skill, violations);
  validateRandomDependentRequiredBindings(skill, violations);
  const runtimeTriggers = [
    ...skill.triggers,
    ...skill.counterUpdates.map((counterUpdate) => counterUpdate.trigger),
    ...sequences.flatMap((sequence) =>
      (sequence.counterUpdates ?? []).map((counterUpdate) => counterUpdate.trigger),
    ),
  ];
  for (const trigger of runtimeTriggers) {
    validateConditionEffectActionReferences(
      collectConditionEffectActionReferences(trigger.condition),
      effectActions,
      skill.skillDefinitionId,
      violations,
    );
  }
  // Issue #247 M7-001D: `EVENT_PAYLOAD`はPS発動を引き起こしたトリガーイベントの
  // payloadだけを参照できる（`PassiveActivationRuntime`が
  // `EffectActionGroupContext.triggerEventPayload`へ供給する）。AS/EXの解決
  // （`action-skill-use-resolver.ts`の`resolveSkillUse`）はこのフィールドを一切
  // populateしないため、schemaが受理してもCatalogロード時点で拒否する — 実行時まで
  // 待つと`evaluateEffectStepCondition`が`DomainValidationError`を投げ、行動選択後に
  // 解決が途中で失敗してしまう。
  if (
    (skill.skillType === "AS" || skill.skillType === "EX") &&
    sequences.some((sequence) => stepsContainEventPayloadCondition(sequence.steps))
  ) {
    violations.push({
      targetId: skill.skillDefinitionId,
      rule: "EVENT_PAYLOAD_REQUIRES_PS_SKILL",
      message: `EVENT_PAYLOAD condition requires a PS Skill (the triggering event's payload only exists during a passive activation) — "${skill.skillDefinitionId}" is skillType "${skill.skillType}"`,
    });
  }
  // R-SKL-08: `TRIGGER_SKILL_USE_DAMAGE_*`はPSを発動させたスキル使用の合計を読む。
  // AS/EXには契機のスキル使用が無く、実行時にFormula評価が例外で止まるため、
  // `EVENT_PAYLOAD`と同じくロード時点で拒否する。
  // 条件版`TRIGGER_SKILL_USE_DAMAGE`はPSのresolution step専用で、trigger条件・
  // `activationCondition`・counterUpdatesでは合計が確定していないため拒否する。
  if (
    (skill.skillType !== "PS" &&
      sequences.some((sequence) =>
        sequenceReadsTriggerSkillUseDamage(sequence.steps, effectActions),
      )) ||
    (skill.activationCondition !== undefined &&
      conditionContainsTriggerSkillUseDamage(skill.activationCondition)) ||
    [...skill.triggers, ...skill.counterUpdates.map((counterUpdate) => counterUpdate.trigger)].some(
      (trigger) => conditionContainsTriggerSkillUseDamage(trigger.condition),
    )
  ) {
    violations.push({
      targetId: skill.skillDefinitionId,
      rule: "TRIGGER_SKILL_USE_DAMAGE_REQUIRES_PS_SKILL",
      message: `TRIGGER_SKILL_USE_DAMAGE(_*) is only evaluable while a PS resolves its steps (only a passive activation has a finished triggering skill use) — "${skill.skillDefinitionId}" (skillType "${skill.skillType}") declares it elsewhere`,
    });
  }
  // R-PS-01: trigger専用kind（`DAMAGE_MAX_HP_RATIO`・`HP_RATIO_CROSSED`）は
  // `TriggerDefinition.condition`専用。
  // `EVENT_PAYLOAD`と違い`effect-step-condition-evaluator.ts`が処理しないため、PSの
  // resolution stepへ置かれてもロードは通るのに発動中の解決が例外で失敗し、AS/EXの
  // `activationCondition`も行動選択（`evaluateActivationCondition`）が同じstep評価器で
  // 解決するため戦闘が停止する。skillTypeを問わず、すべてのresolution step位置と
  // `activationCondition`から拒否する。
  const stepScopedKind = sequences
    .map((sequence) => triggerScopedConditionKindInSteps(sequence.steps))
    .find((kind) => kind !== undefined);
  if (stepScopedKind !== undefined) {
    violations.push({
      targetId: skill.skillDefinitionId,
      rule: `${stepScopedKind}_REQUIRES_TRIGGER`,
      message: `a ${stepScopedKind} condition is trigger-scoped (TriggerDefinition.condition only) — the EffectStep evaluator cannot resolve it, so "${skill.skillDefinitionId}" would fail at resolution time`,
    });
  }
  const activationScopedKind =
    skill.activationCondition !== undefined
      ? triggerScopedConditionKindIn(skill.activationCondition)
      : undefined;
  if (activationScopedKind !== undefined) {
    violations.push({
      targetId: skill.skillDefinitionId,
      rule: `${activationScopedKind}_REQUIRES_TRIGGER`,
      message: `a ${activationScopedKind} condition is trigger-scoped (TriggerDefinition.condition only) — an activationCondition cannot resolve it, so "${skill.skillDefinitionId}" would fail at action selection`,
    });
  }
  // R-ACT-02: AS/EXの`activationCondition`は行動選択時にEffectStep評価器で評価される。
  // 評価器が扱えないkindはロードを通すと行動選択で例外になるため、ロード時点で拒否する。
  const unevaluableKinds =
    (skill.skillType === "AS" || skill.skillType === "EX") &&
    skill.activationCondition !== undefined
      ? actionSelectionUnevaluableKindsIn(skill.activationCondition)
      : [];
  if (unevaluableKinds.length > 0) {
    violations.push({
      targetId: skill.skillDefinitionId,
      rule: "ACTIVATION_CONDITION_UNEVALUABLE_KIND",
      message: `an ${skill.skillType} activationCondition is evaluated at action selection, which cannot evaluate condition kind ${unevaluableKinds.map((kind) => `"${kind}"`).join("/")} — "${skill.skillDefinitionId}" would fail when its unit selects an action. To gate on how many units are alive, declare an optional targetBinding that selects them and compare its size with TARGET_SET_COUNT instead`,
    });
  }
  // R-PS-09: `SELECTED_TARGET_STATE`はPSの発動判定（trigger条件・PSの
  // `activationCondition`）専用。step評価器とAS/EXの行動選択は処理しないため、
  // ロードを通すと解決中・行動選択中に例外で止まる。
  if (
    sequences.some((sequence) =>
      stepsSomeCondition(sequence.steps, conditionContainsSelectedTargetState),
    ) ||
    (skill.skillType !== "PS" &&
      skill.activationCondition !== undefined &&
      conditionContainsSelectedTargetState(skill.activationCondition))
  ) {
    violations.push({
      targetId: skill.skillDefinitionId,
      rule: "SELECTED_TARGET_STATE_REQUIRES_PS_TRIGGER",
      message: `a SELECTED_TARGET_STATE condition is only evaluable in a PS trigger condition or a PS activationCondition — "${skill.skillDefinitionId}" declares it in a resolution step or an ${skill.skillType} activationCondition`,
    });
  }
  // R-PS-04: `TRIGGER_SKILL_USE_HIT`・`TRIGGER_SKILL_USE_TARGET`はPSの候補検出・発動直前確認（trigger条件・PSの
  // `activationCondition`）専用。counterUpdatesの契機判定は命中・処理対象を受け取らない。
  if (
    sequences.some((sequence) =>
      stepsSomeCondition(sequence.steps, conditionContainsTriggerSkillUseHit),
    ) ||
    (skill.skillType !== "PS" &&
      skill.activationCondition !== undefined &&
      conditionContainsTriggerSkillUseHit(skill.activationCondition)) ||
    (skill.skillType !== "PS" &&
      skill.triggers.some((trigger) => conditionContainsTriggerSkillUseHit(trigger.condition))) ||
    skill.counterUpdates.some((counterUpdate) =>
      conditionContainsTriggerSkillUseHit(counterUpdate.trigger.condition),
    )
  ) {
    violations.push({
      targetId: skill.skillDefinitionId,
      rule: "TRIGGER_SKILL_USE_HIT_REQUIRES_PS_TRIGGER",
      message: `a TRIGGER_SKILL_USE_HIT / TRIGGER_SKILL_USE_TARGET condition is only evaluable in a PS trigger condition or a PS activationCondition — "${skill.skillDefinitionId}" declares it elsewhere`,
    });
  }
  for (const trigger of skill.triggers) {
    validateTrigger(trigger, skill.skillDefinitionId, violations);
  }
  for (const counterUpdate of skill.counterUpdates) {
    validateTrigger(counterUpdate.trigger, skill.skillDefinitionId, violations);
  }
}

/** `value`（payload）のどこかが`TRIGGER_SKILL_USE_DAMAGE_*`を参照するか。 */
function readsTriggerSkillUseDamage(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(readsTriggerSkillUseDamage);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Object.entries(value).some(([key, child]) =>
    key === "sourceResult" && typeof child === "string"
      ? child.startsWith("TRIGGER_SKILL_USE_DAMAGE_")
      : readsTriggerSkillUseDamage(child),
  );
}

/**
 * ACTION stepが参照するEffectAction（DAMAGEの`hitConfirmedEffects`を含む）と、
 * step条件の`TRIGGER_SKILL_USE_DAMAGE`のどちらかが契機スキル使用の合計を読むか。
 */
function sequenceReadsTriggerSkillUseDamage(
  steps: readonly EffectStepDefinition[],
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
): boolean {
  const referenced = collectEffectActionReferences(steps).flatMap((reference) => {
    const action = effectActions.get(reference.effectActionDefinitionId);
    if (action === undefined) {
      return [];
    }
    const confirmed =
      action.kind === "DAMAGE"
        ? (action.payload.hitConfirmedEffects ?? []).flatMap((effect) => {
            const granted = effectActions.get(effect.effectActionDefinitionId);
            return granted === undefined ? [] : [granted];
          })
        : [];
    return [action, ...confirmed];
  });
  return (
    referenced.some((action) => readsTriggerSkillUseDamage(action.payload)) ||
    stepsSomeCondition(steps, conditionContainsTriggerSkillUseDamage)
  );
}
