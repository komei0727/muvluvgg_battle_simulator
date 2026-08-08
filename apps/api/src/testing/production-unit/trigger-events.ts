import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type {
  EffectImmunityCategory,
  SkillType,
} from "../../domain/catalog/definitions/catalog-enums.js";
import type { EffectActionKind } from "../../domain/catalog/definitions/effect-action-definition.js";
import {
  createActionId,
  createDomainEventId,
  createEffectInstanceId,
} from "../../domain/shared/event-ids.js";
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

/**
 * 敵の攻撃が対象へ当たる直前（R-EFF-07 の消費点）。`skillType` は「自身がアクティブ
 * スキルで攻撃される直前」を `EVENT_PAYLOAD` で読む trigger のために指定する。
 */
export function unitBeingAttacked(options: {
  readonly source: string;
  readonly target: string;
  readonly skillType?: SkillType;
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
      ...(options.skillType === undefined ? {} : { skillType: options.skillType }),
    },
  };
}

/**
 * スキル使用の開始直前。`skillType` を条件に読むPSが多い。
 *
 * 「自身がアクティブスキルで**攻撃する**前」を表すPSは、混乱（R-CFS-01）で対象が
 * 味方側へ反転しても発動しなければならないため、陣営ではなく `skillDefinitionId`
 * を条件に取る。その成立を作れるよう、契機の使用スキルIDを指定できる。
 */
export function skillUseStarting(options: {
  readonly actor: string;
  readonly targets: readonly string[];
  readonly skillType: SkillType;
  readonly skillDefinitionId?: string;
}): PassiveTriggerEvent<"SkillUseStarting"> {
  const targetUnitIds = options.targets.map((id) => createBattleUnitId(id));
  return {
    eventType: "SkillUseStarting",
    category: "TIMING",
    sourceUnitId: createBattleUnitId(options.actor),
    targetUnitIds,
    payload: {
      skillDefinitionId:
        options.skillDefinitionId === undefined
          ? SYNTHETIC_SKILL_ID
          : createSkillDefinitionId(options.skillDefinitionId),
      skillType: options.skillType,
      actorUnitId: createBattleUnitId(options.actor),
      targetUnitIds,
      costResource: "AP",
      costAmount: 1,
    },
  };
}

/** スキル使用の完了。`skillDefinitionId` は {@link skillUseStarting} と同じ理由で指定できる。 */
export function skillUseCompleted(options: {
  readonly actor: string;
  readonly targets: readonly string[];
  readonly skillType: SkillType;
  readonly skillDefinitionId?: string;
}): PassiveTriggerEvent<"SkillUseCompleted"> {
  const targetUnitIds = options.targets.map((id) => createBattleUnitId(id));
  return {
    eventType: "SkillUseCompleted",
    category: "FACT",
    sourceUnitId: createBattleUnitId(options.actor),
    targetUnitIds,
    payload: {
      skillDefinitionId:
        options.skillDefinitionId === undefined
          ? SYNTHETIC_SKILL_ID
          : createSkillDefinitionId(options.skillDefinitionId),
      skillType: options.skillType,
      resolvedStepCount: 1,
      targetUnitIds,
    },
  };
}

/**
 * チャージ開始。実装は「このイベントには外部の対象がなく、チャージを開始した本人
 * 自身が観測対象である」として `targetUnitIds` へ本人を入れるため、ここでも同じ形にする。
 */
export function chargeStarted(options: {
  readonly actor: string;
  readonly skillDefinitionId: string;
}): PassiveTriggerEvent<"ChargeStarted"> {
  const actorUnitId = createBattleUnitId(options.actor);
  return {
    eventType: "ChargeStarted",
    category: "FACT",
    sourceUnitId: actorUnitId,
    targetUnitIds: [actorUnitId],
    payload: {
      actorUnitId,
      skillDefinitionId: createSkillDefinitionId(options.skillDefinitionId),
      startedActionId: createActionId("B_BEHAVIOUR:action:1"),
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

/** 効果の付与。付与された効果の分類（`categories`）を条件に読むPSの契機。 */
export function effectApplied(options: {
  readonly source: string;
  readonly target: string;
  readonly effectKind: EffectActionKind;
  readonly categories: readonly EffectImmunityCategory[];
  readonly magnitude?: number;
}): PassiveTriggerEvent<"EffectApplied"> {
  return {
    eventType: "EffectApplied",
    category: "FACT",
    sourceUnitId: createBattleUnitId(options.source),
    targetUnitIds: [createBattleUnitId(options.target)],
    payload: {
      effectInstanceId: createEffectInstanceId("B_BEHAVIOUR:effect:0"),
      effectActionDefinitionId: SYNTHETIC_ACTION_ID,
      sourceUnitId: createBattleUnitId(options.source),
      targetUnitId: createBattleUnitId(options.target),
      duplicate: false,
      kindKey: SYNTHETIC_ACTION_ID,
      effectKind: options.effectKind,
      categories: options.categories,
      magnitude: options.magnitude ?? 0,
      linkedEffectGroupId: null,
    },
  };
}

/** PS 1件の解決完了。「味方のパッシブスキル発動後」を契機に持つPSが読む。 */
export function passiveResolved(options: {
  readonly actor: string;
  readonly skillDefinitionId: string;
  readonly resolvedStepCount?: number;
}): PassiveTriggerEvent<"PassiveResolved"> {
  return {
    eventType: "PassiveResolved",
    category: "FACT",
    sourceUnitId: createBattleUnitId(options.actor),
    // PS解決は対象を持つとは限らないため、実装は`targetUnitIds`を設定しない。
    // production Catalogの`targetSelector: SELF`はこの「帰属先を持たない」ことに
    // 依拠して成立する（`trigger-selector-evaluator.ts`）ので、ここでも省く。
    payload: {
      actorUnitId: createBattleUnitId(options.actor),
      skillDefinitionId: createSkillDefinitionId(options.skillDefinitionId),
      resolvedStepCount: options.resolvedStepCount ?? 1,
    },
  };
}

/**
 * ダメージ適用の完了を契機とするPSは、**契機イベントを合成せず実ダメージ
 * pipelineに出させる**（{@link RealDamageTrigger}）。`DamageApplied` payload の
 * `skillType`／`hitPointDamage` のような欄は実装が載せて初めて存在し、手組みの
 * payloadでは「条件が読む欄が実際には空である」種類の欠落を検出できないためである
 * （`SkillUseStarting` の `skillType` 欠落がまさにこの形で見逃されていた）。
 * 反撃系（`DAMAGE_RECEIVED_RATIO`）が読む「同じ解決スコープ内で直前に確定した
 * DAMAGE結果」も、実pipelineを通さなければ存在しない。
 */
export interface RealDamageTrigger {
  readonly kind: "REAL_DAMAGE";
  /** 攻撃側。`sourceSelector` の判定に使われる。 */
  readonly from: string;
  readonly to: string;
  /** 攻撃側のスキル種別。`EVENT_PAYLOAD field: "skillType"` を読む条件が参照する。 */
  readonly skillType: SkillType;
  /** `SKILL_POWER` の倍率。既定の1は「攻撃力 - 防御力」そのもの。 */
  readonly power?: number;
  /**
   * 契機として流すイベント種別。既定は `DamageApplied`。`UnitBeingAttacked` は
   * 「自身がアクティブスキルで攻撃される直前」を表すtriggerのために選ぶ — この
   * payloadの `skillType` も実装が載せて初めて存在するため、実pipelineに出させる。
   */
  readonly event?: "DamageApplied" | "HitPointReduced" | "UnitBeingAttacked";
}

/** 実ダメージpipelineが発行する `DamageApplied`／`HitPointReduced` を契機にする。 */
export function realDamage(options: Omit<RealDamageTrigger, "kind">): RealDamageTrigger {
  return { kind: "REAL_DAMAGE", ...options };
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
