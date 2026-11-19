import type { DamageEventContext } from "../../combat/damage-application-service.js";
import {
  emitEffectConsumptionChangedEvents,
  expireEffectsSteps,
  type ExpirationSeed,
} from "../../effects/duration-expiry-service.js";
import { consumeEffectDurations } from "../../model/applied-effect-duration.js";
import type { ConsumptionKind } from "../../../catalog/definitions/catalog-enums.js";
import {
  eventContextOf,
  type AttackConsumptionScope,
  type EffectActionGroupContext,
} from "./effect-action-group-context.js";

export type { AttackConsumptionScope };
import type { BattleUnit } from "../../model/battle-unit.js";
import type { BattleUnitId } from "../../../shared/ids.js";
import type { DomainEventId, EffectInstanceId } from "../../../shared/event-ids.js";
import type {
  AttackDeathSurvivalEntry,
  AttackDeathSurvivalLedger,
} from "../../combat/defensive-intervention-policy.js";
import type { BattleDomainEvent } from "../../events/domain-event.js";

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

/** `siblings`を渡すと、同じstepの攻撃としてそこへ加わる。 */
export function createAttackConsumptionScope(
  siblings: AttackConsumptionScope[] = [],
): AttackConsumptionScope {
  const scope: AttackConsumptionScope = {
    consumedInstanceKeys: new Set(),
    pendingExpirySeeds: [],
    siblings,
    deathSurvivals: new Map(),
    finished: false,
  };
  siblings.push(scope);
  return scope;
}

export function instanceKeyOf(seed: {
  readonly battleUnitId: BattleUnitId;
  readonly effectInstanceId: EffectInstanceId;
}): string {
  return `${seed.battleUnitId}|${seed.effectInstanceId}`;
}

/**
 * R-EFF-07: この攻撃の計算から除く効果。同じstepの攻撃が使い切って失効を待っている
 * インスタンスのうち、この攻撃自身は消費していないもの。
 */
export function suspendedEffectInstanceIdsFor(
  scope: AttackConsumptionScope,
  /** R-SUB-02: サブユニット追加ヒットの解決まで失効を待っている先行の攻撃。 */
  held: readonly AttackConsumptionScope[] = [],
): ReadonlySet<EffectInstanceId> {
  const suspended = new Set<EffectInstanceId>();
  for (const sibling of [...scope.siblings, ...held]) {
    for (const seed of sibling.pendingExpirySeeds) {
      if (!scope.consumedInstanceKeys.has(instanceKeyOf(seed))) {
        suspended.add(seed.effectInstanceId);
      }
    }
  }
  return suspended;
}

/**
 * R-INT-01 #5: 別の攻撃が耐えに使い、まだ消費していない致死耐えの回数（効果インスタンスごと）。
 * 同じstepのまだ終わっていない攻撃と、追加ヒット（R-SUB-02）の解決まで精算を待っている攻撃
 * （`heldDeathSurvivals`。後続stepの別DAMAGEからも見える）を数える。
 */
export function reservedDeathSurvivalsFor(
  context: EffectActionGroupContext,
  scope?: AttackConsumptionScope,
): ReadonlyMap<EffectInstanceId, number> {
  const ledgers = new Set<AttackDeathSurvivalLedger>(context.heldDeathSurvivals ?? []);
  for (const sibling of scope?.siblings ?? []) {
    if (!sibling.finished) {
      ledgers.add(sibling.deathSurvivals);
    }
  }
  if (scope !== undefined) {
    ledgers.delete(scope.deathSurvivals);
  }
  return reservedDeathSurvivalsIn(ledgers);
}

/**
 * R-INT-01 #5: `ledgers`の未精算の耐えが予約している回数（効果インスタンスごと）。
 *
 * 追加ヒットで使った耐えは、その対象を攻撃した複数の攻撃の台帳へ同じエントリとして書き戻され、
 * 精算もエントリ単位で1回だけ行われる。予約数も同じ単位で数え、共有されたエントリを台帳の数だけ
 * 重ねて数えない。同じ効果インスタンスでも別々に使ったエントリはそれぞれ1回と数える。
 */
export function reservedDeathSurvivalsIn(
  ledgers: Iterable<AttackDeathSurvivalLedger>,
): ReadonlyMap<EffectInstanceId, number> {
  const entries = new Set<AttackDeathSurvivalEntry>();
  for (const ledger of ledgers) {
    for (const entry of ledger.values()) {
      if (!entry.settled) {
        entries.add(entry);
      }
    }
  }
  const reserved = new Map<EffectInstanceId, number>();
  for (const entry of entries) {
    const id = entry.selection.effectInstanceId;
    reserved.set(id, (reserved.get(id) ?? 0) + 1);
  }
  return reserved;
}

/**
 * R-INT-01 #5＋R-SUB-02: 保留中の追加ヒットがあれば、攻撃の致死耐えの精算をその解決まで
 * 待たせる（`heldDeathSurvivals`へ移す）。待たせた場合`true`。
 */
export function holdDeathSurvivalsForSubUnitAdditions(
  context: EffectActionGroupContext,
  ledger: AttackDeathSurvivalLedger,
): boolean {
  const held = context.heldDeathSurvivals;
  if (held === undefined || (context.subUnitAdditions?.pending.size ?? 0) === 0) {
    return false;
  }
  if (!held.includes(ledger)) {
    held.push(ledger);
  }
  return true;
}

/**
 * R-EFF-07: 失効させずに残す消費。`consumption.scope: ACTION`は攻撃ではなく行動の完了で
 * 失効させる（`action-completion.ts`）。行動外の攻撃（ターン開始時のPS等）は待つ行動が
 * 無いため、攻撃単位と同じく攻撃の終了で失効させる。
 */
function waitsForActionCompletion(
  context: EffectActionGroupContext,
  units: readonly BattleUnit[],
  seed: ExpirationSeed,
): boolean {
  if (context.actionId === undefined) {
    return false;
  }
  const effect = units
    .find((unit) => unit.battleUnitId === seed.battleUnitId)
    ?.appliedEffects.find((candidate) => candidate.effectInstanceId === seed.effectInstanceId);
  return effect?.duration.definition.consumption?.scope === "ACTION";
}

/**
 * R-EFF-07: `damage-application-service.ts`（`combat/`）が`effects/`へ直接依存できない
 * （Domain層のmodule境界、`onFactEventForPassiveChain`と同じ理由）ため、
 * `DamageEventContext.consumeEffectDuration`/`finalizeConsumedEffectDurations`として
 * 注入する一対のクロージャを組み立てる。{@link DEFERRED_EXPIRY_CONSUMPTION_KINDS}に
 * 属するkindは、同じ攻撃（`attackScope`）の中で各インスタンスを1回だけ消費し、0になった
 * インスタンスは即座には失効させず`attackScope.pendingExpirySeeds`へ貯める。
 * `finalizeConsumedEffectDurations`がそれをまとめて失効させる。呼び出し側は攻撃の最後の
 * 適用でだけ`finalizeConsumedEffectDurations`を渡す。
 *
 * `APPLY_STATUS`もR-EFF-07の`STATUS_BLOCKED`消費で`consumeEffectDuration`だけを使う。
 */
export function buildConsumeEffectDurationHooks(
  context: EffectActionGroupContext,
  initialAttackScope: AttackConsumptionScope = createAttackConsumptionScope(),
): {
  readonly consumeEffectDuration: NonNullable<DamageEventContext["consumeEffectDuration"]>;
  readonly finalizeConsumedEffectDurations: NonNullable<
    DamageEventContext["finalizeConsumedEffectDurations"]
  >;
  readonly beginNextAttack: NonNullable<DamageEventContext["beginNextAttack"]>;
} {
  let attackScope = initialAttackScope;
  // 失効はステップを`yield`する`expireEffectsSteps`へ委譲し、通知（またはyield）の粒度は
  // `damage-application-service.ts`の`driveRemovalSteps`が決める。
  // `onFactEventForPassiveChain`をこの`eventContext`へ渡すと、そのstep通知とDAMAGE側の
  // step駆動が二重になるため渡さない。
  const eventContext = eventContextOf(context);

  const consumeEffectDuration: NonNullable<DamageEventContext["consumeEffectDuration"]> =
    function* (ownerUnitId, kind, units, callParentEventId, effectInstanceId, attackDamageType) {
      // 消費対象の「決定」と「適用」を分ける。`consumeEffectDurations`は一致する全
      // インスタンスを一括で減算した`units`を返すため、それを起点にしてイベントだけ
      // 1件ずつ発行すると、最初の`EffectConsumptionChanged`を観測するPS/Memoryが
      // 未発行分まで減算済みの状態を見てしまう（state変更がstep単位になっていない）。
      // ここでは対象インスタンスの決定にだけ使い、実際の減算・イベント発行・`yield`は
      // 最新の`workingUnits`へ1インスタンスずつ行う（`consumeEffectDurations`の第4引数で
      // 対象を1件へ限定できる — R-HIT-04のNヒット回避自己消費と同じ機構）。
      const planned = consumeEffectDurations(
        units,
        ownerUnitId,
        kind,
        effectInstanceId,
        attackDamageType,
      );
      if (planned.changes.length === 0) {
        return { units, lastEventId: callParentEventId };
      }
      const perAttack = DEFERRED_EXPIRY_CONSUMPTION_KINDS.has(kind);
      let workingUnits = units;
      let lastEventId = callParentEventId;
      const seeds: ExpirationSeed[] = [];
      for (const plannedChange of planned.changes) {
        // 多段ヒットの2ヒット目以降・2体目以降の対象は、同じ攻撃の続きであり新たな1回ではない。
        const attackKey = instanceKeyOf(plannedChange);
        if (perAttack && attackScope.consumedInstanceKeys.has(attackKey)) {
          continue;
        }
        // 先行stepのPS/Memory連鎖が後続の対象を解除・失効させている場合があるため、
        // 最新の`workingUnits`に対して都度再評価する。既に消えていれば
        // （`changes`が空）このインスタンスの消費自体を行わない。
        const applied = consumeEffectDurations(
          workingUnits,
          ownerUnitId,
          kind,
          plannedChange.effectInstanceId,
          attackDamageType,
        );
        const change = applied.changes[0];
        if (change === undefined) {
          continue;
        }
        workingUnits = applied.units;
        if (perAttack) {
          attackScope.consumedInstanceKeys.add(attackKey);
        }
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
      if (perAttack) {
        attackScope.pendingExpirySeeds.push(
          ...seeds.filter((seed) => !waitsForActionCompletion(context, workingUnits, seed)),
        );
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

  // 攻撃の終了。失効を待つインスタンスのうち、まだ終わっていない同じstepの攻撃も消費して
  // いるもの（その攻撃の残りの適用でも効く）は、その攻撃へ失効を引き継ぐ。
  const finalizeConsumedEffectDurations: NonNullable<
    DamageEventContext["finalizeConsumedEffectDurations"]
  > = function* (units, parentEventId) {
    const scope = attackScope;
    scope.finished = true;
    const pending = scope.pendingExpirySeeds.splice(0, scope.pendingExpirySeeds.length);
    const seeds: ExpirationSeed[] = [];
    for (const seed of pending) {
      const heir = scope.siblings.find(
        (sibling) =>
          sibling !== scope &&
          !sibling.finished &&
          sibling.consumedInstanceKeys.has(instanceKeyOf(seed)),
      );
      if (heir === undefined) {
        seeds.push(seed);
      } else {
        heir.pendingExpirySeeds.push(seed);
      }
    }
    if (seeds.length === 0) {
      return { units, lastEventId: parentEventId };
    }
    // R-SUB-02＋R-EFF-07: サブユニット追加ヒットを保留している間は、元攻撃が消費した効果を
    // 追加ヒットの解決まで残す（後続の別の攻撃からは`suspendedEffectInstanceIdsFor`で隠す）。
    if (
      context.heldAttackConsumptions !== undefined &&
      (context.subUnitAdditions?.pending.size ?? 0) > 0
    ) {
      context.heldAttackConsumptions.push({
        consumedInstanceKeys: scope.consumedInstanceKeys,
        pendingExpirySeeds: seeds,
        siblings: [],
        deathSurvivals: scope.deathSurvivals,
        finished: true,
      });
      return { units, lastEventId: parentEventId };
    }
    const expiry = yield* expireEffectsSteps(
      eventContext,
      units,
      seeds,
      context.definitions.effectActions,
      parentEventId,
    );
    return { units: expiry.units, lastEventId: expiry.lastEventId };
  };

  // 前の攻撃の遅延失効は呼び出し側が`finalizeConsumedEffectDurations`で確定済み。
  const beginNextAttack = (): void => {
    attackScope = createAttackConsumptionScope();
  };

  return { consumeEffectDuration, finalizeConsumedEffectDurations, beginNextAttack };
}

/**
 * R-SUB-02＋R-EFF-07: サブユニット追加ヒットの解決まで待たせていた、元攻撃が消費して0にした
 * 効果を失効させる（DAMAGE区間の終わり、追加ヒットを解決した後。中断時も同じ）。
 */
export function* expireHeldAttackConsumptionsSteps(
  context: EffectActionGroupContext,
  units: readonly BattleUnit[],
  parentEventId: DomainEventId,
): Generator<
  { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
  { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
  readonly BattleUnit[] | undefined
> {
  const held = context.heldAttackConsumptions?.splice(0) ?? [];
  const seeds = held.flatMap((scope) => scope.pendingExpirySeeds.splice(0));
  if (seeds.length === 0) {
    return { units, lastEventId: parentEventId };
  }
  return yield* expireEffectsSteps(
    eventContextOf(context),
    units,
    seeds,
    context.definitions.effectActions,
    parentEventId,
  );
}
