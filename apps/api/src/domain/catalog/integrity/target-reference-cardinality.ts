import type { TargetBindingDefinition } from "../definitions/effect-sequence.js";
import type { TargetReference } from "../definitions/references.js";
import type { TargetSelectorDefinition } from "../definitions/target-selector-definition.js";

/**
 * 「この`TargetReference`は高々1体へ解決されるか」を、実行時値を一切見ずに
 * Catalog構造だけから判定する。対象ごとのコンテキストを持たない評価点
 * （BRANCHの`condition`、AS/EXの`activationCondition`、付与時に単一IDを焼き込む
 * `APPLY_DAMAGE_LINK.linkTo`）が、量化規則（EXISTS/ALL等）を発明せずに済む範囲へ
 * 限定するために使う。
 */

/** `fallback`の連鎖を含めてselectorツリー全体を見る。 */
export function selectorTreeSome(
  selector: TargetSelectorDefinition,
  predicate: (candidate: TargetSelectorDefinition) => boolean,
): boolean {
  return (
    predicate(selector) ||
    (selector.fallback !== undefined && selectorTreeSome(selector.fallback, predicate))
  );
}

/** `targetBindingId`からselectorを引く索引。単一対象性の判定は宣言元のselectorに依存する。 */
export function buildBindingSelectors(
  targetBindings: readonly TargetBindingDefinition[],
): ReadonlyMap<string, TargetSelectorDefinition> {
  return new Map<string, TargetSelectorDefinition>(
    targetBindings.map((binding) => [binding.targetBindingId, binding.selector]),
  );
}

/**
 * `SELF`/`TRIGGER_SOURCE`は常に1体、`BINDING`は宣言元の`selector`が高々1体しか
 * 解決しないことを`selectorGuaranteesAtMostOneUnit`で保証する場合だけ許可する。
 * `TRIGGER_TARGET`（`triggerTargetUnitIds`は複数ありうる）と
 * `LAST_ACTION_TARGETS`/`LAST_DAMAGED_TARGETS`（AOEの直前結果を含みうる）は
 * 保証できない。
 */
export function targetReferenceIsSingleUnit(
  reference: TargetReference,
  bindingSelectors: ReadonlyMap<string, TargetSelectorDefinition>,
): boolean {
  switch (reference.kind) {
    case "SELF":
    case "TRIGGER_SOURCE":
      return true;
    case "TRIGGER_TARGET":
    case "LAST_ACTION_TARGETS":
    case "LAST_DAMAGED_TARGETS":
      return false;
    case "BINDING": {
      if (reference.targetBindingId === undefined) {
        return false;
      }
      const selector = bindingSelectors.get(reference.targetBindingId);
      return selector !== undefined && selectorGuaranteesAtMostOneUnit(selector);
    }
  }
}

/**
 * `TargetSelectorDefinition`自身が高々1体しか解決しないことを保証できるかどうか
 * （`resolveTargets` — `target-selection-policy.ts` — の実装に基づく）。
 * `kind: SELF`は常に`actor`1体、`kind: TRIGGER_SOURCE`は常に
 * `triggerContext.triggerSourceUnitId`の高々1体（`resolveTriggerPool`）、
 * `kind: SELECT`は`count: 1`の場合だけ高々1体（`count`は`SELECT`にしか付けられない）。
 * `filters`/`area`は候補を絞り込むだけで増やさないため、この3ケース以外では
 * 保証しない — `kind: TRIGGER_TARGET`は`triggerTargetUnitIds`が複数ありうるため不可、
 * `kind: BINDING_DERIVED`は`count`を持てず`area`（例: `ADJACENT_ORTHOGONAL`は最大4体）で
 * 絞り込んだ0〜N体になりうるため不可。
 *
 * `resolveTargets`は主selectorの候補が0件のときだけ`fallback`（独立した
 * `TargetSelectorDefinition`）へ切り替えるため（R-TGT-09 #7）、実際に解決されうる
 * 集合は主selectorの結果と`fallback`の結果の和ではなく「どちらか一方」だが、
 * 値を見ずに静的検証する以上はどちらの経路を通っても高々1体であることを
 * 再帰的に保証する必要がある。
 */
export function selectorGuaranteesAtMostOneUnit(selector: TargetSelectorDefinition): boolean {
  const ownSelectionGuaranteesAtMostOne =
    selector.kind === "SELF" ||
    selector.kind === "TRIGGER_SOURCE" ||
    (selector.kind === "SELECT" && selector.count === 1);
  if (!ownSelectionGuaranteesAtMostOne) {
    return false;
  }
  return selector.fallback === undefined || selectorGuaranteesAtMostOneUnit(selector.fallback);
}
