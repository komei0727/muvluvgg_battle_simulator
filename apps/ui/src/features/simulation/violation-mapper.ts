// docs/ui-design/03_API・データ連携設計.md §13 「JSON Pointerとの対応」:
// サーバー violations[].path を元のslotKeyへ対応づける
// (UI-API-004)。送信DTOの units[n] とslotKeyの対応表は
// features/formation/request-mapper.ts の allyUnitSlotKeys/enemyUnitSlotKeys。

import type { UiViolation } from "../formation/draft-validation.js";
import type { ViolationResponseBody } from "./api-contract.js";

const UNIT_PATH_PATTERN = /^\/(allyFormation|enemyFormation)\/units\/(\d+)(?:\/.*)?$/;

function resolveSlotKey(
  path: string,
  allyUnitSlotKeys: readonly string[],
  enemyUnitSlotKeys: readonly string[],
): string | undefined {
  const match = UNIT_PATH_PATTERN.exec(path);
  if (match === null) {
    return undefined;
  }
  const [, formation, indexText] = match;
  const index = Number(indexText);
  const slotKeys = formation === "allyFormation" ? allyUnitSlotKeys : enemyUnitSlotKeys;
  return slotKeys[index];
}

export function mapServerViolationsToUiViolations(
  violations: readonly ViolationResponseBody[],
  allyUnitSlotKeys: readonly string[],
  enemyUnitSlotKeys: readonly string[],
): readonly UiViolation[] {
  return violations.map((violation) => {
    const path = violation.path ?? "";
    const slotKey = resolveSlotKey(path, allyUnitSlotKeys, enemyUnitSlotKeys);
    return {
      path,
      ...(slotKey !== undefined ? { slotKey } : {}),
      code: violation.ruleId ?? "SERVER_VIOLATION",
      message: violation.message,
      severity: "error",
    };
  });
}
