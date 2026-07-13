import type { Violation } from "./application-error.js";
import type { MemoryDefinitionId, UnitDefinitionId } from "../domain/catalog/catalog-ids.js";

/**
 * `09_アプリケーション設計.md` の SimulateBattleCommand. `column`/`row` は
 * 各陣営から見た表現(`0|1|2`, `FRONT|REAR`)を使い、Domainの共通座標表現
 * (`LEFT|CENTER|RIGHT`, `FRONT|BACK`)への変換はApplication層が担う。
 * `unitDefinitionId`/`memoryDefinitionId` はInbound Adapter(#11、未実装)が
 * 外部形式検証の一部としてブランド型へ変換済みである前提とする。
 */
export interface FormationPositionInput {
  readonly column: 0 | 1 | 2;
  readonly row: "FRONT" | "REAR";
}

export interface FormationSlotInput {
  readonly unitDefinitionId: UnitDefinitionId;
  readonly position: FormationPositionInput;
}

export interface FormationInput {
  readonly slots: readonly FormationSlotInput[];
  readonly memoryDefinitionIds: readonly MemoryDefinitionId[];
}

export const LOG_LEVELS = ["SUMMARY", "DETAILED", "DIAGNOSTIC"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface SimulateBattleCommand {
  readonly allyFormation: FormationInput;
  readonly enemyFormation: FormationInput;
  readonly turnLimit: number;
  readonly logLevel: LogLevel;
}

const MIN_SLOTS = 1;
const MAX_SLOTS = 5;
const MAX_MEMORY_DEFINITION_IDS = 6;
const VALID_COLUMNS: readonly number[] = [0, 1, 2];
const VALID_ROWS: readonly string[] = ["FRONT", "REAR"];

function positionKey(position: FormationPositionInput): string {
  return `${position.column}:${position.row}`;
}

/** `09_アプリケーション設計.md`「Command検証」: `column`が0～2、`rowがFRONT`または`REAR`であることを検証する。 */
function validatePosition(
  position: FormationPositionInput,
  path: string,
  violations: Violation[],
): void {
  if (!VALID_COLUMNS.includes(position.column)) {
    violations.push({
      path: `${path}.column`,
      reason: `must be one of [${VALID_COLUMNS.join(", ")}], got ${JSON.stringify(position.column)}`,
    });
  }
  if (!VALID_ROWS.includes(position.row)) {
    violations.push({
      path: `${path}.row`,
      reason: `must be one of [${VALID_ROWS.join(", ")}], got ${JSON.stringify(position.row)}`,
    });
  }
}

function validateFormation(formation: FormationInput, path: string, violations: Violation[]): void {
  if (formation.slots.length < MIN_SLOTS || formation.slots.length > MAX_SLOTS) {
    violations.push({
      path: `${path}.slots`,
      reason: `must contain between ${MIN_SLOTS} and ${MAX_SLOTS} units, got ${formation.slots.length}`,
    });
  }

  const seenPositions = new Set<string>();
  formation.slots.forEach((slot, index) => {
    validatePosition(slot.position, `${path}.slots[${index}].position`, violations);

    const key = positionKey(slot.position);
    if (seenPositions.has(key)) {
      violations.push({
        path: `${path}.slots[${index}].position`,
        reason: `position ${key} is already occupied within this formation`,
      });
    }
    seenPositions.add(key);
  });

  if (formation.memoryDefinitionIds.length > MAX_MEMORY_DEFINITION_IDS) {
    violations.push({
      path: `${path}.memoryDefinitionIds`,
      reason: `must contain at most ${MAX_MEMORY_DEFINITION_IDS} memory IDs, got ${formation.memoryDefinitionIds.length}`,
    });
  }
}

/**
 * `09_アプリケーション設計.md`「Command検証」段階: 人数、件数、値域、配置重複を
 * 可能な限りすべて収集して返す。Catalogへは一切アクセスしない
 * （ユニット・メモリーIDの存在確認は「参照検証」段階の責務）。
 */
export function validateCommandShape(command: SimulateBattleCommand): Violation[] {
  const violations: Violation[] = [];

  if (!Number.isInteger(command.turnLimit) || command.turnLimit < 1 || command.turnLimit > 99) {
    violations.push({
      path: "turnLimit",
      reason: `must be an integer between 1 and 99, got ${command.turnLimit}`,
    });
  }

  validateFormation(command.allyFormation, "allyFormation", violations);
  validateFormation(command.enemyFormation, "enemyFormation", violations);

  if (!LOG_LEVELS.includes(command.logLevel)) {
    violations.push({
      path: "logLevel",
      reason: `must be one of [${LOG_LEVELS.join(", ")}], got "${String(command.logLevel)}"`,
    });
  }

  return violations;
}
