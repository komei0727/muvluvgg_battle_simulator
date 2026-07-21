import type { EffectInstanceId } from "../../shared/event-ids.js";
import type { EffectKindKey } from "./applied-effect.js";

/**
 * `05_ドメインモデル.md`「AppliedEffect」/R-EFF-05「重複効果の期間」の入力形。
 * `AppliedEffect`本体から選択に必要な4フィールドだけを抜き出す（呼び出し側が
 * `CombatStat`計算対象以外の効果種別へも同じ選択規則を適用できるよう、
 * `EffectActionDefinitionId`やCatalog参照を要求しない）。
 */
export interface EffectiveEffectCandidate {
  readonly effectInstanceId: EffectInstanceId;
  readonly kindKey: EffectKindKey;
  /** true: 重複あり（常に有効）。false: 重複なし（同種グループ内の最強1件だけが有効）。 */
  readonly duplicate: boolean;
  readonly magnitude: number;
}

/**
 * R-EFF-05: 重複あり効果は同種であっても効果インスタンスと残り期間を個別に
 * 保持し、常にすべて有効とする。重複なし効果は`EffectKindKey`ごとにグループ化し、
 * その時点で最も強い（絶対値が最大の）1件だけを有効とする（R-STA-03）。
 * 同じ絶対値の候補が複数ある場合は最初に付与されたもの（`candidates`内で先に
 * 出現するもの）を代表として扱う。
 *
 * この関数は状態を持たず、渡された`candidates`だけから毎回選択結果を導出する
 * 純粋関数のため、「採用中の最強効果が失効・解除された場合、残っている同種
 * 効果を再評価し、次に強い1件を即時に有効化する」（次点繰上げ）は、失効・
 * 解除後の`candidates`（対象インスタンスを除いたリスト）で呼び直すだけで
 * 自然に成立する — 明示的な繰上げ処理を別途持たない。
 */
/**
 * R-EFF-05/R-STA-03: 重複なし効果を`EffectKindKey`ごとにグループ化し、各グループの
 * 最強（絶対値が最大の）1件のインスタンスIDだけを返す。重複あり効果は単一の
 * 「採用インスタンス」という概念を持たないため、このMapに含めない。
 */
export function selectNonStackableWinners(
  candidates: readonly EffectiveEffectCandidate[],
): ReadonlyMap<EffectKindKey, EffectInstanceId> {
  const strongestByGroup = new Map<EffectKindKey, EffectiveEffectCandidate>();
  for (const candidate of candidates) {
    if (candidate.duplicate) {
      continue;
    }
    const current = strongestByGroup.get(candidate.kindKey);
    if (current === undefined || Math.abs(candidate.magnitude) > Math.abs(current.magnitude)) {
      strongestByGroup.set(candidate.kindKey, candidate);
    }
  }
  return new Map(
    [...strongestByGroup].map(([kindKey, winner]) => [kindKey, winner.effectInstanceId]),
  );
}

export function selectEffectiveInstances(
  candidates: readonly EffectiveEffectCandidate[],
): ReadonlySet<EffectInstanceId> {
  const effective = new Set<EffectInstanceId>(selectNonStackableWinners(candidates).values());
  for (const candidate of candidates) {
    if (candidate.duplicate) {
      effective.add(candidate.effectInstanceId);
    }
  }
  return effective;
}
