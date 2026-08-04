import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import { applyOneHeal, type HealEventContext } from "./heal-application-service.js";
import {
  applyOneContinuousDamage,
  type ContinuousDamageEventContext,
} from "./continuous-damage-service.js";
import { recordActionCompletion, type ActionCompletionContext } from "./action-completion.js";
import type {
  ActionResolutionResult,
  ResolvableEffectiveActionType,
} from "./action-resolution-shared.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { DomainEventId, ResolutionScopeId } from "../../shared/event-ids.js";

/**
 * R-HEAL-03（M7-005、Issue #184）が実装対象とする`APPLY_CONTINUOUS_HEAL`の
 * `timing`。production Catalogの継続回復13件はすべてこの組み合わせだけを使う
 * （「2行動の間、行動時に最大HP×10%分のHPが回復する」）。それ以外の組み合わせは
 * `catalog-integrity.ts`がCatalogロード時点で拒否するため、この関数は到達しない。
 */
export const SUPPORTED_CONTINUOUS_HEAL_TIMING = {
  eventType: "ActionStarted",
  targetSelector: "EFFECT_OWNER",
} as const;

export interface FireContinuousHealsResult {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
}

/**
 * `06_戦闘状態遷移.md`「START_EVENT：行動開始時処理」#2「継続ダメージなど、行動開始を
 * 契機とする効果を**定義順**に解決する」が対象とする`EffectActionDefinition.kind`。
 * 継続回復（R-HEAL-03、M7-005）と継続ダメージ（R-DOT-01、DMG-008）を1回の走査で
 * 付与順のまま解決するために共有する — 種別ごとに別々の走査へ分けると、保持者が
 * 両方を持つ場合の解決順が付与順ではなく種別順になってしまう。
 */
const ACTION_START_CONTINUOUS_KINDS: ReadonlySet<string> = new Set([
  "APPLY_CONTINUOUS_HEAL",
  "APPLY_CONTINUOUS_DAMAGE",
]);

/**
 * R-HEAL-03 継続回復（M7-005、Issue #184）: 保持者の`ActionStarted`を契機に、
 * その保持者が持つ`APPLY_CONTINUOUS_HEAL`由来の`AppliedEffect`を定義順（付与順）に
 * 発火させ、R-HEAL-01と同じ手順（`applyOneHeal`）で回復する。
 *
 * 回復量Formulaは付与時点の`magnitude`スナップショットではなく発火のたびに
 * 評価し直す — production定義の`MAX_HP_RATIO`/`MISSING_HP_RATIO`は発火時点の
 * 対象HPを参照する必要があり、`SKILL_POWER`も回復元の現在の攻撃力を基礎にする
 * （R-HEAL-03「`R-HEAL-01`と同じ手順で回復する」）。
 *
 * `sourceUnitId`（回復元）はその`AppliedEffect`の付与者とし、`SKILL_POWER`が
 * 参照する攻撃力もこの付与者から引く。付与者が盤面から引けない場合（防御的
 * fallback、現行モデルでは戦闘不能ユニットも配列に残るため通常起きない）は
 * 保持者自身を回復元として扱う。
 *
 * Durationの減算・失効はR-EFF-01/04の共通ライフサイクル
 * （`duration-expiry-service.ts`）が扱い、この関数は関与しない。
 */
export function fireContinuousHealsOnActionStart(
  units: readonly BattleUnit[],
  ownerId: BattleUnitId,
  context: Omit<HealEventContext, "parentEventId" | "sourceUnitId"> & {
    /**
     * R-DOT-01（DMG-008、Issue #189）: 同じ走査で解決する継続ダメージ用のcontext。
     * 未指定なら継続ダメージは発火しない（`APPLY_CONTINUOUS_DAMAGE`を持たない
     * 既存テスト向けの後方互換）。
     */
    readonly continuousDamage?: Omit<
      ContinuousDamageEventContext,
      "recorder" | "turnNumber" | "cycleNumber" | "resolutionScopeId" | "rootEventId" | "actionId"
    >;
  },
  parentEventId: DomainEventId,
  onFactEvent?: (event: BattleDomainEvent, units: readonly BattleUnit[]) => readonly BattleUnit[],
): FireContinuousHealsResult {
  let working = units;
  let lastEventId = parentEventId;

  const owner = working.find((u) => u.battleUnitId === ownerId);
  if (owner === undefined) {
    return { units: working, lastEventId };
  }

  // 発火中の連鎖で保持者のappliedEffectsが変化しうるため、発火対象は
  // 開始時点のインスタンスID列で固定する（R-TGT-10と同じ「定義順評価」規約）。
  const firingInstanceIds = owner.appliedEffects
    .filter((effect) => {
      const definition = context.effectActions.get(effect.effectActionDefinitionId);
      if (definition === undefined || !ACTION_START_CONTINUOUS_KINDS.has(definition.kind)) {
        return false;
      }
      // 継続回復・継続ダメージとも、実装済みの`timing`は保持者自身の
      // `ActionStarted`だけである（R-HEAL-03／R-DOT-01）。
      const timing =
        definition.kind === "APPLY_CONTINUOUS_HEAL" || definition.kind === "APPLY_CONTINUOUS_DAMAGE"
          ? definition.payload.timing
          : undefined;
      return (
        timing !== undefined &&
        timing.eventType === SUPPORTED_CONTINUOUS_HEAL_TIMING.eventType &&
        timing.targetSelector === SUPPORTED_CONTINUOUS_HEAL_TIMING.targetSelector
      );
    })
    .map((effect) => effect.effectInstanceId);

  for (const effectInstanceId of firingInstanceIds) {
    const currentOwner = working.find((u) => u.battleUnitId === ownerId);
    if (currentOwner === undefined) {
      break;
    }
    // R-DOT-01／R-ACTN-01: 先行するインスタンスの発生（またはその連鎖）で保持者が
    // 戦闘不能になったら、残りの継続効果は発火させない。
    if (isDefeated(currentOwner)) {
      break;
    }
    // 連鎖の途中でこのインスタンスが失効・除去された場合は発火しない。
    const effect = currentOwner.appliedEffects.find(
      (candidate) => candidate.effectInstanceId === effectInstanceId,
    );
    if (effect === undefined) {
      continue;
    }
    const definition = context.effectActions.get(effect.effectActionDefinitionId);
    if (definition === undefined) {
      continue;
    }

    // R-DOT-01〜04（DMG-008、Issue #189）: 継続ダメージは`applyOneContinuousDamage`が
    // `ContinuousDamageApplied`（致死なら`UnitDefeated`）まで発行し、連鎖もその中で
    // 解決する（継続回復の`applyOneHeal`と同じ規約）。
    if (definition.kind === "APPLY_CONTINUOUS_DAMAGE") {
      if (context.continuousDamage === undefined) {
        continue;
      }
      const damaged = applyOneContinuousDamage(
        effect,
        definition,
        currentOwner,
        working.find((u) => u.battleUnitId === effect.sourceId),
        working,
        {
          recorder: context.recorder,
          turnNumber: context.turnNumber,
          cycleNumber: context.cycleNumber,
          ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
          ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
          resolutionScopeId: context.resolutionScopeId,
          rootEventId: context.rootEventId,
          effectActions: context.effectActions,
          ...(context.continuousDamage.expireDepletedAbsorbers !== undefined
            ? { expireDepletedAbsorbers: context.continuousDamage.expireDepletedAbsorbers }
            : {}),
        },
        lastEventId,
        onFactEvent,
      );
      working = damaged.units;
      lastEventId = damaged.lastEventId;
      continue;
    }

    if (definition.kind !== "APPLY_CONTINUOUS_HEAL") {
      continue;
    }
    const healer = working.find((u) => u.battleUnitId === effect.sourceId) ?? currentOwner;

    // R-HEAL-04（Issue #229）: 連鎖は`applyOneHeal`が
    // `HealApplied`／各`HealingTransferred`の発行直後にその場で解決する。ここで
    // まとめて連鎖させると`HealApplied`起点のPSが転送後のHPを観測してしまうため、
    // callbackはcontext経由で渡し、この関数は連鎖順に関与しない。
    const applied = applyOneHeal(
      {
        effectActionDefinitionId: effect.effectActionDefinitionId,
        formula: definition.payload.formula,
      },
      healer,
      currentOwner,
      working,
      {
        ...context,
        parentEventId: lastEventId,
        // R-MEM-04（Issue #179）: Memory由来の継続回復は付与者ユニットを持たない
        // ため、回復の発生源としては`healer`（保持者へフォールバック済み）を使う。
        sourceUnitId: effect.sourceId ?? healer.battleUnitId,
        ...(onFactEvent !== undefined ? { onFactEventForPassiveChain: onFactEvent } : {}),
      },
      lastEventId,
    );
    if (applied === undefined) {
      continue;
    }
    working = applied.units;
    lastEventId = applied.lastEventId;
  }

  return { units: working, lastEventId };
}

/**
 * `06_戦闘状態遷移.md`「START_EVENT：行動開始時処理」#4:
 * 「行動者が戦闘不能になった場合は、本体スキルを実行せず`COMPLETING`へ進む」。
 * 同書のシナリオ#8「行動開始時の継続ダメージで行動者が戦闘不能になり、本体スキルを
 * 実行しない」がこの契約の代表例である。
 *
 * M7-005（Issue #184）以前は行動開始時に解決される効果自体が存在しなかったため
 * この分岐へ到達する経路がなかったが、R-HEAL-03の継続回復とその`HealApplied`起点の
 * PS連鎖（#3）が行動者を戦闘不能にしうるようになったため、4つの行動経路すべてが
 * 発火直後にこれを判定する必要がある。
 *
 * 戦闘不能でなければ`undefined`を返し、呼び出し側は通常どおり本体（EXECUTING）へ
 * 進む。戦闘不能なら本体を実行せず`ActionCompleting`〜`ActionCompleted`だけを
 * 記録した`ActionResolutionResult`を返す — 行動自体は「解決済み」として完了させ、
 * 予約やキューへ宙ぶらりんのまま残さない。
 */
export function completeActionIfActorDefeatedAtStart(
  units: readonly BattleUnit[],
  actorId: BattleUnitId,
  recorder: EventRecorder,
  completionContext: ActionCompletionContext,
  effectiveActionType: ResolvableEffectiveActionType,
  triggeringEventId: DomainEventId,
  actionScope: ResolutionScopeId,
  rootEventId: DomainEventId,
  finalizeResolutionScope: (completedEventId: DomainEventId) => readonly BattleUnit[],
): ActionResolutionResult | undefined {
  const actor = units.find((u) => u.battleUnitId === actorId);
  if (actor === undefined || !isDefeated(actor)) {
    return undefined;
  }
  const completion = recordActionCompletion(
    recorder,
    completionContext,
    effectiveActionType,
    triggeringEventId,
    units,
  );
  return {
    units: finalizeResolutionScope(completion.completedEventId),
    actionScope,
    rootEventId,
    completedEventId: completion.completedEventId,
  };
}
