import { calculateCombatStat } from "../model/combat-stat-calculator.js";
import { combineEffects, type StatEffect } from "../model/effect-stacking-policy.js";
import {
  selectEffectiveInstances,
  selectNonStackableWinners,
  type EffectiveEffectCandidate,
} from "../model/effective-effect-selector.js";
import { toEffectSnapshot, type EffectSnapshot, type ValueChange } from "../events/state-delta.js";
import { requireUnit, type BattleUnit } from "../model/battle-unit.js";
import type { AppliedEffect, EffectKindKey } from "../model/applied-effect.js";
import type { CombatStats } from "../model/starting-combat-stats.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { StatKind } from "../../catalog/definitions/catalog-enums.js";
import type {
  ActionId,
  DomainEventId,
  EffectInstanceId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import { createPercentage } from "../../shared/percentage.js";

const ZERO_PERCENTAGE = createPercentage(0);

/**
 * `07_戦闘ルール詳細.md` R-STA-01の`stat`候補（`14_Catalog定義スキーマ.md`
 * 「APPLY_STAT_MOD」）と`CombatStats`（`starting-combat-stats.ts`）のフィールド名の
 * 対応表。
 */
const STAT_FIELD: Readonly<Record<StatKind, keyof CombatStats>> = {
  MAXIMUM_HP: "maximumHp",
  ATTACK: "attack",
  DEFENSE: "defense",
  CRITICAL_RATE: "criticalRate",
  CRITICAL_DAMAGE_BONUS: "criticalDamageBonus",
  AFFINITY_BONUS: "affinityBonus",
  ACTION_SPEED: "actionSpeed",
};

export interface StatChange {
  readonly stat: StatKind;
  readonly before: number;
  readonly after: number;
}

export interface ComputeCombatStatsResult {
  readonly combatStats: CombatStats;
  /** 値が実際に変わったstatだけを持つ（`08_ドメインイベント.md`「CombatStatChanged」は変化があった時だけ発行する）。 */
  readonly changedStats: readonly StatChange[];
  /**
   * `unit.appliedEffects`の全インスタンス（`APPLY_STAT_MOD`以外も含む）を対象に
   * R-EFF-05の選択結果を持つ。`APPLY_STAT_MOD`以外は現状`grantEffect`経由で
   * 付与され得ないため常に空だが、将来他のkindがAppliedEffectを持つようになっても
   * 同じ選択規則を再利用できるよう`unit.appliedEffects`全体に対して計算する。
   */
  readonly isEffectiveByInstance: ReadonlyMap<EffectInstanceId, boolean>;
}

/**
 * R-STA-02〜04・R-EFF-05: `unit.appliedEffects`のうち`APPLY_STAT_MOD`由来のものだけを
 * `unit.baseCombatStats`（編成補正・適性補正だけを反映した不変の基準値）へ
 * 合成し直し、現在の`combatStats`との差分を返す。純粋関数であり、`unit`も
 * `effectActions`も変更しない — 呼び出し側（`recalculateCombatStats`）が
 * イベント記録と`BattleUnit`更新を担う。
 */
export function computeCombatStats(
  unit: BattleUnit,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
): ComputeCombatStatsResult {
  const byStat = new Map<StatKind, { ratio: StatEffect[]; fixed: StatEffect[] }>();

  for (const effect of unit.appliedEffects) {
    const definition = effectActions.get(effect.effectActionDefinitionId);
    if (definition === undefined || definition.kind !== "APPLY_STAT_MOD") {
      continue;
    }
    const statEffect: StatEffect = effect.duplicate
      ? { stacking: "STACKABLE", value: effect.magnitude }
      : { stacking: "NON_STACKABLE", kindKey: effect.kindKey, value: effect.magnitude };
    const bucket = byStat.get(definition.payload.stat) ?? { ratio: [], fixed: [] };
    (definition.payload.valueType === "RATIO" ? bucket.ratio : bucket.fixed).push(statEffect);
    byStat.set(definition.payload.stat, bucket);
  }

  // PR #208レビュー[P2]: 効果を持つstatだけを`unit.combatStats`からの差分更新に
  // すると、あるstatの最後の効果が失効・解除されて`byStat`にエントリが
  // 無くなった時、そのstatだけ補正後の値が残ってしまう。常に全statを
  // `baseCombatStats`から再導出することで、効果が0件のstatも正しく基準値へ
  // 戻す（R-STA-04「次の状態変更後、影響を受ける戦闘中ステータスを再計算する」）。
  const changedStats: StatChange[] = [];
  const nextCombatStats: Record<keyof CombatStats, number> = { ...unit.baseCombatStats };
  for (const stat of Object.keys(STAT_FIELD) as StatKind[]) {
    const field = STAT_FIELD[stat];
    const bucket = byStat.get(stat);
    const before = unit.combatStats[field];
    const after = calculateCombatStat({
      baseValue: unit.baseCombatStats[field],
      formationBonus: ZERO_PERCENTAGE,
      aptitudePenalty: ZERO_PERCENTAGE,
      ratioEffects: bucket?.ratio ?? [],
      fixedCorrection: combineEffects(bucket?.fixed ?? []),
    });
    nextCombatStats[field] = after;
    if (before !== after) {
      changedStats.push({ stat, before, after });
    }
  }

  const candidates: AppliedEffect[] = [...unit.appliedEffects];
  const isEffectiveByInstance = new Map<EffectInstanceId, boolean>();
  const effective = selectEffectiveInstances(candidates);
  for (const effect of candidates) {
    isEffectiveByInstance.set(effect.effectInstanceId, effective.has(effect.effectInstanceId));
  }

  return { combatStats: nextCombatStats, changedStats, isEffectiveByInstance };
}

function toCandidates(effects: readonly AppliedEffect[]): EffectiveEffectCandidate[] {
  return effects.map((effect) => ({
    effectInstanceId: effect.effectInstanceId,
    kindKey: effect.kindKey,
    duplicate: effect.duplicate,
    magnitude: effect.magnitude,
  }));
}

export interface RecalculateContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
}

export interface RecalculateCombatStatsResult {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
}

/**
 * R-STA-02〜04・R-EFF-05: 対象ユニットのCombatStatを再計算し、実際に変化した
 * statごとに`CombatStatChanged`を、重複なしグループの採用対象が変わった
 * `EffectKindKey`ごとに`EffectiveEffectChanged`を発行する
 * （`08_ドメインイベント.md`「EffectExpiredの順序」#3〜#4と同じ順序:
 * `EffectiveEffectChanged`を先に、`CombatStatChanged`を後に発行する）。
 * `beforeUnits`はこの操作の直前（例:`grantEffect`直前）の全ユニット、`units`は
 * 直後の全ユニット — 新規インスタンスの追加自体がこの2つの差分であり、
 * `EffectApplied`が既にその新規インスタンス自身の`isEffective`を記録して
 * いるため、`EffectiveEffectChanged`は新規インスタンス以外の既存インスタンス
 * の採用可否変化だけを対象にする（新規インスタンスと同じ`stateDelta.effects`
 * キーを二重に記録しない）。
 */
export function recalculateCombatStats(
  context: RecalculateContext,
  beforeUnits: readonly BattleUnit[],
  units: readonly BattleUnit[],
  targetId: BattleUnitId,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  parentEventId: DomainEventId,
): RecalculateCombatStatsResult {
  const beforeTarget = requireUnit(beforeUnits, targetId);
  const target = requireUnit(units, targetId);
  const newInstanceIds = new Set(
    target.appliedEffects
      .map((effect) => effect.effectInstanceId)
      .filter(
        (id) => !beforeTarget.appliedEffects.some((effect) => effect.effectInstanceId === id),
      ),
  );

  const beforeWinners = selectNonStackableWinners(toCandidates(beforeTarget.appliedEffects));
  const afterWinners = selectNonStackableWinners(toCandidates(target.appliedEffects));
  const changedGroups = new Set<EffectKindKey>([...beforeWinners.keys(), ...afterWinners.keys()]);

  let lastEventId = parentEventId;

  for (const kindKey of changedGroups) {
    const before = beforeWinners.get(kindKey);
    const after = afterWinners.get(kindKey);
    if (before === after) {
      continue;
    }

    const effects: Record<string, ValueChange<EffectSnapshot | undefined>> = {};
    if (before !== undefined) {
      const instance = target.appliedEffects.find((effect) => effect.effectInstanceId === before);
      if (instance !== undefined) {
        effects[before] = {
          before: toEffectSnapshot(instance, true),
          after: toEffectSnapshot(instance, false),
        };
      }
    }
    if (after !== undefined && !newInstanceIds.has(after)) {
      const instance = target.appliedEffects.find((effect) => effect.effectInstanceId === after)!;
      effects[after] = {
        before: toEffectSnapshot(instance, false),
        after: toEffectSnapshot(instance, true),
      };
    }

    const event = context.recorder.record({
      eventType: "EffectiveEffectChanged",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: lastEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: targetId,
      targetUnitIds: [targetId],
      payload: {
        battleUnitId: targetId,
        kindKey,
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
      },
      ...(Object.keys(effects).length > 0
        ? { stateDelta: { units: { [targetId]: { effects } } } }
        : {}),
    });
    lastEventId = event.eventId;
  }

  const { combatStats, changedStats } = computeCombatStats(target, effectActions);
  const nextUnits =
    changedStats.length > 0
      ? units.map((unit) => (unit.battleUnitId === targetId ? { ...unit, combatStats } : unit))
      : units;

  for (const change of changedStats) {
    const field = STAT_FIELD[change.stat];
    const event = context.recorder.record({
      eventType: "CombatStatChanged",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: lastEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: targetId,
      targetUnitIds: [targetId],
      payload: {
        battleUnitId: targetId,
        stat: change.stat,
        before: change.before,
        after: change.after,
        reason: "EFFECT_APPLIED",
      },
      stateDelta: {
        units: {
          [targetId]: { combatStats: { [field]: { before: change.before, after: change.after } } },
        },
      },
    });
    lastEventId = event.eventId;
  }

  return { units: nextUnits, lastEventId };
}
