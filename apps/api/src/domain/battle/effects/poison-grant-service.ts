import {
  grantEffect,
  type GrantEffectContext,
  type GrantEffectRequest,
} from "./effect-grant-service.js";
import {
  CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY,
  effectKindKeyFromDefinitionId,
  type AppliedEffect,
} from "../model/applied-effect.js";
import { requireUnit, type BattleUnit } from "../model/battle-unit.js";
import { toEffectSnapshot } from "../events/state-delta.js";
import type { DomainEventId } from "../../shared/event-ids.js";

export interface GrantPoisonResult {
  readonly units: readonly BattleUnit[];
  readonly appliedEffect: AppliedEffect;
  readonly lastEventId: DomainEventId;
}

/** R-DOT-04の比較に使う「効果量」。統合では毒ダメージを決める2値を一組で採用する。 */
interface PoisonMagnitude {
  /** 付与時に評価した割合ダメージ（`現在HP × 毒効果率`）。 */
  readonly magnitude: number;
  /** R-DOT-01の付与時攻撃力＝R-DOT-04の上限ダメージ。 */
  readonly snapshotAttack: number;
}

function poisonMagnitudeOf(effect: AppliedEffect): PoisonMagnitude {
  return {
    magnitude: effect.magnitude,
    snapshotAttack: effect.snapshot?.[CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY] ?? 0,
  };
}

/**
 * R-DOT-04「効果量は大きい方を引き継ぐ」の比較。毒の1回あたりダメージは
 * `min(現在HP × 毒効果率, 付与時攻撃力)`（`continuous-damage-service.ts`の
 * `calculateContinuousDamage`）であり、`現在HP`は両候補に共通のため、
 * この`min`そのものが「効果量」の単調な尺度になる。付与時点の対象HPで
 * 評価した`magnitude`を両者とも持っているので、同じ式でそのまま比較できる。
 *
 * 割合と上限は同じ付与元から来た一組として採用する — R-DOT-04が別々の付与元から
 * 採用してよいと述べているのは「期間」と「効果量」の2つであり、効果量を構成する
 * 割合と上限をさらに分解して混ぜてよいとは述べていない。
 */
function poisonTickOf(candidate: PoisonMagnitude): number {
  return Math.min(candidate.magnitude, candidate.snapshotAttack);
}

/**
 * R-DOT-04「既存の毒へ再付与した場合、効果期間は長い方、効果量は大きい方を
 * 引き継いだ一つの毒を残す。期間と効果量は別々の付与元から採用できる」。
 *
 * `grantStunStatus`（R-STS-02）と同じく、Q-EFF-10の既定「再付与は常に新規
 * インスタンスを追加する」を毒固有の規則で上書きし、既存インスタンスを更新する。
 * 気絶と違い比較軸が2つあるため、期間と効果量をそれぞれ独立に採用し、両方とも
 * 既存側が勝った場合だけ変化なし（イベントを発行しない）とする。
 *
 * 「既存の毒」は保持者が持つ毒インスタンス全体から探す（`EffectKindKey`単位では
 * ない）— R-DOT-04は付与元スキルを限定しておらず、別スキル由来の毒との統合も
 * 対象だからである。R-DOT-04の統合により毒は常に高々1つしか存在しない。
 */
export function grantPoisonContinuousDamage(
  context: GrantEffectContext,
  units: readonly BattleUnit[],
  request: GrantEffectRequest,
  parentEventId: DomainEventId,
): GrantPoisonResult {
  const target = requireUnit(units, request.targetId);
  const existing = target.appliedEffects.find(
    (effect) => effect.continuousDamage?.continuousDamageKind === "POISON",
  );

  if (existing === undefined) {
    return grantEffect(context, units, request, parentEventId);
  }

  const existingMagnitude = poisonMagnitudeOf(existing);
  const incomingMagnitude: PoisonMagnitude = {
    magnitude: request.magnitude,
    snapshotAttack: request.snapshot?.[CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY] ?? 0,
  };
  const takeIncomingMagnitude = poisonTickOf(incomingMagnitude) > poisonTickOf(existingMagnitude);

  const existingRemaining = existing.duration.timeLimitRemaining ?? 0;
  const incomingRemaining = request.durationDefinition.timeLimit?.count ?? 0;
  const takeIncomingDuration = incomingRemaining > existingRemaining;

  if (!takeIncomingMagnitude && !takeIncomingDuration) {
    // `marker-apply-service.ts`のKEEP_EXISTINGと同じ「変化が無ければイベントを
    // 発行しない」規約。呼び出し側は`resultKind: SKIPPED`として記録する。
    return { units, appliedEffect: existing, lastEventId: parentEventId };
  }

  const adoptedMagnitude = takeIncomingMagnitude ? incomingMagnitude : existingMagnitude;
  // 効果量側の採用元は、割合を決める効果定義と付与者・付与時攻撃力を一組で運ぶ。
  // 付与者はどちらか一方だけを持つ（R-MEM-04）ため、差し替える場合は
  // `sourceId`/`sourceSide`の両方を採用元のものへ入れ替える。
  const {
    sourceId: _existingSourceId,
    sourceSide: _existingSourceSide,
    ...existingWithoutSource
  } = existing;
  const magnitudeSource = takeIncomingMagnitude
    ? {
        effectActionDefinitionId: request.definition.effectActionDefinitionId,
        kindKey: effectKindKeyFromDefinitionId(request.definition.effectActionDefinitionId),
        ...(request.sourceId !== undefined ? { sourceId: request.sourceId } : {}),
        ...(request.sourceSide !== undefined ? { sourceSide: request.sourceSide } : {}),
      }
    : {
        effectActionDefinitionId: existing.effectActionDefinitionId,
        kindKey: existing.kindKey,
        ...(existing.sourceId !== undefined ? { sourceId: existing.sourceId } : {}),
        ...(existing.sourceSide !== undefined ? { sourceSide: existing.sourceSide } : {}),
      };
  const nextEffect: AppliedEffect = {
    ...existingWithoutSource,
    ...magnitudeSource,
    magnitude: adoptedMagnitude.magnitude,
    snapshot: { [CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY]: adoptedMagnitude.snapshotAttack },
    duration: takeIncomingDuration
      ? {
          ...existing.duration,
          definition: request.durationDefinition,
          timeLimitRemaining: incomingRemaining,
          // R-EFF-04の初回減算除外は「今この行動で付与された」ことを表すため、
          // 期間を差し替えた側の付与時点（＝この行動）で更新する。
          ...(context.actionId !== undefined ? { grantedActionId: context.actionId } : {}),
          grantedTurnNumber: context.turnNumber,
        }
      : existing.duration,
  };

  const nextUnits = units.map((unit) =>
    unit.battleUnitId === request.targetId
      ? {
          ...unit,
          appliedEffects: unit.appliedEffects.map((effect) =>
            effect.effectInstanceId === existing.effectInstanceId ? nextEffect : effect,
          ),
        }
      : unit,
  );

  const merged = context.recorder.record({
    eventType: "EffectMerged",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
    resolutionScopeId: context.resolutionScopeId,
    parentEventId,
    rootEventId: context.rootEventId,
    ...(request.sourceId !== undefined ? { sourceUnitId: request.sourceId } : {}),
    ...(request.sourceSide !== undefined ? { sourceSide: request.sourceSide } : {}),
    targetUnitIds: [request.targetId],
    payload: {
      effectInstanceId: existing.effectInstanceId,
      battleUnitId: request.targetId,
      effectActionDefinitionId: nextEffect.effectActionDefinitionId,
      reason: "POISON_REAPPLY",
      magnitudeBefore: existingMagnitude.magnitude,
      magnitudeAfter: adoptedMagnitude.magnitude,
      snapshotAttackBefore: existingMagnitude.snapshotAttack,
      snapshotAttackAfter: adoptedMagnitude.snapshotAttack,
      remainingBefore: existingRemaining,
      remainingAfter: nextEffect.duration.timeLimitRemaining ?? 0,
    },
    stateDelta: {
      units: {
        [request.targetId]: {
          effects: {
            [existing.effectInstanceId]: {
              before: toEffectSnapshot(existing, true),
              after: toEffectSnapshot(nextEffect, true),
            },
          },
        },
      },
    },
  });

  return { units: nextUnits, appliedEffect: nextEffect, lastEventId: merged.eventId };
}
