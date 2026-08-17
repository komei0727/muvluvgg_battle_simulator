import { DomainValidationError } from "../../shared/errors.js";
import type { DomainEventId } from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { Side } from "../../shared/side.js";

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
 * R-TEX-03 #5: スキル効果処理フェーズの内側でHPが0へ到達したときに記録する保留。
 * 解決はそのフェーズの末尾（R-TEX-06 #5）で行うため、そこまで運ぶ必要がある材料
 * だけを持つ — 対象、HP0へ到達した原因イベント（`UnitBroken`の`parentEventId`に
 * なる。同 #5）、そして撃破トリガーが要求する発生源（同 #2）である。
 */
export interface DeferredBreak {
  readonly targetUnitId: BattleUnitId;
  readonly causeEventId: DomainEventId;
  readonly defeatSource: BreakDefeatSource;
}

/**
 * R-TEX-03 #5の保留の記録・取り出し・破棄を閉じ込めた、効果処理フェーズごとの
 * フレームスタック。
 *
 * 寿命と入れ子は`R-ATM-01`の保留キュー（`resolve-passive-chain.ts`の
 * `ChainState.pendingFrames`／`PassiveActivationRuntime.pendingEffectProcessingFrames`）
 * と同一にする（`05_ドメインモデル.md`「BreakResolutionService」）— 1回のスキル効果
 * 処理につき1フレームを積み、ネストしたPS/MemoryのEffectSequenceは自分のフレームを
 * 持ち（R-TEX-06 #8）、フレームはその効果処理の末尾で必ず取り外す（同 #7: 中断でも
 * 解決せずに破棄することはない）。
 *
 * この実体は`ExerciseRuntime`が持つ（`EventRecorder`と同じ「Battle 1つにつき1
 * インスタンス、解決経路へ参照を渡す」扱い）。フレーム自体は効果処理フェーズ単位で
 * あって演習状態の一部ではない — スナップショットにもStateDeltaにも現れない — が、
 * 器を演習状態と同じ物に載せることで「`exercise`が伝播した経路には必ず保留先も
 * 伝播している」を型ではなく構造で保証する。`exercise`と`resolveBreak`を組で運ばな
 * ければならない既存の制約（`effect-action-group-context.ts`）と同じ理由であり、
 * 片方だけが伝播した経路は保留窓を作らずに即時解決してしまうため、実行時にも気付け
 * ない誤りになる。
 */
export class BreakDeferral {
  /** 配列末尾が現在進行中の効果処理フェーズ。空なら効果処理の外＝即時解決する。 */
  private readonly frames: (DeferredBreak | undefined)[] = [];

  /** 効果処理フェーズの内側か（＝HP0到達を保留すべきか）。 */
  get isDeferring(): boolean {
    return this.frames.length > 0;
  }

  /** `R-ATM-02` #2の効果処理フェーズの開始。呼び出し側は`endEffectProcessing`と必ず対で呼ぶ。 */
  beginEffectProcessing(): void {
    this.frames.push(undefined);
  }

  /**
   * R-TEX-06 #5: 現在の効果処理フェーズのフレームを取り外し、保留したブレイク（あれば）
   * を返す。呼び出し側はこれを受け取った時点でブレイク解決を駆動する。
   */
  endEffectProcessing(): DeferredBreak | undefined {
    return this.frames.pop();
  }

  /**
   * R-TEX-03 #5: 現在の効果処理フェーズへHP0到達を記録する。
   *
   * R-TEX-03 #7「1回の効果処理につきブレイクは高々1回」: 同じ対象が既に保留済みなら
   * 最初の記録を保つ。R-TEX-03 #6が「HPが0へ到達した」最初の事実でブレイクを確定させる
   * ため、`causeEventId`（＝`UnitBroken`の因果の親）も最初の到達のものでなければならない。
   *
   * **別の**対象が既に保留されている場合は例外にする。1フレームは保留を1件しか運べず、
   * 2件目を黙って捨てるとその対象の印を外す主体が存在しなくなり、HP0のまま
   * `isDefeated`が永久に偽（ブレイクも撃破も起きない）というユニットが残る。R-TEX-01 #3
   * が演習の敵をちょうど1体に固定し、印が付くのは敵陣営だけであるため現状は到達しないが、
   * `requireResolveBreak`と同じ理由で、黙って別の意味の状態へ落ちるより不変条件の破れを
   * その場で表面化させる。
   */
  defer(pending: DeferredBreak): void {
    const index = this.frames.length - 1;
    if (index < 0) {
      return;
    }
    const existing = this.frames[index];
    if (existing !== undefined) {
      if (existing.targetUnitId !== pending.targetUnitId) {
        throw new DomainValidationError(
          "breakDeferral.defer",
          `a second unit reached HP 0 while "${existing.targetUnitId}" already had a break pending in the same effect processing; a tactical exercise has exactly one enemy (R-TEX-01 #3) so only that unit can break (R-TEX-03 #7)`,
        );
      }
      return;
    }
    this.frames[index] = pending;
  }
}
