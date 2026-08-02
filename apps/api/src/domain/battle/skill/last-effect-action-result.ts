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
  /**
   * `POST_DAMAGE_CRITICAL_BRANCH`（DMG-003、Issue #196）: 直前のACTION step全体で
   * 実際に適用された会心ヒットの総数。`targetUnitIds`（このEffectAction適用1件の
   * 対象）と違って**step全体**のスコープを持ち、`lastActionTargetUnitIds`/
   * `lastDamagedTargetUnitIds`（`effect-action-group-resolver.ts`の
   * `LastResultState`）と同じ粒度である。
   *
   * step全体にした理由: raw原文の「この攻撃で会心攻撃が発生した場合」は、AOE
   * （`SKL_ROSIE_ARTIST_AS1`の敵横一列、`SKL_URUU_TIMID_EX`の敵全体）でも
   * 「その攻撃のどこかで会心が出たか」を意味しており、最後に処理した対象1体
   * だけの会心では表せないため。単体対象のスキル（`SKL_FEE_BATH_AS2`等）では
   * 両者は一致する。
   *
   * MISS・対象戦闘不能でスキップされたヒットは会心判定自体を行わないため数え
   * ない。DAMAGE以外のEffectActionは常に0。
   */
  readonly criticalHitCount: number;
}
