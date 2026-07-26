import { effectCategoriesOf } from "./effect-category-classifier.js";
import { selectEffectiveInstances } from "../model/effective-effect-selector.js";
import { requireUnit, type BattleUnit } from "../model/battle-unit.js";
import { toEffectSnapshot } from "../events/state-delta.js";
import type { AppliedEffect, EffectImmunityState } from "../model/applied-effect.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { EffectImmunityCategory } from "../../catalog/definitions/catalog-enums.js";
import type { StatusKind } from "../../catalog/definitions/effect-action-payload.js";
import type {
  ActionId,
  DomainEventId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";

/**
 * R-EFF-03（M7-001B、Issue #243）: これから付与しようとしている効果の候補。
 * まだ`AppliedEffect`として存在しないため、`grantEffect`/`applyMarker`へ渡す
 * 直前の値（`magnitude`/`statusKind`）と、`SPECIFIC_EFFECT`一致判定に使う
 * `effectActionDefinitionId`だけを持つ。
 */
export interface ImmunityBlockCandidate {
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly magnitude: number;
  readonly statusKind?: StatusKind;
}

/**
 * `category`単独が候補をブロックするかどうかを判定する。`immunity.statusKinds`
 * が指定されている場合（`categories`が`STATUS`を含むことが前提、Catalog
 * factoryが強制する）、候補が状態異常（`isStatusAilment`、R-STS-01により
 * `STATUS`と`DEBUFF`の両方に分類される）であれば、一致したカテゴリが`STATUS`
 * 自身か`DEBUFF`かに関わらず`statusKinds`一覧で絞り込む — `DEBUFF`側の一致を
 * 経由した迂回を防ぐ（PR #245レビュー[P2]指摘）。候補が状態異常でない
 * （通常のstat debuff等）場合は`DEBUFF`が無条件でブロックする（従来の粒度）。
 */
function categoryBlocks(
  category: EffectImmunityCategory,
  immunity: EffectImmunityState,
  candidate: ImmunityBlockCandidate,
  candidateIsStatusAilment: boolean,
): boolean {
  const isAilmentClassifiedCategory =
    category === "STATUS" || (category === "DEBUFF" && candidateIsStatusAilment);
  if (isAilmentClassifiedCategory && immunity.statusKinds !== undefined) {
    return (
      candidate.statusKind !== undefined && immunity.statusKinds.includes(candidate.statusKind)
    );
  }
  return true;
}

/**
 * R-EFF-03「無効効果が有効な間は、対象カテゴリの新規付与を拒否する」:
 * `target`が保持する`AppliedEffect`のうち、`candidate`の新規付与を拒否する
 * 有効な`EFFECT_IMMUNITY`由来インスタンスを1件返す（複数一致する場合は
 * 付与順で最初に見つかったもの、`appliedEffects`配列順）。`maxBlocks`に
 * 達した免疫はもう拒否しない（`duration`自体の失効・解除とは独立）。
 */
export function findBlockingImmunity(
  target: Pick<BattleUnit, "appliedEffects">,
  candidate: ImmunityBlockCandidate,
  definition: EffectActionDefinition,
): AppliedEffect | undefined {
  const categories = effectCategoriesOf(candidate, definition);
  const candidateIsStatusAilment = categories.has("STATUS");
  return target.appliedEffects.find((effect) => {
    const immunity = effect.immunity;
    if (immunity === undefined) {
      return false;
    }
    if (immunity.maxBlocks !== null && immunity.blockedCount >= immunity.maxBlocks) {
      return false;
    }
    if (
      immunity.categories.includes("SPECIFIC_EFFECT") &&
      immunity.effectActionDefinitionIds?.includes(candidate.effectActionDefinitionId) === true
    ) {
      return true;
    }
    return immunity.categories.some(
      (category) =>
        category !== "SPECIFIC_EFFECT" &&
        categories.has(category) &&
        categoryBlocks(category, immunity, candidate, candidateIsStatusAilment),
    );
  });
}

/** 免疫が実際に1件ブロックした後、そのインスタンスの`blockedCount`を1増やす。 */
export function incrementImmunityBlockedCount(effect: AppliedEffect): AppliedEffect {
  if (effect.immunity === undefined) {
    return effect;
  }
  return {
    ...effect,
    immunity: { ...effect.immunity, blockedCount: effect.immunity.blockedCount + 1 },
  };
}

export interface RejectEffectApplicationContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
}

export interface RejectEffectApplicationRequest {
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly sourceId: BattleUnitId;
  readonly targetId: BattleUnitId;
  readonly blockingEffect: AppliedEffect;
  /** TGT-004フェーズ3と同じ規約: 拒否対象が`APPLY_STATUS`由来の場合だけ持つ。 */
  readonly statusKind?: StatusKind;
}

export interface RejectEffectApplicationResult {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
}

/**
 * R-EFF-03「付与拒否もドメインイベントとして記録できるものとする」:
 * `findBlockingImmunity`が見つけた免疫インスタンスの`blockedCount`を1増やし、
 * `EffectApplicationRejected`を発行する。実際に新しい`AppliedEffect`は作らない
 * （`EffectApplied`は発行しない）ため、`grantEffect`とは異なりCombatStat再計算も
 * 行わない（`blockedCount`はどのCombatStatにも影響しない）。
 */
export function rejectEffectApplication(
  context: RejectEffectApplicationContext,
  units: readonly BattleUnit[],
  request: RejectEffectApplicationRequest,
  parentEventId: DomainEventId,
): RejectEffectApplicationResult {
  const target = requireUnit(units, request.targetId);
  const before = request.blockingEffect;
  const after = incrementImmunityBlockedCount(before);
  const isEffective = selectEffectiveInstances(target.appliedEffects).has(before.effectInstanceId);

  const nextUnits = units.map((unit) =>
    unit.battleUnitId === request.targetId
      ? {
          ...unit,
          appliedEffects: unit.appliedEffects.map((effect) =>
            effect.effectInstanceId === before.effectInstanceId ? after : effect,
          ),
        }
      : unit,
  );

  const rejected = context.recorder.record({
    eventType: "EffectApplicationRejected",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
    resolutionScopeId: context.resolutionScopeId,
    parentEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: request.sourceId,
    targetUnitIds: [request.targetId],
    payload: {
      battleUnitId: request.targetId,
      effectActionDefinitionId: request.effectActionDefinitionId,
      sourceUnitId: request.sourceId,
      blockingEffectInstanceId: before.effectInstanceId,
      reason: "IMMUNITY",
      ...(request.statusKind !== undefined ? { statusKind: request.statusKind } : {}),
    },
    stateDelta: {
      units: {
        [request.targetId]: {
          effects: {
            [before.effectInstanceId]: {
              before: toEffectSnapshot(before, isEffective),
              after: toEffectSnapshot(after, isEffective),
            },
          },
        },
      },
    },
  });

  return { units: nextUnits, lastEventId: rejected.eventId };
}
