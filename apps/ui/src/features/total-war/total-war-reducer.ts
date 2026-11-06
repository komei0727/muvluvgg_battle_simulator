// docs/ui-design/04_コンポーネント・状態管理設計.md §4「総力戦の編成draft」・§5「総力戦の操作」。
//
// 3組の`BattleDraft`を包み、操作を該当する組へ振り分けて処理そのものは既存の
// `formationReducer`へ任せる。組の中身の規則（上限5体・移動・強化入力の編集）を
// ここで二重に持たないため。
import {
  FORMATION_INDICES,
  createInitialTotalWarDraft,
  usedFormationIndices,
} from "./total-war-draft.js";
import type {
  FormationCount,
  FormationIndex,
  TotalWarDraft,
  TotalWarFormations,
} from "./total-war-draft.js";
import { formationReducer } from "../formation/formation-reducer.js";
import type { FormationAction } from "../formation/formation-reducer.js";
import { createInitialDraft } from "../formation/types.js";
import { TOTAL_WAR_MAX_FORMATIONS } from "../../entities/total-war.js";
import type { BattleDraft, Side } from "../../entities/battle-draft.js";

export interface TotalWarState {
  readonly draft: TotalWarDraft;
  /** 陣営ごとに表示中の編成。見え方なので保存しない（復元時は0）。 */
  readonly activeFormation: { readonly ally: FormationIndex; readonly enemy: FormationIndex };
}

export type TotalWarAction =
  // 振り分けて委譲する。`turnLimitChanged`・`exercise*`・`unknownDefinitionsCleared`は無視する。
  | FormationAction
  | { readonly type: "formationAdded"; readonly side: Side }
  // 表示中の編成を削除する。
  | { readonly type: "formationRemoved"; readonly side: Side }
  | { readonly type: "formationActivated"; readonly side: Side; readonly index: FormationIndex }
  | {
      readonly type: "unknownDefinitionsClearedByFormation";
      readonly slotKeys: Readonly<Record<FormationIndex, readonly string[]>>;
    };

/** `draft`は`mlgg:last-draft:total-war`から復元した値（`total-war-persistence.ts`）。 */
export function createInitialTotalWarState(draft?: TotalWarDraft): TotalWarState {
  return { draft: draft ?? createInitialTotalWarDraft(), activeFormation: { ally: 0, enemy: 0 } };
}

function sideOfSlotKey(slotKey: string): Side | undefined {
  const prefix = slotKey.split(":")[0];
  return prefix === "ally" || prefix === "enemy" ? prefix : undefined;
}

function mapFormations(
  formations: TotalWarFormations,
  map: (draft: BattleDraft, index: FormationIndex) => BattleDraft,
): TotalWarFormations {
  return [map(formations[0], 0), map(formations[1], 1), map(formations[2], 2)];
}

function withFormations(state: TotalWarState, formations: TotalWarFormations): TotalWarState {
  return { ...state, draft: { ...state.draft, formations } };
}

function delegate(draft: BattleDraft, action: FormationAction): BattleDraft {
  return formationReducer({ draft }, action).draft;
}

/** 表示中の組だけへ送る。`formationReducer`が変えなかった組は同一参照のまま返す。 */
function delegateToActive(
  state: TotalWarState,
  side: Side,
  action: FormationAction,
): TotalWarState {
  const target = state.activeFormation[side];
  const current = state.draft.formations[target];
  const next = delegate(current, action);
  if (next === current) {
    return state;
  }
  return withFormations(
    state,
    mapFormations(state.draft.formations, (draft, index) => (index === target ? next : draft)),
  );
}

/**
 * 陣営の強化入力は3組で共通の1組とする（01_UI要求・画面設計.md §5.10）。3組すべてへ
 * 送ることで、リクエスト生成・検証・プレビューがどの組からでも同じ値を読める。
 */
function delegateToAll(state: TotalWarState, action: FormationAction): TotalWarState {
  return withFormations(
    state,
    mapFormations(state.draft.formations, (draft) => delegate(draft, action)),
  );
}

/** 組の陣営側（ユニット枠とメモリー枠）を`source`の値へ差し替える。陣営強化は組の間で等しい。 */
function withSideContents(draft: BattleDraft, side: Side, source: BattleDraft): BattleDraft {
  return side === "ally"
    ? {
        ...draft,
        allySlots: source.allySlots,
        allyMemoryDefinitionIds: source.allyMemoryDefinitionIds,
      }
    : {
        ...draft,
        enemySlots: source.enemySlots,
        enemyMemoryDefinitionIds: source.enemyMemoryDefinitionIds,
      };
}

function withSideEnhancementOf(draft: BattleDraft, side: Side, source: BattleDraft): BattleDraft {
  return side === "ally"
    ? { ...draft, allyEnhancement: source.allyEnhancement }
    : { ...draft, enemyEnhancement: source.enemyEnhancement };
}

function withFormationCount(
  state: TotalWarState,
  side: Side,
  count: FormationCount,
  active: FormationIndex,
  formations: TotalWarFormations,
): TotalWarState {
  return {
    draft: {
      ...state.draft,
      formations,
      formationCounts: { ...state.draft.formationCounts, [side]: count },
    },
    activeFormation: { ...state.activeFormation, [side]: active },
  };
}

function addFormation(state: TotalWarState, side: Side): TotalWarState {
  const count = state.draft.formationCounts[side];
  if (count >= TOTAL_WAR_MAX_FORMATIONS) {
    return state;
  }
  const added = count as FormationIndex;
  const empty = createInitialDraft();
  const reference = state.draft.formations[0];
  // 空にしたうえで陣営強化を既存の組に揃える。追加した編成だけ強化が初期値へ戻ると
  // 「3組の陣営強化は等しい」不変条件が崩れる。
  const formations = mapFormations(state.draft.formations, (draft, index) =>
    index === added
      ? withSideEnhancementOf(withSideContents(draft, side, empty), side, reference)
      : draft,
  );
  return withFormationCount(state, side, (count + 1) as FormationCount, added, formations);
}

function removeFormation(state: TotalWarState, side: Side): TotalWarState {
  const count = state.draft.formationCounts[side];
  if (count <= 1) {
    return state;
  }
  const removed = state.activeFormation[side];
  const empty = createInitialDraft();
  const { formations: current } = state.draft;
  // 後ろの編成を1つずつ前へ詰めて出撃順を保ち、末尾を空にする。相手陣営の側は動かさない。
  const formations = mapFormations(current, (draft, index) => {
    if (index < removed || index >= count) {
      return draft;
    }
    const next = FORMATION_INDICES[index + 1];
    return withSideContents(
      draft,
      side,
      index === count - 1 || next === undefined ? empty : current[next],
    );
  });
  const nextCount = (count - 1) as FormationCount;
  const active = Math.min(removed, nextCount - 1) as FormationIndex;
  return withFormationCount(state, side, nextCount, active, formations);
}

function activateFormation(state: TotalWarState, side: Side, index: FormationIndex): TotalWarState {
  if (!usedFormationIndices(state.draft, side).includes(index)) {
    return state;
  }
  return { ...state, activeFormation: { ...state.activeFormation, [side]: index } };
}

export function totalWarReducer(state: TotalWarState, action: TotalWarAction): TotalWarState {
  switch (action.type) {
    case "unitSelected":
    case "unitRemoved":
    case "unitEnhancementLevelChanged":
    case "unitEnhancementRankChanged":
    case "unitEnhancementGearChanged":
    case "unitEnhancementModuleChanged":
    case "unitLinkExclusionChanged": {
      const side = sideOfSlotKey(action.slotKey);
      return side === undefined ? state : delegateToActive(state, side, action);
    }
    case "unitMoved": {
      // 編成を跨ぐ移動は持たない。陣営を跨ぐ指定は`formationReducer`が無視する。
      const side = sideOfSlotKey(action.fromSlotKey);
      return side === undefined ? state : delegateToActive(state, side, action);
    }
    case "memorySelected":
    case "memoryRemoved":
      return delegateToActive(state, action.side, action);
    case "enhancementToggled":
    case "academyLevelChanged":
    case "levelLinkToggled":
    case "levelLinkLevelChanged":
      return delegateToAll(state, action);
    case "logLevelChanged":
      return { ...state, draft: { ...state.draft, logLevel: action.value } };
    // 規定ターン数は15固定で、演習の実行指定も総力戦には無い。`slotKey`は組の間で
    // 同じ文字列になるため、組を区別しない孤児クリアも使わない。
    case "turnLimitChanged":
    case "exerciseExecutionModeChanged":
    case "exerciseRunCountChanged":
    case "exerciseSeedChanged":
    case "unknownDefinitionsCleared":
      return state;
    case "draftReset":
      return createInitialTotalWarState();
    case "unknownDefinitionsClearedByFormation":
      return withFormations(
        state,
        mapFormations(state.draft.formations, (draft, index) => {
          const slotKeys = action.slotKeys[index];
          return slotKeys.length === 0
            ? draft
            : delegate(draft, { type: "unknownDefinitionsCleared", slotKeys });
        }),
      );
    case "formationAdded":
      return addFormation(state, action.side);
    case "formationRemoved":
      return removeFormation(state, action.side);
    case "formationActivated":
      return activateFormation(state, action.side, action.index);
  }
}
