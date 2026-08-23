// Mirrors docs/ui-design/04_コンポーネント・状態管理設計.md §4-5, scoped to the
// draft/selection-dialog slice. Catalog load state and execution state are
// separate slices (catalog-loader.ts / execution-reducer.ts).
import { isSlotLevelLinked } from "./level-link.js";
import {
  createInitialDraft,
  createInitialUnitEnhancement,
  enhancementForSide,
  memorySlotKeyOf,
  slotsForSide,
} from "./types.js";
import type {
  BattleDraft,
  ExerciseExecutionInput,
  ExerciseExecutionMode,
  FormationSlotInput,
  GearInput,
  LevelLinkInput,
  LogLevel,
  Side,
  SideEnhancementInput,
  UnitEnhancementInput,
} from "../../entities/battle-draft.js";
import type { PlayerSideEnhancement } from "./types.js";

export const MAX_UNITS_PER_SIDE = 5;

export type SelectionDialogState =
  | { readonly kind: "closed" }
  | { readonly kind: "unit"; readonly slotKey: string }
  | { readonly kind: "memory"; readonly side: Side; readonly index: number }
  | { readonly kind: "unitEnhancement"; readonly slotKey: string };

export interface FormationState {
  readonly draft: BattleDraft;
  readonly selectionDialog: SelectionDialogState;
  /**
   * 直近に強化入力を編集した枠。手持ちデータ（`persistence.ts`）はユニット定義ID
   * 単位だが同じ定義を複数枠へ置けるため、どの枠の値を書き戻すかをこれで一意に
   * 決める。draftの値ではないので、送信内容には影響しない。
   */
  readonly lastEditedSlotKey?: string;
}

export type FormationAction =
  | {
      readonly type: "unitSelected";
      readonly slotKey: string;
      readonly unitDefinitionId: string;
      /**
       * 手持ちデータ由来のプリフィル値（`persistence.ts`）。味方枠への配置時だけ
       * 載せる。伴わない場合は枠の入力を保持する（敵側は都度入力の方針）。
       */
      readonly enhancement?: UnitEnhancementInput;
      /**
       * その陣営へ1体しか置かない配置（戦術演習の敵、`R-TEX-01` #3）。空き枠を
       * 選んだときは既存の1体を配置先へ移し替え、2体目にはしない。移動と選択を
       * 別actionへ分けると、途中状態として2体並んだdraftが一瞬でも成立する。
       */
      readonly exclusiveForSide?: boolean;
    }
  | { readonly type: "unitRemoved"; readonly slotKey: string }
  | {
      readonly type: "memorySelected";
      readonly side: Side;
      readonly index: number;
      readonly memoryDefinitionId: string;
    }
  | { readonly type: "memoryRemoved"; readonly side: Side; readonly index: number }
  | { readonly type: "turnLimitChanged"; readonly value: number | "" }
  | { readonly type: "logLevelChanged"; readonly value: LogLevel }
  | {
      readonly type: "exerciseExecutionModeChanged";
      readonly value: ExerciseExecutionMode;
    }
  | { readonly type: "exerciseRunCountChanged"; readonly value: number | "" }
  | { readonly type: "exerciseSeedChanged"; readonly value: string }
  | { readonly type: "enhancementToggled"; readonly side: Side; readonly enabled: boolean }
  | {
      readonly type: "academyLevelChanged";
      readonly side: Side;
      readonly group: "unitTypes" | "attributes";
      readonly key: string;
      readonly value: number | "";
    }
  | {
      readonly type: "unitEnhancementLevelChanged";
      readonly slotKey: string;
      readonly value: number | "";
    }
  | { readonly type: "levelLinkToggled"; readonly side: Side; readonly enabled: boolean }
  | { readonly type: "levelLinkLevelChanged"; readonly side: Side; readonly value: number | "" }
  // 「リンクから外す」／「リンクへ戻す」。外した瞬間のシードはreducerが解決する。
  | {
      readonly type: "unitLinkExclusionChanged";
      readonly slotKey: string;
      readonly excluded: boolean;
    }
  | {
      readonly type: "unitEnhancementGearChanged";
      readonly slotKey: string;
      readonly gearIndex: number;
      readonly gear?: GearInput;
    }
  | {
      readonly type: "selectionOpened";
      readonly selection: Exclude<SelectionDialogState, { kind: "closed" }>;
    }
  | { readonly type: "selectionClosed" }
  | { readonly type: "unitMoved"; readonly fromSlotKey: string; readonly toSlotKey: string }
  // 「編成をクリア」。学園レベルとレベルリンクだけ手持ちデータからプリフィルし直す。
  | { readonly type: "draftReset"; readonly allyPlayerEnhancement?: PlayerSideEnhancement }
  // 「保存した育成データをクリア」に伴う味方育成入力の初期化。
  | { readonly type: "allyEnhancementCleared" }
  // 復元直後にCatalogから消えていた定義の枠を空にする。
  | { readonly type: "unknownDefinitionsCleared"; readonly slotKeys: readonly string[] };

/** `draft`は`mlgg:last-draft`から復元した値（`persistence.ts`）。 */
export function createInitialFormationState(draft?: BattleDraft): FormationState {
  return { draft: draft ?? createInitialDraft(), selectionDialog: { kind: "closed" } };
}

function filledCount(slots: readonly FormationSlotInput[]): number {
  return slots.filter((slot) => slot.unitDefinitionId !== undefined).length;
}

function findSlot(draft: BattleDraft, slotKey: string): FormationSlotInput | undefined {
  return [...draft.allySlots, ...draft.enemySlots].find((slot) => slot.slotKey === slotKey);
}

function replaceSlotUnit(
  slots: readonly FormationSlotInput[],
  slotKey: string,
  unitDefinitionId: string | undefined,
): readonly FormationSlotInput[] {
  return slots.map((slot) => {
    if (slot.slotKey !== slotKey) {
      return slot;
    }
    const { unitDefinitionId: _discarded, ...rest } = slot;
    return unitDefinitionId === undefined ? rest : { ...rest, unitDefinitionId };
  });
}

function withSlotUnit(
  draft: BattleDraft,
  side: Side,
  slotKey: string,
  unitDefinitionId: string | undefined,
): BattleDraft {
  return side === "ally"
    ? { ...draft, allySlots: replaceSlotUnit(draft.allySlots, slotKey, unitDefinitionId) }
    : { ...draft, enemySlots: replaceSlotUnit(draft.enemySlots, slotKey, unitDefinitionId) };
}

/**
 * 移動・入れ替えではユニットIDとユニット単位の強化入力を一体で運ぶ
 * （UI-AC-032: 強化はユニットに追随する）。`undefined`はキーごと落とし、
 * 空き枠に残キーが生まれないようにする。
 */
function withSlotContents(
  slots: readonly FormationSlotInput[],
  slotKey: string,
  contents: Pick<FormationSlotInput, "unitDefinitionId" | "enhancement">,
): readonly FormationSlotInput[] {
  return slots.map((slot) => {
    if (slot.slotKey !== slotKey) {
      return slot;
    }
    const { unitDefinitionId: _unit, enhancement: _enhancement, ...rest } = slot;
    return {
      ...rest,
      ...(contents.unitDefinitionId !== undefined
        ? { unitDefinitionId: contents.unitDefinitionId }
        : {}),
      ...(contents.enhancement !== undefined ? { enhancement: contents.enhancement } : {}),
    };
  });
}

/**
 * 1体だけを置く陣営（`exclusiveForSide`）で、配置先以外の枠を空にする。
 * ユニット単位の強化入力は`unitRemoved`と同じく枠に残す（送信対象は
 * ユニットが居る枠だけなので、残っていても送信内容は変わらない）。
 */
function withOnlySlotFilled(draft: BattleDraft, side: Side, slotKey: string): BattleDraft {
  const clear = (slots: readonly FormationSlotInput[]): readonly FormationSlotInput[] =>
    slots.reduce(
      (current, slot) =>
        slot.slotKey === slotKey || slot.unitDefinitionId === undefined
          ? current
          : replaceSlotUnit(current, slot.slotKey, undefined),
      slots,
    );
  return side === "ally"
    ? { ...draft, allySlots: clear(draft.allySlots) }
    : { ...draft, enemySlots: clear(draft.enemySlots) };
}

function withSlotEnhancement(
  draft: BattleDraft,
  side: Side,
  slotKey: string,
  enhancement: UnitEnhancementInput | undefined,
): BattleDraft {
  const replace = (slots: readonly FormationSlotInput[]): readonly FormationSlotInput[] =>
    slots.map((slot) => {
      if (slot.slotKey !== slotKey) {
        return slot;
      }
      const { enhancement: _discarded, ...rest } = slot;
      return enhancement === undefined ? rest : { ...rest, enhancement };
    });
  return side === "ally"
    ? { ...draft, allySlots: replace(draft.allySlots) }
    : { ...draft, enemySlots: replace(draft.enemySlots) };
}

function replaceMemory(
  ids: readonly (string | undefined)[],
  index: number,
  value: string | undefined,
): readonly (string | undefined)[] {
  return ids.map((id, i) => (i === index ? value : id));
}

function withSideEnhancement(
  draft: BattleDraft,
  side: Side,
  enhancement: SideEnhancementInput,
): BattleDraft {
  return side === "ally"
    ? { ...draft, allyEnhancement: enhancement }
    : { ...draft, enemyEnhancement: enhancement };
}

/**
 * UI-CMP-014: トグルOFFへ戻しても入力値は保持し、送信対象からだけ外す
 * （送信対象の判定は`request-mapper.ts`が`enabled`だけを見て行う）。
 */
function toggledEnhancement(
  enhancement: SideEnhancementInput,
  enabled: boolean,
): SideEnhancementInput {
  return { ...enhancement, enabled };
}

function withLevelLink(
  enhancement: SideEnhancementInput,
  levelLink: LevelLinkInput,
): SideEnhancementInput {
  return { ...enhancement, levelLink };
}

function withAcademyLevel(
  enhancement: SideEnhancementInput,
  group: "unitTypes" | "attributes",
  key: string,
  value: number | "",
): SideEnhancementInput {
  return {
    ...enhancement,
    academyLevels: {
      ...enhancement.academyLevels,
      [group]: { ...enhancement.academyLevels[group], [key]: value },
    },
  };
}

/**
 * ユニット強化はスロット単位の任意入力なので、最初の編集時に既定値
 * （レベル200・ギア9枠すべて空）から作り始める。
 */
function editSlotEnhancement(
  state: FormationState,
  slotKey: string,
  edit: (enhancement: UnitEnhancementInput) => UnitEnhancementInput,
): FormationState {
  const slot = findSlot(state.draft, slotKey);
  if (slot === undefined) {
    return state;
  }
  const enhancement = edit(slot.enhancement ?? createInitialUnitEnhancement());
  const replace = (slots: readonly FormationSlotInput[]): readonly FormationSlotInput[] =>
    slots.map((candidate) =>
      candidate.slotKey === slotKey ? { ...candidate, enhancement } : candidate,
    );
  const draft: BattleDraft =
    slot.side === "ally"
      ? { ...state.draft, allySlots: replace(state.draft.allySlots) }
      : { ...state.draft, enemySlots: replace(state.draft.enemySlots) };
  return { ...state, draft, lastEditedSlotKey: slotKey };
}

function withExerciseExecution(
  state: FormationState,
  patch: Partial<ExerciseExecutionInput>,
): FormationState {
  return {
    ...state,
    draft: {
      ...state.draft,
      exerciseExecution: { ...state.draft.exerciseExecution, ...patch },
    },
  };
}

export function formationReducer(state: FormationState, action: FormationAction): FormationState {
  switch (action.type) {
    case "unitSelected": {
      const slot = findSlot(state.draft, action.slotKey);
      if (slot === undefined) {
        return state;
      }
      // 1体だけの陣営では他の枠を空にしてから置く。上限に達していても
      // 「置けない」ではなく「その枠へ移る」ので、容量判定の対象外にする。
      const base =
        action.exclusiveForSide === true
          ? withOnlySlotFilled(state.draft, slot.side, action.slotKey)
          : state.draft;
      const isNewSelection = slot.unitDefinitionId === undefined;
      if (
        action.exclusiveForSide !== true &&
        isNewSelection &&
        filledCount(slotsForSide(state.draft, slot.side)) >= MAX_UNITS_PER_SIDE
      ) {
        return state;
      }
      const placed = withSlotUnit(base, slot.side, action.slotKey, action.unitDefinitionId);
      return {
        ...state,
        draft:
          action.enhancement === undefined
            ? placed
            : withSlotEnhancement(placed, slot.side, action.slotKey, action.enhancement),
        selectionDialog: { kind: "closed" },
      };
    }
    case "unitRemoved": {
      const slot = findSlot(state.draft, action.slotKey);
      if (slot === undefined) {
        return state;
      }
      return {
        ...state,
        draft: withSlotUnit(state.draft, slot.side, action.slotKey, undefined),
        selectionDialog: { kind: "closed" },
      };
    }
    case "memorySelected": {
      const draft: BattleDraft =
        action.side === "ally"
          ? {
              ...state.draft,
              allyMemoryDefinitionIds: replaceMemory(
                state.draft.allyMemoryDefinitionIds,
                action.index,
                action.memoryDefinitionId,
              ),
            }
          : {
              ...state.draft,
              enemyMemoryDefinitionIds: replaceMemory(
                state.draft.enemyMemoryDefinitionIds,
                action.index,
                action.memoryDefinitionId,
              ),
            };
      return { ...state, draft, selectionDialog: { kind: "closed" } };
    }
    case "memoryRemoved": {
      const draft: BattleDraft =
        action.side === "ally"
          ? {
              ...state.draft,
              allyMemoryDefinitionIds: replaceMemory(
                state.draft.allyMemoryDefinitionIds,
                action.index,
                undefined,
              ),
            }
          : {
              ...state.draft,
              enemyMemoryDefinitionIds: replaceMemory(
                state.draft.enemyMemoryDefinitionIds,
                action.index,
                undefined,
              ),
            };
      return { ...state, draft, selectionDialog: { kind: "closed" } };
    }
    case "turnLimitChanged":
      return { ...state, draft: { ...state.draft, turnLimit: action.value } };
    case "logLevelChanged":
      return { ...state, draft: { ...state.draft, logLevel: action.value } };
    // 実行モードの切替は`runCount`・`seed`を保持する。モードを往復しただけで
    // 入力が消えると、単一実行でログを確かめてから統計実行へ戻す使い方が壊れる。
    case "exerciseExecutionModeChanged":
      return withExerciseExecution(state, { mode: action.value });
    case "exerciseRunCountChanged":
      return withExerciseExecution(state, { runCount: action.value });
    case "exerciseSeedChanged":
      return withExerciseExecution(state, { seed: action.value });
    case "enhancementToggled":
      return {
        ...state,
        draft: withSideEnhancement(
          state.draft,
          action.side,
          toggledEnhancement(enhancementForSide(state.draft, action.side), action.enabled),
        ),
      };
    case "levelLinkToggled":
      // 参照時解決なので、リンクのON/OFFで各枠の`level`は書き換えない
      // （UI-CMP-023。OFFへ戻すだけで各枠が元の手動レベルへ戻る）。
      return {
        ...state,
        draft: withSideEnhancement(
          state.draft,
          action.side,
          withLevelLink(enhancementForSide(state.draft, action.side), {
            ...enhancementForSide(state.draft, action.side).levelLink,
            enabled: action.enabled,
          }),
        ),
      };
    case "levelLinkLevelChanged":
      return {
        ...state,
        draft: withSideEnhancement(
          state.draft,
          action.side,
          withLevelLink(enhancementForSide(state.draft, action.side), {
            ...enhancementForSide(state.draft, action.side).levelLink,
            level: action.value,
          }),
        ),
      };
    case "unitLinkExclusionChanged": {
      const slot = findSlot(state.draft, action.slotKey);
      if (slot === undefined) {
        return state;
      }
      // UI-AC-036: 外した瞬間、その枠のレベルをその時点のリンクレベルでシードする。
      // シードしないと外した途端に枠が保持していた古い値（多くは200）へ跳ね戻り、
      // 外す操作が破壊的に見える。リンクへ戻すときは触らない（参照時解決なので、
      // 書き換えなくても表示と送信はリンクレベルへ切り替わる）。
      const seeded =
        action.excluded && isSlotLevelLinked(slot, enhancementForSide(state.draft, slot.side));
      const { levelLink } = enhancementForSide(state.draft, slot.side);
      return editSlotEnhancement(state, action.slotKey, (enhancement) => ({
        ...enhancement,
        ...(seeded ? { level: levelLink.level } : {}),
        linkExcluded: action.excluded,
      }));
    }
    case "academyLevelChanged":
      return {
        ...state,
        draft: withSideEnhancement(
          state.draft,
          action.side,
          withAcademyLevel(
            enhancementForSide(state.draft, action.side),
            action.group,
            action.key,
            action.value,
          ),
        ),
      };
    case "unitEnhancementLevelChanged":
      return editSlotEnhancement(state, action.slotKey, (enhancement) => ({
        ...enhancement,
        level: action.value,
      }));
    case "unitEnhancementGearChanged":
      return editSlotEnhancement(state, action.slotKey, (enhancement) => ({
        ...enhancement,
        gears: enhancement.gears.map((gear, index) =>
          index === action.gearIndex ? action.gear : gear,
        ),
      }));
    case "selectionOpened": {
      // UI-CMP-015: 陣営の強化トグルOFFではユニット強化ダイアログを開かない。
      // `UnitSlot`側でも起動操作を無効化するが、draft操作以外の経路に備えて
      // reducerでも同じ条件を守る。
      if (action.selection.kind === "unitEnhancement") {
        const slot = findSlot(state.draft, action.selection.slotKey);
        if (slot === undefined || !enhancementForSide(state.draft, slot.side).enabled) {
          return state;
        }
      }
      return { ...state, selectionDialog: action.selection };
    }
    case "selectionClosed":
      return { ...state, selectionDialog: { kind: "closed" } };
    case "unitMoved": {
      const from = findSlot(state.draft, action.fromSlotKey);
      const to = findSlot(state.draft, action.toSlotKey);
      // 陣営を跨ぐ移動はUI側（陣営別のFormationEditor）でも防ぐが、
      // reducerでも同じ制約を守る。同一陣営内の移動は選択数を変えない
      // ため、容量チェックは不要。
      if (
        from === undefined ||
        to === undefined ||
        from.slotKey === to.slotKey ||
        from.unitDefinitionId === undefined ||
        from.side !== to.side
      ) {
        return state;
      }
      const swap = (slots: readonly FormationSlotInput[]): readonly FormationSlotInput[] =>
        withSlotContents(withSlotContents(slots, from.slotKey, to), to.slotKey, from);
      const draft: BattleDraft =
        from.side === "ally"
          ? { ...state.draft, allySlots: swap(state.draft.allySlots) }
          : { ...state.draft, enemySlots: swap(state.draft.enemySlots) };
      // 移動は編集ではないため`lastEditedSlotKey`を落とす。残すと入れ替えで
      // 旧座標へ移ってきた未編集ユニットの値が手持ちデータを上書きする
      // （UI-CT-049の退行）。
      const { lastEditedSlotKey: _edited, ...rest } = state;
      return { ...rest, draft };
    }
    case "draftReset":
      // 実行状態と直近結果は別sliceが持つため、ここでは消さない（UI-CMP-020）。
      return {
        draft: createInitialDraft(action.allyPlayerEnhancement),
        selectionDialog: { kind: "closed" },
      };
    case "allyEnhancementCleared": {
      // 手持ちデータと味方の育成入力は同じ値の2つの置き場であり、片方だけ消しても
      // もう片方から書き戻されるため対で初期化する（01_UI要求・画面設計.md §5.9）。
      const initial = createInitialDraft();
      const { lastEditedSlotKey: _discarded, ...rest } = state;
      return {
        ...rest,
        draft: {
          ...state.draft,
          allySlots: state.draft.allySlots.map(({ enhancement: _discarded, ...slot }) => slot),
          allyEnhancement: {
            ...state.draft.allyEnhancement,
            academyLevels: initial.allyEnhancement.academyLevels,
            levelLink: initial.allyEnhancement.levelLink,
          },
        },
      };
    }
    case "unknownDefinitionsCleared": {
      const slotKeys = new Set(action.slotKeys);
      if (slotKeys.size === 0) {
        return state;
      }
      const clearSlots = (slots: readonly FormationSlotInput[]): readonly FormationSlotInput[] =>
        slots.map(({ unitDefinitionId, enhancement, ...slot }) =>
          slotKeys.has(slot.slotKey)
            ? slot
            : {
                ...slot,
                ...(unitDefinitionId === undefined ? {} : { unitDefinitionId }),
                ...(enhancement === undefined ? {} : { enhancement }),
              },
        );
      const clearMemories = (
        side: Side,
        ids: readonly (string | undefined)[],
      ): readonly (string | undefined)[] =>
        ids.map((id, index) => (slotKeys.has(memorySlotKeyOf(side, index)) ? undefined : id));
      return {
        ...state,
        draft: {
          ...state.draft,
          allySlots: clearSlots(state.draft.allySlots),
          enemySlots: clearSlots(state.draft.enemySlots),
          allyMemoryDefinitionIds: clearMemories("ally", state.draft.allyMemoryDefinitionIds),
          enemyMemoryDefinitionIds: clearMemories("enemy", state.draft.enemyMemoryDefinitionIds),
        },
      };
    }
  }
}
