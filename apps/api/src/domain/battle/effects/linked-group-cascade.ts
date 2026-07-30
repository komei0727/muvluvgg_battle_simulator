import { recalculateCombatStats } from "./combat-stat-recalculation-service.js";
import { selectEffectiveInstances } from "../model/effective-effect-selector.js";
import { requireUnit, type BattleUnit } from "../model/battle-unit.js";
import { toEffectSnapshot, toMarkerSnapshot } from "../events/state-delta.js";
import type { LinkedGroupInstances, LinkedGroupMember } from "../model/linked-effect-group.js";
import type { LinkedEffectGroupRole } from "../../catalog/definitions/duration-definition.js";
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
  /**
   * PR #280レビュー[P1]: 1メンバーの除去（イベント記録＋CombatStat再計算）ごとに、
   * 次のメンバーへ進む前にPS/Memoryの即時連鎖へ通知する
   * （`08_ドメインイベント.md`「各イベントに対応するPS/Memory候補を直ちに解決する」）。
   * まとめて最後に通知すると、子の`EffectExpired`をtriggerにするPSが、イベント順では
   * まだ存在する親Marker／親効果を既に除去済みとして観測してしまう。
   * `freeze-removal-service.ts`の`RemoveFreezeContext`と同じ形・同じ役割で、
   * 未指定なら通知しない（呼び出し側がgenerator経由で自分で駆動する経路）。
   */
  readonly onFactEventForPassiveChain?: (
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
  ) => readonly BattleUnit[];
}

/**
 * `eventsStart`以降に記録されたイベントを順に`onFactEventForPassiveChain`へ渡し、
 * PS/Memory連鎖が書き換えた`units`を返す（callback未指定なら`units`をそのまま返す）。
 * カスケード分（`removeCascadedMembers`）とseed分（各サービスの除去ループ）が
 * 同じ粒度・同じ手順で通知するための共有ヘルパー。
 *
 * callbackを持たない経路（PS自身のEffectSequence解決が`passive-activation-service.ts`
 * から委譲される経路）は、`freeze-removal-service.ts`の`removeFreezeEffectSteps`と
 * 同じく`expireEffectsSteps`が`yield`するステップをdriverへ渡す設計であり、
 * そちらの粒度はdriver側が決める（PR #280再レビュー[P1]でダメージpipelineの
 * 消費失効フックもこのステップ型へ移行した）。
 */
export function notifyRemovalStep(
  context: LinkedGroupCascadeContext,
  units: readonly BattleUnit[],
  eventsStart: number,
): readonly BattleUnit[] {
  if (context.onFactEventForPassiveChain === undefined) {
    return units;
  }
  let working = units;
  for (const event of context.recorder.getEvents().slice(eventsStart)) {
    working = context.onFactEventForPassiveChain(event, working);
  }
  return working;
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
 * `linkedEffectGroupRole`から失効順の優先度を導く。R-EFF-09「同時失効では、子効果を
 * 先に失効させ、最後に親効果を失効させる」を、ロールを持たない（レガシー、対称
 * カスケード）メンバーを挟んだ3段で表す。
 */
function cascadeOrderTier(role: LinkedEffectGroupRole | undefined): number {
  if (role === "CHILD") {
    return 0;
  }
  return role === "PARENT" ? 2 : 1;
}

/**
 * R-EFF-09「同時失効では、子効果を先に失効させ、最後に親効果を失効させる」を、
 * 同じ除去バッチのseed列（呼び出し側が渡した`ExpirationSeed`／`MarkerRemovalSeed`
 * ／解除対象`AppliedEffect`）へも適用する。
 *
 * PR #280再レビュー[P2]: ロール順の整列を`orderCascadedOnlyMembers`（カスケード分）
 * だけに適用していたため、同じグループの`PARENT`と`CHILD`が同一ターン／行動で
 * 同時に0になった場合（どちらもseedになり、カスケード分には含まれない）、
 * `units`／`changes`の並び次第で`PARENT`の失効イベントが先に発行され得た。
 *
 * 安定ソートのため、同じtier内では呼び出し側が渡した順（減算・消費が検出した順）が
 * そのまま保たれる。
 */
export function sortSeedsByCascadeOrder<T>(
  seeds: readonly T[],
  roleOf: (seed: T) => LinkedEffectGroupRole | undefined,
): readonly T[] {
  if (seeds.length < 2) {
    return seeds;
  }
  return [...seeds].sort(
    (left, right) => cascadeOrderTier(roleOf(left)) - cascadeOrderTier(roleOf(right)),
  );
}

/**
 * R-EFF-09「同時失効では、子効果を先に失効させ、最後に親効果を失効させる」:
 * `cascade`（`collectLinkedGroupCascade`の結果。seed自身も含む）から`seeds`を
 * 除いた「カスケードだけで巻き込まれたメンバー」を失効順に並べる。
 *
 * 第1キーは`linkedEffectGroupRole`（`CHILD`→ロールなし→`PARENT`）。PR #280
 * レビュー[P2]: 以前は種別（`AppliedEffect`→`MarkerState`）と保持順だけで並べて
 * いたため、スキーマが禁じていない「同一グループに複数の`PARENT`」を持つ定義では、
 * カスケードされた`PARENT`が同グループの`CHILD`より先に失効し得た（例: Markerの
 * `PARENT`をseedにし、同グループに`AppliedEffect`の`PARENT`とMarkerの`CHILD`が
 * ある場合）。ロールを第1キーにすることで、グループあたりのPARENT数を
 * Catalog整合性検証で縛らずにR-EFF-09の順序契約を満たす。
 *
 * 第2キーは種別（`AppliedEffect`→`MarkerState`）、第3キーは`units`の保持順
 * （付与順）。同じtier内の相対順はR-EFF-09の規定に触れないが、イベント列を
 * 決定的にするため固定する。
 */
export function orderCascadedOnlyMembers(
  units: readonly BattleUnit[],
  cascade: LinkedGroupInstances,
  seeds: LinkedGroupInstances,
): readonly LinkedGroupMember[] {
  const ordered: { readonly member: LinkedGroupMember; readonly tier: number }[] = [];
  for (const unit of units) {
    for (const effect of unit.appliedEffects) {
      if (
        cascade.effectInstanceIds.has(effect.effectInstanceId) &&
        !seeds.effectInstanceIds.has(effect.effectInstanceId)
      ) {
        ordered.push({
          member: { kind: "EFFECT", effectInstanceId: effect.effectInstanceId },
          tier: cascadeOrderTier(effect.duration.definition.linkedEffectGroupRole),
        });
      }
    }
  }
  for (const unit of units) {
    for (const marker of unit.markerStates) {
      if (
        cascade.markerInstanceIds.has(marker.markerInstanceId) &&
        !seeds.markerInstanceIds.has(marker.markerInstanceId)
      ) {
        ordered.push({
          member: { kind: "MARKER", markerInstanceId: marker.markerInstanceId },
          tier: cascadeOrderTier(marker.duration.definition.linkedEffectGroupRole),
        });
      }
    }
  }
  // `Array.prototype.sort`は安定ソートのため、同じtier内では上で積んだ順
  // （種別→保持順）がそのまま保たれる。
  return ordered.sort((left, right) => left.tier - right.tier).map((entry) => entry.member);
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
 * `removeCascadedMembersSteps`を`context.onFactEventForPassiveChain`（あれば）で
 * 同期的に駆動する薄いwrapper（`freeze-removal-service.ts`の`removeFreezeEffect`と
 * 同じ形）。`duration-expiry-service.ts`／`marker-removal-service.ts`／
 * `effect-removal-service.ts`が使う。callbackが無い場合はステップ通知なしで
 * 最後まで進める（呼び出し側がイベント列をまとめて扱う経路）。
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
    let currentUnits = step.value.units;
    if (context.onFactEventForPassiveChain !== undefined) {
      for (const event of step.value.events) {
        currentUnits = context.onFactEventForPassiveChain(event, currentUnits);
      }
    }
    step = steps.next(currentUnits);
  }
  return step.value;
}
