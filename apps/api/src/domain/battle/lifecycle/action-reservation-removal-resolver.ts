import { requireUnit } from "./action-resolution-shared.js";
import { isQueueEligible, type ActionReservation } from "../action/action-queue.js";
import { PassiveActivationRuntime } from "./passive-activation-service.js";
import type { ResolutionResult } from "./resolution-result.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
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
}

export interface ReservationRemovalResult extends ResolutionResult {
  readonly remaining: readonly ActionReservation[];
}

/**
 * Issue #251/#180: 予約除去を「反応可能なドメイン遷移」として扱う専用の
 * ドメインサービス。`06_戦闘状態遷移.md`「戦闘不能者の除去」「R-ORD-01適格性の
 * 喪失」の固定点解決を1箇所へ集約する。
 *
 * `ActionReservationRemoved`はCatalog上・設計書上（`catalog-event-types.ts`、
 * `08_ドメインイベント.md`）トリガー可能なFACTイベントであり、他のFACTイベント
 * と同じくPS/Memory連鎖の契機になり得る。このため`battle.ts`の`startBattle`
 * （`BattleStarted`）と同じ形——新しい`resolutionScopeId`（PS発動済み集合・
 * 候補スタックをこの除去群専用に区切る）を発行し、独立した
 * `PassiveActivationRuntime`で各`ActionReservationRemoved`を
 * `onFactEventWithResult`へ渡してから`finalizeResolutionScope`する——で処理する。
 * `rootEventId`は除去群を引き起こした行動（呼び出し側が渡す`context.rootEventId`）
 * を維持し、監査上の因果は「この行動が引き起こした」まま保つ。
 *
 * 除去対象を一括で事前計算してから順に処理すると、ある除去のPS/Memory連鎖が
 * 他の予約の適格性・生死を変えても反映されない（例: Bの除去PSがCの凍結を解除し
 * 適格性を戻してもCは事前リストに残ったまま誤って除去される。逆にBの除去PSが
 * Dの適格性を奪ってもDは事前リストに無く実行されてしまう。Bの除去PSがDを
 * 戦闘不能にした場合、除去理由も本来の`DEFEATED`ではなく事前計算時点の
 * `INELIGIBLE`のまま記録されてしまう）。そのため`remaining`全体を対象に、
 * 除去対象と理由（戦闘不能なら`DEFEATED`、それ以外でR-ORD-01を満たさなくなって
 * いれば`INELIGIBLE`）を1件ずつ最新の`units`から判定し、そのPS/Memory連鎖を
 * 解決してから次を判定し直す——除去不要な状態に落ち着くまで繰り返す。
 * `remaining`は毎回ちょうど1件ずつ減るため、無限ループにはならない。
 *
 * `finalizeResolutionScope()`自体が`resetScope: RESOLUTION_SCOPE`のcounter
 * 破棄・`RuntimeCounterReset`発行とその候補解決を行うため、ここでも`remaining`
 * の生死・適格性が変わりうる。終了済みのruntimeは再利用できない
 * （`finalizeResolutionScope`は1回しか意味を持たない終端操作）ため、外側の
 * ループで「1件ずつ除去→finalizeResolutionScope→最新状態で再評価」を、
 * 新たな除去対象が無くなるまで繰り返す。新たな除去対象が見つかった回だけ、
 * 新しい`resolutionScopeId`と独立した`PassiveActivationRuntime`を発行する。
 *
 * 因果カーソル（`lastEventId`）は、同じ除去スコープ内の連続する
 * `ActionReservationRemoved`同士（`onFactEventWithResult`が返す、直前の除去の
 * 反応連鎖まで含めた終端イベント、Issue #251）と、`finalizeResolutionScope()`が
 * 発行・解決した最後の`DomainEventId`（発行済みなら、何も無ければ直前のまま、
 * Issue #180/#251）の両方から、常に呼び出し側が推測せず明示的に受け取る。
 */
export function resolveReservationRemovals(
  remaining: readonly ActionReservation[],
  units: readonly BattleUnit[],
  context: ReservationRemovalContext,
): ReservationRemovalResult {
  const { definitions, random, recorder, turnNumber, cycleNumber, rootEventId } = context;
  let currentRemaining = remaining;
  let working = units;
  let lastEventId = context.parentEventId;

  for (;;) {
    let passiveRuntime: PassiveActivationRuntime | undefined;
    const resolutionScopeId = recorder.nextResolutionScopeId();

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
      passiveRuntime ??= new PassiveActivationRuntime(
        { definitions, random, recorder, turnNumber, cycleNumber, resolutionScopeId, rootEventId },
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
      const resolved = passiveRuntime.onFactEventWithResult(event, working);
      working = resolved.units;
      lastEventId = resolved.lastEventId;
      currentRemaining = currentRemaining.filter(
        (entry) => entry.battleUnitId !== next.battleUnitId,
      );
    }

    if (passiveRuntime === undefined) {
      // この回は除去対象が最初から無かった——直前の
      // `finalizeResolutionScope`後の再評価も含め、これ以上除去すべき
      // ものは残っていない。
      break;
    }
    const finalized = passiveRuntime.finalizeResolutionScope();
    working = finalized.units;
    // 何も破棄・発行しなかった場合（`finalized.lastEventId === undefined`）は、
    // この因果カーソルを無関係な値で巻き戻さず、直前のイベントのままにする。
    if (finalized.lastEventId !== undefined) {
      lastEventId = finalized.lastEventId;
    }
    // ループの先頭に戻り、finalizeResolutionScope自身のPS/Memory連鎖後の
    // 最新`working`で`currentRemaining`を再評価する。新しい除去スコープを
    // 開始する場合、その最初の`ActionReservationRemoved.parentEventId`は
    // この`lastEventId`（何か発行していれば終了処理自身の終端イベント、
    // 何も発行していなければ直前の除去イベントのまま）を引き継ぐ。
  }

  return { remaining: currentRemaining, units: working, lastEventId };
}
