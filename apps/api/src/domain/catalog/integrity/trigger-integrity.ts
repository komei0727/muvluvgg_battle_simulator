import { conditionContainsKind } from "./condition-inspection.js";
import {
  DIAGNOSTIC_ONLY_EVENT_TYPES,
  EVENT_TYPE_CATEGORIES,
} from "../definitions/catalog-event-types.js";
import type { TriggerDefinition } from "../definitions/trigger-definition.js";
import type { CatalogIntegrityViolation } from "./catalog-integrity-violation.js";

/**
 * R-ATM-04「効果処理中TIMINGイベントのトリガー禁止」: 効果処理フェーズの内部で
 * 発行されるTIMINGイベント。監査・診断用の観測イベントとして発行自体は続けるが、
 * PS/Memoryの発動契機（`TriggerDefinition.eventType`）には使えない — 効果処理の
 * アトミック性（`R-ATM-01`）を破る唯一の残り経路であるため、Catalogロード時に拒否する。
 * 効果処理の外で発行されるTIMINGイベント（`SkillUseStarting`・`UnitBeingAttacked`・
 * `ActionCompleting`・`TurnCompleting`）は引き続き発動契機に使える。
 */
const EFFECT_PROCESSING_TIMING_EVENT_TYPES: ReadonlySet<string> = new Set([
  "DamageWillBeApplied",
  "EffectStepStarting",
  "EffectActionStarting",
]);

/** R-PS-01: payloadに`hpBefore`/`hpAfter`を持ち、HPが減る向きにだけ発行されるイベント。 */
const HP_RATIO_CROSSED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "HitPointReduced",
  "ContinuousDamageApplied",
]);

/**
 * `TriggerDefinition.eventType`の閉リスト検証。`trigger-definition.ts`は単体の
 * Shape検証しか行えず、イベント種別の台帳（`catalog-event-types.ts`）との突き合わせを
 * ここへ委ねている（issue #7）。
 */
export function validateTrigger(
  trigger: TriggerDefinition,
  targetId: string,
  violations: CatalogIntegrityViolation[],
): void {
  const documentedCategory = EVENT_TYPE_CATEGORIES[trigger.eventType];
  if (documentedCategory === undefined) {
    const isDiagnosticOnly = DIAGNOSTIC_ONLY_EVENT_TYPES.has(trigger.eventType);
    violations.push({
      targetId,
      rule: "UNKNOWN_EVENT_TYPE",
      message: isDiagnosticOnly
        ? `references DIAGNOSTIC-only eventType "${trigger.eventType}", which cannot be a Trigger target`
        : `references unknown eventType "${trigger.eventType}"`,
    });
    return;
  }
  if (EFFECT_PROCESSING_TIMING_EVENT_TYPES.has(trigger.eventType)) {
    violations.push({
      targetId,
      rule: "EFFECT_PROCESSING_TIMING_EVENT_TRIGGER",
      message: `references eventType "${trigger.eventType}", which is emitted inside the effect processing phase and cannot be a Trigger target (R-ATM-04)`,
    });
    return;
  }
  // R-PS-01: `HP_RATIO_CROSSED`は契機イベントpayloadの`hpBefore`/`hpAfter`を読む。
  // それを持たないイベントでは決して成立しないため、黙って発動しないPSを作らせない。
  if (
    trigger.condition !== undefined &&
    conditionContainsKind(trigger.condition, "HP_RATIO_CROSSED") &&
    !HP_RATIO_CROSSED_EVENT_TYPES.has(trigger.eventType)
  ) {
    violations.push({
      targetId,
      rule: "HP_RATIO_CROSSED_UNSUPPORTED_EVENT",
      message: `an HP_RATIO_CROSSED condition reads hpBefore/hpAfter, which eventType "${trigger.eventType}" does not carry (supported: ${[...HP_RATIO_CROSSED_EVENT_TYPES].join(", ")})`,
    });
  }
  if (documentedCategory !== trigger.category) {
    violations.push({
      targetId,
      rule: "EVENT_CATEGORY_MISMATCH",
      message: `eventType "${trigger.eventType}" is documented as category "${documentedCategory}", but declares category "${trigger.category}"`,
    });
  }
}
