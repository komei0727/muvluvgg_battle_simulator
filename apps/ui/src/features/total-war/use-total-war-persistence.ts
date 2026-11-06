// docs/ui-design/04_コンポーネント・状態管理設計.md §4「永続化」の総力戦の項。
import { useEffect, useRef } from "react";
import { readJsonItem, writeJsonItem } from "../../lib/storage.js";
import { createInitialTotalWarState } from "./total-war-reducer.js";
import type { TotalWarAction, TotalWarState } from "./total-war-reducer.js";
import {
  TOTAL_WAR_DRAFT_STORAGE_KEY,
  parseStoredTotalWarDraft,
  toStoredTotalWarDraft,
} from "./total-war-persistence.js";
import { FORMATION_INDICES } from "./total-war-draft.js";
import type { FormationIndex, TotalWarDraft } from "./total-war-draft.js";
import { selectUnknownDefinitionSlotKeys } from "../formation/persistence.js";
import type { CatalogLoadState } from "../catalog-selection/catalog-loader.js";
import type { UiViolation } from "../../entities/violation.js";

/** `useReducer`のlazy initializer。表示中の編成は保存しないため各陣営の編成1から開く。 */
export function createPersistedTotalWarState(): TotalWarState {
  return createInitialTotalWarState(
    parseStoredTotalWarDraft(readJsonItem(TOTAL_WAR_DRAFT_STORAGE_KEY)),
  );
}

/** `UNKNOWN_DEFINITION`の枠を編成ごとに分ける。`slotKey`は組の間で同じ文字列になる。 */
function unknownSlotKeysByFormation(
  violations: readonly UiViolation[],
): Readonly<Record<FormationIndex, readonly string[]>> | undefined {
  const byFormation = FORMATION_INDICES.map((index) =>
    selectUnknownDefinitionSlotKeys(
      violations.filter((violation) => violation.formationIndex === index),
    ),
  );
  if (byFormation.every((slotKeys) => slotKeys.length === 0)) {
    return undefined;
  }
  return { 0: byFormation[0] ?? [], 1: byFormation[1] ?? [], 2: byFormation[2] ?? [] };
}

export interface UseTotalWarPersistenceInput {
  readonly draft: TotalWarDraft;
  readonly catalog: CatalogLoadState;
  /** 総力戦の送信前検証の結果（`formationIndex`付き）。孤児IDの特定に使う。 */
  readonly violations: readonly UiViolation[];
  readonly dispatch: (action: TotalWarAction) => void;
}

/**
 * 総力戦のdraftを`mlgg:last-draft:total-war`へ同期し、mount後の最初のCatalog readyで
 * 1回だけ、Catalogから消えた定義の枠を編成ごとに空にする（`usePersistedDraft`と同じ規約）。
 */
export function useTotalWarPersistence({
  draft,
  catalog,
  violations,
  dispatch,
}: UseTotalWarPersistenceInput): void {
  const catalogRevision = catalog.status === "ready" ? catalog.response.catalogRevision : undefined;

  useEffect(() => {
    writeJsonItem(TOTAL_WAR_DRAFT_STORAGE_KEY, toStoredTotalWarDraft(draft, catalogRevision));
  }, [draft, catalogRevision]);

  const prunedRef = useRef(false);
  useEffect(() => {
    if (prunedRef.current || catalog.status !== "ready") {
      return;
    }
    prunedRef.current = true;
    const slotKeys = unknownSlotKeysByFormation(violations);
    if (slotKeys !== undefined) {
      dispatch({ type: "unknownDefinitionsClearedByFormation", slotKeys });
    }
  }, [catalog, violations, dispatch]);
}
