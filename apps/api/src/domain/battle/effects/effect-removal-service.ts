import { effectCategoriesOf } from "./effect-category-classifier.js";
import { recalculateCombatStats } from "./combat-stat-recalculation-service.js";
import { collectLinkedGroupCascade } from "../model/applied-effect-linked-group.js";
import { selectEffectiveInstances } from "../model/effective-effect-selector.js";
import { requireUnit, type BattleUnit } from "../model/battle-unit.js";
import { toEffectSnapshot } from "../events/state-delta.js";
import type { AppliedEffect } from "../model/applied-effect.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { EffectRemovalReason } from "../events/domain-event.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { EffectImmunityCategory } from "../../catalog/definitions/catalog-enums.js";
import type {
  ActionId,
  DomainEventId,
  EffectInstanceId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";

export interface RemoveEffectsContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
}

/**
 * R-EFF-02「解除」の解除条件。`categories`（`SPECIFIC_EFFECT`を含みうる）と
 * `SPECIFIC_EFFECT`用の`effectActionDefinitionIds`、および`maxRemovals`
 * （`REMOVE_EFFECTS_COUNT_LIMIT`、省略時は該当全件）を持つ。
 */
export interface EffectRemovalCriteria {
  readonly categories: readonly EffectImmunityCategory[];
  readonly effectActionDefinitionIds?: readonly EffectActionDefinitionId[];
  readonly maxRemovals?: number;
}

export interface RemoveEffectsResult {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
  /** 直接一致で解除したインスタンス数（R-EFF-02 #3の「解除数」。cascade分は含めない）。 */
  readonly removedCount: number;
}

/**
 * R-EFF-02 #2「バフ、デバフ、状態異常、シールドなど一致する効果を抽出する」:
 * ある`AppliedEffect`が解除条件`criteria`に一致するかを判定する。`SPECIFIC_EFFECT`は
 * `effectActionDefinitionId`の直接一致で、その他のカテゴリは
 * `effectCategoriesOf`が返す固有カテゴリとの積集合で判定する。
 */
function matchesCriteria(
  effect: AppliedEffect,
  definition: EffectActionDefinition,
  criteria: EffectRemovalCriteria,
): boolean {
  if (
    criteria.categories.includes("SPECIFIC_EFFECT") &&
    criteria.effectActionDefinitionIds?.includes(effect.effectActionDefinitionId)
  ) {
    return true;
  }
  const intrinsic = effectCategoriesOf(effect, definition);
  return criteria.categories.some(
    (category) => category !== "SPECIFIC_EFFECT" && intrinsic.has(category),
  );
}

/**
 * R-EFF-02「解除」#1〜#5: `REMOVE_EFFECTS`の即時効果として、`targetId`が保持する
 * `AppliedEffect`のうち`criteria`に一致するものを解除する。`duration-expiry-service.ts`
 * の`expireEffects`と同じ構造だが、失効（時間制限・消費）ではなく能動的な解除で
 * あるため`EffectRemoved`（`reason: REMOVED`）を発行する。R-EFF-02 #3の「解除数」は
 * `maxRemovals`で制限し、一致した効果を付与順（古い順、`appliedEffects`配列順）で
 * 先頭から採用する。R-EFF-09に従い、解除した効果と同じ`linkedEffectGroupId`を持つ
 * 子効果は`cascaded: true`/`reason: LINKED_GROUP_CASCADE`で連動解除する
 * （子を先に、親を後に）。各インスタンス除去直後に`recalculateCombatStats`
 * （`reason: EFFECT_REMOVED`）でR-EFF-05の次点繰上げとR-STA-04の再計算を反映する。
 */
export function removeEffects(
  context: RemoveEffectsContext,
  units: readonly BattleUnit[],
  targetId: BattleUnitId,
  criteria: EffectRemovalCriteria,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  parentEventId: DomainEventId,
): RemoveEffectsResult {
  const target = requireUnit(units, targetId);

  // #1〜#3: 一致する効果を付与順で抽出し、maxRemovalsで解除数を制限する。
  const matchedSeeds: EffectInstanceId[] = [];
  for (const effect of target.appliedEffects) {
    const definition = effectActions.get(effect.effectActionDefinitionId);
    if (definition === undefined) {
      continue;
    }
    if (matchesCriteria(effect, definition, criteria)) {
      matchedSeeds.push(effect.effectInstanceId);
    }
  }
  const seedIds =
    criteria.maxRemovals !== undefined ? matchedSeeds.slice(0, criteria.maxRemovals) : matchedSeeds;

  if (seedIds.length === 0) {
    return { units, lastEventId: parentEventId, removedCount: 0 };
  }

  // R-EFF-09: 直接解除した効果に連動する子効果をカスケード対象に含める。
  const seedIdSet = new Set(seedIds);
  const cascadeIds = collectLinkedGroupCascade(units, seedIdSet);
  const reasonById = new Map<
    EffectInstanceId,
    { reason: EffectRemovalReason; cascaded: boolean }
  >();
  for (const id of seedIds) {
    reasonById.set(id, { reason: "REMOVED", cascaded: false });
  }
  const cascadedOnlyOrdered: EffectInstanceId[] = [];
  for (const unit of units) {
    for (const effect of unit.appliedEffects) {
      if (cascadeIds.has(effect.effectInstanceId) && !seedIdSet.has(effect.effectInstanceId)) {
        cascadedOnlyOrdered.push(effect.effectInstanceId);
        reasonById.set(effect.effectInstanceId, {
          reason: "LINKED_GROUP_CASCADE",
          cascaded: true,
        });
      }
    }
  }
  const orderedInstanceIds = [...cascadedOnlyOrdered, ...seedIds];

  let working = units;
  let lastEventId = parentEventId;

  for (const effectInstanceId of orderedInstanceIds) {
    const holder = working.find((unit) =>
      unit.appliedEffects.some((effect) => effect.effectInstanceId === effectInstanceId),
    );
    if (holder === undefined) {
      continue;
    }
    const holderUnit = requireUnit(working, holder.battleUnitId);
    const targetEffect = holderUnit.appliedEffects.find(
      (effect) => effect.effectInstanceId === effectInstanceId,
    )!;
    const wasEffective = selectEffectiveInstances(
      holderUnit.appliedEffects.map((effect) => ({
        effectInstanceId: effect.effectInstanceId,
        kindKey: effect.kindKey,
        duplicate: effect.duplicate,
        magnitude: effect.magnitude,
      })),
    ).has(effectInstanceId);

    const beforeRemovalUnits = working;
    working = working.map((unit) =>
      unit.battleUnitId === holderUnit.battleUnitId
        ? {
            ...unit,
            appliedEffects: unit.appliedEffects.filter(
              (effect) => effect.effectInstanceId !== effectInstanceId,
            ),
          }
        : unit,
    );

    const info = reasonById.get(effectInstanceId)!;
    const removed = context.recorder.record({
      eventType: "EffectRemoved",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: lastEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: holderUnit.battleUnitId,
      targetUnitIds: [holderUnit.battleUnitId],
      payload: {
        effectInstanceId,
        battleUnitId: holderUnit.battleUnitId,
        effectActionDefinitionId: targetEffect.effectActionDefinitionId,
        kindKey: targetEffect.kindKey,
        reason: info.reason,
        linkedEffectGroupId: targetEffect.duration.definition.linkedEffectGroupId,
        cascaded: info.cascaded,
      },
      stateDelta: {
        units: {
          [holderUnit.battleUnitId]: {
            effects: {
              [effectInstanceId]: {
                before: toEffectSnapshot(targetEffect, wasEffective),
                after: undefined,
              },
            },
          },
        },
      },
    });
    lastEventId = removed.eventId;

    const recalculation = recalculateCombatStats(
      {
        recorder: context.recorder,
        turnNumber: context.turnNumber,
        cycleNumber: context.cycleNumber,
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
        resolutionScopeId: context.resolutionScopeId,
        rootEventId: context.rootEventId,
      },
      beforeRemovalUnits,
      working,
      holderUnit.battleUnitId,
      effectActions,
      lastEventId,
      "EFFECT_REMOVED",
    );
    working = recalculation.units;
    lastEventId = recalculation.lastEventId;
  }

  return { units: working, lastEventId, removedCount: seedIds.length };
}
