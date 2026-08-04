import { removeEffects } from "../../effects/effect-removal-service.js";
import {
  settledOutcome,
  type EffectActionHandler,
  type EffectActionOutcome,
} from "./effect-action-handler.js";
import { eventContextOf } from "./effect-action-group-context.js";

/**
 * R-EFF-02（M7-001）: 対象カテゴリに一致する`AppliedEffect`を即時解除する
 * （`effect-removal-service.ts`）。
 *
 * M7-001A（`REMOVE_EFFECTS_CATEGORY_GAP`）: SHIELD/SUBUNITは、シールド・サブユニットの
 * 実行時状態が未モデル化だった間だけ、silent no-opへの退行を防ぐ防御的ガードとして
 * ここで明示的に拒否していた。DMG-004（`CAP_SHIELD`）とDMG-005（`CAP_SUBUNIT`）が
 * どちらも`AppliedEffect.shield`/`AppliedEffect.subUnit`として実行時状態を持つように
 * なったため、ガードを外して他カテゴリと同じ経路へ通す — シールドプール
 * （`shield-policy.ts`の`shieldPoolsOf`）もサブユニット耐久力（`sub-unit-policy.ts`の
 * `subUnitDurabilityTotal`）もインスタンス集合からの導出値であり、インスタンスの除去が
 * そのまま解除になる。分類は他カテゴリと同じく`effect-category-classifier.ts`
 * （`APPLY_SHIELD`→`SHIELD`、`APPLY_SUBUNIT`→`SUBUNIT`）ただ1つを正本とする。
 *
 * REMOVE_MARKERと同じ理由で、除去より前に記録済みの`EffectActionStarting`を先に通知し、
 * 以降のインスタンス単位の通知は`removeEffects`内部（R-EFF-09カスケード分＋seed分）へ委ねる。
 */
export const resolveRemoveEffects: EffectActionHandler<"REMOVE_EFFECTS"> = (
  input,
): EffectActionOutcome => {
  const { context, box, application, effectAction, startingEventId, cursor } = input;
  cursor.notifyPending();
  const removal = removeEffects(
    {
      ...eventContextOf(context),
      ...(context.onFactEventForPassiveChain !== undefined
        ? { onFactEventForPassiveChain: context.onFactEventForPassiveChain }
        : {}),
    },
    box.units,
    application.targetUnitId,
    {
      categories: effectAction.payload.categories,
      ...(effectAction.payload.effectActionDefinitionIds !== undefined
        ? { effectActionDefinitionIds: effectAction.payload.effectActionDefinitionIds }
        : {}),
      ...(effectAction.payload.maxRemovals !== undefined
        ? { maxRemovals: effectAction.payload.maxRemovals }
        : {}),
    },
    context.definitions.effectActions,
    startingEventId,
  );
  box.units = removal.units;
  cursor.consumeNotifiedByCallee();
  return settledOutcome(
    input,
    removal.lastEventId,
    removal.removedCount > 0 ? "APPLIED" : "SKIPPED",
  );
};
