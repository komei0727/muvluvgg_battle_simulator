// Mirrors docs/ui-design/04_コンポーネント・状態管理設計.md §4-5, scoped to the
// draft/selection-dialog slice owned by this issue (execution state is added
// by a later issue).

import { createInitialDraft, slotsForSide } from "./types.js";
import type { BattleDraft, FormationSlotInput, LogLevel, Side } from "./types.js";

export const MAX_UNITS_PER_SIDE = 5;

export type SelectionDialogState =
  | { readonly kind: "closed" }
  | { readonly kind: "unit"; readonly slotKey: string }
  | { readonly kind: "memory"; readonly side: Side; readonly index: number };

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
  | {
      readonly type: "selectionOpened";
      readonly selection: Exclude<SelectionDialogState, { kind: "closed" }>;
    }
  | { readonly type: "selectionClosed" };

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

function replaceMemory(
  ids: readonly (string | undefined)[],
  index: number,
  value: string | undefined,
): readonly (string | undefined)[] {
  return ids.map((id, i) => (i === index ? value : id));
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
    case "selectionOpened":
      return { ...state, selectionDialog: action.selection };
    case "selectionClosed":
      return { ...state, selectionDialog: { kind: "closed" } };
  }
}
