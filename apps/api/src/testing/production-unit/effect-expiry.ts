import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import {
  emitEffectDurationReducedEvents,
  expireEffects,
  type ExpirationSeed,
} from "../../domain/battle/effects/duration-expiry-service.js";
import { recordActionCompletion } from "../../domain/battle/resolution/action-completion.js";
import { decrementTurnEffectDurations } from "../../domain/battle/model/applied-effect-duration.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { CombatStats } from "../../domain/battle/model/starting-combat-stats.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";

/**
 * ユニット効果軸の `-004` 以降が使う「付与された効果が、**以後の行動・ターンを
 * 跨いで**どう減り、いつ失効し、失効で CombatStat が戻るか」を観測するハーネス。
 *
 * `-001` の振る舞い表は**スキル使用1回**を単位とするため、`duration` の宣言
 * （`timeLimit` の単位・回数・owner、`consumption` の種別・上限）は
 * `AppliedEffect.duration.definition` から観測へ載るが、**残り回数が誰の行動で
 * 減るか**（R-EFF-04 の owner 解決）・**0で失効すること**（R-EFF-06）・
 * **失効で効果が巻き戻ること**・**linkedEffectGroup の巻き添え失効**（R-EFF-09）は
 * 構造的に表せない。ここがその境界だけを引き受ける。
 *
 * 行動終了は実ライフサイクル（`action-completion.ts` の `recordActionCompletion`）を
 * そのまま通す — 減算・失効・CombatStat再計算の配線ごと観測へ載せるためで、
 * `decrementActionEffectDurations` を直接呼ぶと「実装がその順で呼んでいるか」が
 * 観測の外に落ちる。ターン終了は `battle.ts` の TURN_ENDING #5-7 と同じ3手順
 * （減算 → `EffectDurationReduced` → 失効）を同じ順で通す（`advanceBattle` は
 * 行動フェーズまで進めてしまい、境界だけを取り出せない）。
 */

export type ExpiryStep =
  | {
      /** 1行動の終了。`actor` の行動終了として R-EFF-04 の owner 解決を通す。 */
      readonly kind: "ACTION_END";
      readonly actor: string;
    }
  | {
      /** 1ターンの終了。R-EFF-06 は行動者を問わず全ユニットで1減らす。 */
      readonly kind: "TURN_END";
    };

/** `EffectExpired` payload のうち、失効の意味を決める欄だけ。 */
export interface ObservedExpiry {
  readonly unitId: string;
  readonly effectActionDefinitionId: string;
  readonly reason: string;
  /** linkedEffectGroup の巻き添えで失効した子効果だけが `true`。 */
  readonly cascaded: boolean;
}

export interface ObservedExpiryStep {
  /** `ACTION_END(ally:subject)` / `TURN_END(2)`。 */
  readonly step: string;
  /**
   * 期間・消費回数を持つ効果の残り（`<unitId>/<ACT_ID>`）。失効するとキーごと
   * 落ちるため、`toEqual` の完全一致が「減ったこと」と「消えたこと」を同時に固定する。
   * 同一ユニットへ同じ定義が複数付いている場合は2件目以降を `#2`・`#3` で表す。
   */
  readonly remaining: Readonly<Record<string, number>>;
  /** この step で失効したインスタンス（`EffectExpired` の発行順）。 */
  readonly expired?: readonly ObservedExpiry[];
  /** `watch` した CombatStat のうち、直前の step から変化したものだけ。 */
  readonly stats?: Readonly<Record<string, number>>;
  /**
   * `watchShields` を渡したときだけ現れる、シールド残量（`<unitId>/<ACT_ID>`）。
   * `APPLY_SHIELD.decay`（R-SHD-01第3項）の漸減は `duration` を一切動かさないため
   * `remaining` には現れず、枯渇して失効した瞬間にキーごと落ちる。
   */
  readonly shields?: Readonly<Record<string, number>>;
}

export interface EffectExpiryOptions {
  readonly units: readonly BattleUnit[];
  readonly definitions: BattleDefinitions;
  readonly steps: readonly ExpiryStep[];
  /**
   * 失効で巻き戻るはずの CombatStat。`<unitId>/<stat>` を key に、開始時点から
   * 変化した step でだけ観測へ現れる。
   */
  readonly watch?: readonly { readonly unitId: string; readonly stat: keyof CombatStats }[];
  /** シールド残量を step ごとに観測するユニット。省略すると `shields` は現れない。 */
  readonly watchShields?: readonly string[];
  readonly battleId?: string;
}

export interface EffectExpiryObservation {
  readonly steps: readonly ObservedExpiryStep[];
  readonly units: readonly BattleUnit[];
  readonly recorder: EventRecorder;
}

/** 期間つき効果の残りを `<unitId>/<ACT_ID>` の表にする。 */
function remainingOf(units: readonly BattleUnit[]): Record<string, number> {
  const remaining: Record<string, number> = {};
  for (const unit of units) {
    for (const effect of unit.appliedEffects) {
      const value = effect.duration.timeLimitRemaining ?? effect.duration.consumptionRemaining;
      if (value === undefined) {
        continue;
      }
      const base = `${unit.battleUnitId}/${effect.effectActionDefinitionId}`;
      let key = base;
      for (let index = 2; key in remaining; index += 1) {
        key = `${base}#${index}`;
      }
      remaining[key] = value;
    }
  }
  return remaining;
}

/** 指定ユニットが保持するシールドの残量を `<unitId>/<ACT_ID>` の表にする。 */
function shieldsOf(
  units: readonly BattleUnit[],
  watchShields: EffectExpiryOptions["watchShields"],
): Record<string, number> {
  const shields: Record<string, number> = {};
  for (const unitId of watchShields ?? []) {
    const unit = units.find((candidate) => candidate.battleUnitId === unitId);
    if (unit === undefined) {
      throw new Error(`no unit "${unitId}" on the board`);
    }
    for (const effect of unit.appliedEffects) {
      if (effect.shield === undefined) {
        continue;
      }
      shields[`${unitId}/${effect.effectActionDefinitionId}`] = effect.shield.remaining;
    }
  }
  return shields;
}

function statsOf(
  units: readonly BattleUnit[],
  watch: EffectExpiryOptions["watch"],
): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const entry of watch ?? []) {
    const unit = units.find((candidate) => candidate.battleUnitId === entry.unitId);
    if (unit === undefined) {
      throw new Error(`no unit "${entry.unitId}" on the board`);
    }
    stats[`${entry.unitId}/${entry.stat}`] = unit.combatStats[entry.stat];
  }
  return stats;
}

function expiriesOf(events: readonly BattleDomainEvent[]): readonly ObservedExpiry[] {
  return events
    .filter(
      (event): event is Extract<BattleDomainEvent, { eventType: "EffectExpired" }> =>
        event.eventType === "EffectExpired",
    )
    .map((event) => ({
      unitId: event.payload.battleUnitId,
      effectActionDefinitionId: event.payload.effectActionDefinitionId,
      reason: event.payload.reason,
      cascaded: event.payload.cascaded === true,
    }));
}

function changedStats(
  after: Readonly<Record<string, number>>,
  before: Readonly<Record<string, number>>,
): Record<string, number> {
  const changed: Record<string, number> = {};
  for (const [key, value] of Object.entries(after)) {
    if (before[key] !== value) {
      changed[key] = value;
    }
  }
  return changed;
}

/**
 * 行動終了・ターン終了を順に通し、step ごとの残り回数・失効・CombatStat変化を返す。
 * 戻り値は表の期待値と `toEqual` で突き合わせる前提の正規形。
 */
export function observeEffectExpiry(options: EffectExpiryOptions): EffectExpiryObservation {
  const recorder = new EventRecorder(createBattleId(options.battleId ?? "B_EXPIRY"));
  let units = options.units;
  let previousStats = statsOf(units, options.watch);
  // ターン番号は行動終了では進めない（`timeLimit.unit: TURN` の効果が行動終了で
  // 減らないことを、同じ観測の中で対照として見られるようにする）。
  let turnNumber = 1;
  const observed: ObservedExpiryStep[] = [];

  for (const step of options.steps) {
    const eventsBefore = recorder.getEvents().length;
    const resolutionScopeId = recorder.nextResolutionScopeId();

    if (step.kind === "ACTION_END") {
      const actionId = recorder.nextActionId();
      const actionStarted = recorder.record({
        eventType: "ActionStarted",
        category: "FACT",
        turnNumber,
        cycleNumber: 1,
        actionId,
        resolutionScopeId,
        payload: {
          actorUnitId: createBattleUnitId(step.actor),
          reservedActionType: "AS",
          effectiveActionType: "AS",
          apBefore: 1,
          apAfter: 0,
          exBefore: 0,
          exAfter: 0,
        },
      });
      units = recordActionCompletion(
        recorder,
        {
          actionId,
          resolutionScopeId,
          rootEventId: actionStarted.eventId,
          turnNumber,
          cycleNumber: 1,
          actorUnitId: createBattleUnitId(step.actor),
          effectActions: options.definitions.effectActions,
        },
        "AS",
        actionStarted.eventId,
        units,
      ).units;
    } else {
      turnNumber += 1;
      const turnCompleting = recorder.record({
        eventType: "TurnCompleting",
        category: "TIMING",
        turnNumber,
        cycleNumber: 0,
        resolutionScopeId,
        payload: { turnNumber },
      });
      // `battle.ts` TURN_ENDING #5-7 と同じ3手順・同じ順序。
      const decrement = decrementTurnEffectDurations(units, turnNumber);
      units = decrement.units;
      if (decrement.changes.length > 0) {
        const eventContext = {
          recorder,
          turnNumber,
          cycleNumber: 0,
          resolutionScopeId,
          rootEventId: turnCompleting.eventId,
        };
        const lastEventId = emitEffectDurationReducedEvents(
          eventContext,
          units,
          decrement.changes,
          turnCompleting.eventId,
        );
        const seeds: ExpirationSeed[] = decrement.changes
          .filter((change) => change.after === 0)
          .map((change) => ({
            battleUnitId: change.battleUnitId,
            effectInstanceId: change.effectInstanceId,
            reason: "TIME_LIMIT",
          }));
        if (seeds.length > 0) {
          units = expireEffects(
            eventContext,
            units,
            seeds,
            options.definitions.effectActions,
            lastEventId,
          ).units;
        }
      }
    }

    const stats = statsOf(units, options.watch);
    const changed = changedStats(stats, previousStats);
    previousStats = stats;
    const expired = expiriesOf(recorder.getEvents().slice(eventsBefore));
    observed.push({
      step: step.kind === "ACTION_END" ? `ACTION_END(${step.actor})` : `TURN_END(${turnNumber})`,
      remaining: remainingOf(units),
      ...(expired.length === 0 ? {} : { expired }),
      ...(Object.keys(changed).length === 0 ? {} : { stats: changed }),
      ...(options.watchShields === undefined
        ? {}
        : { shields: shieldsOf(units, options.watchShields) }),
    });
  }

  return { steps: observed, units, recorder };
}

/**
 * 失効の契機を実経路で作れない効果（`timeLimit.unit: BATTLE` の linkedEffectGroup
 * 親など）のために、指定インスタンス1件だけを名指しで失効させる。
 *
 * 呼び出すのは**カスケードそのもの**（R-EFF-09）を見るテストに限る — 親を失効
 * させる契機の側は他のルール（R-EFF-04/06/07・R-EFF-02）が持つ責務であり、
 * ここで作りたいのは「親が失効した」という一点だけである。
 */
export function expireInstance(options: {
  readonly units: readonly BattleUnit[];
  readonly definitions: BattleDefinitions;
  readonly unitId: string;
  readonly effectActionDefinitionId: string;
  readonly reason: ExpirationSeed["reason"];
  readonly battleId?: string;
}): {
  readonly units: readonly BattleUnit[];
  readonly expired: readonly ObservedExpiry[];
  readonly recorder: EventRecorder;
} {
  const recorder = new EventRecorder(createBattleId(options.battleId ?? "B_EXPIRY"));
  const resolutionScopeId = recorder.nextResolutionScopeId();
  const seed = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    resolutionScopeId,
    payload: { turnNumber: 1 },
  });
  const holder = options.units.find((unit) => unit.battleUnitId === options.unitId);
  const target = holder?.appliedEffects.find(
    (effect) => effect.effectActionDefinitionId === options.effectActionDefinitionId,
  );
  if (target === undefined) {
    throw new Error(`"${options.unitId}" holds no "${options.effectActionDefinitionId}" to expire`);
  }
  const result = expireEffects(
    { recorder, turnNumber: 1, cycleNumber: 1, resolutionScopeId, rootEventId: seed.eventId },
    options.units,
    [
      {
        battleUnitId: createBattleUnitId(options.unitId),
        effectInstanceId: target.effectInstanceId,
        reason: options.reason,
      },
    ],
    options.definitions.effectActions,
    seed.eventId,
  );
  return { units: result.units, expired: expiriesOf(recorder.getEvents()), recorder };
}
