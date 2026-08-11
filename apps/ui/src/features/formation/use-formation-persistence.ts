import { useCallback, useEffect, useRef, useState } from "react";
import { readJsonItem, removeJsonItem, writeJsonItem } from "../../lib/storage.js";
import { createInitialFormationState } from "./formation-reducer.js";
import {
  LAST_DRAFT_STORAGE_KEY,
  PLAYER_DATA_STORAGE_KEY,
  createEmptyPlayerData,
  isEmptyPlayerData,
  mergePlayerDataFromDraft,
  parsePlayerData,
  parseStoredDraft,
  prefillUnitEnhancement,
  prunePlayerData,
  selectUnknownDefinitionSlotKeys,
  toStoredDraft,
  toStoredPlayerData,
} from "./persistence.js";
import { createInitialDraft } from "./types.js";
import type { FormationAction, FormationState } from "./formation-reducer.js";
import type { UiViolation } from "./draft-validation.js";
import type { BattleDraft, Side, UnitEnhancementInput } from "./types.js";
import type { CatalogLoadState } from "../catalog-selection/catalog-loader.js";

/**
 * `useReducer`のlazy initializerとして呼ぶ（04_コンポーネント・状態管理設計.md
 * §4「永続化」）。復元をreducerの副作用にしないため、storageの読み出しはここへ寄せる。
 * 保存draftが無い・壊れている場合は初期draftへ落とし、学園レベルだけ手持ちデータから
 * プリフィルする。
 */
export function createPersistedInitialState(): FormationState {
  const restored = parseStoredDraft(readJsonItem(LAST_DRAFT_STORAGE_KEY));
  if (restored !== undefined) {
    return createInitialFormationState(restored);
  }
  return createInitialFormationState(createInitialDraft(readPlayerData().academyLevels));
}

function readPlayerData() {
  return parsePlayerData(readJsonItem(PLAYER_DATA_STORAGE_KEY)) ?? createEmptyPlayerData();
}

export interface UseFormationPersistenceInput {
  readonly draft: BattleDraft;
  readonly catalog: CatalogLoadState;
  /** `validateDraft`の結果。孤児IDの特定に`UNKNOWN_DEFINITION`だけを使う。 */
  readonly violations: readonly UiViolation[];
  readonly dispatch: (action: FormationAction) => void;
}

export interface FormationPersistence {
  /** 味方枠へ配置するユニットのプリフィル値。敵枠は都度入力なので`undefined`。 */
  readonly prefillEnhancementFor: (
    side: Side,
    unitDefinitionId: string,
  ) => UnitEnhancementInput | undefined;
  readonly resetDraft: () => void;
  readonly clearPlayerData: () => void;
}

/**
 * 編成draftと味方の育成データをlocalStorageへ同期する（01_UI要求・画面設計.md §5.9）。
 * 書き込みは全てこのhookのeffectに閉じ、`formationReducer`は純粋なまま保つ。
 * 保存の失敗は`lib/storage.ts`が握り潰すため、ここでは成否を扱わない。
 */
export function useFormationPersistence({
  draft,
  catalog,
  violations,
  dispatch,
}: UseFormationPersistenceInput): FormationPersistence {
  const [playerData, setPlayerData] = useState(readPlayerData);
  const catalogRevision = catalog.status === "ready" ? catalog.response.catalogRevision : undefined;

  // 味方の育成入力を手持ちデータへ書き戻す。draftの参照はreducerが値を変えたときだけ
  // 変わり、変化が無ければ`mergePlayerDataFromDraft`が同じ参照を返すので、ここが
  // 再レンダーのループになることはない。
  useEffect(() => {
    setPlayerData((previous) => mergePlayerDataFromDraft(previous, draft));
  }, [draft]);

  useEffect(() => {
    if (isEmptyPlayerData(playerData)) {
      // 既定値だけの手持ちデータはキーごと消す。「保存した育成データをクリア」の
      // 結果が、既定値を書き戻しただけの状態として残らないようにする。
      removeJsonItem(PLAYER_DATA_STORAGE_KEY);
      return;
    }
    writeJsonItem(PLAYER_DATA_STORAGE_KEY, toStoredPlayerData(playerData));
  }, [playerData]);

  useEffect(() => {
    writeJsonItem(LAST_DRAFT_STORAGE_KEY, toStoredDraft(draft, catalogRevision));
  }, [draft, catalogRevision]);

  // 孤児IDのクリアはmount後の最初のCatalog readyで1回だけ行う。以降の再読込では
  // 04_コンポーネント・状態管理設計.md §5のとおり黙って削除せず、`validateDraft`の
  // errorとして送信を止める（利用者が今まさに選んだ定義を消さないため）。
  const prunedRef = useRef(false);
  useEffect(() => {
    if (prunedRef.current || catalog.status !== "ready") {
      return;
    }
    prunedRef.current = true;
    const slotKeys = selectUnknownDefinitionSlotKeys(violations);
    if (slotKeys.length > 0) {
      dispatch({ type: "unknownDefinitionsCleared", slotKeys });
    }
    const knownUnitIds = catalog.response.units.map((unit) => unit.unitDefinitionId);
    setPlayerData((previous) => prunePlayerData(previous, knownUnitIds));
  }, [catalog, violations, dispatch]);

  const prefillEnhancementFor = useCallback(
    (side: Side, unitDefinitionId: string) =>
      side === "ally" ? prefillUnitEnhancement(playerData, unitDefinitionId) : undefined,
    [playerData],
  );

  const resetDraft = useCallback(() => {
    dispatch({ type: "draftReset", allyAcademyLevels: playerData.academyLevels });
  }, [dispatch, playerData]);

  const clearPlayerData = useCallback(() => {
    // 手持ちデータと画面の味方育成入力は同じ値の2つの置き場なので対で消す。
    // 片方だけ消すと、直後に書き戻しeffectが画面の値から復元してしまう。
    setPlayerData(createEmptyPlayerData());
    dispatch({ type: "allyEnhancementCleared" });
  }, [dispatch]);

  return { prefillEnhancementFor, resetDraft, clearPlayerData };
}
