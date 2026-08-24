import { useEffect, useReducer, useRef } from "react";
import { readJsonItem, removeJsonItem, writeJsonItem } from "../../lib/storage.js";
import {
  PLAYER_DATA_STORAGE_KEY,
  isEmptyPlayerData,
  mergeForPersistence,
  parsePlayerData,
  toStoredPlayerData,
} from "./persistence.js";
import {
  createInitialPlayerEnhancementState,
  playerEnhancementReducer,
} from "./player-enhancement-reducer.js";
import type {
  PlayerEnhancementAction,
  PlayerEnhancementState,
} from "./player-enhancement-reducer.js";
import type { CatalogLoadState } from "../catalog-selection/catalog-loader.js";

function createPersistedInitialPlayerEnhancementState(): PlayerEnhancementState {
  return createInitialPlayerEnhancementState(
    parsePlayerData(readJsonItem(PLAYER_DATA_STORAGE_KEY)),
  );
}

export interface PlayerEnhancementPersistence {
  readonly state: PlayerEnhancementState;
  readonly dispatch: (action: PlayerEnhancementAction) => void;
}

/**
 * 手持ちデータ（味方の学園レベル・レベルリンク・ユニット強化、モード非依存の
 * 単一slice）を`mlgg:player-data`へ同期する（01_UI要求・画面設計.md §5.9、
 * REF-058 / Issue #603）。編成draftそのものの保存は`use-formation-persistence.ts`
 * が持つ。
 *
 * 生きたstate（`state`）は入力欄の表示のため未入力（`""`）をそのまま持てるが、
 * 保存データはそれを表現できないため、書き込む値は直前に保存した値
 * （`persistedRef`）との`mergeForPersistence`を通す。画面には常に生のstateを見せ、
 * 保存だけが未入力を前回値へフォールバックさせる。
 */
export function usePlayerEnhancementPersistence(
  catalog: CatalogLoadState,
): PlayerEnhancementPersistence {
  const [state, dispatch] = useReducer(
    playerEnhancementReducer,
    undefined,
    createPersistedInitialPlayerEnhancementState,
  );
  const persistedRef = useRef(state);

  useEffect(() => {
    const merged = mergeForPersistence(persistedRef.current, state);
    if (merged === persistedRef.current) {
      return;
    }
    persistedRef.current = merged;
    if (isEmptyPlayerData(merged)) {
      // 既定値だけの手持ちデータはキーごと消す。「保存した育成データをクリア」の
      // 結果が、既定値を書き戻しただけの状態として残らないようにする。
      removeJsonItem(PLAYER_DATA_STORAGE_KEY);
      return;
    }
    writeJsonItem(PLAYER_DATA_STORAGE_KEY, toStoredPlayerData(merged));
  }, [state]);

  // 未知ユニットの手持ちデータもmount後の最初のCatalog readyで1回だけ取り除く
  // （枠側の孤児クリアは`use-formation-persistence.ts`が同じタイミングで行う）。
  const prunedRef = useRef(false);
  useEffect(() => {
    if (prunedRef.current || catalog.status !== "ready") {
      return;
    }
    prunedRef.current = true;
    const knownUnitDefinitionIds = catalog.response.units.map((unit) => unit.unitDefinitionId);
    dispatch({ type: "pruned", knownUnitDefinitionIds });
  }, [catalog]);

  return { state, dispatch };
}
