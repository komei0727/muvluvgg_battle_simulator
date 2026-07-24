import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { BattleUnitId } from "../../shared/ids.js";

/**
 * `domain/battle/events`の`EffectActionResultKind`（`domain-event.ts`）と同じ語彙を
 * 独立して持つ。`domain/battle/skill`は`domain/battle/events`へ依存できない
 * （module境界、`eslint.config.*`の`no-restricted-imports`）ため、この型は
 * 意図的な重複であり、共有できない。
 */
export type LastEffectActionResultKind =
  | "APPLIED"
  | "SKIPPED"
  | "MISSED"
  | "REJECTED"
  | "INTERRUPTED";

/**
 * R-SKL-08「直前結果」: 同じ解決スコープ内で直前に確定した`EffectAction`結果。
 * `LAST_RESULT` Conditionと`LAST_ACTION_TARGETS`/`LAST_DAMAGED_TARGETS`
 * TargetReferenceが参照する。実際に適用が確定した結果だけを表し（MISS・付与
 * 拒否・対象不在も、R-SKL-08「結果種別を持つ直前結果として記録する」の通り
 * 含む）、未実行の（「もし実行していたら」の）結果を表すことはない。
 */
export interface LastEffectActionResult {
  readonly resultKind: LastEffectActionResultKind;
  readonly effectActionKind: EffectActionDefinition["kind"];
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly targetUnitIds: readonly BattleUnitId[];
}
