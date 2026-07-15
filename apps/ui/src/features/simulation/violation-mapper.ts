// docs/ui-design/03_API・データ連携設計.md §13 「JSON Pointerとの対応」:
// サーバー violations[].path を元のslotKeyへ対応づける
// (UI-API-004)。送信DTOの units[n] とslotKeyの対応表は
// features/formation/request-mapper.ts の allyUnitSlotKeys/enemyUnitSlotKeys。

import type { UiViolation } from "../formation/draft-validation.js";
import type { ViolationResponseBody } from "./api-contract.js";

const UNIT_PATH_PATTERN = /^\/(allyFormation|enemyFormation)\/units\/(\d+)(?:\/.*)?$/;
const MEMORY_PATH_PATTERN = /^\/(allyFormation|enemyFormation)\/memoryDefinitionIds\/(\d+)$/;

interface SlotKeyMaps {
  readonly allyUnitSlotKeys: readonly string[];
  readonly enemyUnitSlotKeys: readonly string[];
  // request-mapper.ts compresses memoryDefinitionIds (empty slots removed),
  // so the API array index does not equal the UI memory slot index. These
  // maps are index-aligned with the compressed array the server actually saw,
  // captured at submission time — the raw API index must never be fed
  // directly into memorySlotKeyOf.
  readonly allyMemorySlotKeys: readonly string[];
  readonly enemyMemorySlotKeys: readonly string[];
}

function resolveSlotKey(path: string, maps: SlotKeyMaps): string | undefined {
  const unitMatch = UNIT_PATH_PATTERN.exec(path);
  if (unitMatch !== null) {
    const [, formation, indexText] = unitMatch;
    const index = Number(indexText);
    const slotKeys = formation === "allyFormation" ? maps.allyUnitSlotKeys : maps.enemyUnitSlotKeys;
    return slotKeys[index];
  }

  const memoryMatch = MEMORY_PATH_PATTERN.exec(path);
  if (memoryMatch !== null) {
    const [, formation, indexText] = memoryMatch;
    const index = Number(indexText);
    const slotKeys =
      formation === "allyFormation" ? maps.allyMemorySlotKeys : maps.enemyMemorySlotKeys;
    return slotKeys[index];
  }

  return undefined;
}

export function mapServerViolationsToUiViolations(
  violations: readonly ViolationResponseBody[],
  allyUnitSlotKeys: readonly string[],
  enemyUnitSlotKeys: readonly string[],
  allyMemorySlotKeys: readonly string[],
  enemyMemorySlotKeys: readonly string[],
): readonly UiViolation[] {
  const maps: SlotKeyMaps = {
    allyUnitSlotKeys,
    enemyUnitSlotKeys,
    allyMemorySlotKeys,
    enemyMemorySlotKeys,
  };
  return violations.map((violation) => {
    const path = violation.path ?? "";
    const slotKey = resolveSlotKey(path, maps);
    return {
      path,
      ...(slotKey !== undefined ? { slotKey } : {}),
      code: violation.ruleId ?? "SERVER_VIOLATION",
      message: violation.message,
      severity: "error",
    };
  });
}
