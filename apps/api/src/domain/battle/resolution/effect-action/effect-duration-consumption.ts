import type { DamageEventContext } from "../../combat/damage-application-service.js";
import {
  emitEffectConsumptionChangedEvents,
  expireEffectsSteps,
  type ExpirationSeed,
} from "../../effects/duration-expiry-service.js";
import { consumeEffectDurations } from "../../model/applied-effect-duration.js";
import type { ConsumptionKind } from "../../../catalog/definitions/catalog-enums.js";
import { eventContextOf, type EffectActionGroupContext } from "./effect-action-group-context.js";

/**
 * `NEXT_OUTGOING_ATTACK`/`NEXT_INCOMING_ATTACK`は「効果ownerが次に攻撃/攻撃対象に
 * なった時点」で消費するが（R-EFF-07）、`14_Catalog定義スキーマ.md`「上限に到達した
 * 効果は、該当するEffectActionの解決後に失効する」契約により、実際の除去・CombatStat
 * 再計算はその攻撃（EffectAction）自身の解決が終わるまで遅延させる必要がある。即時に
 * 除去すると、その効果が本来押し上げるはずの会心率・攻撃力・防御力等が、まさにその
 * 効果を消費させた攻撃自身の計算から失われてしまう（実Catalogの
 * `ACT_FEE_ACTOR_PS1_CRIT_UP`/`ACT_LAURA_MOUNTAIN_PS1_ATK_BUFF`等、
 * `NEXT_OUTGOING_ATTACK`/`NEXT_INCOMING_ATTACK`を持つ`APPLY_STAT_MOD`が該当）。
 * `OUTGOING_HIT`/`INCOMING_HIT`はヒット確定後に消費するため、消費時点でそのヒット自身の
 * 計算は既に終わっており、この遅延は不要（即時失効のまま）。
 */
const DEFERRED_EXPIRY_CONSUMPTION_KINDS: ReadonlySet<ConsumptionKind> = new Set([
  "NEXT_OUTGOING_ATTACK",
  "NEXT_INCOMING_ATTACK",
]);

/**
 * R-EFF-07: `damage-application-service.ts`（`combat/`）が`effects/`へ直接依存できない
 * （Domain層のmodule境界、`onFactEventForPassiveChain`と同じ理由）ため、
 * `DamageEventContext.consumeEffectDuration`/`finalizeConsumedEffectDurations`として
 * 注入する一対のクロージャを組み立てる。{@link DEFERRED_EXPIRY_CONSUMPTION_KINDS}に
 * 属するkindの消費で0になったインスタンスは即座には失効させず、`pendingExpirySeeds`へ
 * 貯めておき、`finalizeConsumedEffectDurations`（呼び出し側が1回の`applyDamageAction`＝
 * 1EffectActionの全ヒット解決後に1回だけ呼ぶ）でまとめて失効させる。
 *
 * `APPLY_STATUS`もR-EFF-07の`STATUS_BLOCKED`消費で`consumeEffectDuration`だけを使う。
 */
export function buildConsumeEffectDurationHooks(context: EffectActionGroupContext): {
  readonly consumeEffectDuration: NonNullable<DamageEventContext["consumeEffectDuration"]>;
  readonly finalizeConsumedEffectDurations: NonNullable<
    DamageEventContext["finalizeConsumedEffectDurations"]
  >;
} {
  const pendingExpirySeeds: ExpirationSeed[] = [];
  // 失効はステップを`yield`する`expireEffectsSteps`へ委譲し、通知（またはyield）の粒度は
  // `damage-application-service.ts`の`driveRemovalSteps`が決める。
  // `onFactEventForPassiveChain`をこの`eventContext`へ渡すと、そのstep通知とDAMAGE側の
  // step駆動が二重になるため渡さない。
  const eventContext = eventContextOf(context);

  const consumeEffectDuration: NonNullable<DamageEventContext["consumeEffectDuration"]> =
    function* (ownerUnitId, kind, units, callParentEventId, effectInstanceId) {
      // 消費対象の「決定」と「適用」を分ける。`consumeEffectDurations`は一致する全
      // インスタンスを一括で減算した`units`を返すため、それを起点にしてイベントだけ
      // 1件ずつ発行すると、最初の`EffectConsumptionChanged`を観測するPS/Memoryが
      // 未発行分まで減算済みの状態を見てしまう（state変更がstep単位になっていない）。
      // ここでは対象インスタンスの決定にだけ使い、実際の減算・イベント発行・`yield`は
      // 最新の`workingUnits`へ1インスタンスずつ行う（`consumeEffectDurations`の第4引数で
      // 対象を1件へ限定できる — R-HIT-04のNヒット回避自己消費と同じ機構）。
      const planned = consumeEffectDurations(units, ownerUnitId, kind, effectInstanceId);
      if (planned.changes.length === 0) {
        return { units, lastEventId: callParentEventId };
      }
      let workingUnits = units;
      let lastEventId = callParentEventId;
      const seeds: ExpirationSeed[] = [];
      for (const plannedChange of planned.changes) {
        // 先行stepのPS/Memory連鎖が後続の対象を解除・失効させている場合があるため、
        // 最新の`workingUnits`に対して都度再評価する。既に消えていれば
        // （`changes`が空）このインスタンスの消費自体を行わない。
        const applied = consumeEffectDurations(
          workingUnits,
          ownerUnitId,
          kind,
          plannedChange.effectInstanceId,
        );
        const change = applied.changes[0];
        if (change === undefined) {
          continue;
        }
        workingUnits = applied.units;
        const stepEventsStart = eventContext.recorder.getEvents().length;
        lastEventId = emitEffectConsumptionChangedEvents(
          eventContext,
          workingUnits,
          [change],
          lastEventId,
        );
        const injected = yield {
          events: eventContext.recorder.getEvents().slice(stepEventsStart),
          units: workingUnits,
        };
        if (injected !== undefined) {
          workingUnits = injected;
        }
        if (change.after === 0) {
          seeds.push({
            battleUnitId: change.battleUnitId,
            effectInstanceId: change.effectInstanceId,
            reason: "CONSUMPTION",
          });
        }
      }
      if (seeds.length === 0) {
        return { units: workingUnits, lastEventId };
      }
      if (DEFERRED_EXPIRY_CONSUMPTION_KINDS.has(kind)) {
        pendingExpirySeeds.push(...seeds);
        return { units: workingUnits, lastEventId };
      }
      const expiry = yield* expireEffectsSteps(
        eventContext,
        workingUnits,
        seeds,
        context.definitions.effectActions,
        lastEventId,
      );
      return { units: expiry.units, lastEventId: expiry.lastEventId };
    };

  const finalizeConsumedEffectDurations: NonNullable<
    DamageEventContext["finalizeConsumedEffectDurations"]
  > = function* (units, parentEventId) {
    if (pendingExpirySeeds.length === 0) {
      return { units, lastEventId: parentEventId };
    }
    const seeds = pendingExpirySeeds.splice(0, pendingExpirySeeds.length);
    const expiry = yield* expireEffectsSteps(
      eventContext,
      units,
      seeds,
      context.definitions.effectActions,
      parentEventId,
    );
    return { units: expiry.units, lastEventId: expiry.lastEventId };
  };

  return { consumeEffectDuration, finalizeConsumedEffectDurations };
}
