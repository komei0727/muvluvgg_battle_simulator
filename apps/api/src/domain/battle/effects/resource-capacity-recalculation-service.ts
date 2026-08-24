import {
  createActionPoint,
  createExtraGauge,
  createHitPoint,
  createPassivePoint,
  truncateFraction,
} from "../model/resource-gauge.js";
import { isDefeated, requireUnit, type BattleUnit } from "../model/battle-unit.js";
import { selectEffectiveInstances } from "../model/effective-effect-selector.js";
import {
  GAUGE_CAPACITY_RESOURCES,
  type GaugeCapacityResource,
  type ResourceKind,
} from "../../catalog/definitions/catalog-enums.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent, ResourceCapacityChangeReason } from "../events/domain-event.js";
import type {
  ActionId,
  DomainEventId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { ExerciseRuntime } from "../model/exercise-runtime.js";
import {
  requireResolveBreak,
  requiresBreakResolution,
  type ResolveBreakHook,
} from "../events/break-resolution.js";

/**
 * `MODIFY_RESOURCE_CAPACITY`が上限を変更できるリソースのうち、ゲージ最大値を
 * `BattleUnit`が直接持つもの。`HP`だけは上限が`combatStats.maximumHp`
 * （`MAXIMUM_HP` CombatStat）であり、`APPLY_STAT_MOD`と同じ再計算・同じ
 * `CombatStatChanged`が差分を所有するため、この一覧には含めない。
 */
const GAUGE_CAPACITY_FIELD = {
  AP: { current: "maximumAp", base: "baseMaximumAp", delta: "maximumAp" },
  PP: { current: "maximumPp", base: "baseMaximumPp", delta: "maximumPp" },
  EX_GAUGE: {
    current: "maximumExtraGauge",
    base: "baseMaximumExtraGauge",
    delta: "maximumExtraGauge",
  },
} as const satisfies Readonly<
  Record<
    GaugeCapacityResource,
    { current: keyof BattleUnit; base: keyof BattleUnit; delta: string }
  >
>;

export interface ResourceCapacityChange {
  readonly resource: GaugeCapacityResource;
  readonly before: number;
  readonly after: number;
}

export interface ComputeResourceCapacitiesResult {
  readonly maximumAp: number;
  readonly maximumPp: number;
  readonly maximumExtraGauge: number;
  /** 値が実際に変わったリソースだけを持つ（`ResourceCapacityChanged`は変化があった時だけ発行する）。 */
  readonly changedCapacities: readonly ResourceCapacityChange[];
}

/**
 * G-09（`14_Catalog定義スキーマ.md`「MODIFY_RESOURCE_CAPACITY」、M7-002A／Issue #255）:
 * `baseValue`（その resource の不変な基準上限）へ、対象が現在保持している
 * `MODIFY_RESOURCE_CAPACITY`のうちR-EFF-05で有効な効果だけを合成して現在の上限を
 * 導く純粋関数。`unit`も`effectActions`も変更しない。
 *
 * 合成規約（`operation`は`ADD`/`SET`の2種のみ。`14_Catalog定義スキーマ.md`が
 * `SET_TO_MAX`/`DISTRIBUTE`を上限変更には許可しない）:
 *
 * 1. `SET`は基準そのものを置き換える。複数有効な場合は`appliedEffects`の並び
 *    （付与順、R-EFF-01）で後のものが勝つ — `APPLY_STAT_MOD`の固定値補正のように
 *    合成できる量ではなく、互いに排他な「その値にする」指定であるため。
 * 2. `ADD`は 1 の結果へ合算する。`ADD`同士は加算のみで交換法則が成り立つため、
 *    付与順に依存しない。
 *
 * `combatStats`（R-STA-04）と同じく、常にこの不変な基準から再合成し直すことで、
 * 失効・解除時に「効果が0件なら基準へ戻る」が明示的な巻き戻し処理なしに成立する。
 */
export function composeResourceCapacity(
  baseValue: number,
  unit: BattleUnit,
  resource: ResourceKind,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
): number {
  const effective = selectEffectiveInstances(unit.appliedEffects);
  let setValue: number | undefined;
  let addTotal = 0;
  for (const effect of unit.appliedEffects) {
    if (!effective.has(effect.effectInstanceId)) {
      continue;
    }
    const definition = effectActions.get(effect.effectActionDefinitionId);
    if (
      definition === undefined ||
      definition.kind !== "MODIFY_RESOURCE_CAPACITY" ||
      definition.payload.resource !== resource
    ) {
      continue;
    }
    if (definition.payload.operation === "SET") {
      setValue = effect.magnitude;
      continue;
    }
    addTotal += effect.magnitude;
  }
  return (setValue ?? baseValue) + addTotal;
}

/**
 * AP/PP/EXゲージの現在の上限を`baseMaximum*`から再合成し、現在の`maximum*`との
 * 差分を返す。`composeResourceCapacity`の結果はゲージ最大値として使うため、
 * `createBoundedGauge`の不変条件（0以上のinteger）へ合わせて0方向へ切り捨て、
 * 0未満は0へ丸める（R-NUM-02）。`HP`の上限は`combatStats.maximumHp`であり、
 * 全精度のまま`computeCombatStats`が合成する（R-NUM-01）ためここでは扱わない。
 */
export function computeResourceCapacities(
  unit: BattleUnit,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
): ComputeResourceCapacitiesResult {
  const changedCapacities: ResourceCapacityChange[] = [];
  const next: Record<GaugeCapacityResource, number> = {
    AP: unit.maximumAp,
    PP: unit.maximumPp,
    EX_GAUGE: unit.maximumExtraGauge,
  };
  for (const resource of GAUGE_CAPACITY_RESOURCES) {
    const field = GAUGE_CAPACITY_FIELD[resource];
    const before = unit[field.current];
    const after = Math.max(
      0,
      truncateFraction(composeResourceCapacity(unit[field.base], unit, resource, effectActions)),
    );
    next[resource] = after;
    if (before !== after) {
      changedCapacities.push({ resource, before, after });
    }
  }
  return {
    maximumAp: next.AP,
    maximumPp: next.PP,
    maximumExtraGauge: next.EX_GAUGE,
    changedCapacities,
  };
}

/**
 * `combat-stat-recalculation-service.ts`の`RecalculateContext`と同じ形。
 * `domain/battle/effects`は`domain/battle/resolution`へ依存できない（モジュール境界、
 * `eslint.config.mjs`）ため`ResourceChangeRecordContext`を再利用できず、また
 * `combat-stat-recalculation-service.ts`は本モジュールへ依存する側であるため、
 * そこからの型輸入は循環依存になる（`madge --circular`）。構造的に同じ形を持つ。
 */
export interface ResourceCapacityRecalculateContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  /**
   * R-TEX-03 #1: `MAXIMUM_HP`上限の低下で現在HPが0へ切り下げられる経路も「到達経路を
   * 問わない」HP0到達である。演習状態がある場合は戦闘不能ではなくブレイクとして解決する。
   */
  readonly exercise?: ExerciseRuntime;
  /**
   * `exercise`とセットで注入する`BreakResolutionService`。`effects/`同士の相互import
   * （`break-resolution-service.ts`は`combat-stat-recalculation-service.ts`経由で
   * このモジュールへ依存する）を避けるため、直接importせずhookとして受け取る。
   */
  readonly resolveBreak?: ResolveBreakHook;
  /**
   * ブレイク解決の各stepを、次へ進む前にPS/Memoryの即時連鎖へ渡すためのcallback
   * （`LinkedGroupCascadeContext`と同じ役割・同じ形）。generatorを自分で駆動しない
   * 呼び出し側が`recalculateResourceCapacities`（同期wrapper）を使うときに要る。
   */
  readonly onFactEventForPassiveChain?: (
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
  ) => readonly BattleUnit[];
}

export interface RecalculateResourceCapacitiesResult {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
}

const CURRENT_VALUE_FIELD = {
  AP: "currentAp",
  PP: "currentPp",
  EX_GAUGE: "currentExtraGauge",
  HP: "currentHp",
} as const satisfies Readonly<Record<ResourceKind, keyof BattleUnit>>;

const RESOURCE_DELTA_FIELD = {
  AP: "ap",
  PP: "pp",
  EX_GAUGE: "extraGauge",
  HP: "hp",
} as const satisfies Readonly<Record<ResourceKind, string>>;

function withClampedCurrentValue(
  unit: BattleUnit,
  resource: ResourceKind,
  maximum: number,
  value: number,
): BattleUnit {
  switch (resource) {
    case "AP":
      return { ...unit, currentAp: createActionPoint(value, maximum) };
    case "PP":
      return { ...unit, currentPp: createPassivePoint(value, maximum) };
    case "EX_GAUGE":
      return { ...unit, currentExtraGauge: createExtraGauge(value, maximum) };
    case "HP":
      return { ...unit, currentHp: createHitPoint(value, maximum) };
  }
}

/**
 * G-09（M7-002A／Issue #255）: R-STA-04の再計算フックのリソース上限側。
 * `recalculateCombatStats`がCombatStatを確定させた直後に、同じ契機
 * （付与・失効・解除）でAP/PP/EXゲージの上限を`baseMaximum*`から再合成し、
 * 実際に変化したリソースごとに`ResourceCapacityChanged`を発行する。
 *
 * 上限が下がった結果として現在値が可動域`[0, 新上限]`の外へ出た場合は、
 * その場で切り下げて`ResourceChanged`（`reason: EFFECT_ACTION` — 上限変更は
 * 常に`MODIFY_RESOURCE_CAPACITY` EffectAction由来であり、失効・解除もその
 * インスタンスの寿命として同じ原因に属する）を発行する。clampしないと
 * `createActionPoint`等の不変条件違反が、後続の無関係なリソース操作で初めて
 * 例外として現れてしまう。
 *
 * `HP`は上限が`MAXIMUM_HP` CombatStatであり、`computeCombatStats`が既に
 * `composeResourceCapacity`を通して合成済みのため、ここでは現在値のclampだけを
 * 行う（上限差分は`CombatStatChanged`が所有する）。clampでHPが0になった場合は
 * R-END-02に従い`UnitDefeated`も発行する。
 */
export function* recalculateResourceCapacitiesSteps(
  context: ResourceCapacityRecalculateContext,
  units: readonly BattleUnit[],
  targetUnitId: BattleUnitId,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  parentEventId: DomainEventId,
  reason: ResourceCapacityChangeReason,
): Generator<
  { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
  RecalculateResourceCapacitiesResult,
  readonly BattleUnit[] | undefined
> {
  const target = requireUnit(units, targetUnitId);
  const { changedCapacities, ...capacities } = computeResourceCapacities(target, effectActions);
  let updated: BattleUnit = changedCapacities.length > 0 ? { ...target, ...capacities } : target;
  let lastEventId = parentEventId;

  for (const change of changedCapacities) {
    const event = context.recorder.record({
      eventType: "ResourceCapacityChanged",
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
        battleUnitId: targetUnitId,
        resource: change.resource,
        before: change.before,
        after: change.after,
        reason,
      },
      stateDelta: {
        units: {
          [targetUnitId]: {
            [GAUGE_CAPACITY_FIELD[change.resource].delta]: {
              before: change.before,
              after: change.after,
            },
          },
        },
      },
    });
    lastEventId = event.eventId;
  }

  // 上限が上がった場合に現在値を追随させることはしない（R-ACT-04: 変化させるのは
  // 明示的なリソース操作・ターン開始回復だけ）。下がった場合だけ可動域へ収める。
  const wasDefeated = isDefeated(updated);
  for (const resource of [...GAUGE_CAPACITY_RESOURCES, "HP"] as const) {
    const maximum =
      resource === "HP"
        ? truncateFraction(updated.combatStats.maximumHp)
        : updated[GAUGE_CAPACITY_FIELD[resource].current];
    const before = updated[CURRENT_VALUE_FIELD[resource]];
    if (before <= maximum) {
      continue;
    }
    updated = withClampedCurrentValue(updated, resource, maximum, maximum);
    const event = context.recorder.record({
      eventType: "ResourceChanged",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: lastEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: targetUnitId,
      payload: {
        battleUnitId: targetUnitId,
        resource,
        before,
        after: maximum,
        delta: maximum - before,
        // 上限打ち止めそのものが原因の変化であり、`RESOURCE_GAIN_MOD`のような
        // Modifierは介在しないため基礎量は最終量と一致する。
        baseDelta: maximum - before,
        reason: "EFFECT_ACTION",
        causeEventId: lastEventId,
      },
      stateDelta: {
        units: { [targetUnitId]: { [RESOURCE_DELTA_FIELD[resource]]: { before, after: maximum } } },
      },
    });
    lastEventId = event.eventId;
  }

  if (!wasDefeated && isDefeated(updated)) {
    // R-TEX-03: 演習の敵はここでも戦闘不能にならない。ブレイク解決が復活まで済ませた
    // 状態をそのまま返す（`units`の差し替えも解決結果が持つ）。
    if (requiresBreakResolution(context.exercise, updated)) {
      const resolveBreak = requireResolveBreak(
        context.resolveBreak,
        "resourceCapacityRecalculateContext.resolveBreak",
      );
      const clamped = units.map((u) => (u.battleUnitId === targetUnitId ? updated : u));
      // この経路の`UnitDefeated`と同じ発生源（上限を変えた効果の保持者自身）。
      // 自身を発生源にすると`sourceSelector`の照合では落ちるが（`break-deferral.ts`）、
      // R-TEX-10 #2のブレイク履歴はこの値をユニットへの帰属として公開する。現状この
      // 分岐は到達しない——Catalogの`MAXIMUM_HP` Modifierはすべて正で、最大HPが現在HPを
      // 0へ切り下げることがないためである。上限を下げる定義を追加する場合は、
      // 「敵が自分自身をブレイクした」と読める帰属になる点をここで解決すること。
      const steps = resolveBreak(targetUnitId, clamped, lastEventId, {
        sourceUnitId: targetUnitId,
      });
      // R-TEX-03 #2: 各ブレイクstepを駆動側へ返し、撃破トリガーを解除より前に
      // 解決させる（ローカルに消費し切ると順序が逆転する）。
      let step = steps.next();
      while (!step.done) {
        const injected = yield { events: step.value.events, units: step.value.units };
        step = steps.next(injected ?? step.value.units);
      }
      return { units: step.value.units, lastEventId: step.value.lastEventId };
    }
    const event = context.recorder.record({
      eventType: "UnitDefeated",
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
      payload: { unitId: targetUnitId, causeEventId: lastEventId },
    });
    lastEventId = event.eventId;
  }

  return {
    units:
      updated === target
        ? units
        : units.map((u) => (u.battleUnitId === targetUnitId ? updated : u)),
    lastEventId,
  };
}

/**
 * `recalculateResourceCapacitiesSteps`を`context.onFactEventForPassiveChain`（あれば）で
 * 同期的に駆動する薄いwrapper。通常戦闘では一度も`yield`しないため、演習以外の
 * 呼び出し側は従来どおりこちらを使えばよい。
 */
export function recalculateResourceCapacities(
  context: ResourceCapacityRecalculateContext,
  units: readonly BattleUnit[],
  targetUnitId: BattleUnitId,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  parentEventId: DomainEventId,
  reason: ResourceCapacityChangeReason,
): RecalculateResourceCapacitiesResult {
  const steps = recalculateResourceCapacitiesSteps(
    context,
    units,
    targetUnitId,
    effectActions,
    parentEventId,
    reason,
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
