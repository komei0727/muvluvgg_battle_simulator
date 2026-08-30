// docs/ui-design/01_UI要求・画面設計.md §5.9 と
// docs/ui-design/04_コンポーネント・状態管理設計.md §4「永続化」の写像。
//
// 保存形式は送信DTO（`request-mapper.ts`）ではなくdraft型を写したものにする。
// 送信DTOは空枠を圧縮するため、どの枠にどのユニットが居たかを復元できない。
//
// ここは純関数だけを置く。localStorageへの読み書きは `lib/storage.ts`、
// stateの持ち回りは `use-formation-persistence.ts` が担う。
import { isRecord, stringOf } from "../../lib/unknown-narrowing.js";
import {
  DEFAULT_UNIT_LEVEL,
  DEFAULT_UNIT_RANK,
  ENHANCEMENT_ATTRIBUTES,
  ENHANCEMENT_UNIT_TYPES,
  GEAR_GRADES,
  GEAR_SLOT_COUNT,
  GEAR_STATS,
  GEAR_TIERS,
  UNIT_RANKS,
  createInitialDraft,
  createInitialExerciseExecution,
  createInitialLevelLink,
} from "./types.js";
import type {
  BattleDraft,
  ExerciseExecutionInput,
  ExerciseExecutionMode,
  FormationSlotInput,
  GearInput,
  LevelLinkInput,
  LogLevel,
  SideEnhancementInput,
  UnitEnhancementInput,
} from "../../entities/battle-draft.js";
import type { UiViolation } from "../../entities/violation.js";

export const PLAYER_DATA_STORAGE_KEY = "mlgg:player-data";
export const LAST_DRAFT_STORAGE_KEY = "mlgg:last-draft";
/**
 * 戦術演習draftの保存先。モードごとに別キーへ分ける（01_UI要求・画面設計.md §5.9）。
 * 1つのキーへ両モードのdraftを入れると、既に`mlgg:last-draft`へ書かれている
 * 単一draft形式と互換が切れ、前回セッションの通常戦闘の編成が丸ごと失われる。
 */
export const EXERCISE_DRAFT_STORAGE_KEY = "mlgg:last-draft:exercise";

/**
 * 保存形式の版。draft型・手持ちデータの構造を変えたら上げる。異なる版の保存データは
 * 移行せず破棄する（入力し直せる値であり、誤った移行で壊れた入力を復元するより安全）。
 *
 * レベルリンク（`levelLink`・`linkExcluded`）を足しても版は1のまま据え置く。
 * 版を上げると`envelopeOf`の完全一致判定で全利用者の保存データ（手持ちデータと
 * 両モードのdraft）が破棄されるためである。デコーダは既知キーだけを読むので、
 * 新項目を「欠落したら既定値」で読めば旧データはそのまま復元できる。
 * `mlgg:player-data`には未知キーを拒否する外部の読み手（`tools/exercise-lab`）が
 * いるため、そちらを先に追随させてからこの項目を書き始める。
 */
export const PERSISTENCE_SCHEMA_VERSION = 1;

export type AcademyLevels = SideEnhancementInput["academyLevels"];

/**
 * 手持ちデータ（味方の育成情報、モード非依存の単一slice。REF-058 / Issue #603）。
 * `player-enhancement-reducer.ts`の生きた状態でもあり、`mlgg:player-data`へ
 * 保存する形でもある——両者は同じ形なので、そのまま読み書きする。
 */
export interface StoredPlayerData {
  readonly academyLevels: SideEnhancementInput["academyLevels"];
  readonly levelLink: LevelLinkInput;
  readonly units: Readonly<Record<string, UnitEnhancementInput>>;
}

const LOG_LEVELS: readonly LogLevel[] = ["SUMMARY", "DETAILED"];

/**
 * ログ方針刷新2/3（Issue #464）: `DIAGNOSTIC`はUIの選択肢から外れたが、以前の
 * セッションで保存されたドラフトには残っている。保存データ全体を破棄すると編成を
 * 入力し直させることになり、そのまま送れば`DIAGNOSTIC`を廃止したAPI（3/3）が422で
 * 拒否する。`DIAGNOSTIC`は`DETAILED`と同一挙動になったため、読み替えは選択の意味を
 * 変えない。
 */
function logLevelOf(value: unknown): LogLevel {
  if (value === "DIAGNOSTIC") {
    return "DETAILED";
  }
  return isMemberOf(LOG_LEVELS, value) ? value : fail();
}

const EXERCISE_EXECUTION_MODES: readonly ExerciseExecutionMode[] = ["SINGLE", "STATISTICS"];

/**
 * Issue #539: 演習の実行モードは`logLevel`の選択を置き換えたが、以前のセッションで
 * 保存されたdraftは`exerciseExecution`を持たない。`levelLink`と同じく版を上げずに
 * 項目を足すため、欠落は既定（単一実行）として読む — 版を上げると`envelopeOf`の
 * 完全一致判定で全利用者の保存データが破棄される。保存済みの`logLevel`は残す
 * （通常戦闘のdraftは引き続きその値で実行し、演習は`DETAILED`固定で送る）。
 */
function exerciseExecutionOf(value: unknown): ExerciseExecutionInput {
  if (value === undefined) {
    return createInitialExerciseExecution();
  }
  if (!isRecord(value)) {
    return fail();
  }
  const mode = value["mode"];
  const seed = value["seed"];
  if (!isMemberOf(EXERCISE_EXECUTION_MODES, mode) || typeof seed !== "string") {
    return fail();
  }
  return { mode, runCount: levelOf(value["runCount"]), seed };
}

function isMemberOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/** 契約から外れた値は`undefined`ではなくthrowで伝える。部分的に信じないため。 */
class StoredDataMismatch extends Error {}

function fail(): never {
  throw new StoredDataMismatch();
}

function levelOf(value: unknown): number | "" {
  if (value === "") {
    return "";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return fail();
}

/**
 * 新項目のため欠落を許す（既定はLR+5＝内部値5）。6択のselectであり`level`と違い
 * 未入力状態（`""`）を持たないため、届いた値は`UNIT_RANKS`（R-ENH-07: 0〜5の整数）
 * のメンバーかまで検証する。範囲外・小数を許すと、そのまま次の送信へ乗って
 * APIの422で実行不能になる。
 */
function rankOf(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_UNIT_RANK;
  }
  if (typeof value === "number" && UNIT_RANKS.includes(value)) {
    return value;
  }
  return fail();
}

function academyLevelsOf(value: unknown): AcademyLevels {
  if (!isRecord(value)) {
    return fail();
  }
  const unitTypes = value["unitTypes"];
  const attributes = value["attributes"];
  if (!isRecord(unitTypes) || !isRecord(attributes)) {
    return fail();
  }
  return {
    unitTypes: Object.fromEntries(
      ENHANCEMENT_UNIT_TYPES.map((unitType) => [unitType, levelOf(unitTypes[unitType])]),
    ) as AcademyLevels["unitTypes"],
    attributes: Object.fromEntries(
      ENHANCEMENT_ATTRIBUTES.map((attribute) => [attribute, levelOf(attributes[attribute])]),
    ) as AcademyLevels["attributes"],
  };
}

function gearOf(value: unknown): GearInput | undefined {
  // JSONの配列は`undefined`を`null`へ落とすため、空枠は`null`として戻ってくる。
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return fail();
  }
  const { stat, tier, grade } = value;
  if (
    !isMemberOf(GEAR_STATS, stat) ||
    !isMemberOf(GEAR_TIERS, tier) ||
    !isMemberOf(GEAR_GRADES, grade)
  ) {
    return fail();
  }
  return { stat, tier, grade };
}

/** 新項目のため欠落を許す（既定はリンクOFF・レベル200）。届いた値は契約どおり検証する。 */
function levelLinkOf(value: unknown): LevelLinkInput {
  if (value === undefined || value === null) {
    return createInitialLevelLink();
  }
  if (!isRecord(value) || typeof value["enabled"] !== "boolean") {
    return fail();
  }
  return { enabled: value["enabled"], level: levelOf(value["level"]) };
}

function unitEnhancementOf(value: unknown): UnitEnhancementInput {
  if (!isRecord(value)) {
    return fail();
  }
  // 枠数は固定であり、長さも契約の一部として検証する（短い配列を空枠で
  // 補うと、枠位置がずれた保存データを黙って受理してしまう）。
  const gears = value["gears"];
  if (!Array.isArray(gears) || gears.length !== GEAR_SLOT_COUNT) {
    return fail();
  }
  return {
    level: levelOf(value["level"]),
    rank: rankOf(value["rank"]),
    // 新項目のため欠落を許す。旧データの枠はどれもリンクから外れていない。
    linkExcluded: value["linkExcluded"] === true,
    gears: gears.map((gear) => gearOf(gear)),
  };
}

function sideEnhancementOf(value: unknown): SideEnhancementInput {
  if (!isRecord(value) || typeof value["enabled"] !== "boolean") {
    return fail();
  }
  return {
    enabled: value["enabled"],
    levelLink: levelLinkOf(value["levelLink"]),
    academyLevels: academyLevelsOf(value["academyLevels"]),
  };
}

/**
 * 枠の骨格（slotKey・side・row・column）は保存値を信じず`createInitialDraft()`側を使い、
 * 保存値からはユニットIDと強化入力だけを載せ替える。壊れた保存値が枠構造そのものを
 * 変えてしまうと、以降の座標変換・違反対応づけが崩れるため。
 */
function slotsOf(
  skeleton: readonly FormationSlotInput[],
  value: unknown,
): readonly FormationSlotInput[] {
  // 枠数は固定。重複と未知のslotKeyを弾いたうえで長さが一致すれば、
  // 保存データが全枠をちょうど1回ずつ覆っていることになる。
  if (!Array.isArray(value) || value.length !== skeleton.length) {
    return fail();
  }
  const bySlotKey = new Map<string, Record<string, unknown>>();
  for (const entry of value) {
    if (!isRecord(entry)) {
      return fail();
    }
    const slotKey = stringOf(entry["slotKey"]);
    if (
      slotKey === undefined ||
      bySlotKey.has(slotKey) ||
      !skeleton.some((slot) => slot.slotKey === slotKey)
    ) {
      return fail();
    }
    bySlotKey.set(slotKey, entry);
  }
  return skeleton.map((slot) => {
    const stored = bySlotKey.get(slot.slotKey);
    if (stored === undefined) {
      return slot;
    }
    const unitDefinitionId = stored["unitDefinitionId"];
    const enhancement = stored["enhancement"];
    return {
      ...slot,
      ...(unitDefinitionId === undefined
        ? {}
        : { unitDefinitionId: stringOf(unitDefinitionId) ?? fail() }),
      ...(enhancement === undefined ? {} : { enhancement: unitEnhancementOf(enhancement) }),
    };
  });
}

function memoryIdsOf(value: unknown, length: number): readonly (string | undefined)[] {
  // 枠数は固定。空枠はJSON上`null`として並ぶ。
  if (!Array.isArray(value) || value.length !== length) {
    return fail();
  }
  return value.map((id) =>
    id === null || id === undefined ? undefined : (stringOf(id) ?? fail()),
  );
}

function envelopeOf(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || value["schemaVersion"] !== PERSISTENCE_SCHEMA_VERSION) {
    return fail();
  }
  return value;
}

/** 保存する`mlgg:last-draft`の中身。`catalogRevision`は診断用で、復元条件にはしない。 */
export function toStoredDraft(draft: BattleDraft, catalogRevision?: string): unknown {
  return {
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    ...(catalogRevision === undefined ? {} : { catalogRevision }),
    draft,
  };
}

/** 1項目でも契約から外れれば保存データ全体を破棄する（`undefined`を返す）。 */
export function parseStoredDraft(value: unknown): BattleDraft | undefined {
  try {
    const stored = envelopeOf(value)["draft"];
    if (!isRecord(stored)) {
      return fail();
    }
    const skeleton = createInitialDraft();
    const logLevel = logLevelOf(stored["logLevel"]);
    return {
      allySlots: slotsOf(skeleton.allySlots, stored["allySlots"]),
      enemySlots: slotsOf(skeleton.enemySlots, stored["enemySlots"]),
      allyMemoryDefinitionIds: memoryIdsOf(
        stored["allyMemoryDefinitionIds"],
        skeleton.allyMemoryDefinitionIds.length,
      ),
      enemyMemoryDefinitionIds: memoryIdsOf(
        stored["enemyMemoryDefinitionIds"],
        skeleton.enemyMemoryDefinitionIds.length,
      ),
      turnLimit: levelOf(stored["turnLimit"]),
      logLevel,
      exerciseExecution: exerciseExecutionOf(stored["exerciseExecution"]),
      allyEnhancement: sideEnhancementOf(stored["allyEnhancement"]),
      enemyEnhancement: sideEnhancementOf(stored["enemyEnhancement"]),
    };
  } catch (error) {
    if (error instanceof StoredDataMismatch) {
      return undefined;
    }
    throw error;
  }
}

export function toStoredPlayerData(data: StoredPlayerData): unknown {
  return { schemaVersion: PERSISTENCE_SCHEMA_VERSION, ...data };
}

export function parsePlayerData(value: unknown): StoredPlayerData | undefined {
  try {
    const stored = envelopeOf(value);
    const units = stored["units"];
    if (!isRecord(units)) {
      return fail();
    }
    return {
      academyLevels: academyLevelsOf(stored["academyLevels"]),
      levelLink: levelLinkOf(stored["levelLink"]),
      units: Object.fromEntries(
        Object.entries(units).map(([id, enhancement]) => [id, unitEnhancementOf(enhancement)]),
      ),
    };
  } catch (error) {
    if (error instanceof StoredDataMismatch) {
      return undefined;
    }
    throw error;
  }
}

export function createEmptyPlayerData(): StoredPlayerData {
  return {
    academyLevels: createInitialDraft().allyEnhancement.academyLevels,
    levelLink: createInitialLevelLink(),
    units: {},
  };
}

/** 既定値のままの手持ちデータは保存せずキー自体を消すため、「空」を判定する。 */
export function isEmptyPlayerData(data: StoredPlayerData): boolean {
  const empty = createEmptyPlayerData();
  return (
    Object.keys(data.units).length === 0 &&
    isSameAcademyLevels(data.academyLevels, empty.academyLevels) &&
    // リンクだけを設定した手持ちデータをキーごと消すと、リロードでリンクが失われる。
    isSameLevelLink(data.levelLink, empty.levelLink)
  );
}

function isSameLevelLink(a: LevelLinkInput, b: LevelLinkInput): boolean {
  return a.enabled === b.enabled && a.level === b.level;
}

function isSameAcademyLevels(a: AcademyLevels, b: AcademyLevels): boolean {
  return (
    ENHANCEMENT_UNIT_TYPES.every((unitType) => a.unitTypes[unitType] === b.unitTypes[unitType]) &&
    ENHANCEMENT_ATTRIBUTES.every((attribute) => a.attributes[attribute] === b.attributes[attribute])
  );
}

function isSameEnhancement(a: UnitEnhancementInput, b: UnitEnhancementInput): boolean {
  return (
    a.level === b.level &&
    a.rank === b.rank &&
    // 「リンクから外す」だけを切り替えた編集も保存されなければならない。
    a.linkExcluded === b.linkExcluded &&
    a.gears.length === b.gears.length &&
    a.gears.every((gear, index) => {
      const other = b.gears[index];
      if (gear === undefined || other === undefined) {
        return gear === other;
      }
      return gear.stat === other.stat && gear.tier === other.tier && gear.grade === other.grade;
    })
  );
}

function isSamePlayerData(a: StoredPlayerData, b: StoredPlayerData): boolean {
  const aIds = Object.keys(a.units);
  return (
    isSameAcademyLevels(a.academyLevels, b.academyLevels) &&
    isSameLevelLink(a.levelLink, b.levelLink) &&
    aIds.length === Object.keys(b.units).length &&
    aIds.every((id) => {
      const other = b.units[id];
      const own = a.units[id];
      return other !== undefined && own !== undefined && isSameEnhancement(own, other);
    })
  );
}

export function mergedAcademyLevels(previous: AcademyLevels, next: AcademyLevels): AcademyLevels {
  // 未入力（`""`）は「その項目を消した」ではなく入力途中なので、前回値を残す。
  return {
    unitTypes: Object.fromEntries(
      ENHANCEMENT_UNIT_TYPES.map((unitType) => [
        unitType,
        next.unitTypes[unitType] === "" ? previous.unitTypes[unitType] : next.unitTypes[unitType],
      ]),
    ) as AcademyLevels["unitTypes"],
    attributes: Object.fromEntries(
      ENHANCEMENT_ATTRIBUTES.map((attribute) => [
        attribute,
        next.attributes[attribute] === ""
          ? previous.attributes[attribute]
          : next.attributes[attribute],
      ]),
    ) as AcademyLevels["attributes"],
  };
}

export function mergedLevelLink(previous: LevelLinkInput, next: LevelLinkInput): LevelLinkInput {
  // 未入力（`""`）は「リンクレベルを消した」ではなく入力途中なので、前回値を残す
  // （`mergedAcademyLevels`と同じ規約）。保存形式は未入力を表現しない。
  return { enabled: next.enabled, level: next.level === "" ? previous.level : next.level };
}

/**
 * `player-enhancement-reducer.ts`の生きたstate（`next`）から、保存へ書き出す値を
 * 導出する。生きたstateは入力欄の表示のため未入力（`""`）をそのまま持てるが、
 * 保存データはそれを表現できない——書き出す直前に、直前まで保存されていた値
 * （`previous`）で未入力を埋める（`mergedAcademyLevels`・`mergedLevelLink`と同じ
 * 規約）。`gears`・`linkExcluded`はテキスト入力ではなく未入力になり得ないため、
 * `next`の値をそのまま使う。変化が無ければ`previous`をそのまま返し、保存effectと
 * 再レンダーを起こさない。
 */
export function mergeForPersistence(
  previous: StoredPlayerData,
  next: StoredPlayerData,
): StoredPlayerData {
  const merged: StoredPlayerData = {
    academyLevels: mergedAcademyLevels(previous.academyLevels, next.academyLevels),
    levelLink: mergedLevelLink(previous.levelLink, next.levelLink),
    units: Object.fromEntries(
      Object.entries(next.units).map(([unitDefinitionId, enhancement]) => [
        unitDefinitionId,
        {
          ...enhancement,
          level:
            enhancement.level === ""
              ? (previous.units[unitDefinitionId]?.level ?? DEFAULT_UNIT_LEVEL)
              : enhancement.level,
        },
      ]),
    ),
  };
  return isSamePlayerData(previous, merged) ? previous : merged;
}

/** Catalogから消えたユニットのエントリだけを落とす。学園レベルは定義に依存しないため残す。 */
export function prunePlayerData(
  data: StoredPlayerData,
  knownUnitDefinitionIds: Iterable<string>,
): StoredPlayerData {
  const known = new Set(knownUnitDefinitionIds);
  const entries = Object.entries(data.units).filter(([id]) => known.has(id));
  if (entries.length === Object.keys(data.units).length) {
    return data;
  }
  return { ...data, units: Object.fromEntries(entries) };
}

/**
 * 復元直後にCatalogから消えていた枠を特定する。判定は`validateDraft`の
 * `UNKNOWN_DEFINITION`を流用し、この関数はCatalogを直接読まない。
 */
export function selectUnknownDefinitionSlotKeys(
  violations: readonly UiViolation[],
): readonly string[] {
  return violations
    .filter((violation) => violation.code === "UNKNOWN_DEFINITION")
    .map((violation) => violation.slotKey)
    .filter((slotKey): slotKey is string => slotKey !== undefined);
}
