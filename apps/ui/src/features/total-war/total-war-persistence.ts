// docs/ui-design/04_コンポーネント・状態管理設計.md §4「永続化」の総力戦の項と
// 01_UI要求・画面設計.md §5.10「保存とリセット」の写像。
//
// 3組は既存のdraftキーと同じ形で直列化し、組ごとの読み手は`persistence.ts`の
// ナローイングをそのまま使う。任意項目（`levelLink`・`linkExcluded`・`rank`）の
// 既定値読みを1か所に保つため。表示中の編成（`activeFormation`）は見え方なので
// 保存しない。
import { isFormationCount } from "./total-war-draft.js";
import type { TotalWarDraft, TotalWarFormations } from "./total-war-draft.js";
import { isRecord } from "../../lib/unknown-narrowing.js";
import {
  PERSISTENCE_SCHEMA_VERSION,
  parseStoredDraftBody,
  parseStoredLogLevel,
} from "../formation/persistence.js";
import type { BattleDraft } from "../../entities/battle-draft.js";

/** 他モードと互いに現れないよう、モードごとに別キーへ分ける（01_UI要求・画面設計.md §5.9）。 */
export const TOTAL_WAR_DRAFT_STORAGE_KEY = "mlgg:last-draft:total-war";

/** `catalogRevision`は診断用で、復元条件にはしない。 */
export function toStoredTotalWarDraft(draft: TotalWarDraft, catalogRevision?: string): unknown {
  return {
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    ...(catalogRevision === undefined ? {} : { catalogRevision }),
    formations: draft.formations,
    formationCounts: draft.formationCounts,
    logLevel: draft.logLevel,
  };
}

function formationsOf(value: unknown): TotalWarFormations | undefined {
  // 組の数は固定。長さが違う保存データは組と編成番号の対応が信じられないため全体を捨てる。
  if (!Array.isArray(value) || value.length !== 3) {
    return undefined;
  }
  const parsed = value.map((formation) => parseStoredDraftBody(formation));
  const [first, second, third] = parsed;
  if (first === undefined || second === undefined || third === undefined) {
    return undefined;
  }
  return [first, second, third] satisfies readonly [BattleDraft, BattleDraft, BattleDraft];
}

/** 1項目でも契約から外れれば保存データ全体を破棄する（`undefined`を返す）。 */
export function parseStoredTotalWarDraft(value: unknown): TotalWarDraft | undefined {
  if (!isRecord(value) || value["schemaVersion"] !== PERSISTENCE_SCHEMA_VERSION) {
    return undefined;
  }
  const formations = formationsOf(value["formations"]);
  const counts = value["formationCounts"];
  const logLevel = parseStoredLogLevel(value["logLevel"]);
  if (formations === undefined || !isRecord(counts) || logLevel === undefined) {
    return undefined;
  }
  const ally = counts["ally"];
  const enemy = counts["enemy"];
  if (!isFormationCount(ally) || !isFormationCount(enemy)) {
    return undefined;
  }
  return { formations, formationCounts: { ally, enemy }, logLevel };
}
