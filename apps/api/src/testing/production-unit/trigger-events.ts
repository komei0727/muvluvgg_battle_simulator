import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { SkillType } from "../../domain/catalog/definitions/catalog-enums.js";
import { createDomainEventId } from "../../domain/shared/event-ids.js";
import { createBattleUnitId } from "../../domain/shared/ids.js";
import type { PassiveTriggerEvent } from "./passive-activation.js";

/**
 * PSの契機イベントを、production の `trigger` が読む欄だけ埋めて組み立てる。
 *
 * PSは `eventType` / `sourceSelector` / `targetSelector` / `condition` の4点で
 * 候補化されるため、テスト側が用意すべきなのは「どの種別のイベントが、誰から誰へ
 * 発行されたか」と、条件が読む payload 欄だけである。ここを型付きの factory へ
 * 寄せることで、表の行は `unitDefeated({ unit: "ally:front" })` のように
 * **原文の契機をそのまま書ける**。
 *
 * 実イベントとの差: ターン境界（`TurnStarted`/`TurnCompleting`）は本来 `actionId` を
 * 持たない行動外のトップレベルイベントだが、このハーネスは行動envelopeの中で
 * 発行する。行動単位期間の初回減算除外（R-EFF-04）の扱いだけが実戦闘と異なり得る。
 * 発行地点そのものの検証は機能軸（`turn-boundary-self-selector`）が持つ。
 */

const SYNTHETIC_CAUSE_EVENT_ID = createDomainEventId("B_BEHAVIOUR:cause");
const SYNTHETIC_SKILL_ID = createSkillDefinitionId("SKL_TEST_TRIGGER_SOURCE");
const SYNTHETIC_ACTION_ID = createEffectActionDefinitionId("ACT_TEST_TRIGGER_SOURCE");

/** 敵の攻撃が対象へ当たる直前（R-EFF-07 の消費点）。 */
export function unitBeingAttacked(options: {
  readonly source: string;
  readonly target: string;
}): PassiveTriggerEvent<"UnitBeingAttacked"> {
  return {
    eventType: "UnitBeingAttacked",
    category: "TIMING",
    sourceUnitId: createBattleUnitId(options.source),
    targetUnitIds: [createBattleUnitId(options.target)],
    payload: {
      skillDefinitionId: SYNTHETIC_SKILL_ID,
      effectActionDefinitionId: SYNTHETIC_ACTION_ID,
      hitIndex: 1,
      targetUnitId: createBattleUnitId(options.target),
    },
  };
}

/** スキル使用の開始直前。`skillType` を条件に読むPSが多い。 */
export function skillUseStarting(options: {
  readonly actor: string;
  readonly targets: readonly string[];
  readonly skillType: SkillType;
}): PassiveTriggerEvent<"SkillUseStarting"> {
  const targetUnitIds = options.targets.map((id) => createBattleUnitId(id));
  return {
    eventType: "SkillUseStarting",
    category: "TIMING",
    sourceUnitId: createBattleUnitId(options.actor),
    targetUnitIds,
    payload: {
      skillDefinitionId: SYNTHETIC_SKILL_ID,
      skillType: options.skillType,
      actorUnitId: createBattleUnitId(options.actor),
      targetUnitIds,
      costResource: "AP",
      costAmount: 1,
    },
  };
}

/** スキル使用の完了。 */
export function skillUseCompleted(options: {
  readonly actor: string;
  readonly targets: readonly string[];
  readonly skillType: SkillType;
}): PassiveTriggerEvent<"SkillUseCompleted"> {
  const targetUnitIds = options.targets.map((id) => createBattleUnitId(id));
  return {
    eventType: "SkillUseCompleted",
    category: "FACT",
    sourceUnitId: createBattleUnitId(options.actor),
    targetUnitIds,
    payload: {
      skillDefinitionId: SYNTHETIC_SKILL_ID,
      skillType: options.skillType,
      resolvedStepCount: 1,
      targetUnitIds,
    },
  };
}

/** ターン開始。`sourceSelector: SELF` のPSは保持者自身を発生源として受け取る。 */
export function turnStarted(options: {
  readonly unit: string;
  readonly turnNumber: number;
}): PassiveTriggerEvent<"TurnStarted"> {
  return {
    eventType: "TurnStarted",
    category: "FACT",
    sourceUnitId: createBattleUnitId(options.unit),
    targetUnitIds: [createBattleUnitId(options.unit)],
    payload: { turnNumber: options.turnNumber },
  };
}

/** ターン終了直前。 */
export function turnCompleting(options: {
  readonly unit: string;
  readonly turnNumber: number;
}): PassiveTriggerEvent<"TurnCompleting"> {
  return {
    eventType: "TurnCompleting",
    category: "TIMING",
    sourceUnitId: createBattleUnitId(options.unit),
    targetUnitIds: [createBattleUnitId(options.unit)],
    payload: { turnNumber: options.turnNumber },
  };
}

/** ユニットの戦闘不能。`defeatedBy` は `sourceSelector` の判定に使われる。 */
export function unitDefeated(options: {
  readonly unit: string;
  readonly defeatedBy: string;
}): PassiveTriggerEvent<"UnitDefeated"> {
  return {
    eventType: "UnitDefeated",
    category: "FACT",
    sourceUnitId: createBattleUnitId(options.defeatedBy),
    targetUnitIds: [createBattleUnitId(options.unit)],
    payload: {
      unitId: createBattleUnitId(options.unit),
      // 実戦闘では致命打のイベントIDが入る。候補検出は参照しないため合成値を使う。
      causeEventId: SYNTHETIC_CAUSE_EVENT_ID,
    },
  };
}

/** 会心判定の確定。`result` を条件に読むPSがある。 */
export function criticalCheckResolved(options: {
  readonly source: string;
  readonly target: string;
  readonly result: boolean;
}): PassiveTriggerEvent<"CriticalCheckResolved"> {
  return {
    eventType: "CriticalCheckResolved",
    category: "FACT",
    sourceUnitId: createBattleUnitId(options.source),
    targetUnitIds: [createBattleUnitId(options.target)],
    payload: {
      mode: "NORMAL",
      baseCriticalRate: options.result ? 1 : 0,
      effectiveCriticalRate: options.result ? 1 : 0,
      result: options.result,
    },
  };
}

/** HP減少。HP割合を条件に読むPSの契機。 */
export function hitPointReduced(options: {
  readonly source: string;
  readonly target: string;
  readonly damage: number;
  readonly hpBefore: number;
}): PassiveTriggerEvent<"HitPointReduced"> {
  return {
    eventType: "HitPointReduced",
    category: "FACT",
    sourceUnitId: createBattleUnitId(options.source),
    targetUnitIds: [createBattleUnitId(options.target)],
    payload: {
      effectActionDefinitionId: SYNTHETIC_ACTION_ID,
      hitIndex: 1,
      targetUnitId: createBattleUnitId(options.target),
      hitPointDamage: options.damage,
      hpBefore: options.hpBefore,
      hpAfter: options.hpBefore - options.damage,
    },
  };
}
