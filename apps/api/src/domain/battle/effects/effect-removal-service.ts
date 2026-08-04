import { effectCategoriesOf } from "./effect-category-classifier.js";
import {
  cascadedOnlyRemovals,
  orderGroupRemovals,
  removeGroupMembers,
  type LinkedGroupRemoval,
} from "./linked-group-cascade.js";
import { NO_MARKER_INSTANCE_IDS, collectLinkedGroupCascade } from "../model/linked-effect-group.js";
import { requireUnit, type BattleUnit } from "../model/battle-unit.js";
import type { AppliedEffect } from "../model/applied-effect.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { EffectImmunityCategory } from "../../catalog/definitions/catalog-enums.js";
import type {
  ActionId,
  DomainEventId,
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
  /**
   * 1インスタンスの除去ごと（カスケード分もseed分も）に、
   * 次へ進む前にPS/Memoryの即時連鎖へ通知する。詳細は
   * `linked-group-cascade.ts`の`LinkedGroupCascadeContext`を参照。未指定なら
   * 通知せず、呼び出し側がイベント列をまとめて扱う（従来どおりの挙動）。
   */
  readonly onFactEventForPassiveChain?: (
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
  ) => readonly BattleUnit[];
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
  // R-EFF-01/R-EFF-02: 明示的に解除不可（`dispellable: false`）と
  // された効果・永続効果は直接解除の対象にしない。linkedEffectGroupの親解除に伴う
  // cascade（R-EFF-09）はこれとは別扱いで、`dispellable`を問わず巻き込む。
  const matched = target.appliedEffects.filter((effect) => {
    if (effect.duration.definition.dispellable === false) {
      return false;
    }
    const definition = effectActions.get(effect.effectActionDefinitionId);
    return definition !== undefined && matchesCriteria(effect, definition, criteria);
  });
  const capped =
    criteria.maxRemovals !== undefined ? matched.slice(0, criteria.maxRemovals) : matched;

  if (capped.length === 0) {
    return { units, lastEventId: parentEventId, removedCount: 0 };
  }

  // R-EFF-09: 親子の両方が解除カテゴリへ一致した場合、子を独立seedと
  // せず親のcascade対象として扱い、「子を先に（`LINKED_GROUP_CASCADE`/`cascaded:true`）、
  // 親を最後に（`REMOVED`）」の順序・reasonを保証する。ある一致効果は、同じ
  // linkedEffectGroupに一致した非CHILDメンバー（cascade起点になり得る親/ロールなし）が
  // 存在するCHILDロールのとき、root seedから除外する（cascadeが必ず巻き込むため）。
  const hasMatchedParent = (effect: AppliedEffect): boolean => {
    const groupId = effect.duration.definition.linkedEffectGroupId;
    if (groupId === null || effect.duration.definition.linkedEffectGroupRole !== "CHILD") {
      return false;
    }
    return capped.some(
      (candidate) =>
        candidate.effectInstanceId !== effect.effectInstanceId &&
        candidate.duration.definition.linkedEffectGroupId === groupId &&
        candidate.duration.definition.linkedEffectGroupRole !== "CHILD",
    );
  };
  const rootSeeds = capped.filter((effect) => !hasMatchedParent(effect));
  const rootSeedSet = new Set(rootSeeds.map((effect) => effect.effectInstanceId));
  const seedInstances = {
    effectInstanceIds: rootSeedSet,
    markerInstanceIds: NO_MARKER_INSTANCE_IDS,
  };
  // M7-013（Issue #267）: R-EFF-09第1項に従い、解除した親効果と同じ
  // `linkedEffectGroupId`を持つ`MarkerState`も連動解除する（`MarkerRemoved`／
  // `reason: LINKED_GROUP_CASCADE`）。カスケード分の`AppliedEffect`は解除起点に
  // 連なるため`EffectRemoved`で表す（`EffectRemovalReason`）。
  //
  // カスケード分とroot seed分を単一の除去バッチとして
  // 扱い、メンバーごとの`reason`/`cascaded`を保ったまま一度だけrole順へ整列する。
  const cascade = collectLinkedGroupCascade(units, seedInstances);
  const removals = orderGroupRemovals(units, [
    ...cascadedOnlyRemovals(cascade, seedInstances),
    ...rootSeeds.map(
      (effect): LinkedGroupRemoval => ({
        member: { kind: "EFFECT", effectInstanceId: effect.effectInstanceId },
        reason: "REMOVED",
        cascaded: false,
      }),
    ),
  ]);
  const removed = removeGroupMembers(
    context,
    units,
    removals,
    effectActions,
    parentEventId,
    "EffectRemoved",
  );

  // 「解除数」は直接一致で解除したインスタンス数（cascadeで巻き込んだ子効果は含めない）。
  return { units: removed.units, lastEventId: removed.lastEventId, removedCount: capped.length };
}
