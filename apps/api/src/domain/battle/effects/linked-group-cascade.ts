import { recalculateCombatStats } from "./combat-stat-recalculation-service.js";
import { selectEffectiveInstances } from "../model/effective-effect-selector.js";
import { requireUnit, type BattleUnit } from "../model/battle-unit.js";
import { toEffectSnapshot, toMarkerSnapshot } from "../events/state-delta.js";
import type { LinkedGroupInstances, LinkedGroupMember } from "../model/linked-effect-group.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type {
  ActionId,
  DomainEventId,
  EffectInstanceId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";

/**
 * `duration-expiry-service.ts`の`ExpireEffectsContext`・
 * `marker-removal-service.ts`の`RemoveMarkersContext`・
 * `effect-removal-service.ts`の`RemoveEffectsContext`・
 * `freeze-removal-service.ts`の`RemoveFreezeStepsContext`が共通に持つ形。
 * この4経路すべてがR-EFF-09のカスケードを同じ実装で行うため、依存方向を
 * 一方向（各サービス→本モジュール）に保つためここで独立に宣言する
 * （madgeの循環依存検査は型のみのimportも辺として数えるため）。
 */
export interface LinkedGroupCascadeContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
}

/**
 * `AppliedEffect`のカスケード失効を表すイベント種別。自然失効の起点（時間制限・
 * 消費・特殊失効・凍結解除）に連なるカスケードは`EffectExpired`、`REMOVE_EFFECTS`
 * による能動的な解除に連なるカスケードは`EffectRemoved`で表す
 * （`domain-event.ts`の`EffectRemovalReason`コメント）。
 */
export type CascadedEffectEventType = "EffectExpired" | "EffectRemoved";

export interface LinkedGroupCascadeStep {
  readonly events: readonly BattleDomainEvent[];
  /** このステップ完了直後（`yield`時点）の`units` — `.next()`へ渡す基点として使う。 */
  readonly units: readonly BattleUnit[];
}

export interface LinkedGroupCascadeResult {
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
 * R-EFF-09「同時失効では、子効果を先に失効させ、最後に親効果を失効させる」:
 * `cascade`（`collectLinkedGroupCascade`の結果。seed自身も含む）から`seeds`を
 * 除いた「カスケードだけで巻き込まれたメンバー」を、`AppliedEffect`→`MarkerState`
 * の順に並べる。同種別内の順序は`units`の保持順（付与順）とする。
 *
 * 種別間で`AppliedEffect`を先に置くのは、production Catalogのcross-typeグループ
 * （`UNIT_TARISA_TROUBLEMAKER`の「負けん気」・`UNIT_AOI_ELEGANT`の「高揚」）が
 * いずれもMarkerを`PARENT`、`AppliedEffect`を`CHILD`とするため — 「子を先に」を
 * 実際の親子関係と一致させる。`AppliedEffect`が`PARENT`のグループでは、
 * cascadeで巻き込まれる側は定義上すべて子であり、種別間の相対順は
 * R-EFF-09の規定に触れない（どちらも親より前に発行される）。
 */
export function orderCascadedOnlyMembers(
  units: readonly BattleUnit[],
  cascade: LinkedGroupInstances,
  seeds: LinkedGroupInstances,
): readonly LinkedGroupMember[] {
  const effects: LinkedGroupMember[] = [];
  const markers: LinkedGroupMember[] = [];
  for (const unit of units) {
    for (const effect of unit.appliedEffects) {
      if (
        cascade.effectInstanceIds.has(effect.effectInstanceId) &&
        !seeds.effectInstanceIds.has(effect.effectInstanceId)
      ) {
        effects.push({ kind: "EFFECT", effectInstanceId: effect.effectInstanceId });
      }
    }
    for (const marker of unit.markerStates) {
      if (
        cascade.markerInstanceIds.has(marker.markerInstanceId) &&
        !seeds.markerInstanceIds.has(marker.markerInstanceId)
      ) {
        markers.push({ kind: "MARKER", markerInstanceId: marker.markerInstanceId });
      }
    }
  }
  return [...effects, ...markers];
}

/**
 * `orderCascadedOnlyMembers`が並べたカスケード対象を順に除去し、種別ごとの
 * イベント（`AppliedEffect`は`effectEventType`、`MarkerState`は`MarkerRemoved`）を
 * `reason: LINKED_GROUP_CASCADE`／`cascaded: true`で発行する。`AppliedEffect`の
 * 除去直後は`recalculateCombatStats`（R-EFF-05の次点繰上げ・R-STA-04の再計算）を
 * 呼ぶ。`MarkerState`はCombatStatへ直接寄与しないため呼ばない
 * （`marker-removal-service.ts`のseed経路と同じ扱い）。
 *
 * 各メンバーの除去を記録した直後に`yield`する generator — `freeze-removal-service.ts`
 * が要求する「1ステップごとにPS/Memoryの即時連鎖へ通知する」経路（PR #237
 * 再指摘[P2]）と、通知を伴わない他3経路の両方から同じ実装を再利用できるように
 * するため、通知方法を持たない。呼び出し側が各yieldの直後に
 * `.next(externallyMutatedUnits)`で外部変化を注入すれば、次のステップはその状態を
 * 前提に進む。yieldを必要としない呼び出し側は`removeCascadedMembers`を使う。
 */
export function* removeCascadedMembersSteps(
  context: LinkedGroupCascadeContext,
  units: readonly BattleUnit[],
  members: readonly LinkedGroupMember[],
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  parentEventId: DomainEventId,
  effectEventType: CascadedEffectEventType,
): Generator<LinkedGroupCascadeStep, LinkedGroupCascadeResult, readonly BattleUnit[] | undefined> {
  let working = units;
  let lastEventId = parentEventId;

  for (const member of members) {
    const stepEventsStart = context.recorder.getEvents().length;
    const holder = working.find((unit) =>
      member.kind === "EFFECT"
        ? unit.appliedEffects.some((effect) => effect.effectInstanceId === member.effectInstanceId)
        : unit.markerStates.some((marker) => marker.markerInstanceId === member.markerInstanceId),
    );
    if (holder === undefined) {
      // Already removed by an earlier step in this same batch (e.g. a
      // duplicate seed/cascade reference) — nothing left to expire.
      continue;
    }
    const target = requireUnit(working, holder.battleUnitId);

    if (member.kind === "MARKER") {
      const targetMarker = target.markerStates.find(
        (marker) => marker.markerInstanceId === member.markerInstanceId,
      )!;
      working = working.map((unit) =>
        unit.battleUnitId === target.battleUnitId
          ? {
              ...unit,
              markerStates: unit.markerStates.filter(
                (marker) => marker.markerInstanceId !== member.markerInstanceId,
              ),
            }
          : unit,
      );
      const removed = context.recorder.record({
        eventType: "MarkerRemoved",
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
          markerInstanceId: member.markerInstanceId,
          markerId: targetMarker.markerId,
          targetUnitId: target.battleUnitId,
          reason: "LINKED_GROUP_CASCADE",
          linkedEffectGroupId: targetMarker.duration.definition.linkedEffectGroupId,
          cascaded: true,
        },
        stateDelta: {
          units: {
            [target.battleUnitId]: {
              markers: {
                [member.markerInstanceId]: {
                  before: toMarkerSnapshot(targetMarker),
                  after: undefined,
                },
              },
            },
          },
        },
      });
      lastEventId = removed.eventId;
    } else {
      const targetEffect = target.appliedEffects.find(
        (effect) => effect.effectInstanceId === member.effectInstanceId,
      )!;
      const wasEffective = isEffectiveNow(target, member.effectInstanceId);
      const beforeRemovalUnits = working;
      working = working.map((unit) =>
        unit.battleUnitId === target.battleUnitId
          ? {
              ...unit,
              appliedEffects: unit.appliedEffects.filter(
                (effect) => effect.effectInstanceId !== member.effectInstanceId,
              ),
            }
          : unit,
      );
      const removed = context.recorder.record({
        eventType: effectEventType,
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
          effectInstanceId: member.effectInstanceId,
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
                [member.effectInstanceId]: {
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
        target.battleUnitId,
        effectActions,
        lastEventId,
        effectEventType === "EffectExpired" ? "EFFECT_EXPIRED" : "EFFECT_REMOVED",
      );
      working = recalculation.units;
      lastEventId = recalculation.lastEventId;
    }

    const injected = yield {
      events: context.recorder.getEvents().slice(stepEventsStart),
      units: working,
    };
    if (injected !== undefined) {
      working = injected;
    }
  }

  return { units: working, lastEventId };
}

/**
 * `removeCascadedMembersSteps`をステップ通知なしで駆動する薄いwrapper。
 * `duration-expiry-service.ts`／`marker-removal-service.ts`／
 * `effect-removal-service.ts`（いずれも呼び出し側がカスケード全体の完了後に
 * まとめてイベント列を扱う経路）が使う。
 */
export function removeCascadedMembers(
  context: LinkedGroupCascadeContext,
  units: readonly BattleUnit[],
  members: readonly LinkedGroupMember[],
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  parentEventId: DomainEventId,
  effectEventType: CascadedEffectEventType,
): LinkedGroupCascadeResult {
  const steps = removeCascadedMembersSteps(
    context,
    units,
    members,
    effectActions,
    parentEventId,
    effectEventType,
  );
  let step = steps.next();
  while (!step.done) {
    step = steps.next(step.value.units);
  }
  return step.value;
}
