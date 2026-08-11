// Mirrors docs/ui-design/04_コンポーネント・状態管理設計.md §4-5, scoped to the
// draft/selection-dialog slice. Catalog load state and execution state are
// separate slices (catalog-loader.ts / execution-reducer.ts).

import {
  createInitialDraft,
  createInitialUnitEnhancement,
  enhancementForSide,
  memorySlotKeyOf,
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
  | {
      readonly type: "unitSelected";
      readonly slotKey: string;
      readonly unitDefinitionId: string;
      /**
       * 手持ちデータ由来のプリフィル値（`persistence.ts`）。味方枠への配置時だけ
       * 載せる。伴わない場合は枠の入力を保持する（敵側は都度入力の方針）。
       */
      readonly enhancement?: UnitEnhancementInput;
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
  // 「編成をクリア」。学園レベルだけ手持ちデータからプリフィルし直す。
  | {
      readonly type: "draftReset";
      readonly allyAcademyLevels?: SideEnhancementInput["academyLevels"];
    }
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
      const placed = withSlotUnit(state.draft, slot.side, action.slotKey, action.unitDefinitionId);
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
    case "draftReset":
      // 実行状態と直近結果は別sliceが持つため、ここでは消さない（UI-CMP-020）。
      return {
        draft: createInitialDraft(action.allyAcademyLevels),
        selectionDialog: { kind: "closed" },
      };
    case "allyEnhancementCleared": {
      // 手持ちデータと味方の育成入力は同じ値の2つの置き場であり、片方だけ消しても
      // もう片方から書き戻されるため対で初期化する（01_UI要求・画面設計.md §5.9）。
      const initial = createInitialDraft();
      return {
        ...state,
        draft: {
          ...state.draft,
          allySlots: state.draft.allySlots.map(({ enhancement: _discarded, ...slot }) => slot),
          allyEnhancement: {
            ...state.draft.allyEnhancement,
            academyLevels: initial.allyEnhancement.academyLevels,
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
