// Mirrors docs/ui-design/04_コンポーネント・状態管理設計.md §4-5, scoped to the
// draft/selection-dialog slice. Catalog load state and execution state are
// separate slices (catalog-loader.ts / execution-reducer.ts).

import {
  createInitialDraft,
  createInitialUnitEnhancement,
  enhancementForSide,
  slotsForSide,
} from "./types.js";
import type {
  BattleDraft,
  FormationSlotInput,
  GearInput,
  LogLevel,
  Side,
  SideEnhancementInput,
  UnitEnhancementInput,
} from "./types.js";

export const MAX_UNITS_PER_SIDE = 5;

export type SelectionDialogState =
  | { readonly kind: "closed" }
  | { readonly kind: "unit"; readonly slotKey: string }
  | { readonly kind: "memory"; readonly side: Side; readonly index: number }
  | { readonly kind: "unitEnhancement"; readonly slotKey: string };

export interface FormationState {
  readonly draft: BattleDraft;
  readonly selectionDialog: SelectionDialogState;
}

export type FormationAction =
  | { readonly type: "unitSelected"; readonly slotKey: string; readonly unitDefinitionId: string }
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
  | { readonly type: "unitMoved"; readonly fromSlotKey: string; readonly toSlotKey: string };

export function createInitialFormationState(): FormationState {
  return { draft: createInitialDraft(), selectionDialog: { kind: "closed" } };
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
 * （UI-AC-029: 強化はユニットに追随する）。`undefined`はキーごと落とし、
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
  return { ...state, draft };
}

export function formationReducer(state: FormationState, action: FormationAction): FormationState {
  switch (action.type) {
    case "unitSelected": {
      const slot = findSlot(state.draft, action.slotKey);
      if (slot === undefined) {
        return state;
      }
      const isNewSelection = slot.unitDefinitionId === undefined;
      if (
        isNewSelection &&
        filledCount(slotsForSide(state.draft, slot.side)) >= MAX_UNITS_PER_SIDE
      ) {
        return state;
      }
      return {
        ...state,
        draft: withSlotUnit(state.draft, slot.side, action.slotKey, action.unitDefinitionId),
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
    case "enhancementToggled":
      return {
        ...state,
        draft: withSideEnhancement(
          state.draft,
          action.side,
          toggledEnhancement(enhancementForSide(state.draft, action.side), action.enabled),
        ),
      };
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
      return { ...state, draft };
    }
  }
}
