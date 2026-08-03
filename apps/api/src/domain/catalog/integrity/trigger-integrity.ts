import {
  DIAGNOSTIC_ONLY_EVENT_TYPES,
  EVENT_TYPE_CATEGORIES,
} from "../definitions/catalog-event-types.js";
import type { TriggerDefinition } from "../definitions/trigger-definition.js";
import type { CatalogIntegrityViolation } from "./catalog-integrity-violation.js";

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
  if (documentedCategory !== trigger.category) {
    violations.push({
      targetId,
      rule: "EVENT_CATEGORY_MISMATCH",
      message: `eventType "${trigger.eventType}" is documented as category "${documentedCategory}", but declares category "${trigger.category}"`,
    });
  }
}
