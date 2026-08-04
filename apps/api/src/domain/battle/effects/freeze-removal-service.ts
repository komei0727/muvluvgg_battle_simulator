import { recalculateCombatStats } from "./combat-stat-recalculation-service.js";
import {
  cascadedOnlyRemovals,
  orderGroupRemovals,
  removeGroupMembersSteps,
} from "./linked-group-cascade.js";
import { NO_MARKER_INSTANCE_IDS, collectLinkedGroupCascade } from "../model/linked-effect-group.js";
import { selectEffectiveInstances } from "../model/effective-effect-selector.js";
import { requireUnit, type BattleUnit } from "../model/battle-unit.js";
import { toEffectSnapshot } from "../events/state-delta.js";
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
import type { BattleUnitId } from "../../shared/ids.js";

export interface RemoveFreezeStepsContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
}

export interface RemoveFreezeContext extends RemoveFreezeStepsContext {
  /**
   * Issue #183: linkedEffectGroupカスケードの各ステップ
   * （子の`EffectExpired`→その`CombatStatChanged`、…、最後に凍結自身の
   * `FreezeRemoved`→その`CombatStatChanged`）を記録した直後にPS/Memoryの
   * 即時連鎖へ通知する。呼び出し側がまとめて全カスケード終了後に通知すると、
   * 最初の`EffectExpired`をtriggerにするPSが既に`FreezeRemoved`まで完了した
   * 状態を見てしまい、発行順契約（`08_ドメインイベント.md`）に反する。
   */
  readonly onFactEventForPassiveChain?: (
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
  ) => readonly BattleUnit[];
}

export interface RemoveFreezeResult {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
}

export interface RemoveFreezeStep {
  readonly events: readonly BattleDomainEvent[];
  /** このステップ完了直後（`yield`時点）の`units` — `.next()`へ渡す基点として使う。 */
  readonly units: readonly BattleUnit[];
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
 * R-STS-03「新たな攻撃スキルによるダメージで解除する」＋R-EFF-09
 * （`linkedEffectGroupId`カスケード）: 凍結`AppliedEffect`を`FreezeRemoved`
 * （`triggeringDamage`付き）として除去する。`duration-expiry-service.ts`の
 * `expireEffects`と同じ`collectLinkedGroupCascade`を使い、同じ
 * `linkedEffectGroupId`を共有する未失効の子効果があれば同じ順序（子を先に、
 * 親を最後に）・同じイベント形（`EffectExpired`/`reason: LINKED_GROUP_CASCADE`、
 * `recalculateCombatStats`）でカスケード除去する。凍結自身の除去だけが
 * `FreezeRemoved`（R-STS-03固有の事実）で、カスケード分は`expireEffects`と
 * 区別しない — `EffectExpired`のまま。
 *
 * Issue #183: カスケードの各ステップを記録した
 * 直後に`yield`するgenerator — AS/EXの同期callback（`removeFreezeEffect`）と、
 * PS自身のEffectSequence解決（`resolveOneEffectActionApplication`が
 * `driveActivation`の共有stateへ`yield*`相当で参加する必要がある経路、
 * `combat/damage-application-service.ts`の`applyDamageActionSteps`）の
 * どちらからも同じ実装を再利用できるよう、通知方法（同期callback or
 * generator yield）を持たない。呼び出し側が各yieldの直後に
 * `.next(externallyMutatedUnits)`で外部変化（PS連鎖による対象の状態変化）を
 * 注入すれば、次のステップはその状態を前提に進む。
 */
export function* removeFreezeEffectSteps(
  context: RemoveFreezeStepsContext,
  units: readonly BattleUnit[],
  targetUnitId: BattleUnitId,
  freezeEffectInstanceId: EffectInstanceId,
  triggeringDamage: number,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  parentEventId: DomainEventId,
): Generator<RemoveFreezeStep, RemoveFreezeResult, readonly BattleUnit[] | undefined> {
  const seedInstances = {
    effectInstanceIds: new Set([freezeEffectInstanceId]),
    markerInstanceIds: NO_MARKER_INSTANCE_IDS,
  };
  const cascade = collectLinkedGroupCascade(units, seedInstances);
  // R-EFF-09「子を先に、親を最後に」: カスケードで見つかった子（`AppliedEffect`と、
  // M7-013で加わった同グループの`MarkerState`）を共有実装で先に処理し、凍結自身は
  // そのあとで`FreezeRemoved`として除去する。
  const cascadeSteps = removeGroupMembersSteps(
    context,
    units,
    orderGroupRemovals(units, cascadedOnlyRemovals(cascade, seedInstances)),
    effectActions,
    parentEventId,
    "EffectExpired",
  );
  const cascaded = yield* cascadeSteps;

  let working = cascaded.units;
  let lastEventId = cascaded.lastEventId;

  const holder = working.find((unit) =>
    unit.appliedEffects.some((effect) => effect.effectInstanceId === freezeEffectInstanceId),
  );
  if (holder === undefined) {
    // Already removed earlier in this same cascade batch.
    return { units: working, lastEventId };
  }
  const stepEventsStart = context.recorder.getEvents().length;
  const target = requireUnit(working, holder.battleUnitId);
  const targetEffect = target.appliedEffects.find(
    (effect) => effect.effectInstanceId === freezeEffectInstanceId,
  )!;
  const wasEffective = isEffectiveNow(target, freezeEffectInstanceId);

  const beforeRemovalUnits = working;
  working = working.map((unit) =>
    unit.battleUnitId === target.battleUnitId
      ? {
          ...unit,
          appliedEffects: unit.appliedEffects.filter(
            (effect) => effect.effectInstanceId !== freezeEffectInstanceId,
          ),
        }
      : unit,
  );

  const recorded = context.recorder.record({
    eventType: "FreezeRemoved",
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
      effectInstanceId: freezeEffectInstanceId,
      battleUnitId: target.battleUnitId,
      triggeringDamage,
    },
    stateDelta: {
      units: {
        [target.battleUnitId]: {
          effects: {
            [freezeEffectInstanceId]: {
              before: toEffectSnapshot(targetEffect, wasEffective),
              after: undefined,
            },
          },
        },
      },
    },
  });
  lastEventId = recorded.eventId;

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

  // 凍結自身の`FreezeRemoved`とそれに続く`CombatStatChanged`も
  // カスケードの各ステップと同じ粒度で`yield`する — まとめて最後に通知すると、
  // 最初のステップをtriggerにするPSが既に後続ステップまで完了した状態を見てしまう。
  // 呼び出し側が`.next()`へ渡す値は、このyield中にPS連鎖が変化させた最新の`units`。
  const injected = yield {
    events: context.recorder.getEvents().slice(stepEventsStart),
    units: working,
  };
  if (injected !== undefined) {
    working = injected;
  }

  return { units: working, lastEventId };
}

/**
 * `removeFreezeEffectSteps`を`context.onFactEventForPassiveChain`（あれば）で
 * 同期的に駆動する薄いwrapper。AS/EX・チャージ解放（呼び出し元が同期callbackで
 * 即時連鎖を解決できる経路）向け。PS自身のEffectSequence解決（`combat/`の
 * `applyDamageActionSteps`が`onFactEventForPassiveChain`未指定を検出して
 * `removeFreezeEffectSteps`を直接`yield`委譲する経路）はこの関数を経由しない。
 */
export function removeFreezeEffect(
  context: RemoveFreezeContext,
  units: readonly BattleUnit[],
  targetUnitId: BattleUnitId,
  freezeEffectInstanceId: EffectInstanceId,
  triggeringDamage: number,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  parentEventId: DomainEventId,
): RemoveFreezeResult {
  const gen = removeFreezeEffectSteps(
    context,
    units,
    targetUnitId,
    freezeEffectInstanceId,
    triggeringDamage,
    effectActions,
    parentEventId,
  );
  let step = gen.next();
  while (!step.done) {
    let currentUnits = step.value.units;
    if (context.onFactEventForPassiveChain !== undefined) {
      for (const event of step.value.events) {
        currentUnits = context.onFactEventForPassiveChain(event, currentUnits);
      }
    }
    step = gen.next(currentUnits);
  }
  return step.value;
}
