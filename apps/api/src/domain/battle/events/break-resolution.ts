import { DomainValidationError } from "../../shared/errors.js";
import { markBreakPending, type BattleUnit } from "../model/battle-unit.js";
import type { BreakDefeatSource } from "../model/break-deferral.js";
import type { ExerciseRuntime } from "../model/exercise-runtime.js";
import type { BattleDomainEvent } from "./domain-event.js";
import type { DomainEventId } from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";

/**
 * `BreakResolutionService`（`effects/break-resolution-service.ts`）が`yield`する
 * ステップの形。除去ステップ（`linked-group-cascade.ts`）・凍結解除・消費失効と
 * 同じ規約であり、呼び出し側は各`yield`のイベントをPS/Memory即時連鎖へ渡し、
 * 連鎖後の`units`を`.next()`で注入する。
 */
export type BreakResolutionSteps = Generator<
  { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
  { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
  readonly BattleUnit[] | undefined
>;

/**
 * 戦闘不能判定を持つ各サービスが注入を受ける、ブレイク解決への単一の入口。
 * 実装は`effects/break-resolution-service.ts`にあり、`combat/`（`effects/`へ依存
 * できない）と`effects/resource-capacity-recalculation-service.ts`（実装との相互
 * importになる）の双方が同じ形で受け取れるよう、依存の無い`events/`で宣言する。
 */
export type ResolveBreakHook = (
  targetUnitId: BattleUnitId,
  units: readonly BattleUnit[],
  causeEventId: DomainEventId,
  defeatSource: BreakDefeatSource,
) => BreakResolutionSteps;

/**
 * R-TEX-03 #1: このHP0到達を戦闘不能ではなくブレイクとして解決すべきかを判定する、
 * **唯一の**判断点。到達経路（攻撃・継続ダメージ・リソース操作等）を問わないため、
 * 判定材料も経路に依存しない2つだけにする — 戦闘モードが戦術演習であること
 * （`exercise`の有無がそのままモードを表す）と、対象が敵陣営であることである。
 * 演習の敵陣営はちょうど1体（R-TEX-01 #3）なので陣営の判定で足りる。
 */
export function requiresBreakResolution(
  exercise: ExerciseRuntime | undefined,
  target: BattleUnit,
): boolean {
  return exercise !== undefined && target.side === "ENEMY";
}

/**
 * R-TEX-06 #4.3: この到達を保留するなら、保留の印を立てた対象を返す。
 *
 * 印は**到達したヒットのイベントを発行する前**に立てなければならない。ブレイク解決
 * （＝保留の記録）を後段で駆動する形にすると、その間に発行される`HitPointReduced`／
 * `DamageApplied`／`ResourceChanged`のPS/Memory候補検出・特殊失効評価（R-EFF-08）が、
 * 「HPが0で印の無い敵」を観測してしまう。R-TEX-06 #4.3は保留窓の間に敵が戦闘不能として
 * 観測される経路が**一つも**無いことを要求するため、窓が開くのは印が立った瞬間からで
 * なければならない。
 *
 * 保留窓の外（効果処理フェーズが無い経路）では何もしない — 到達時点で解決が完了し、
 * 保留窓自体が存在しないためである。
 */
export function markBreakPendingIfDeferred(
  exercise: ExerciseRuntime | undefined,
  target: BattleUnit,
): BattleUnit {
  return exercise?.deferredBreaks.isDeferring === true ? markBreakPending(target) : target;
}

/**
 * `requiresBreakResolution`が成立したのに`resolveBreak`が注入されていない配線漏れを、
 * その場で失敗させる。
 *
 * fallbackとして`UnitDefeated`を発行してはならない — R-TEX-06 #1は「敵ユニットが
 * 戦闘不能として観測されるタイミングを作らない」と定めており、1経路でも取りこぼすと
 * その経路だけ演習が意図せず終了する。黙って別の意味の状態遷移を起こすより、
 * 明確な例外で配線漏れを表面化させる。
 */
export function requireResolveBreak(
  hook: ResolveBreakHook | undefined,
  path: string,
): ResolveBreakHook {
  if (hook === undefined) {
    throw new DomainValidationError(
      path,
      "a tactical exercise reached an enemy's HP 0 without a BreakResolutionService hook; every defeat-detection path must route through it (R-TEX-03/R-TEX-06)",
    );
  }
  return hook;
}
