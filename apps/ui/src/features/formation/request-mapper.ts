// Mirrors docs/ui-design/03_API・データ連携設計.md §4-5 (coordinate conversion
// and request generation rules).

import { DEFAULT_UNIT_LEVEL, enhancementForSide, memorySlotKeyOf } from "./types.js";
import type {
  BattleDraft,
  FormationSlotInput,
  GearInput,
  LogLevel,
  Side,
  SideEnhancementInput,
  UiColumn,
  UiRow,
} from "./types.js";

/** docs/ui-design/03_API・データ連携設計.md §5.1 (M11). */
export interface UnitEnhancementRequest {
  readonly level: number;
  readonly gears: readonly GearInput[];
}

export interface FormationEnhancementRequest {
  readonly academyLevels: {
    readonly unitTypes: Readonly<Record<string, number>>;
    readonly attributes: Readonly<Record<string, number>>;
  };
}

export interface BattleSimulationUnitRequest {
  readonly unitDefinitionId: string;
  readonly position: { readonly column: UiColumn; readonly row: UiRow };
  readonly enhancement?: UnitEnhancementRequest;
}

export interface FormationRequest {
  readonly units: readonly BattleSimulationUnitRequest[];
  readonly memoryDefinitionIds: readonly string[];
  readonly enhancement?: FormationEnhancementRequest;
}

export interface BattleSimulationRequest {
  readonly allyFormation: FormationRequest;
  readonly enemyFormation: FormationRequest;
  readonly turnLimit: number;
  readonly options: { readonly logLevel: LogLevel };
}

const ROW_ORDER: Readonly<Record<UiRow, number>> = { FRONT: 0, REAR: 1 };

// The catalog's positionAptitudes vocabulary (FRONT/BACK) is display-only;
// the API always takes the UI row name (FRONT/REAR) verbatim.
function apiRowForUiRow(row: UiRow): UiRow {
  return row;
}

export interface BuiltFormation {
  readonly formation: FormationRequest;
  readonly unitSlotKeys: readonly string[];
  readonly memorySlotKeys: readonly string[];
  readonly gearSlotIndices: readonly (readonly number[])[];
}

/**
 * 送信DTOに載る編成部分は戦闘・プレビュー・戦術演習で同一である。エンドポイント
 * ごとの差分（`turnLimit`の有無、人数制約）は呼び出し側が持つ。
 */
export type RequestBuildResult<TRequest = BattleSimulationRequest> =
  | {
      readonly ok: true;
      readonly request: TRequest;
      readonly allyUnitSlotKeys: readonly string[];
      readonly enemyUnitSlotKeys: readonly string[];
      // memoryDefinitionIds is compressed (empty slots removed), so its API
      // array index does not equal the UI memory slot index. These arrays are
      // index-aligned with the compressed array instead, mirroring
      // allyUnitSlotKeys/enemyUnitSlotKeys (UI-API-004).
      readonly allyMemorySlotKeys: readonly string[];
      readonly enemyMemorySlotKeys: readonly string[];
      // §13 (M11): 送信したギア配列は空枠を除外しているため、`gears[m]`の
      // indexはUIのギア枠indexと一致しない。unitSlotKeysと同じ並びで、
      // 送信配列の各要素が由来する元のギア枠indexを持つ。
      readonly allyGearSlotIndices: readonly (readonly number[])[];
      readonly enemyGearSlotIndices: readonly (readonly number[])[];
    }
  | { readonly ok: false };

function isPositiveInteger(value: number | ""): value is number {
  return value !== "" && Number.isInteger(value);
}

/**
 * UI-API-018: 学園レベル9キーはすべて出力する（既定値1も省略しない）。
 * 未入力（`""`）が残っている陣営はリクエストを組み立てず、送信前検証の
 * エラーとして表示する（`draft-validation.ts`）。
 */
function buildFormationEnhancement(
  enhancement: SideEnhancementInput,
): FormationEnhancementRequest | undefined {
  const groups = ["unitTypes", "attributes"] as const;
  const built: Record<string, Record<string, number>> = {};
  for (const group of groups) {
    const levels: Record<string, number> = {};
    for (const [key, level] of Object.entries(enhancement.academyLevels[group])) {
      if (!isPositiveInteger(level)) {
        return undefined;
      }
      levels[key] = level;
    }
    built[group] = levels;
  }
  return {
    academyLevels: {
      unitTypes: built["unitTypes"] ?? {},
      attributes: built["attributes"] ?? {},
    },
  };
}

interface BuiltUnitEnhancement {
  readonly enhancement?: UnitEnhancementRequest;
  readonly gearSlotIndices: readonly number[];
}

/**
 * UI-API-018: 空枠を除外した0〜9件のギア配列を枠順のまま出力する。
 * レベル200かつギア0件は省略時の既定と同値のため`enhancement`自体を出力しない。
 */
function buildUnitEnhancement(slot: FormationSlotInput): BuiltUnitEnhancement | undefined {
  const enhancement = slot.enhancement;
  if (enhancement === undefined) {
    return { gearSlotIndices: [] };
  }
  if (!isPositiveInteger(enhancement.level)) {
    return undefined;
  }
  const filledGears = enhancement.gears
    .map((gear, index) => ({ gear, index }))
    .filter((entry): entry is { gear: GearInput; index: number } => entry.gear !== undefined);
  if (enhancement.level === DEFAULT_UNIT_LEVEL && filledGears.length === 0) {
    return { gearSlotIndices: [] };
  }
  return {
    enhancement: { level: enhancement.level, gears: filledGears.map((entry) => entry.gear) },
    gearSlotIndices: filledGears.map((entry) => entry.index),
  };
}

export function buildFormation(
  side: Side,
  slots: readonly FormationSlotInput[],
  memoryDefinitionIds: readonly (string | undefined)[],
  sideEnhancement: SideEnhancementInput,
): BuiltFormation | undefined {
  const filled = slots.filter(
    (slot): slot is FormationSlotInput & { unitDefinitionId: string } =>
      slot.unitDefinitionId !== undefined,
  );
  const sorted = filled.toSorted((a, b) => {
    const rowDiff = ROW_ORDER[a.row] - ROW_ORDER[b.row];
    return rowDiff !== 0 ? rowDiff : a.column - b.column;
  });

  const filledMemories = memoryDefinitionIds
    .map((memoryDefinitionId, index) => ({ memoryDefinitionId, index }))
    .filter(
      (entry): entry is { memoryDefinitionId: string; index: number } =>
        entry.memoryDefinitionId !== undefined,
    );

  // UI-API-017: トグルOFFの陣営は陣営・ユニットとも`enhancement`を持たない
  // 従来どおりのペイロードにする。入力値はdraftに残っていても出力しない。
  const formationEnhancement = sideEnhancement.enabled
    ? buildFormationEnhancement(sideEnhancement)
    : undefined;
  if (sideEnhancement.enabled && formationEnhancement === undefined) {
    return undefined;
  }

  const builtUnits = sorted.map((slot) =>
    sideEnhancement.enabled ? buildUnitEnhancement(slot) : { gearSlotIndices: [] },
  );
  if (builtUnits.some((built) => built === undefined)) {
    return undefined;
  }

  return {
    formation: {
      units: sorted.map((slot, index) => {
        const unitEnhancement = builtUnits[index]?.enhancement;
        return {
          unitDefinitionId: slot.unitDefinitionId,
          position: { column: slot.column, row: apiRowForUiRow(slot.row) },
          ...(unitEnhancement === undefined ? {} : { enhancement: unitEnhancement }),
        };
      }),
      memoryDefinitionIds: filledMemories.map((entry) => entry.memoryDefinitionId),
      ...(formationEnhancement === undefined ? {} : { enhancement: formationEnhancement }),
    },
    unitSlotKeys: sorted.map((slot) => slot.slotKey),
    memorySlotKeys: filledMemories.map((entry) => memorySlotKeyOf(side, entry.index)),
    gearSlotIndices: builtUnits.map((built) => built?.gearSlotIndices ?? []),
  };
}

/** docs/ui-design/03_API・データ連携設計.md §2.5: プレビューは編成部分だけを送る。 */
export interface FormationStatPreviewRequest {
  readonly allyFormation: FormationRequest;
  readonly enemyFormation: FormationRequest;
}

export type PreviewRequestBuildResult =
  | {
      readonly ok: true;
      readonly request: FormationStatPreviewRequest;
      readonly allyUnitSlotKeys: readonly string[];
      readonly enemyUnitSlotKeys: readonly string[];
    }
  | { readonly ok: false };

/**
 * UI-API-020: 戦闘リクエストと同じ`buildFormation`で編成部分を組み立てる。
 * `turnLimit`は見ない — プレビューは戦闘を実行せず、ターン上限が未入力でも
 * ステータスは確定するため、ここで止めると編集途中に表示が消える。
 * 片側だけ埋まった編成もそのまま送る（APIは0体の陣営を受け付ける）。
 * 両陣営とも0体のときだけ送らず、UIは未取得として扱う。
 */
export function buildFormationStatPreviewRequest(draft: BattleDraft): PreviewRequestBuildResult {
  const ally = buildFormation(
    "ally",
    draft.allySlots,
    draft.allyMemoryDefinitionIds,
    enhancementForSide(draft, "ally"),
  );
  const enemy = buildFormation(
    "enemy",
    draft.enemySlots,
    draft.enemyMemoryDefinitionIds,
    enhancementForSide(draft, "enemy"),
  );
  if (ally === undefined || enemy === undefined) {
    return { ok: false };
  }
  if (ally.formation.units.length === 0 && enemy.formation.units.length === 0) {
    return { ok: false };
  }

  return {
    ok: true,
    request: { allyFormation: ally.formation, enemyFormation: enemy.formation },
    allyUnitSlotKeys: ally.unitSlotKeys,
    enemyUnitSlotKeys: enemy.unitSlotKeys,
  };
}

export function buildBattleSimulationRequest(draft: BattleDraft): RequestBuildResult {
  if (draft.turnLimit === "" || !Number.isInteger(draft.turnLimit)) {
    return { ok: false };
  }

  const ally = buildFormation(
    "ally",
    draft.allySlots,
    draft.allyMemoryDefinitionIds,
    enhancementForSide(draft, "ally"),
  );
  const enemy = buildFormation(
    "enemy",
    draft.enemySlots,
    draft.enemyMemoryDefinitionIds,
    enhancementForSide(draft, "enemy"),
  );
  if (ally === undefined || enemy === undefined) {
    return { ok: false };
  }

  return {
    ok: true,
    request: {
      allyFormation: ally.formation,
      enemyFormation: enemy.formation,
      turnLimit: draft.turnLimit,
      options: { logLevel: draft.logLevel },
    },
    allyUnitSlotKeys: ally.unitSlotKeys,
    enemyUnitSlotKeys: enemy.unitSlotKeys,
    allyMemorySlotKeys: ally.memorySlotKeys,
    enemyMemorySlotKeys: enemy.memorySlotKeys,
    allyGearSlotIndices: ally.gearSlotIndices,
    enemyGearSlotIndices: enemy.gearSlotIndices,
  };
}
