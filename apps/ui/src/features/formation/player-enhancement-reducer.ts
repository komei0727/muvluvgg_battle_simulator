// Mirrors docs/ui-design/04_コンポーネント・状態管理設計.md §4「手持ちデータ」。
//
// 手持ちデータ（味方の学園レベル・レベルリンク・ユニット強化）はモードに依らない
// 単一sliceとして持つ（REF-058 / Issue #603）。以前はモード別の`formationReducer`
// draftへ複製し、編集のたびに`BattleSimulatorPage`が両モードへfan-outしていたが、
// ここへ引き上げることでfan-outそのものを不要にする。敵側は都度入力の方針のため
// このsliceに含まれず、引き続き`formationReducer`のモード別draftが持つ。
//
// stateの形は保存形式（`persistence.ts`の`StoredPlayerData`）と同一であり、
// 別名を持たない——生きたstateと保存データが常に同じ形であることが、この引き上げの
// 目的そのもの（1つの場所にしか育成データを持たない）である。
import { createEmptyPlayerData, prunePlayerData } from "./persistence.js";
import type { StoredPlayerData } from "./persistence.js";
import type { GearInput } from "../../entities/battle-draft.js";
import { createInitialUnitEnhancement } from "./types.js";

export type PlayerEnhancementState = StoredPlayerData;

export type PlayerEnhancementAction =
  | {
      readonly type: "academyLevelChanged";
      readonly group: "unitTypes" | "attributes";
      readonly key: string;
      readonly value: number | "";
    }
  | { readonly type: "levelLinkToggled"; readonly enabled: boolean }
  | { readonly type: "levelLinkLevelChanged"; readonly value: number | "" }
  | {
      readonly type: "unitEnhancementLevelChanged";
      readonly unitDefinitionId: string;
      readonly value: number | "";
    }
  | {
      readonly type: "unitEnhancementRankChanged";
      readonly unitDefinitionId: string;
      readonly value: number;
    }
  | {
      readonly type: "unitEnhancementGearChanged";
      readonly unitDefinitionId: string;
      readonly gearIndex: number;
      readonly gear?: GearInput;
    }
  | {
      readonly type: "unitLinkExclusionChanged";
      readonly unitDefinitionId: string;
      readonly excluded: boolean;
      /**
       * UI-AC-036: 外した瞬間、その時点のリンクレベルでユニットのレベルをシードする
       * （`formation-reducer.ts`の`unitLinkExclusionChanged`と同じ規約。呼び出し側
       * ——`app/SelectionDialogs.tsx`——が`isSlotLevelLinked`で判定し載せる）。
       */
      readonly seedLevel?: number | "";
    }
  // 「保存した育成データをクリア」。旧`allyEnhancementCleared`に相当する。
  | { readonly type: "cleared" }
  // Catalogから消えたユニットのエントリを取り除く（`prunePlayerData`のdispatch版）。
  | { readonly type: "pruned"; readonly knownUnitDefinitionIds: readonly string[] };

/** `draft`は`mlgg:player-data`から復元した値（`persistence.ts`）。 */
export function createInitialPlayerEnhancementState(
  data?: StoredPlayerData,
): PlayerEnhancementState {
  return data ?? createEmptyPlayerData();
}

/**
 * ユニット強化はユニット定義ID単位の任意入力なので、最初の編集時に既定値
 * （レベル200・ギア9枠すべて空）から作り始める（`formation-reducer.ts`の
 * `editSlotEnhancement`と同じ規約。あちらはslotKey単位、こちらはunitDefinitionId単位）。
 */
function editUnit(
  state: PlayerEnhancementState,
  unitDefinitionId: string,
  edit: (
    enhancement: PlayerEnhancementState["units"][string],
  ) => PlayerEnhancementState["units"][string],
): PlayerEnhancementState["units"] {
  const current = state.units[unitDefinitionId] ?? createInitialUnitEnhancement();
  return { ...state.units, [unitDefinitionId]: edit(current) };
}

export function playerEnhancementReducer(
  state: PlayerEnhancementState,
  action: PlayerEnhancementAction,
): PlayerEnhancementState {
  switch (action.type) {
    case "academyLevelChanged":
      return {
        ...state,
        academyLevels: {
          ...state.academyLevels,
          [action.group]: { ...state.academyLevels[action.group], [action.key]: action.value },
        },
      };
    case "levelLinkToggled":
      // 参照時解決なので、リンクのON/OFFで各ユニットの`level`は書き換えない
      // （UI-CMP-023。OFFへ戻すだけで各枠が元の手動レベルへ戻る）。
      return { ...state, levelLink: { ...state.levelLink, enabled: action.enabled } };
    case "levelLinkLevelChanged":
      return { ...state, levelLink: { ...state.levelLink, level: action.value } };
    case "unitEnhancementLevelChanged":
      return {
        ...state,
        units: editUnit(state, action.unitDefinitionId, (enhancement) => ({
          ...enhancement,
          level: action.value,
        })),
      };
    case "unitEnhancementRankChanged":
      return {
        ...state,
        units: editUnit(state, action.unitDefinitionId, (enhancement) => ({
          ...enhancement,
          rank: action.value,
        })),
      };
    case "unitEnhancementGearChanged":
      return {
        ...state,
        units: editUnit(state, action.unitDefinitionId, (enhancement) => ({
          ...enhancement,
          gears: enhancement.gears.map((gear, index) =>
            index === action.gearIndex ? action.gear : gear,
          ),
        })),
      };
    case "unitLinkExclusionChanged":
      return {
        ...state,
        units: editUnit(state, action.unitDefinitionId, (enhancement) => ({
          ...enhancement,
          ...(action.seedLevel === undefined ? {} : { level: action.seedLevel }),
          linkExcluded: action.excluded,
        })),
      };
    case "cleared":
      return createEmptyPlayerData();
    case "pruned":
      return prunePlayerData(state, action.knownUnitDefinitionIds);
  }
}
