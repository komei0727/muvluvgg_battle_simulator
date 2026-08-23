// Mirrors docs/ui-design/03_API・データ連携設計.md §6 (client validation table)
// and docs/ui-design/04_コンポーネント・状態管理設計.md §9 (UiViolation shape).
import { aptitudeMatches } from "../../lib/aptitude.js";
import { PLAYABLE_CATEGORY, unitCategoryOf } from "../catalog-selection/unit-pool.js";
import type {
  BattleDraft,
  FormationSlotInput,
  GearInput,
  GearStat,
  Side,
  SideEnhancementInput,
} from "../../entities/battle-draft.js";
import type { UiViolation } from "../../entities/violation.js";
import type { BattleSimulationCatalogResponse } from "../../shared/api/api-contract.js";
import { isSlotLevelLinked } from "./level-link.js";
import {
  GEAR_STAT_LABELS,
  MAX_GEARS_PER_STAT,
  enhancementForSide,
  gearStatCounts,
  memorySlotKeyOf,
} from "./types.js";

const MIN_UNITS_PER_SIDE = 1;
const MAX_UNITS_PER_SIDE = 5;
const MAX_MEMORIES_PER_SIDE = 6;
const MIN_TURN_LIMIT = 1;
const MAX_TURN_LIMIT = 99;
const MAX_GEARS_PER_UNIT = 9;

function unitsPath(side: Side): string {
  return side === "ally" ? "/allyFormation/units" : "/enemyFormation/units";
}

function memoriesPath(side: Side): string {
  return side === "ally"
    ? "/allyFormation/memoryDefinitionIds"
    : "/enemyFormation/memoryDefinitionIds";
}

function filledSlots(
  slots: readonly FormationSlotInput[],
): readonly (FormationSlotInput & { readonly unitDefinitionId: string })[] {
  return slots.filter(
    (slot): slot is FormationSlotInput & { unitDefinitionId: string } =>
      slot.unitDefinitionId !== undefined,
  );
}

/**
 * エンドポイントごとに異なる制約だけを外から与える。演習は敵ちょうど1体・敵
 * メモリー0件で、ターン上限を持たない（`03_API・データ連携設計.md`§2.3）。
 * 共有する規則（配置重複・定義存在・適性・強化入力）はモードに依らない。
 */
export interface DraftValidationRules {
  readonly enemyUnitCount: {
    readonly min: number;
    readonly max: number;
    readonly message: string;
  };
  readonly enemyMemoryCount: { readonly max: number; readonly message: string };
  readonly validatesTurnLimit: boolean;
  /** R-TEX-11 #2 #3: 陣営ごとに受理するユニットカテゴリ。 */
  readonly unitPools: { readonly ally: string; readonly enemy: string };
}

export const BATTLE_DRAFT_VALIDATION_RULES: DraftValidationRules = {
  enemyUnitCount: {
    min: MIN_UNITS_PER_SIDE,
    max: MAX_UNITS_PER_SIDE,
    message: "敵ユニットを1～5体設定してください。",
  },
  enemyMemoryCount: { max: MAX_MEMORIES_PER_SIDE, message: "メモリーは6件まで設定できます。" },
  validatesTurnLimit: true,
  unitPools: { ally: PLAYABLE_CATEGORY, enemy: PLAYABLE_CATEGORY },
};

function validateUnitCount(
  side: Side,
  slots: readonly FormationSlotInput[],
  bounds: { readonly min: number; readonly max: number; readonly message: string },
): UiViolation[] {
  const count = filledSlots(slots).length;
  if (count >= bounds.min && count <= bounds.max) {
    return [];
  }
  return [
    {
      path: unitsPath(side),
      code: "UNIT_COUNT_OUT_OF_RANGE",
      message: bounds.message,
      severity: "error",
    },
  ];
}

const ALLY_UNIT_COUNT_BOUNDS = {
  min: MIN_UNITS_PER_SIDE,
  max: MAX_UNITS_PER_SIDE,
  message: "味方ユニットを1～5体設定してください。",
} as const;

function validateDuplicatePositions(
  side: Side,
  slots: readonly FormationSlotInput[],
): UiViolation[] {
  const seenCoordinates = new Set<string>();
  const violations: UiViolation[] = [];
  for (const slot of filledSlots(slots)) {
    const coordinateKey = `${slot.row}:${slot.column}`;
    if (seenCoordinates.has(coordinateKey)) {
      violations.push({
        path: unitsPath(side),
        slotKey: slot.slotKey,
        code: "DUPLICATE_POSITION",
        message: "同じ配置枠に複数のユニットは設定できません。",
        severity: "error",
      });
    } else {
      seenCoordinates.add(coordinateKey);
    }
  }
  return violations;
}

function validateMemoryCount(
  side: Side,
  ids: readonly (string | undefined)[],
  bounds: { readonly max: number; readonly message: string },
): UiViolation[] {
  const count = ids.filter((id) => id !== undefined).length;
  if (count <= bounds.max) {
    return [];
  }
  return [
    {
      path: memoriesPath(side),
      code: "MEMORY_COUNT_OUT_OF_RANGE",
      message: bounds.message,
      severity: "error",
    },
  ];
}

function validateTurnLimit(turnLimit: BattleDraft["turnLimit"]): UiViolation[] {
  const message = "ターン上限は1～99の整数で入力してください。";
  const isValid =
    turnLimit !== "" &&
    Number.isInteger(turnLimit) &&
    turnLimit >= MIN_TURN_LIMIT &&
    turnLimit <= MAX_TURN_LIMIT;
  if (isValid) {
    return [];
  }
  return [{ path: "/turnLimit", code: "TURN_LIMIT_INVALID", message, severity: "error" }];
}

function validateUnitExistence(
  side: Side,
  slots: readonly FormationSlotInput[],
  catalog: BattleSimulationCatalogResponse,
): UiViolation[] {
  const violations: UiViolation[] = [];
  for (const slot of filledSlots(slots)) {
    const definition = catalog.units.find(
      (unit) => unit.unitDefinitionId === slot.unitDefinitionId,
    );
    if (definition === undefined) {
      violations.push({
        path: unitsPath(side),
        slotKey: slot.slotKey,
        code: "UNKNOWN_DEFINITION",
        message: "Catalogに存在しない定義です。選択し直してください。",
        severity: "error",
      });
    }
  }
  return violations;
}

function validateMemoryExistence(
  side: Side,
  ids: readonly (string | undefined)[],
  catalog: BattleSimulationCatalogResponse,
): UiViolation[] {
  const violations: UiViolation[] = [];
  ids.forEach((memoryDefinitionId, index) => {
    if (memoryDefinitionId === undefined) {
      return;
    }
    const definition = catalog.memories.find(
      (memory) => memory.memoryDefinitionId === memoryDefinitionId,
    );
    if (definition === undefined) {
      violations.push({
        path: `${memoriesPath(side)}/${index}`,
        slotKey: memorySlotKeyOf(side, index),
        code: "UNKNOWN_DEFINITION",
        message: "Catalogに存在しない定義です。選択し直してください。",
        severity: "error",
      });
    }
  });
  return violations;
}

/**
 * R-TEX-11 #2 #3: サーバーが422で弾く編成プール違反を送信前に止める。ダイアログの
 * 候補を絞るだけでは、保存draftの復元やCatalog更新で誤プールのユニットが枠へ
 * 残り得るため、送信経路にも同じ制約を置く。Catalogに無い定義は
 * `UNKNOWN_DEFINITION`が指すので、ここでは重ねて報告しない。
 */
function validateUnitPools(
  side: Side,
  slots: readonly FormationSlotInput[],
  catalog: BattleSimulationCatalogResponse,
  allowedCategory: string,
): UiViolation[] {
  const violations: UiViolation[] = [];
  for (const slot of filledSlots(slots)) {
    const definition = catalog.units.find(
      (unit) => unit.unitDefinitionId === slot.unitDefinitionId,
    );
    if (definition === undefined || unitCategoryOf(definition) === allowedCategory) {
      continue;
    }
    violations.push({
      path: unitsPath(side),
      slotKey: slot.slotKey,
      code: "UNIT_POOL_MISMATCH",
      message:
        allowedCategory === PLAYABLE_CATEGORY
          ? "この枠には戦術演習専用ユニットを設定できません。選び直してください。"
          : "この枠には戦術演習専用ユニットだけを設定できます。選び直してください。",
      severity: "error",
    });
  }
  return violations;
}

function validateAptitudeWarnings(
  side: Side,
  slots: readonly FormationSlotInput[],
  catalog: BattleSimulationCatalogResponse,
): UiViolation[] {
  const violations: UiViolation[] = [];
  for (const slot of filledSlots(slots)) {
    const definition = catalog.units.find(
      (unit) => unit.unitDefinitionId === slot.unitDefinitionId,
    );
    if (definition === undefined) {
      continue;
    }
    if (!aptitudeMatches(slot.row, definition.positionAptitudes)) {
      violations.push({
        path: unitsPath(side),
        slotKey: slot.slotKey,
        code: "APTITUDE_MISMATCH",
        message: "適性外の配置です。サーバーが適性補正を適用します。",
        severity: "warning",
      });
    }
  }
  return violations;
}

function formationPath(side: Side): string {
  return side === "ally" ? "/allyFormation" : "/enemyFormation";
}

function isPositiveInteger(value: number | ""): boolean {
  return value !== "" && Number.isInteger(value) && value >= 1;
}

/**
 * UI-AC-024: 学園レベル9項目は1以上の整数。トグルOFFの陣営は送信対象から
 * 外れる（値は保持する）ため検証しない。
 */
function validateAcademyLevels(side: Side, enhancement: SideEnhancementInput): UiViolation[] {
  if (!enhancement.enabled) {
    return [];
  }
  const violations: UiViolation[] = [];
  for (const group of ["unitTypes", "attributes"] as const) {
    for (const [key, level] of Object.entries(enhancement.academyLevels[group])) {
      if (!isPositiveInteger(level)) {
        violations.push({
          path: `${formationPath(side)}/enhancement/academyLevels/${group}/${key}`,
          code: "ACADEMY_LEVEL_INVALID",
          message: "学園レベルは1以上の整数で入力してください。",
          severity: "error",
        });
      }
    }
  }
  return violations;
}

/**
 * UI-AC-038: リンクレベルは1以上の整数。陣営の強化トグルOFFまたはリンクOFFでは
 * 検証しない（入力値はdraftへ保持したまま送信対象から外れるため。学園レベルと同じ）。
 */
function validateLevelLink(side: Side, enhancement: SideEnhancementInput): UiViolation[] {
  if (!enhancement.enabled || !enhancement.levelLink.enabled) {
    return [];
  }
  if (isPositiveInteger(enhancement.levelLink.level)) {
    return [];
  }
  return [
    {
      path: `${formationPath(side)}/enhancement/levelLink/level`,
      code: "LEVEL_LINK_INVALID",
      message: "リンクレベルは1以上の整数で入力してください。",
      severity: "error",
    },
  ];
}

/**
 * R-ENH-04 #4 は同一ステータスの重複を許すが、実ゲームのギアカスタムは1ユニットに
 * つき同一ステータス3個までしか装備できない（`MAX_GEARS_PER_STAT`）。上限超過は
 * **警告**として出す — この段のAPIはまだ受理するため、送信を止めると既存の保存
 * データが上限を超えている利用者は入力し直すまで実行できなくなる。送信を止めるのは
 * APIが422を返すようになってからでよい。
 *
 * 4枚目以降のギア枠それぞれへ`gearIndex`を付けるのは、ダイアログで「どの枠を外せば
 * よいか」を指せるようにするため。メッセージはユニットとステータスを名指す
 * （集約表示は文言で重複を畳むため、枠ごとに同じ文言になる）。
 */
function validateGearStatLimit(
  side: Side,
  slot: FormationSlotInput,
  gears: readonly (GearInput | undefined)[],
  unitDisplayName: string,
): UiViolation[] {
  const counts = gearStatCounts(gears);
  const seen = new Map<GearStat, number>();
  const violations: UiViolation[] = [];
  gears.forEach((gear, gearIndex) => {
    if (gear === undefined) {
      return;
    }
    const occurrence = (seen.get(gear.stat) ?? 0) + 1;
    seen.set(gear.stat, occurrence);
    if (occurrence <= MAX_GEARS_PER_STAT) {
      return;
    }
    violations.push({
      path: `${formationPath(side)}/units/enhancement/gears`,
      slotKey: slot.slotKey,
      gearIndex,
      code: "GEAR_STAT_COUNT_OVER_LIMIT",
      message: `${unitDisplayName}の${GEAR_STAT_LABELS[gear.stat]}のギアが${String(
        counts.get(gear.stat) ?? 0,
      )}枚あります。同一ステータスのギアは${String(MAX_GEARS_PER_STAT)}枚までです。`,
      severity: "warning",
    });
  });
  return violations;
}

/**
 * ユニット強化の違反はslotKeyで枠を特定する。pathは送信DTOのindexを持たない
 * 固定文字列にし、ダイアログ側はslotKeyとpathの末尾で入力を対応づける
 * （サーバー違反のpathは`units/{n}/...`のindex付きになるため、
 * 表示側はどちらでも一致するsuffix照合を使う）。
 *
 * UI-CMP-014: トグルOFFの陣営は検証しない。OFFでも入力値をdraftへ保持するのが
 * 要件であり、`request-mapper.ts`がOFF側のユニット強化を出力しない以上、
 * 保持しているだけの値は送信内容に影響しない。ここで検証すると「編集後にOFFへ
 * 戻した」だけで送信が止まる。R-ENH-01 #3の「陣営指定なしのユニット指定」は
 * リクエスト生成側の構造で保証する（`03_API・データ連携設計.md`§6）。
 */
function validateUnitEnhancements(
  side: Side,
  slots: readonly FormationSlotInput[],
  enhancement: SideEnhancementInput,
  catalog: BattleSimulationCatalogResponse,
): UiViolation[] {
  if (!enhancement.enabled) {
    return [];
  }
  const violations: UiViolation[] = [];
  for (const slot of slots) {
    const unitEnhancement = slot.enhancement;
    if (unitEnhancement === undefined) {
      continue;
    }
    // UI-AC-038: リンク中の枠の`level`は送信に使われないため検証しない。免除しないと
    // 「リンクをONにする前に途中まで打った`""`」がリンクON後も永久に送信を止める。
    // 判定はリンクレベルの妥当性を見ない（`level-link.ts`）。
    if (!isSlotLevelLinked(slot, enhancement) && !isPositiveInteger(unitEnhancement.level)) {
      violations.push({
        path: `${formationPath(side)}/units/enhancement/level`,
        slotKey: slot.slotKey,
        code: "UNIT_LEVEL_INVALID",
        message: "ユニットレベルは1以上の整数で入力してください。",
        severity: "error",
      });
    }
    const gearCount = unitEnhancement.gears.filter((gear) => gear !== undefined).length;
    if (gearCount > MAX_GEARS_PER_UNIT) {
      violations.push({
        path: `${formationPath(side)}/units/enhancement/gears`,
        slotKey: slot.slotKey,
        code: "GEAR_COUNT_OUT_OF_RANGE",
        message: "ギアは9枠まで設定できます。",
        severity: "error",
      });
    }
    // Catalogに無い定義（`UNKNOWN_DEFINITION`が別に指す）とユニット未選択の枠は
    // 定義IDをそのまま名前に使う。名指しできないことを理由に上限超過を伏せない。
    const displayName =
      catalog.units.find((unit) => unit.unitDefinitionId === slot.unitDefinitionId)?.displayName ??
      slot.unitDefinitionId ??
      "このユニット";
    violations.push(...validateGearStatLimit(side, slot, unitEnhancement.gears, displayName));
  }
  return violations;
}

export function validateDraftWithRules(
  draft: BattleDraft,
  catalog: BattleSimulationCatalogResponse,
  rules: DraftValidationRules,
): readonly UiViolation[] {
  return [
    ...validateUnitCount("ally", draft.allySlots, ALLY_UNIT_COUNT_BOUNDS),
    ...validateUnitCount("enemy", draft.enemySlots, rules.enemyUnitCount),
    ...validateDuplicatePositions("ally", draft.allySlots),
    ...validateDuplicatePositions("enemy", draft.enemySlots),
    ...validateMemoryCount("ally", draft.allyMemoryDefinitionIds, {
      max: MAX_MEMORIES_PER_SIDE,
      message: "メモリーは6件まで設定できます。",
    }),
    ...validateMemoryCount("enemy", draft.enemyMemoryDefinitionIds, rules.enemyMemoryCount),
    ...(rules.validatesTurnLimit ? validateTurnLimit(draft.turnLimit) : []),
    ...validateUnitExistence("ally", draft.allySlots, catalog),
    ...validateUnitExistence("enemy", draft.enemySlots, catalog),
    ...validateMemoryExistence("ally", draft.allyMemoryDefinitionIds, catalog),
    ...validateMemoryExistence("enemy", draft.enemyMemoryDefinitionIds, catalog),
    ...validateUnitPools("ally", draft.allySlots, catalog, rules.unitPools.ally),
    ...validateUnitPools("enemy", draft.enemySlots, catalog, rules.unitPools.enemy),
    ...validateAptitudeWarnings("ally", draft.allySlots, catalog),
    ...validateAptitudeWarnings("enemy", draft.enemySlots, catalog),
    ...validateAcademyLevels("ally", enhancementForSide(draft, "ally")),
    ...validateAcademyLevels("enemy", enhancementForSide(draft, "enemy")),
    ...validateLevelLink("ally", enhancementForSide(draft, "ally")),
    ...validateLevelLink("enemy", enhancementForSide(draft, "enemy")),
    ...validateUnitEnhancements(
      "ally",
      draft.allySlots,
      enhancementForSide(draft, "ally"),
      catalog,
    ),
    ...validateUnitEnhancements(
      "enemy",
      draft.enemySlots,
      enhancementForSide(draft, "enemy"),
      catalog,
    ),
  ];
}

export function validateDraft(
  draft: BattleDraft,
  catalog: BattleSimulationCatalogResponse,
): readonly UiViolation[] {
  return validateDraftWithRules(draft, catalog, BATTLE_DRAFT_VALIDATION_RULES);
}

export function selectCanSubmit(violations: readonly UiViolation[]): boolean {
  return !violations.some((violation) => violation.severity === "error");
}
