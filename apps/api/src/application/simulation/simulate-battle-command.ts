import type { Violation } from "../contracts/application-error.js";
import type {
  MemoryDefinitionId,
  UnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import { STAT_KINDS } from "../../domain/catalog/definitions/catalog-enums.js";
import type { AcademyLevels } from "../../domain/battle/model/academy-level-policy.js";
import {
  GEAR_GRADES,
  GEAR_TIERS,
  MAX_GEARS_PER_UNIT,
  type GearSpecification,
} from "../../domain/battle/model/gear-customization-policy.js";

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

/**
 * `10_API設計.md`「GearRequest」に対応するCommand入力（M11）。Domainのギア指定と
 * 同形のため型を共有する（`stat`/`tier`/`grade`の列挙値の実検証は
 * `validateCommandShape`が行い、`422 INVALID_COMMAND`として返す）。
 */
export type GearInput = GearSpecification;

/** `10_API設計.md`「UnitEnhancementRequest」に対応するCommand入力（R-ENH-01 #1）。 */
export interface UnitEnhancementInput {
  readonly level?: number;
  readonly gears?: readonly GearInput[];
}

/**
 * `10_API設計.md`「FormationEnhancementRequest」に対応するCommand入力。
 * 存在すること自体がその陣営を強化計算の対象にする（R-ENH-01 #2）ため、
 * `academyLevels`を持たない空オブジェクトにも意味がある。
 */
export interface FormationEnhancementInput {
  readonly academyLevels?: AcademyLevels;
}

export interface FormationSlotInput {
  readonly unitDefinitionId: UnitDefinitionId;
  readonly position: FormationPositionInput;
  readonly enhancement?: UnitEnhancementInput;
}

export interface FormationInput {
  readonly slots: readonly FormationSlotInput[];
  readonly memoryDefinitionIds: readonly MemoryDefinitionId[];
  readonly enhancement?: FormationEnhancementInput;
}

/**
 * `10_API設計.md`「公開レベル」: 用途は「大量実行して勝敗とユニット別集計だけを
 * 見る」(`SUMMARY`)と「効果発動を追う」(`DETAILED`)の2つ。`DIAGNOSTIC`は
 * `DETAILED`と同一挙動になったうえで廃止した — 受理を続けると、同じ意味の値が
 * 2つある状態が公開契約に残り続ける。指定は`validateLogLevel`が
 * `422 INVALID_COMMAND`として拒否する。
 */
export const LOG_LEVELS = ["SUMMARY", "DETAILED"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * 両陣営の編成だけを持つCommandの共通部分。戦闘実行（`SimulateBattleCommand`）と
 * 開始時ステータスのプレビュー（`PreviewFormationStatsCommand`）が同じ編成検証・
 * 参照検証を共有するための最小の形。
 */
export interface FormationPairCommand {
  readonly allyFormation: FormationInput;
  readonly enemyFormation: FormationInput;
}

export interface SimulateBattleCommand extends FormationPairCommand {
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

/** R-ENH-02 #1・R-ENH-05 #4: 学園レベル・現在レベルは1以上の整数で、上限を設けない。 */
function validateEnhancementLevel(level: number, path: string, violations: Violation[]): void {
  if (!Number.isInteger(level) || level < 1) {
    violations.push({
      path,
      reason: `must be an integer of at least 1, got ${JSON.stringify(level)}`,
    });
  }
}

/** R-ENH-02 #1: タイプ3系統・属性6系統それぞれのレベルを検証する。省略した系統は1として扱う。 */
function validateAcademyLevels(
  academyLevels: AcademyLevels,
  path: string,
  violations: Violation[],
): void {
  for (const group of ["unitTypes", "attributes"] as const) {
    const levels: Readonly<Record<string, number | undefined>> = academyLevels[group] ?? {};
    for (const [system, level] of Object.entries(levels)) {
      if (level !== undefined) {
        validateEnhancementLevel(level, `${path}.${group}.${system}`, violations);
      }
    }
  }
}

/** R-ENH-04 #2: 対象ステータス・種別・ランクは定義済みの列挙値だけを受け付ける。 */
function validateGear(gear: GearInput, path: string, violations: Violation[]): void {
  if (!STAT_KINDS.includes(gear.stat)) {
    violations.push({
      path: `${path}.stat`,
      reason: `must be one of [${STAT_KINDS.join(", ")}], got ${JSON.stringify(gear.stat)}`,
    });
  }
  if (!GEAR_TIERS.includes(gear.tier)) {
    violations.push({
      path: `${path}.tier`,
      reason: `must be one of [${GEAR_TIERS.join(", ")}], got ${JSON.stringify(gear.tier)}`,
    });
  }
  if (!GEAR_GRADES.includes(gear.grade)) {
    violations.push({
      path: `${path}.grade`,
      reason: `must be one of [${GEAR_GRADES.join(", ")}], got ${JSON.stringify(gear.grade)}`,
    });
  }
}

/**
 * R-ENH-01 #3: ユニット単位の強化指定は、その陣営の強化指定があるときだけ許可する。
 * 陣営指定なしのユニット指定は黙って無視せず、リクエスト不備として拒否する。
 */
function validateSlotEnhancement(
  enhancement: UnitEnhancementInput,
  hasFormationEnhancement: boolean,
  path: string,
  violations: Violation[],
): void {
  if (!hasFormationEnhancement) {
    violations.push({
      path,
      reason: "requires an enhancement specification on its own formation (R-ENH-01)",
    });
  }
  if (enhancement.level !== undefined) {
    validateEnhancementLevel(enhancement.level, `${path}.level`, violations);
  }
  const gears = enhancement.gears;
  if (gears !== undefined) {
    if (gears.length > MAX_GEARS_PER_UNIT) {
      violations.push({
        path: `${path}.gears`,
        reason: `must contain at most ${MAX_GEARS_PER_UNIT} gears, got ${gears.length}`,
      });
    }
    gears.forEach((gear, index) => validateGear(gear, `${path}.gears[${index}]`, violations));
  }
}

export interface FormationShapeOptions {
  /**
   * 陣営あたりの最小ユニット数。戦闘実行は1（R-FRM-01）だが、開始時ステータスの
   * プレビューは陣営ごとに独立して算出でき、片側だけ組みかけの編成にも意味が
   * あるため0を渡す（`09_アプリケーション設計.md`「PreviewFormationStatsCommand」）。
   */
  readonly minimumSlots?: number;
}

/**
 * 1陣営ぶんの編成検証。`turnLimit`・`logLevel`を持たないCommand
 * （`PreviewFormationStatsCommand`）からも同じ規則を使えるよう公開する
 * ——最小人数以外の受理条件（上限5体、配置重複、メモリー件数、強化指定）が
 * 経路ごとにずれると、プレビューできた編成で戦闘が実行できない（またはその逆）
 * 状態が生まれるため。
 */
export function validateFormationShape(
  formation: FormationInput,
  path: string,
  options: FormationShapeOptions = {},
): Violation[] {
  const violations: Violation[] = [];
  validateFormation(formation, path, violations, options);
  return violations;
}

function validateFormation(
  formation: FormationInput,
  path: string,
  violations: Violation[],
  options: FormationShapeOptions = {},
): void {
  const minimumSlots = options.minimumSlots ?? MIN_SLOTS;
  if (formation.slots.length < minimumSlots || formation.slots.length > MAX_SLOTS) {
    violations.push({
      path: `${path}.slots`,
      reason: `must contain between ${minimumSlots} and ${MAX_SLOTS} units, got ${formation.slots.length}`,
    });
  }

  if (formation.enhancement?.academyLevels !== undefined) {
    validateAcademyLevels(
      formation.enhancement.academyLevels,
      `${path}.enhancement.academyLevels`,
      violations,
    );
  }

  const seenPositions = new Set<string>();
  formation.slots.forEach((slot, index) => {
    validatePosition(slot.position, `${path}.slots[${index}].position`, violations);
    if (slot.enhancement !== undefined) {
      validateSlotEnhancement(
        slot.enhancement,
        formation.enhancement !== undefined,
        `${path}.slots[${index}].enhancement`,
        violations,
      );
    }

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
 * イベント公開レベルの受理値検証。戦闘実行と戦術演習
 * （`simulate-tactical-exercise-command.ts`）が同じ列挙値を共有する。
 */
export function validateLogLevel(logLevel: LogLevel, violations: Violation[]): void {
  if (!LOG_LEVELS.includes(logLevel)) {
    violations.push({
      path: "logLevel",
      reason: `must be one of [${LOG_LEVELS.join(", ")}], got "${String(logLevel)}"`,
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

  validateLogLevel(command.logLevel, violations);

  return violations;
}
