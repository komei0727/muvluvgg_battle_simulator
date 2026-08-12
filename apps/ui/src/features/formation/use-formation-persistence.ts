import { useCallback, useEffect, useRef, useState } from "react";
import { readJsonItem, removeJsonItem, writeJsonItem } from "../../lib/storage.js";
import { createInitialFormationState } from "./formation-reducer.js";
import {
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
 * プリフィルする。モード別draftはそれぞれの保存キーを`useReducer`の第2引数で渡す。
 */
export function createPersistedInitialState(storageKey: string): FormationState {
  const restored = parseStoredDraft(readJsonItem(storageKey));
  if (restored !== undefined) {
    return createInitialFormationState(restored);
  }
  return createInitialFormationState(createInitialDraft(readPlayerData().academyLevels));
}

function readPlayerData() {
  return parsePlayerData(readJsonItem(PLAYER_DATA_STORAGE_KEY)) ?? createEmptyPlayerData();
}

export interface UsePersistedDraftInput {
  /** このdraftの保存先キー。モードごとに1つ持つ（§5.9）。 */
  readonly storageKey: string;
  readonly draft: BattleDraft;
  readonly catalog: CatalogLoadState;
  /** そのdraftの`validateDraft`結果。孤児IDの特定に`UNKNOWN_DEFINITION`だけを使う。 */
  readonly violations: readonly UiViolation[];
  readonly dispatch: (action: FormationAction) => void;
}

/**
 * 1つの編成draftをlocalStorageへ同期し、Catalogから消えた定義を持つ枠を空にする
 * （01_UI要求・画面設計.md §5.9）。モードごとにdraftとキーが独立するため、
 * モード数だけ呼ぶ。孤児IDの判定は渡されたdraftのviolationだけで行う — `slotKey`は
 * モード間で同じ文字列になるため、他モードのviolationを混ぜると無関係な枠を空にする。
 */
export function usePersistedDraft({
  storageKey,
  draft,
  catalog,
  violations,
  dispatch,
}: UsePersistedDraftInput): void {
  const catalogRevision = catalog.status === "ready" ? catalog.response.catalogRevision : undefined;

  useEffect(() => {
    writeJsonItem(storageKey, toStoredDraft(draft, catalogRevision));
  }, [storageKey, draft, catalogRevision]);

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
  }, [catalog, violations, dispatch]);
}

export interface UseFormationPersistenceInput {
  /**
   * 手持ちデータの書き戻し元、すなわち今まさに編集しているdraft。手持ちデータは
   * モードに依らない味方の育成情報なので、どのモードで編集しても書き戻す
   * （`UI-AC-030`）。
   */
  readonly editedDraft: BattleDraft;
  /**
   * 書き戻し元draftの識別子（モード）。これが変わっただけの再レンダーでは書き戻さない
   * ——モード切替は編集ではなく、離れたモードのdraftが持つ古い値で最新の手持ちデータを
   * 上書きしてはならない。
   */
  readonly editedDraftId: string;
  /**
   * 直近に強化入力を編集した枠（`FormationState.lastEditedSlotKey`）。同じユニットを
   * 複数枠へ置けるため、手持ちデータへ書き戻す枠をこれで一意に決める。
   */
  readonly lastEditedSlotKey?: string;
  readonly catalog: CatalogLoadState;
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
  /**
   * 保存対象ではないdraft（`UI-CMP-010`のモード別draft）も同じ初期値へ戻せるよう、
   * dispatch先を固定しないactionだけを返す。学園レベルは手持ちデータ由来のため、
   * どのdraftを初期化してもここで解決した値を使う。
   */
  readonly createDraftResetAction: () => FormationAction;
}

/**
 * 味方の育成データ（手持ちデータ）をlocalStorageへ同期する（01_UI要求・画面設計.md
 * §5.9）。編成draftそのものの保存は`usePersistedDraft`が持つ。書き込みは全て
 * このhookのeffectに閉じ、`formationReducer`は純粋なまま保つ。保存の失敗は
 * `lib/storage.ts`が握り潰すため、ここでは成否を扱わない。
 */
export function useFormationPersistence({
  editedDraft,
  editedDraftId,
  lastEditedSlotKey,
  catalog,
  dispatch,
}: UseFormationPersistenceInput): FormationPersistence {
  const [playerData, setPlayerData] = useState(readPlayerData);

  // 味方の育成入力を手持ちデータへ書き戻す。draftの参照はreducerが値を変えたときだけ
  // 変わり、変化が無ければ`mergePlayerDataFromDraft`が同じ参照を返すので、ここが
  // 再レンダーのループになることはない。
  const lastMergedDraftIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const previousId = lastMergedDraftIdRef.current;
    lastMergedDraftIdRef.current = editedDraftId;
    // 書き戻し元が別のdraftへ切り替わった直後は書き戻さない。切替自体は編集では
    // ないため、ここで書き戻すと切替先のdraftが持つ古い値で手持ちデータを上書きする。
    if (previousId !== undefined && previousId !== editedDraftId) {
      return;
    }
    setPlayerData((previous) => mergePlayerDataFromDraft(previous, editedDraft, lastEditedSlotKey));
  }, [editedDraft, editedDraftId, lastEditedSlotKey]);

  useEffect(() => {
    if (isEmptyPlayerData(playerData)) {
      // 既定値だけの手持ちデータはキーごと消す。「保存した育成データをクリア」の
      // 結果が、既定値を書き戻しただけの状態として残らないようにする。
      removeJsonItem(PLAYER_DATA_STORAGE_KEY);
      return;
    }
    writeJsonItem(PLAYER_DATA_STORAGE_KEY, toStoredPlayerData(playerData));
  }, [playerData]);

  // 未知ユニットの手持ちデータもmount後の最初のCatalog readyで1回だけ取り除く
  // （枠側の孤児クリアは`usePersistedDraft`が同じタイミングで行う）。
  const prunedRef = useRef(false);
  useEffect(() => {
    if (prunedRef.current || catalog.status !== "ready") {
      return;
    }
    prunedRef.current = true;
    const knownUnitIds = catalog.response.units.map((unit) => unit.unitDefinitionId);
    setPlayerData((previous) => prunePlayerData(previous, knownUnitIds));
  }, [catalog]);

  const prefillEnhancementFor = useCallback(
    (side: Side, unitDefinitionId: string) =>
      side === "ally" ? prefillUnitEnhancement(playerData, unitDefinitionId) : undefined,
    [playerData],
  );

  const createDraftResetAction = useCallback(
    (): FormationAction => ({
      type: "draftReset",
      allyAcademyLevels: playerData.academyLevels,
    }),
    [playerData],
  );

  const resetDraft = useCallback(() => {
    dispatch(createDraftResetAction());
  }, [dispatch, createDraftResetAction]);

  const clearPlayerData = useCallback(() => {
    // 手持ちデータと画面の味方育成入力は同じ値の2つの置き場なので対で消す。
    // 片方だけ消すと、直後に書き戻しeffectが画面の値から復元してしまう。
    setPlayerData(createEmptyPlayerData());
    dispatch({ type: "allyEnhancementCleared" });
  }, [dispatch]);

  return { prefillEnhancementFor, resetDraft, clearPlayerData, createDraftResetAction };
}
