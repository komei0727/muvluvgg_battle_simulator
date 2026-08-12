import { recalculateCombatStatsSteps } from "./combat-stat-recalculation-service.js";
import {
  orderGroupRemovals,
  removeGroupMembersSteps,
  type LinkedGroupCascadeContext,
  type LinkedGroupCascadeResult,
  type LinkedGroupCascadeStep,
  type LinkedGroupRemoval,
} from "./linked-group-cascade.js";
import { requireUnit, type BattleUnit } from "../model/battle-unit.js";
import { applyExerciseScaling } from "../model/exercise-scaling-policy.js";
import type { ExerciseRuntime } from "../model/exercise-runtime.js";
import type { BreakDefeatSource } from "../events/break-resolution.js";
import { createHitPoint, truncateFraction } from "../model/resource-gauge.js";
import type { CombatStats } from "../model/starting-combat-stats.js";
import type { ValueChange } from "../events/state-delta.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { DomainEventId } from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";

/**
 * `BreakResolutionService`（`05_ドメインモデル.md`）が必要とする因果関係コンテキスト。
 * 除去バッチをそのまま`linked-group-cascade.ts`へ委譲するため、そちらの契約
 * （`onFactEventForPassiveChain`を含む）をそのまま引き継ぐ。
 */
export interface BreakResolutionContext extends LinkedGroupCascadeContext {
  /** R-TEX-03 #4／R-TEX-04 #4: ブレイク回数の正本と、強化の基準になる原基準値。 */
  readonly exercise: ExerciseRuntime;
}

/**
 * R-MEM-04: メモリー由来の付与は具体的な付与者ユニットを持たず`sourceSide`だけを持つ。
 * R-TEX-05 #2の解除免除はこの形だけを対象にする（「敵陣営が付与したもの」ではなく
 * 「メモリーが付与したもの」が免除対象であるため、`sourceUnitId`の不在が判定条件になる）。
 */
function isMemoryGranted(grant: {
  readonly sourceUnitId?: BattleUnitId;
  readonly sourceSide?: unknown;
}): boolean {
  return grant.sourceUnitId === undefined && grant.sourceSide !== undefined;
}

/**
 * R-TEX-05 #2／R-TEX-07: ブレイクしたユニット**自身**が保持する、メモリー由来以外の
 * 効果・マーカーだけを解除対象にする。
 *
 * `REMOVE_EFFECTS`（R-EFF-02）と違い`dispellable: false`を尊重しない — R-TEX-05は
 * 解除スキルではなく演習固有のライフサイクル処理であり、「付与されたバフ・デバフ・
 * マーカーをすべて解除する」と定めているためである。
 *
 * R-EFF-09の`linkedEffectGroupId`カスケードも起こさない。カスケードは他ユニットが
 * 保持するメンバーまで巻き込むが、敵が味方へ付与済みの効果・マーカーはブレイクで
 * 解除しない（R-TEX-07 #1）ためである。同一ユニット内のグループメンバーは、
 * ここで列挙する「自身の非メモリー由来すべて」に元から含まれる。
 */
function breakRemovals(target: BattleUnit): readonly LinkedGroupRemoval[] {
  const removals: LinkedGroupRemoval[] = [];
  for (const effect of target.appliedEffects) {
    if (!isMemoryGranted(effect)) {
      removals.push({
        member: { kind: "EFFECT", effectInstanceId: effect.effectInstanceId },
        reason: "REMOVED",
        cascaded: false,
      });
    }
  }
  for (const marker of target.markerStates) {
    if (!isMemoryGranted(marker)) {
      removals.push({
        member: { kind: "MARKER", markerInstanceId: marker.markerInstanceId },
        reason: "REMOVED",
        cascaded: false,
      });
    }
  }
  return orderGroupRemovals([target], removals);
}

/** 実際に値が変わった基礎ステータスだけの差分（`UnitRevived`が所有する）。 */
function baseCombatStatsDelta(
  before: CombatStats,
  after: CombatStats,
): Readonly<Partial<Record<keyof CombatStats, ValueChange<number>>>> {
  const delta: Partial<Record<keyof CombatStats, ValueChange<number>>> = {};
  for (const field of Object.keys(after) as (keyof CombatStats)[]) {
    if (before[field] !== after[field]) {
      delta[field] = { before: before[field], after: after[field] };
    }
  }
  return delta;
}

/**
 * R-TEX-03／05／06: 演習中の敵ユニットのHP0到達を、戦闘不能に代えてブレイクとして
 * 解決し、同一の解決ステップ内で復活まで原子的に完了する。**全ての戦闘不能判定箇所が
 * 経由する単一のシーム**であり、この経路を通らないHP0到達は演習でも`UnitDefeated`に
 * なってしまう（`break-resolution.ts`の`requireBreakResolution`がその配線漏れを
 * 実行時に検出する）。
 *
 * 手順は`06_戦闘状態遷移.md`「ブレイクと復活（戦術演習）」の順:
 *
 * 1. ブレイク回数を1増やし`UnitBroken`を発行する（R-TEX-03 #3／#4）。勝敗判定・
 *    行動順キューからの除去・スキル解決の中断は行わない — このサービスはHPと
 *    効果保持だけを触り、キュー・進行状態には一切触れないことでそれを保証する
 *    （R-TEX-06 #2／#3のAP・PP・EX・CT・チャージ・RuntimeCounter・予約の引き継ぎも同じ）。
 * 2. `UnitBroken`をPS/Memory即時連鎖へ渡し、「敵撃破時」契機を発動させる
 *    （R-TEX-03 #2。照合側は`trigger-event-matching.ts`）。
 * 3. 自身の非メモリー由来の効果・マーカーを解除する（R-TEX-05 #2）。
 * 4. 原基準値からブレイク強化を再計算して`baseCombatStats`を書き換え、R-STA-04の
 *    既存の再計算で戦闘中ステータスへ合成する（R-TEX-04 #4）。
 * 5. 強化後の最大HPまで全回復し`UnitRevived`を発行する（R-TEX-05 #3／#5）。
 *
 * 回復（R-HEAL系）の経路は一切使わない（R-TEX-05 #4）— 回復量補正・回復リンク転送・
 * 回復契機トリガーのいずれも発生させないため、`HealApplied`ではなく`UnitRevived`が
 * 直接HP差分を所有する。
 */
export function* resolveBreakSteps(
  context: BreakResolutionContext,
  units: readonly BattleUnit[],
  targetUnitId: BattleUnitId,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  causeEventId: DomainEventId,
  /**
   * R-TEX-03 #2: この経路の`UnitDefeated`が載せていたのと同じ発生源。`sourceSelector`
   * で絞る「敵撃破時」トリガーが、Catalog定義のまま`UnitBroken`でも成立するために要る。
   */
  defeatSource: BreakDefeatSource = {},
): Generator<LinkedGroupCascadeStep, LinkedGroupCascadeResult, readonly BattleUnit[] | undefined> {
  let working = units;
  const broken = context.exercise.recordBreak();

  const brokenEvent = context.recorder.record({
    eventType: "UnitBroken",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
    resolutionScopeId: context.resolutionScopeId,
    parentEventId: causeEventId,
    rootEventId: context.rootEventId,
    // R-TEX-03 #2: 撃破元をそのまま引き継ぐ（ブレイク対象自身にしない）。
    ...(defeatSource.sourceUnitId !== undefined ? { sourceUnitId: defeatSource.sourceUnitId } : {}),
    ...(defeatSource.sourceSide !== undefined ? { sourceSide: defeatSource.sourceSide } : {}),
    targetUnitIds: [targetUnitId],
    payload: {
      unitId: targetUnitId,
      breakNumber: broken.breakNumber,
      turnNumber: context.turnNumber,
      totalScore: context.exercise.totalScore,
      causeEventId,
    },
    stateDelta: { exercise: { breakCount: { before: broken.before, after: broken.after } } },
  });
  let lastEventId = brokenEvent.eventId;

  // R-TEX-03 #2: 撃破トリガーの発動を、解除・強化・全回復より前に完了させる
  // （`06_戦闘状態遷移.md`の手順2）。連鎖が状態を変えたなら以降はその最新stateで進む。
  const injectedAfterBreak = yield { events: [brokenEvent], units: working };
  if (injectedAfterBreak !== undefined) {
    working = injectedAfterBreak;
  }

  const removed = yield* removeGroupMembersSteps(
    context,
    working,
    breakRemovals(requireUnit(working, targetUnitId)),
    effectActions,
    lastEventId,
    "EffectRemoved",
  );
  working = removed.units;
  lastEventId = removed.lastEventId;

  // R-TEX-04 #4: 強化は毎回**原基準値**から再計算する（複利にしない）。
  const beforeScaling = requireUnit(working, targetUnitId);
  const enhancedBase = applyExerciseScaling(
    context.exercise.originalEnemyBaseCombatStats,
    broken.breakNumber,
  );
  const scaled: BattleUnit = { ...beforeScaling, baseCombatStats: enhancedBase };
  working = working.map((unit) => (unit.battleUnitId === targetUnitId ? scaled : unit));

  // R-STA-04: 基礎側が動いたので、残存効果（メモリー由来）の割合・固定値補正を
  // 強化後の基礎値へ合成し直す。差分は既存の`CombatStatChanged`が所有する。
  const recalculation = yield* recalculateCombatStatsSteps(
    context,
    working,
    working,
    targetUnitId,
    effectActions,
    lastEventId,
    "BREAK_ENHANCEMENT",
  );
  working = recalculation.units;
  lastEventId = recalculation.lastEventId;

  // R-TEX-05 #3: 強化後の最大HPまで全回復する。R-NUM-02に従い、全精度で保持される
  // `combatStats.maximumHp`をHPゲージ境界で整数化する（他のHP適用経路と同じ規約）。
  const beforeRevival = requireUnit(working, targetUnitId);
  const hpBefore = beforeRevival.currentHp;
  const enhancedMaximumHp = truncateFraction(beforeRevival.combatStats.maximumHp);
  const revived: BattleUnit = {
    ...beforeRevival,
    currentHp: createHitPoint(enhancedMaximumHp, enhancedMaximumHp),
  };
  working = working.map((unit) => (unit.battleUnitId === targetUnitId ? revived : unit));

  const revivedEvent = context.recorder.record({
    eventType: "UnitRevived",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
    resolutionScopeId: context.resolutionScopeId,
    parentEventId: lastEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: targetUnitId,
    targetUnitIds: [targetUnitId],
    payload: {
      unitId: targetUnitId,
      breakNumber: broken.breakNumber,
      hpAfter: revived.currentHp,
      baseCombatStats: enhancedBase,
    },
    stateDelta: {
      units: {
        [targetUnitId]: {
          hp: { before: hpBefore, after: revived.currentHp },
          baseCombatStats: baseCombatStatsDelta(beforeScaling.baseCombatStats, enhancedBase),
        },
      },
    },
  });
  lastEventId = revivedEvent.eventId;

  const injectedAfterRevival = yield { events: [revivedEvent], units: working };
  if (injectedAfterRevival !== undefined) {
    working = injectedAfterRevival;
  }

  return { units: working, lastEventId };
}

/**
 * `resolveBreakSteps`を`context.onFactEventForPassiveChain`（あれば）で同期的に駆動する
 * 薄いwrapper。`linked-group-cascade.ts`の`removeGroupMembers`とまったく同じ形・役割で、
 * generatorを自分で駆動しない呼び出し側（`resource-modification-service.ts`など）が使う。
 */
export function resolveBreak(
  context: BreakResolutionContext,
  units: readonly BattleUnit[],
  targetUnitId: BattleUnitId,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  causeEventId: DomainEventId,
  defeatSource: BreakDefeatSource = {},
): LinkedGroupCascadeResult {
  const steps = resolveBreakSteps(
    context,
    units,
    targetUnitId,
    effectActions,
    causeEventId,
    defeatSource,
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
