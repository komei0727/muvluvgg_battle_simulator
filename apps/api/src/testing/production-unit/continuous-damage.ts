import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { expireEffectsSteps } from "../../domain/battle/effects/duration-expiry-service.js";
import { fireContinuousHealsOnActionStart } from "../../domain/battle/lifecycle/continuous-heal-service.js";
import { PassiveActivationRuntime } from "../../domain/battle/lifecycle/passive-activation-service.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { DepletedAbsorberReason } from "../../domain/battle/combat/damage-application-service.js";
import type { DomainEventId, EffectInstanceId } from "../../domain/shared/event-ids.js";
import { createBattleId, createBattleUnitId, type BattleUnitId } from "../../domain/shared/ids.js";
import { SequenceRandomSource } from "../random/sequence-random-source.js";

/**
 * ユニット効果軸の `-004` 以降が使う「付与された継続ダメージが、**保持者の次の
 * 行動開始で**いくら発生し、シールド・サブユニットへどう振り分けられるか」を
 * 観測するハーネス（R-DOT-01〜04）。
 *
 * `-001` の振る舞い表は**スキル使用1回**を単位とするため、付与そのもの（種別ごとの
 * `magnitude` スナップショット・期間）は観測へ載るが、**発生**は保持者の以後の行動に
 * 属するため構造的に表せない。ここがその境界だけを引き受ける。
 *
 * 発火は実ライフサイクル（`continuous-heal-service.ts` の
 * `fireContinuousHealsOnActionStart`）をそのまま通す — AS/EX/待機の各 resolver が
 * 行動開始時処理（`06_戦闘状態遷移.md`「START_EVENT」#2）で呼ぶ関数そのもので、
 * 継続回復と継続ダメージを1回の走査で付与順に解決する配線ごと観測へ載せる。
 * `applyOneContinuousDamage` を直接呼ぶと「行動開始で発火するか」も
 * 「継続回復と同じ順で解決するか」も観測の外に落ちる。
 *
 * シールド枯渇の失効（R-SHD-01第3項）とPS連鎖も production の呼び出し側と同じ形で
 * 注入する。固定継続ダメージがシールドを削り切ったとき、実戦闘では
 * `EffectExpired`（`SHIELD_DEPLETED`）まで進む。
 */

/** `ContinuousDamageApplied` payload のうち、R-DOT-01〜04の意味を決める欄だけ。 */
export interface ObservedContinuousDamage {
  readonly unitId: string;
  readonly effectActionDefinitionId: string;
  readonly continuousDamageKind: string;
  readonly damageType: string;
  /** R-DOT-01: 付与時に記録した付与者攻撃力。 */
  readonly snapshotAttack: number;
  /** 切り捨て・最低1ダメージ・炎上2倍の適用前の素の算出値。 */
  readonly formulaResult: number;
  /** R-DOT-03: 対象が炎上を3つ保持しているとき `2`。 */
  readonly burnStackMultiplier: number;
  /** R-DOT-04: `付与時攻撃力 × 100%` で頭打ちになったか。 */
  readonly cappedBySnapshotAttack: boolean;
  readonly calculatedDamage: number;
  readonly typedShieldAbsorbed: number;
  readonly untypedShieldAbsorbed: number;
  readonly subUnitAbsorbed: number;
  readonly discardedDamage: number;
  readonly hitPointDamage: number;
}

export interface ObservedContinuousDamageStep {
  /** `ACTION_START(enemy:front)`。 */
  readonly step: string;
  /** この行動開始で発生した継続ダメージ（発行順）。 */
  readonly ticks: readonly ObservedContinuousDamage[];
  /** この step で失効したインスタンスの由来定義（`EffectExpired` の発行順）。 */
  readonly expired?: readonly string[];
  /** step 開始時からのHP変化（変化したユニットだけ）。 */
  readonly hpDeltas: Readonly<Record<string, number>>;
}

export interface ContinuousDamageObservation {
  readonly steps: readonly ObservedContinuousDamageStep[];
  readonly units: readonly BattleUnit[];
  readonly recorder: EventRecorder;
}

export interface ContinuousDamageOptions {
  readonly units: readonly BattleUnit[];
  readonly definitions: BattleDefinitions;
  /** 行動開始を通すユニット。指定順に1回ずつ `ActionStarted` を発行する。 */
  readonly actors: readonly string[];
  readonly battleId?: string;
}

function ticksOf(events: readonly BattleDomainEvent[]): readonly ObservedContinuousDamage[] {
  return events
    .filter(
      (event): event is Extract<BattleDomainEvent, { eventType: "ContinuousDamageApplied" }> =>
        event.eventType === "ContinuousDamageApplied",
    )
    .map((event) => ({
      unitId: String(event.payload.targetUnitId),
      effectActionDefinitionId: String(event.payload.effectActionDefinitionId),
      continuousDamageKind: event.payload.continuousDamageKind,
      damageType: event.payload.damageType,
      snapshotAttack: event.payload.snapshotAttack,
      formulaResult: event.payload.formulaResult,
      burnStackMultiplier: event.payload.burnStackMultiplier,
      cappedBySnapshotAttack: event.payload.cappedBySnapshotAttack,
      calculatedDamage: event.payload.calculatedDamage,
      typedShieldAbsorbed: event.payload.typedShieldAbsorbed,
      untypedShieldAbsorbed: event.payload.untypedShieldAbsorbed,
      subUnitAbsorbed: event.payload.subUnitAbsorbed,
      discardedDamage: event.payload.discardedDamage,
      hitPointDamage: event.payload.hitPointDamage,
    }));
}

function expiredOf(events: readonly BattleDomainEvent[]): readonly string[] {
  return events
    .filter(
      (event): event is Extract<BattleDomainEvent, { eventType: "EffectExpired" }> =>
        event.eventType === "EffectExpired",
    )
    .map((event) => String(event.payload.effectActionDefinitionId));
}

function hpOf(units: readonly BattleUnit[]): Record<string, number> {
  return Object.fromEntries(units.map((unit) => [String(unit.battleUnitId), unit.currentHp]));
}

function hpDeltasBetween(
  after: readonly BattleUnit[],
  before: Readonly<Record<string, number>>,
): Record<string, number> {
  const deltas: Record<string, number> = {};
  for (const [unitId, hp] of Object.entries(hpOf(after))) {
    const previous = before[unitId];
    if (previous !== undefined && previous !== hp) {
      deltas[unitId] = hp - previous;
    }
  }
  return deltas;
}

/**
 * `actors` の行動開始を順に通し、step ごとに発生した継続ダメージ・失効・HP変化を返す。
 * 戻り値は表の期待値と `toEqual` で突き合わせる前提の正規形。
 */
export function observeContinuousDamage(
  options: ContinuousDamageOptions,
): ContinuousDamageObservation {
  const recorder = new EventRecorder(createBattleId(options.battleId ?? "B_DOT"));
  // 会心・確率抽選をすべて「外れ側」へ倒し、継続ダメージだけを観測に残す。
  const random = new SequenceRandomSource(new Array<number>(64).fill(0.99));
  let units = options.units;
  const steps: ObservedContinuousDamageStep[] = [];

  for (const actor of options.actors) {
    const actorUnitId = createBattleUnitId(actor);
    const hpBefore = hpOf(units);
    const eventsBefore = recorder.getEvents().length;
    const resolutionScopeId = recorder.nextResolutionScopeId();
    const actionId = recorder.nextActionId();
    const actionStarted = recorder.record({
      eventType: "ActionStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      actionId,
      resolutionScopeId,
      sourceUnitId: actorUnitId,
      payload: {
        actorUnitId,
        reservedActionType: "AS",
        effectiveActionType: "AS",
        apBefore: 1,
        apAfter: 0,
        exBefore: 0,
        exAfter: 0,
      },
    });
    const eventContext = {
      recorder,
      turnNumber: 1,
      cycleNumber: 1,
      actionId,
      resolutionScopeId,
      rootEventId: actionStarted.eventId,
    };
    // production の各 resolver と同じく、行動専用の runtime を発火より前に生成して
    // `ContinuousDamageApplied` 起点のPS連鎖を同じ解決スコープへ繋ぐ。
    const passiveRuntime = new PassiveActivationRuntime(
      { definitions: options.definitions, random, ...eventContext },
      units,
    );

    units = fireContinuousHealsOnActionStart(
      units,
      actorUnitId,
      {
        ...eventContext,
        // 回復元（`sourceUnitId`）と親イベントはインスタンスごとに解決されるため、
        // ここでは渡さない（`fireContinuousHealsOnActionStart` の契約）。
        effectActions: options.definitions.effectActions,
        continuousDamage: {
          effectActions: options.definitions.effectActions,
          expireDepletedAbsorbers: (
            targetUnitId: BattleUnitId,
            depletedEffectInstanceIds: readonly EffectInstanceId[],
            reason: DepletedAbsorberReason,
            unitsForExpiry: readonly BattleUnit[],
            parentEventId: DomainEventId,
          ) =>
            expireEffectsSteps(
              eventContext,
              unitsForExpiry,
              depletedEffectInstanceIds.map((effectInstanceId) => ({
                battleUnitId: targetUnitId,
                effectInstanceId,
                reason,
              })),
              options.definitions.effectActions,
              parentEventId,
            ),
        },
      },
      actionStarted.eventId,
      (event, unitsForChain) => passiveRuntime.onFactEvent(event, unitsForChain).units,
    ).units;

    const emitted = recorder.getEvents().slice(eventsBefore);
    const expired = expiredOf(emitted);
    steps.push({
      step: `ACTION_START(${actor})`,
      ticks: ticksOf(emitted),
      ...(expired.length === 0 ? {} : { expired }),
      hpDeltas: hpDeltasBetween(units, hpBefore),
    });
  }

  return { steps, units, recorder };
}
