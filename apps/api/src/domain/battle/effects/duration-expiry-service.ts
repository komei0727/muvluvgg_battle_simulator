import { recalculateCombatStats } from "./combat-stat-recalculation-service.js";
import { collectLinkedGroupCascade } from "../model/applied-effect-linked-group.js";
import { selectEffectiveInstances } from "../model/effective-effect-selector.js";
import { requireUnit, type BattleUnit } from "../model/battle-unit.js";
import { toEffectSnapshot } from "../events/state-delta.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { EffectExpirationReason } from "../events/domain-event.js";
import type { ConsumptionChange, EffectDurationChange } from "../model/applied-effect-duration.js";
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

export interface ExpireEffectsContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
}

/**
 * R-EFF-04/06/07/08: 効果インスタンスが自身の時間制限・消費・特殊失効条件に
 * よって直接失効した契機。R-EFF-09のcascadeで巻き込まれる子効果自身の理由
 * (`LINKED_GROUP_CASCADE`)はこの型に呼び出し側が含めない — `expireEffects`が
 * cascade分を自動導出する。
 */
export type ExpirationSeedReason = Exclude<EffectExpirationReason, "LINKED_GROUP_CASCADE">;

export interface ExpirationSeed {
  readonly battleUnitId: BattleUnitId;
  readonly effectInstanceId: EffectInstanceId;
  readonly reason: ExpirationSeedReason;
}

export interface ExpireEffectsResult {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
}

/**
 * R-EFF-04/06: `decrementActionEffectDurations`/`decrementTurnEffectDurations`が
 * 返した`changes`（0になる減算も含む）ごとに`EffectDurationReduced`を発行する
 * （`CooldownReduced`と同じ「減算そのものを独立Reducer復元可能にする」役割）。
 * `units`は減算適用後の状態を渡す — 各インスタンスの`isEffective`（R-EFF-05）は
 * 純粋な残り回数の減算では変化しないため、現在の状態から1回だけ導出し、
 * `before`スナップショットは`duration.remaining`だけを`change.before`へ
 * 差し替えて構築する。`changes`が空の場合は`parentEventId`をそのまま返す。
 */
export function emitEffectDurationReducedEvents(
  context: ExpireEffectsContext,
  units: readonly BattleUnit[],
  changes: readonly EffectDurationChange[],
  parentEventId: DomainEventId,
): DomainEventId {
  let lastEventId = parentEventId;
  for (const change of changes) {
    const holder = requireUnit(units, change.battleUnitId);
    const targetEffect = holder.appliedEffects.find(
      (effect) => effect.effectInstanceId === change.effectInstanceId,
    )!;
    const isEffective = selectEffectiveInstances(
      holder.appliedEffects.map((effect) => ({
        effectInstanceId: effect.effectInstanceId,
        kindKey: effect.kindKey,
        duplicate: effect.duplicate,
        magnitude: effect.magnitude,
      })),
    ).has(change.effectInstanceId);
    const afterSnapshot = toEffectSnapshot(targetEffect, isEffective);

    const reduced = context.recorder.record({
      eventType: "EffectDurationReduced",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: lastEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: change.battleUnitId,
      targetUnitIds: [change.battleUnitId],
      payload: {
        effectInstanceId: change.effectInstanceId,
        battleUnitId: change.battleUnitId,
        unit: change.unit,
        before: change.before,
        after: change.after,
      },
      stateDelta: {
        units: {
          [change.battleUnitId]: {
            effects: {
              [change.effectInstanceId]: {
                before: {
                  ...afterSnapshot,
                  duration: { ...afterSnapshot.duration!, remaining: change.before },
                },
                after: afterSnapshot,
              },
            },
          },
        },
      },
    });
    lastEventId = reduced.eventId;
  }
  return lastEventId;
}

/**
 * R-EFF-07: `consumeEffectDurations`が返した`changes`（0になる消費も含む）
 * ごとに`EffectConsumptionChanged`を発行する。`emitEffectDurationReducedEvents`
 * と同じ形 — `isEffective`は消費では変化しないため現在の状態から1回だけ導出し、
 * `before`スナップショットは`consumptionRemaining`だけを`change.before`へ
 * 差し替えて構築する。`changes`が空の場合は`parentEventId`をそのまま返す。
 */
export function emitEffectConsumptionChangedEvents(
  context: ExpireEffectsContext,
  units: readonly BattleUnit[],
  changes: readonly ConsumptionChange[],
  parentEventId: DomainEventId,
): DomainEventId {
  let lastEventId = parentEventId;
  for (const change of changes) {
    const holder = requireUnit(units, change.battleUnitId);
    const targetEffect = holder.appliedEffects.find(
      (effect) => effect.effectInstanceId === change.effectInstanceId,
    )!;
    const isEffective = selectEffectiveInstances(
      holder.appliedEffects.map((effect) => ({
        effectInstanceId: effect.effectInstanceId,
        kindKey: effect.kindKey,
        duplicate: effect.duplicate,
        magnitude: effect.magnitude,
      })),
    ).has(change.effectInstanceId);
    const afterSnapshot = toEffectSnapshot(targetEffect, isEffective);

    const changed = context.recorder.record({
      eventType: "EffectConsumptionChanged",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: lastEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: change.battleUnitId,
      targetUnitIds: [change.battleUnitId],
      payload: {
        effectInstanceId: change.effectInstanceId,
        battleUnitId: change.battleUnitId,
        kind: change.kind,
        before: change.before,
        after: change.after,
      },
      stateDelta: {
        units: {
          [change.battleUnitId]: {
            effects: {
              [change.effectInstanceId]: {
                before: { ...afterSnapshot, consumptionRemaining: change.before },
                after: afterSnapshot,
              },
            },
          },
        },
      },
    });
    lastEventId = changed.eventId;
  }
  return lastEventId;
}

/**
 * `08_ドメインイベント.md`「EffectExpiredの順序」/R-EFF-09: 呼び出し側が直接
 * 失効を確定させた`seeds`（時間制限・消費・特殊失効のいずれか）から、同じ
 * `linkedEffectGroupId`を共有する子効果を`collectLinkedGroupCascade`で
 * カスケードし、`EffectExpired`をインスタンスごとに発行してから対象を除去する。
 * 子（cascade分）を先に、親（`seeds`）を後に処理する（R-EFF-09「同時失効では、
 * 子効果を先に失効させ、最後に親効果を失効させる」）。各インスタンスの除去
 * 直後に`recalculateCombatStats`（`EffectiveEffectChanged`→`CombatStatChanged`、
 * reason: `EFFECT_EXPIRED`）を呼び、R-EFF-05の次点繰上げを自然に反映する。
 * `seeds`が空の場合は何もせず`parentEventId`をそのまま返す。
 */
export function expireEffects(
  context: ExpireEffectsContext,
  units: readonly BattleUnit[],
  seeds: readonly ExpirationSeed[],
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  parentEventId: DomainEventId,
): ExpireEffectsResult {
  if (seeds.length === 0) {
    return { units, lastEventId: parentEventId };
  }

  const seedIds = new Set(seeds.map((seed) => seed.effectInstanceId));
  // レビュー指摘[P2]（PR #209）: Catalogの`linkedEffectGroupId`は同グループ所属を
  // 表すフラットな値で、親子の役割を区別するフィールドを持たない。以前は
  // 失効理由（`CONSUMPTION`かどうか）から役割を推測していたが、実production
  // Catalog（`UNIT_HARRIET_SAGE`の`HARRIET_BARRIER`）では`ACT_HARRIET_SAGE_
  // AS2_IMMUNITY`自身が`consumption: INCOMING_HIT`を持ちながら、その失効は
  // 同グループの`ACT_HARRIET_SAGE_AS2_CONTINUOUS_HEAL`へカスケードする必要が
  // ある。そのためAppliedEffectだけで構成されるグループでは、失効理由を問わず
  // 同じ`linkedEffectGroupId`を共有する全インスタンスへ対称にカスケードする。
  // R-EFF-09が明示する「子効果だけが消費条件で失効した場合、親効果は維持する」
  // 例外は、`AppliedEffect`と`MarkerState`の親子関係（Markerが親、
  // AppliedEffectが子）を前提とした規則であり、Marker自体が未実装(EFF-004)の
  // 現状では到達しない — Marker実装時にこの例外を再導入する。
  const cascadeIds = collectLinkedGroupCascade(units, seedIds);
  const reasonById = new Map<
    EffectInstanceId,
    { reason: EffectExpirationReason; cascaded: boolean }
  >();
  for (const seed of seeds) {
    reasonById.set(seed.effectInstanceId, { reason: seed.reason, cascaded: false });
  }

  const cascadedOnlyOrdered: EffectInstanceId[] = [];
  for (const unit of units) {
    for (const effect of unit.appliedEffects) {
      if (cascadeIds.has(effect.effectInstanceId) && !seedIds.has(effect.effectInstanceId)) {
        cascadedOnlyOrdered.push(effect.effectInstanceId);
        reasonById.set(effect.effectInstanceId, {
          reason: "LINKED_GROUP_CASCADE",
          cascaded: true,
        });
      }
    }
  }
  const orderedInstanceIds = [
    ...cascadedOnlyOrdered,
    ...seeds.map((seed) => seed.effectInstanceId),
  ];

  let working = units;
  let lastEventId = parentEventId;

  for (const effectInstanceId of orderedInstanceIds) {
    const holder = working.find((unit) =>
      unit.appliedEffects.some((effect) => effect.effectInstanceId === effectInstanceId),
    );
    if (holder === undefined) {
      // Already removed by an earlier step in this same batch (e.g. a
      // duplicate seed/cascade reference) — nothing left to expire.
      continue;
    }
    const target = requireUnit(working, holder.battleUnitId);
    const targetEffect = target.appliedEffects.find(
      (effect) => effect.effectInstanceId === effectInstanceId,
    )!;
    const wasEffective = selectEffectiveInstances(
      target.appliedEffects.map((effect) => ({
        effectInstanceId: effect.effectInstanceId,
        kindKey: effect.kindKey,
        duplicate: effect.duplicate,
        magnitude: effect.magnitude,
      })),
    ).has(effectInstanceId);

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

    const info = reasonById.get(effectInstanceId)!;
    const expired = context.recorder.record({
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
        reason: info.reason,
        linkedEffectGroupId: targetEffect.duration.definition.linkedEffectGroupId,
        cascaded: info.cascaded,
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
    lastEventId = expired.eventId;

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
