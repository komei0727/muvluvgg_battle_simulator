import { requireUnit } from "./action-resolution-shared.js";
import { isQueueEligible, type ActionReservation } from "../action/action-queue.js";
import { PassiveActivationRuntime } from "./passive-activation-service.js";
import type { ResolutionResult } from "./resolution-result.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import type { ExerciseRuntime } from "../model/exercise-runtime.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import type { DomainEventId } from "../../shared/event-ids.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { ActionReservationRemovalReason } from "../events/domain-event.js";
import type { RandomSource } from "../../ports/random-source.js";

export interface ReservationRemovalContext {
  readonly definitions: BattleDefinitions;
  readonly random: RandomSource;
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  /** この除去群を引き起こした行動が完了した時点の終端イベントID。最初の`ActionReservationRemoved.parentEventId`に使う。 */
  readonly parentEventId: DomainEventId;
  /** 除去群を引き起こした行動の`rootEventId`。除去群全体を通じて維持する（監査上の因果は「この行動が引き起こした」まま）。 */
  readonly rootEventId: DomainEventId;
  /** R-TEX-02: 除去を契機に発動したPS/Memoryが与えるダメージもスコアへ計上するため運ぶ。 */
  readonly exercise?: ExerciseRuntime;
}

export interface ReservationRemovalResult extends ResolutionResult {
  readonly remaining: readonly ActionReservation[];
}

/**
 * Issue #251/#180: 予約除去を「反応可能なドメイン遷移」として扱う専用の
 * ドメインサービス。`06_戦闘状態遷移.md`「戦闘不能者の除去」「R-ORD-01適格性の
 * 喪失」の固定点解決を1箇所へ集約する。
 *
 * Issue #251が定義する固定点ライフサイクルをそのまま実装する。
 *
 * 1. 最新の`working`から除去対象と理由を1件決定する（戦闘不能なら`DEFEATED`、
 *    それ以外でR-ORD-01を満たさなくなっていれば`INELIGIBLE`）。
 * 2. `ActionReservationRemoved`を発行する。
 * 3. そのPS/Memory連鎖を`onFactEvent`で解決する。
 * 4. `finalizeResolutionScope()`で解決スコープを終了する。
 * 5. 終了時イベント（`RuntimeCounterReset`）の連鎖も含む最新状態で、残る
 *    `remaining`全体を再検証する。
 * 6. 除去対象がなくなるまで、新しい`resolutionScopeId`と独立した
 *    `PassiveActivationRuntime`で1から反復する。
 *
 * `ActionReservationRemoved`はCatalog上・設計書上（`catalog-event-types.ts`、
 * `08_ドメインイベント.md`）トリガー可能なFACTイベントであり、他のFACTイベント
 * と同じくPS/Memory候補の発動契機になり得る。除去1件ごとに新しい
 * `resolutionScopeId`と独立した`PassiveActivationRuntime`を発行するのは、
 * R-PS-07「1解決スコープ1回」がPS発動済み集合をスコープ単位で管理するため——
 * 除去を1つのスコープへまとめると、同じPSが2件目以降の除去には
 * （既にそのスコープで発動済みとして）反応できなくなる。除去1件＝1解決スコープ
 * とすることで、各`ActionReservationRemoved`が独立したトップレベルイベントとして
 * 同じPSからも毎回反応を受けられる（Issue #251）。
 *
 * `rootEventId`は除去群を引き起こした行動（呼び出し側が渡す`context.rootEventId`）
 * を維持し、監査上の因果は「この行動が引き起こした」まま保つ——`resolutionScopeId`
 * だけが除去1件ごとに切り替わる。
 *
 * 除去対象を一括で事前計算してから順に処理すると、ある除去のPS/Memory連鎖が
 * 他の予約の適格性・生死を変えても反映されない（例: Bの除去PSがCの凍結を解除し
 * 適格性を戻してもCは事前リストに残ったまま誤って除去される。逆にBの除去PSが
 * Dの適格性を奪ってもDは事前リストに無く実行されてしまう。Bの除去PSがDを
 * 戦闘不能にした場合、除去理由も本来の`DEFEATED`ではなく事前計算時点の
 * `INELIGIBLE`のまま記録されてしまう）。そのため`remaining`は除去のたびに
 * 最新の`working`から1件ずつ再判定し、`remaining`は毎回ちょうど1件ずつ減るため
 * 無限ループにはならない。
 *
 * `finalizeResolutionScope()`自体も`resetScope: RESOLUTION_SCOPE`のcounter
 * 破棄・`RuntimeCounterReset`発行とその候補解決を行うため、残存予約の生死・
 * 適格性を変えうる——次の除去対象の判定は、この連鎖後の最新`working`に対して
 * 必ず行う。
 *
 * 因果カーソル（`lastEventId`）は、`onFactEvent`が返す直前の除去の
 * 反応連鎖まで含めた終端イベントと、`finalizeResolutionScope()`が発行・解決
 * した最後の`DomainEventId`（発行済みなら、何も無ければ直前のまま）の両方から、
 * 常に呼び出し側が推測せず明示的に受け取る。
 */
export function resolveReservationRemovals(
  remaining: readonly ActionReservation[],
  units: readonly BattleUnit[],
  context: ReservationRemovalContext,
): ReservationRemovalResult {
  const { definitions, random, recorder, turnNumber, cycleNumber, rootEventId, exercise } = context;
  let currentRemaining = remaining;
  let working = units;
  let lastEventId = context.parentEventId;

  for (;;) {
    const next = currentRemaining.find((entry) => {
      const unit = requireUnit(working, entry.battleUnitId);
      return isDefeated(unit) || !isQueueEligible(unit);
    });
    if (next === undefined) {
      break;
    }
    const reason: ActionReservationRemovalReason = isDefeated(
      requireUnit(working, next.battleUnitId),
    )
      ? "DEFEATED"
      : "INELIGIBLE";

    const resolutionScopeId = recorder.nextResolutionScopeId();
    const passiveRuntime = new PassiveActivationRuntime(
      {
        definitions,
        random,
        recorder,
        turnNumber,
        cycleNumber,
        resolutionScopeId,
        rootEventId,
        ...(exercise !== undefined ? { exercise } : {}),
      },
      working,
    );
    const event = recorder.record({
      eventType: "ActionReservationRemoved",
      category: "FACT",
      turnNumber,
      cycleNumber,
      resolutionScopeId,
      parentEventId: lastEventId,
      rootEventId,
      sourceUnitId: next.battleUnitId,
      payload: { battleUnitId: next.battleUnitId, reason },
    });
    const resolved = passiveRuntime.onFactEvent(event, working);
    working = resolved.units;
    lastEventId = resolved.lastEventId;
    currentRemaining = currentRemaining.filter((entry) => entry.battleUnitId !== next.battleUnitId);

    const finalized = passiveRuntime.finalizeResolutionScope(lastEventId);
    working = finalized.units;
    lastEventId = finalized.lastEventId;
    // ループの先頭に戻り、この1件の除去とfinalizeResolutionScope自身のPS/
    // Memory連鎖後の最新`working`で`currentRemaining`を再評価する。次の除去
    // 対象が見つかれば、新しい`resolutionScopeId`と独立した
    // `PassiveActivationRuntime`でこの一連の処理を継続する。
  }

  return { remaining: currentRemaining, units: working, lastEventId };
}
