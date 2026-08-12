import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { ExerciseRuntime } from "../model/exercise-runtime.js";
import type { BattleDomainEvent } from "./domain-event.js";
import type { DomainEventId } from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { Side } from "../../shared/side.js";

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
 * R-TEX-03 #2: ブレイクを撃破として扱うために`UnitBroken`が引き継ぐ発生源。
 *
 * 「敵撃破時」契機の`TriggerDefinition`は`sourceSelector`で発生源を絞る
 * （production例: `SKL_HIIRO_LONEWOLF_PS2`／`SKL_LILY_HERO_PS1`／
 * `SKL_YURIA_WILDCARD_PS1`はいずれも`sourceSelector: SELF`＝「自身が敵を撃破した時」）。
 * `UnitBroken`がブレイク対象自身を発生源にすると、`matchesTriggerEventType`で
 * 種別の照合に成功してもselectorで脱落し、Catalog定義を変えずに発動させるという
 * R-TEX-03 #2の要求を満たさない。そのため各シームは、その経路の`UnitDefeated`が
 * 載せていたのとまったく同じ発生源をここへ渡す。
 *
 * 継続ダメージのようにメモリー由来の発生源（`sourceUnitId`を持たず`sourceSide`だけ）
 * があり得るため、両方を省略可能にする（R-MEM-04）。
 */
export interface BreakDefeatSource {
  readonly sourceUnitId?: BattleUnitId;
  readonly sourceSide?: Side;
}

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
