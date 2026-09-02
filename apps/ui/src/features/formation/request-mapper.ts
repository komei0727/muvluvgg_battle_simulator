// Mirrors docs/ui-design/03_API・データ連携設計.md §4-5 (coordinate conversion
// and request generation rules).
import { resolveSlotLevel } from "./level-link.js";
import {
  DEFAULT_UNIT_LEVEL,
  DEFAULT_UNIT_RANK,
  MODULE_STATS,
  enhancementForSide,
  memorySlotKeyOf,
} from "./types.js";
import type {
  BattleDraft,
  FormationSlotInput,
  GearInput,
  ModuleOverrideInput,
  ModuleStatOverrideInput,
  Side,
  SideEnhancementInput,
  UiRow,
} from "../../entities/battle-draft.js";
import type {
  BattleSimulationRequest,
  FormationEnhancementRequest,
  FormationRequest,
  FormationStatPreviewMode,
  FormationStatPreviewRequest,
  ModuleOverrideRequest,
  ModuleStatOverrideRequest,
  UnitEnhancementRequest,
} from "../../shared/api/api-contract.js";

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
 * R-ENH-08: `""`（未上書き）の項目はキーごと省略する。`ratio`はUI表示のパーセント
 * 単位（例: `10`）からAPIの内部表現の小数（`0.1`）へここで変換する——境界は
 * この1か所に閉じ、UI状態・reducerはパーセント値のまま保持する。
 */
function buildModuleStatOverride(
  override: ModuleStatOverrideInput,
): ModuleStatOverrideRequest | undefined {
  const fixed = override.fixed === "" ? undefined : override.fixed;
  const ratio = override.ratio === "" ? undefined : override.ratio / 100;
  if (fixed === undefined && ratio === undefined) {
    return undefined;
  }
  return { ...(fixed === undefined ? {} : { fixed }), ...(ratio === undefined ? {} : { ratio }) };
}

/** R-ENH-08: 1項目も上書きしていなければ`module`キー自体を出力しない。 */
function buildModuleOverride(module: ModuleOverrideInput): ModuleOverrideRequest | undefined {
  const built: Record<string, ModuleStatOverrideRequest> = {};
  for (const stat of MODULE_STATS) {
    const statOverride = buildModuleStatOverride(module[stat]);
    if (statOverride !== undefined) {
      built[stat] = statOverride;
    }
  }
  return Object.keys(built).length === 0 ? undefined : built;
}

/**
 * UI-API-018: 空枠を除外した0〜9件のギア配列を枠順のまま出力する。
 * レベル200・ランクLR+5（5）・ギア0件・モジュール上書きなしは省略時の既定と
 * 同値のため`enhancement`自体を出力しない（R-ENH-08: モジュール上書きが1件でも
 * あれば、他が既定のままでも`enhancement`を出力する）。
 *
 * UI-API-023/024: 送信するのは解決済みレベル（`level-link.ts`）であり、
 * `levelLink`・`linkExcluded`は出力しない。強化入力を一度も開いていない枠
 * （`slot.enhancement === undefined`）もリンク対象なので、ここで早期returnしない。
 * `rank`はレベルリンクの対象外であり、枠の入力値（省略時5）をそのまま出力する。
 */
function buildUnitEnhancement(
  slot: FormationSlotInput,
  sideEnhancement: SideEnhancementInput,
): BuiltUnitEnhancement | undefined {
  const level = resolveSlotLevel(slot, sideEnhancement);
  if (!isPositiveInteger(level)) {
    return undefined;
  }
  const rank = slot.enhancement?.rank ?? DEFAULT_UNIT_RANK;
  const filledGears = (slot.enhancement?.gears ?? [])
    .map((gear, index) => ({ gear, index }))
    .filter((entry): entry is { gear: GearInput; index: number } => entry.gear !== undefined);
  const module =
    slot.enhancement === undefined ? undefined : buildModuleOverride(slot.enhancement.module);
  if (
    level === DEFAULT_UNIT_LEVEL &&
    rank === DEFAULT_UNIT_RANK &&
    filledGears.length === 0 &&
    module === undefined
  ) {
    return { gearSlotIndices: [] };
  }
  return {
    enhancement: {
      level,
      rank,
      gears: filledGears.map((entry) => entry.gear),
      ...(module === undefined ? {} : { module }),
    },
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
    sideEnhancement.enabled ? buildUnitEnhancement(slot, sideEnhancement) : { gearSlotIndices: [] },
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
export function buildFormationStatPreviewRequest(
  draft: BattleDraft,
  mode: FormationStatPreviewMode = "NORMAL",
): PreviewRequestBuildResult {
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
    request: {
      allyFormation: ally.formation,
      enemyFormation: enemy.formation,
      // 既定と同じ`NORMAL`は送らない。この項目を知らない旧APIは
      // `additionalProperties: false`で422にするため。
      ...(mode === "NORMAL" ? {} : { mode }),
    },
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
