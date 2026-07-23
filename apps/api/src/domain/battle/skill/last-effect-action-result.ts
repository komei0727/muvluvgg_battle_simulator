import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionKind } from "../../catalog/definitions/effect-action-definition.js";
import type { BattleUnitId } from "../../shared/ids.js";

/**
 * `08_ドメインイベント.md`「EffectActionCompleted」の`resultKind`と同じ語彙
 * （`battle/events/domain-event.ts`の`EffectActionResultKind`）を、`domain/battle/skill`
 * のモジュール境界（`events`へ依存できない）内で再定義したもの。文字列リテラル
 * union同士は構造的に同一なため、`lifecycle/`側で両方の型へキャストなしに
 * 同じ値を割り当てられる。
 */
export type LastEffectActionResultKind =
  | "APPLIED"
  | "SKIPPED"
  | "MISSED"
  | "REJECTED"
  | "INTERRUPTED";

/**
 * R-SKL-08「直前結果」: 同じ解決スコープ内で直前に確定した`EffectAction`結果。
 * `LAST_RESULT` Conditionが`field`で参照し、MISS・付与拒否・対象不在などで
 * 効果が適用されなかった場合も、結果種別を持つ直前結果として記録する
 * （`resultKind: "MISSED" | "REJECTED" | "SKIPPED"`等）。
 */
export interface LastEffectActionResult {
  readonly resultKind: LastEffectActionResultKind;
  readonly effectActionKind: EffectActionKind;
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly targetUnitIds: readonly BattleUnitId[];
}
