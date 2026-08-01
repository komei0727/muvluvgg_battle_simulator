import { recalculateCombatStats } from "./combat-stat-recalculation-service.js";
import { selectEffectiveInstances } from "../model/effective-effect-selector.js";
import { requireUnit, type BattleUnit } from "../model/battle-unit.js";
import { toEffectSnapshot, toMarkerSnapshot } from "../events/state-delta.js";
import { linkedGroupMemberKey, type LinkedGroupMemberKey } from "../model/linked-effect-group.js";
import type { LinkedGroupInstances, LinkedGroupMember } from "../model/linked-effect-group.js";
import type { LinkedEffectGroupRole } from "../../catalog/definitions/duration-definition.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type {
  BattleDomainEvent,
  EffectExpirationReason,
  EffectRemovalReason,
  MarkerRemovalReason,
} from "../events/domain-event.js";
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
 * 除去バッチの1メンバーと、そのメンバー固有の失効・解除理由。
 *
 * PR #280再々レビュー[P2]: カスケード分とseed分を別々のリストとして順に処理して
 * いたため、除去バッチ**全体**ではR-EFF-09の「子を先に、親を最後に」が崩れていた
 * （同一グループに複数`PARENT`がある合法な定義で、非seedの`PARENT`がカスケード分
 * として先に失効し、その後でseedの`CHILD`が失効し得た）。両者を単一のリストへ
 * まとめ、メンバーごとの`reason`/`cascaded`を保持したまま一度だけrole順へ整列する。
 */
export interface LinkedGroupRemoval {
  readonly member: LinkedGroupMember;
  /**
   * `EffectExpirationReason`／`EffectRemovalReason`／`MarkerRemovalReason`のいずれか。
   * 3つのunionの和は`MarkerRemovalReason`（`REMOVED`＋失効4種）に一致する。
   * `AppliedEffect`側は`effectEventType`と組み合わせて`asEffectExpirationReason`／
   * `asEffectRemovalReason`で狭める。
   */
  readonly reason: MarkerRemovalReason;
  readonly cascaded: boolean;
}

/**
 * `EffectExpired`が運べる理由の閉じたリスト。`MarkerRemovalReason`のうち、
 * `REMOVED`は`EffectRemoved`固有の理由であり（`domain-event.ts`の
 * `EffectRemovalReason`）、`SOURCE_DEFEATED`は`MarkerState`だけが持つ解除契機
 * （M7-020、Issue #279）であるため含まない。
 */
const EFFECT_EXPIRATION_REASONS: readonly EffectExpirationReason[] = [
  "TIME_LIMIT",
  "CONSUMPTION",
  "EXPIRATION_CONDITION",
  "SHIELD_DEPLETED",
  "SUBUNIT_DEPLETED",
  "LINKED_GROUP_CASCADE",
];

/**
 * `EffectExpired`が運べる理由へ狭める。`effectEventType`が`EffectExpired`の
 * 呼び出し（期間満了・消費・特殊失効・凍結解除）が上記以外を渡すことはないため、
 * 到達したら呼び出し側の配線ミスとして明確に失敗させる。除外リストではなく
 * 許可リストで判定するのは、`MarkerRemovalReason`へMarker固有の理由が増えても
 * 自動的に拒否側へ落ちるようにするため。
 */
function asEffectExpirationReason(reason: MarkerRemovalReason): EffectExpirationReason {
  const allowed = EFFECT_EXPIRATION_REASONS.find((candidate) => candidate === reason);
  if (allowed === undefined) {
    throw new Error(
      `EffectExpired cannot carry reason "${reason}" — only MarkerState carries REMOVED (active removal) and SOURCE_DEFEATED (granter defeated, R-EFF-10 M7-020); see domain-event.ts`,
    );
  }
  return allowed;
}

/** `EffectRemoved`が運べる理由へ狭める（`asEffectExpirationReason`と対）。 */
function asEffectRemovalReason(reason: MarkerRemovalReason): EffectRemovalReason {
  if (reason !== "REMOVED" && reason !== "LINKED_GROUP_CASCADE") {
    throw new Error(
      `EffectRemoved cannot carry reason "${reason}" — natural expiration reasons belong to EffectExpired (domain-event.ts)`,
    );
  }
  return reason;
}

function memberOrderKey(units: readonly BattleUnit[]): (member: LinkedGroupMember) => {
  readonly tier: number;
  readonly typeRank: number;
  readonly index: number;
} {
  const effectIndex = new Map<LinkedGroupMemberKey, number>();
  const markerIndex = new Map<LinkedGroupMemberKey, number>();
  const roleByKey = new Map<LinkedGroupMemberKey, LinkedEffectGroupRole | undefined>();
  for (const unit of units) {
    for (const effect of unit.appliedEffects) {
      const key = linkedGroupMemberKey({
        kind: "EFFECT",
        effectInstanceId: effect.effectInstanceId,
      });
      effectIndex.set(key, effectIndex.size);
      roleByKey.set(key, effect.duration.definition.linkedEffectGroupRole);
    }
    for (const marker of unit.markerStates) {
      const key = linkedGroupMemberKey({
        kind: "MARKER",
        markerInstanceId: marker.markerInstanceId,
      });
      markerIndex.set(key, markerIndex.size);
      roleByKey.set(key, marker.duration.definition.linkedEffectGroupRole);
    }
  }
  return (member) => {
    const key = linkedGroupMemberKey(member);
    return {
      tier: cascadeOrderTier(roleByKey.get(key)),
      typeRank: member.kind === "EFFECT" ? 0 : 1,
      index: (member.kind === "EFFECT" ? effectIndex.get(key) : markerIndex.get(key)) ?? 0,
    };
  };
}

/**
 * R-EFF-09「同時失効では、子効果を先に失効させ、最後に親効果を失効させる」:
 * 除去バッチ（カスケードで巻き込まれたメンバー＋呼び出し側が確定させたseed）を
 * 単一の失効順へ並べる。
 *
 * 第1キーは`linkedEffectGroupRole`（`CHILD`→ロールなし→`PARENT`）。PR #280
 * レビュー[P2]: スキーマは同一グループの複数`PARENT`を禁じていないため、ロールを
 * 第1キーにすることでグループあたりのPARENT数をCatalog整合性検証で縛らずに
 * R-EFF-09の順序契約を満たす。第2キーはカスケード分か`seeds`か（カスケード分が
 * 先 — ロールを持たないレガシーグループではこれが唯一の親子情報）。第3キーは
 * 種別（`AppliedEffect`→`MarkerState`）、第4キーは`units`の保持順（付与順）。
 * 第3・第4キーはR-EFF-09の規定に触れないが、イベント列を決定的にするため固定する。
 */
export function orderGroupRemovals(
  units: readonly BattleUnit[],
  removals: readonly LinkedGroupRemoval[],
): readonly LinkedGroupRemoval[] {
  if (removals.length < 2) {
    return removals;
  }
  const keyOf = memberOrderKey(units);
  return [...removals].sort((left, right) => {
    const a = keyOf(left.member);
    const b = keyOf(right.member);
    return (
      a.tier - b.tier ||
      // 同じロール階層内では、カスケードで巻き込まれたメンバーをseedより先に置く。
      // ロールを持たない（レガシー、対称カスケード）グループではこれが唯一の
      // 親子情報 — 直接失効が確定した`seeds`を「親」、そこから引き込まれた側を
      // 「子」として扱う従来の順序（`UT-R-EFF-09-005`）を保つ。
      Number(right.cascaded) - Number(left.cascaded) ||
      a.typeRank - b.typeRank ||
      a.index - b.index
    );
  });
}

/**
 * `collectLinkedGroupCascade`の結果（seed自身も含む）から`seeds`を除いた
 * 「カスケードだけで巻き込まれたメンバー」を`LinkedGroupRemoval`（
 * `reason: LINKED_GROUP_CASCADE`／`cascaded: true`）として列挙する。
 */
export function cascadedOnlyRemovals(
  cascade: LinkedGroupInstances,
  seeds: LinkedGroupInstances,
): readonly LinkedGroupRemoval[] {
  const removals: LinkedGroupRemoval[] = [];
  for (const effectInstanceId of cascade.effectInstanceIds) {
    if (!seeds.effectInstanceIds.has(effectInstanceId)) {
      removals.push({
        member: { kind: "EFFECT", effectInstanceId },
        reason: "LINKED_GROUP_CASCADE",
        cascaded: true,
      });
    }
  }
  for (const markerInstanceId of cascade.markerInstanceIds) {
    if (!seeds.markerInstanceIds.has(markerInstanceId)) {
      removals.push({
        member: { kind: "MARKER", markerInstanceId },
        reason: "LINKED_GROUP_CASCADE",
        cascaded: true,
      });
    }
  }
  return removals;
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
export function* removeGroupMembersSteps(
  context: LinkedGroupCascadeContext,
  units: readonly BattleUnit[],
  removals: readonly LinkedGroupRemoval[],
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  parentEventId: DomainEventId,
  effectEventType: CascadedEffectEventType,
): Generator<LinkedGroupCascadeStep, LinkedGroupCascadeResult, readonly BattleUnit[] | undefined> {
  let working = units;
  let lastEventId = parentEventId;

  for (const { member, reason, cascaded } of removals) {
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
          reason,
          linkedEffectGroupId: targetMarker.duration.definition.linkedEffectGroupId,
          cascaded,
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
      const effectPayload = {
        effectInstanceId: member.effectInstanceId,
        battleUnitId: target.battleUnitId,
        effectActionDefinitionId: targetEffect.effectActionDefinitionId,
        kindKey: targetEffect.kindKey,
        linkedEffectGroupId: targetEffect.duration.definition.linkedEffectGroupId,
        cascaded,
      };
      const effectStateDelta = {
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
      };
      const effectEnvelope = {
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
      } as const;
      const removed =
        effectEventType === "EffectExpired"
          ? context.recorder.record({
              eventType: "EffectExpired",
              ...effectEnvelope,
              payload: { ...effectPayload, reason: asEffectExpirationReason(reason) },
              stateDelta: effectStateDelta,
            })
          : context.recorder.record({
              eventType: "EffectRemoved",
              ...effectEnvelope,
              payload: { ...effectPayload, reason: asEffectRemovalReason(reason) },
              stateDelta: effectStateDelta,
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
export function removeGroupMembers(
  context: LinkedGroupCascadeContext,
  units: readonly BattleUnit[],
  removals: readonly LinkedGroupRemoval[],
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  parentEventId: DomainEventId,
  effectEventType: CascadedEffectEventType,
): LinkedGroupCascadeResult {
  const steps = removeGroupMembersSteps(
    context,
    units,
    removals,
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
