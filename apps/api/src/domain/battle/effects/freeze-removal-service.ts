import { recalculateCombatStats } from "./combat-stat-recalculation-service.js";
import { collectLinkedGroupCascade } from "../model/applied-effect-linked-group.js";
import { selectEffectiveInstances } from "../model/effective-effect-selector.js";
import { requireUnit, type BattleUnit } from "../model/battle-unit.js";
import { toEffectSnapshot } from "../events/state-delta.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type {
  ActionId,
  DomainEventId,
  EffectInstanceId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";

export interface RemoveFreezeContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
}

export interface RemoveFreezeResult {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
}

function isEffectiveNow(unit: BattleUnit, effectInstanceId: EffectInstanceId): boolean {
  return selectEffectiveInstances(
    unit.appliedEffects.map((effect) => ({
      effectInstanceId: effect.effectInstanceId,
      kindKey: effect.kindKey,
      duplicate: effect.duplicate,
      magnitude: effect.magnitude,
    })),
  ).has(effectInstanceId);
}

/**
 * R-STS-03「新たな攻撃スキルによるダメージで解除する」＋R-EFF-09
 * （`linkedEffectGroupId`カスケード）: 凍結`AppliedEffect`を`FreezeRemoved`
 * （`triggeringDamage`付き）として除去する。`duration-expiry-service.ts`の
 * `expireEffects`と同じ`collectLinkedGroupCascade`を使い、同じ
 * `linkedEffectGroupId`を共有する未失効の子効果があれば同じ順序（子を先に、
 * 親を最後に）・同じイベント形（`EffectExpired`/`reason: LINKED_GROUP_CASCADE`、
 * `recalculateCombatStats`）でカスケード除去する。凍結自身の除去だけが
 * `FreezeRemoved`（R-STS-03固有の事実）で、カスケード分は`expireEffects`と
 * 区別しない — `EffectExpired`のまま。
 */
export function removeFreezeEffect(
  context: RemoveFreezeContext,
  units: readonly BattleUnit[],
  targetUnitId: BattleUnitId,
  freezeEffectInstanceId: EffectInstanceId,
  triggeringDamage: number,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  parentEventId: DomainEventId,
): RemoveFreezeResult {
  const cascadeIds = collectLinkedGroupCascade(units, new Set([freezeEffectInstanceId]));
  // R-EFF-09「子を先に、親を最後に」: `collectLinkedGroupCascade`はseed自身も
  // 含む集合を返すため、凍結自身を末尾へ回し、残り（カスケードで見つかった
  // 子効果）を先に処理する。
  const cascadedOnlyIds = [...cascadeIds].filter((id) => id !== freezeEffectInstanceId);
  const orderedInstanceIds = [...cascadedOnlyIds, freezeEffectInstanceId];

  let working = units;
  let lastEventId = parentEventId;

  for (const effectInstanceId of orderedInstanceIds) {
    const holder = working.find((unit) =>
      unit.appliedEffects.some((effect) => effect.effectInstanceId === effectInstanceId),
    );
    if (holder === undefined) {
      // Already removed earlier in this same cascade batch.
      continue;
    }
    const target = requireUnit(working, holder.battleUnitId);
    const targetEffect = target.appliedEffects.find(
      (effect) => effect.effectInstanceId === effectInstanceId,
    )!;
    const wasEffective = isEffectiveNow(target, effectInstanceId);

    const beforeRemovalUnits = working;
    working = working.map((unit) =>
      unit.battleUnitId === target.battleUnitId
        ? {
            ...unit,
            appliedEffects: unit.appliedEffects.filter(
              (effect) => effect.effectInstanceId !== effectInstanceId,
            ),
          }
        : unit,
    );

    const isFreezeItself = effectInstanceId === freezeEffectInstanceId;
    const recorded = isFreezeItself
      ? context.recorder.record({
          eventType: "FreezeRemoved",
          category: "FACT",
          turnNumber: context.turnNumber,
          cycleNumber: context.cycleNumber,
          ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
          ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
          resolutionScopeId: context.resolutionScopeId,
          parentEventId: lastEventId,
          rootEventId: context.rootEventId,
          sourceUnitId: target.battleUnitId,
          targetUnitIds: [target.battleUnitId],
          payload: {
            effectInstanceId,
            battleUnitId: target.battleUnitId,
            triggeringDamage,
          },
          stateDelta: {
            units: {
              [target.battleUnitId]: {
                effects: {
                  [effectInstanceId]: {
                    before: toEffectSnapshot(targetEffect, wasEffective),
                    after: undefined,
                  },
                },
              },
            },
          },
        })
      : context.recorder.record({
          eventType: "EffectExpired",
          category: "FACT",
          turnNumber: context.turnNumber,
          cycleNumber: context.cycleNumber,
          ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
          ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
          resolutionScopeId: context.resolutionScopeId,
          parentEventId: lastEventId,
          rootEventId: context.rootEventId,
          sourceUnitId: target.battleUnitId,
          targetUnitIds: [target.battleUnitId],
          payload: {
            effectInstanceId,
            battleUnitId: target.battleUnitId,
            effectActionDefinitionId: targetEffect.effectActionDefinitionId,
            kindKey: targetEffect.kindKey,
            reason: "LINKED_GROUP_CASCADE",
            linkedEffectGroupId: targetEffect.duration.definition.linkedEffectGroupId,
            cascaded: true,
          },
          stateDelta: {
            units: {
              [target.battleUnitId]: {
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
    lastEventId = recorded.eventId;

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
      target.battleUnitId,
      effectActions,
      lastEventId,
      "EFFECT_EXPIRED",
    );
    working = recalculation.units;
    lastEventId = recalculation.lastEventId;
  }

  return { units: working, lastEventId };
}
