/**
 * `11_インフラストラクチャ設計.md`「SimulationExecutionGuard」が保持する
 * 「PS候補スタック深度」「1解決スコープ内の効果解決数」の上限判定。ガード自身は
 * 勝敗を決定せず、上限超過を構造化された結果として通知するだけに留める
 * （`09_アプリケーション設計.md`「ガードの値を戦闘ルールの判定には使用しない」）。
 * `resolvePassiveChain`が`PassiveResolutionStack`の深さと発動処理回数をこの
 * 上限と照合する。
 */
export interface PassiveChainLimits {
  readonly maxPassiveDepth: number;
  readonly maxEffectsPerScope: number;
}

export type PassiveChainLimitViolationReason =
  | "MAX_PASSIVE_DEPTH_EXCEEDED"
  | "MAX_EFFECTS_PER_SCOPE_EXCEEDED";

export type PassiveChainLimitCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PassiveChainLimitViolationReason };

export function checkPassiveDepth(
  depth: number,
  limits: PassiveChainLimits,
): PassiveChainLimitCheck {
  return depth > limits.maxPassiveDepth
    ? { ok: false, reason: "MAX_PASSIVE_DEPTH_EXCEEDED" }
    : { ok: true };
}

export function checkEffectsResolvedCount(
  count: number,
  limits: PassiveChainLimits,
): PassiveChainLimitCheck {
  return count > limits.maxEffectsPerScope
    ? { ok: false, reason: "MAX_EFFECTS_PER_SCOPE_EXCEEDED" }
    : { ok: true };
}
