import { useEffect, useRef } from "react";
import { readJsonItem, writeJsonItem } from "../../lib/storage.js";
import { createInitialFormationState } from "./formation-reducer.js";
import { parseStoredDraft, selectUnknownDefinitionSlotKeys, toStoredDraft } from "./persistence.js";
import { createInitialDraft } from "./types.js";
import type { BattleDraft } from "../../entities/battle-draft.js";
import type { UiViolation } from "../../entities/violation.js";
import type { FormationAction, FormationState } from "./formation-reducer.js";
import type { CatalogLoadState } from "../catalog-selection/catalog-loader.js";

/**
 * `useReducer`のlazy initializerとして呼ぶ（04_コンポーネント・状態管理設計.md
 * §4「永続化」）。復元をreducerの副作用にしないため、storageの読み出しはここへ寄せる。
 * 味方の学園レベル・レベルリンク・ユニット強化はモード非依存の単一slice
 * （`player-enhancement-reducer.ts`、REF-058 / Issue #603）が持つため、ここでは
 * 触れない——モード別draftは編成枠・実行パラメータ・ダイアログ起点だけを持つ。
 */
export function createPersistedInitialState(storageKey: string): FormationState {
  const restored = parseStoredDraft(readJsonItem(storageKey));
  return createInitialFormationState(restored ?? createInitialDraft());
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
