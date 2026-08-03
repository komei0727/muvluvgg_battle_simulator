import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import type { DamageEventContext, DamageStep } from "./damage-event-context.js";
import type { DomainEventId, EffectInstanceId } from "../../shared/event-ids.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type { ConsumptionKind } from "../../catalog/definitions/catalog-enums.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnitId } from "../../shared/ids.js";

/**
 * 1ヒットの解決中に発行したイベントをPS/Memory即時連鎖へ届け、その連鎖後の最新stateで
 * 前提を再検証するための共通基盤（`08_ドメインイベント.md`「TIMINGイベント後の再検証」）。
 * ダメージpipelineの各段（観測・介入・吸収・HP適用・リンク・反射・追加ダメージ）は
 * すべてこの2経路の規約を共有する。
 */

export function findUnit(
  units: ReadonlyMap<BattleUnitId, BattleUnit>,
  id: BattleUnitId,
  path: string,
): BattleUnit {
  const unit = units.get(id);
  if (unit === undefined) {
    throw new DomainValidationError(path, `references an unknown BattleUnitId: "${id}"`);
  }
  return unit;
}

/**
 * R-EFF-07: `context.consumeEffectDuration`（呼び出し側が注入する、`combat/`は
 * `effects/`へ依存できないため）へ委譲し、`ownerUnitId`が保持する`kind`一致の
 * 消費条件効果を1消費・必要なら失効させる。フック未指定、または該当効果が
 * 無い場合は`workingMap`を変更せず`parentEventId`をそのまま返す。
 */
export function* consumeAndExpire(
  context: DamageEventContext,
  workingMap: Map<BattleUnitId, BattleUnit>,
  ownerUnitId: BattleUnitId,
  kind: ConsumptionKind,
  parentEventId: DomainEventId,
  effectInstanceId?: EffectInstanceId,
): Generator<DamageStep, DomainEventId, readonly BattleUnit[] | undefined> {
  if (context.consumeEffectDuration === undefined) {
    return parentEventId;
  }
  const result = yield* driveRemovalSteps(
    context,
    workingMap,
    context.consumeEffectDuration(
      ownerUnitId,
      kind,
      Array.from(workingMap.values()),
      parentEventId,
      effectInstanceId,
    ),
  );
  return result.lastEventId;
}

/**
 * 除去ステップを`yield`するgenerator（凍結解除・消費失効・遅延失効の確定）を、凍結解除と
 * 同じ規約で駆動する共通ヘルパー。`context.onFactEventForPassiveChain`があれば
 * ステップごとにその場で同期通知し、無ければ1ステップずつ`yield`して、driverが更新した
 * `units`を次の除去へ注入する。
 */
export function* driveRemovalSteps(
  context: DamageEventContext,
  workingMap: Map<BattleUnitId, BattleUnit>,
  removal: Generator<
    { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
    { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
    readonly BattleUnit[] | undefined
  >,
): Generator<
  DamageStep,
  { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
  readonly BattleUnit[] | undefined
> {
  let step = removal.next();
  while (!step.done) {
    if (context.onFactEventForPassiveChain !== undefined) {
      let stepUnits = step.value.units;
      for (const event of step.value.events) {
        stepUnits = context.onFactEventForPassiveChain(event, stepUnits);
      }
      step = removal.next(stepUnits);
    } else {
      const injected = yield { events: step.value.events, units: step.value.units };
      step = removal.next(injected);
    }
  }
  for (const unit of step.value.units) {
    workingMap.set(unit.battleUnitId, unit);
  }
  return step.value;
}

/** `08_ドメインイベント.md`の一般的な流儀: 記録済みの新規イベントをPS即時連鎖フックへ順に転送する。 */
export function notifyNewEvents(
  context: DamageEventContext,
  workingMap: Map<BattleUnitId, BattleUnit>,
  eventsStart: number,
): void {
  if (context.onFactEventForPassiveChain === undefined) {
    return;
  }
  for (const event of context.recorder.getEvents().slice(eventsStart)) {
    const updatedUnits = context.onFactEventForPassiveChain(event, Array.from(workingMap.values()));
    for (const unit of updatedUnits) {
      workingMap.set(unit.battleUnitId, unit);
    }
  }
}

/**
 * 1ヒットの内部イベント（`UnitBeingAttacked`・`EvasionActivated`・`HitConfirmed`・
 * `CriticalCheckResolved`・`DamageWillBeApplied`）を、記録直後にPS/Memory即時連鎖へ届けて
 * 次の判定へ進む前に解決し切るための共通ヘルパー。凍結解除・消費失効
 * （`driveRemovalSteps`）と同じ2経路の規約を持つ。
 *
 * - `context.onFactEventForPassiveChain`あり（AS/EX・チャージ解放）: その場で
 *   同期通知する。この経路では`effect-action-group-resolver.ts`の`innerEvents`が
 *   常に空になるため、ここで通知しないイベントはPS/Memory連鎖へ一度も届かない
 *   （`CriticalCheckResolved`をtriggerにするproduction PSが実戦闘で発動しない、
 *   という形で顕在化していた）。
 * - 未指定（PS/Memory自身のEffectSequence解決）: 1ステップ`yield`し、driver
 *   （`resolveOneEffectActionApplication`）が子連鎖を解決して更新した`units`を
 *   `.next()`で注入する。これが無いとEffectAction完了時まで連鎖が遅れ、
 *   TIMINGイベントの再検証契機を過ぎてしまう。
 */
export function* notifyOrYieldNewEvents(
  context: DamageEventContext,
  workingMap: Map<BattleUnitId, BattleUnit>,
  eventsStart: number,
): Generator<DamageStep, void, readonly BattleUnit[] | undefined> {
  if (context.onFactEventForPassiveChain !== undefined) {
    notifyNewEvents(context, workingMap, eventsStart);
    return;
  }
  const injected = yield {
    events: context.recorder.getEvents().slice(eventsStart),
    units: Array.from(workingMap.values()),
  };
  for (const unit of injected ?? []) {
    workingMap.set(unit.battleUnitId, unit);
  }
}

/**
 * `notifyOrYieldNewEvents`が解決した子連鎖の後に、このヒットを続行してよいかを
 * `working`（連鎖後の最新state）から判定する。
 *
 * - `INTERRUPT`: 使用者が戦闘不能。R-SKL-01/R-SKL-03に従い、このヒットを含む
 *   残りのヒットをすべて中断する
 * - `SKIP`: 対象が戦闘不能（`context.includeDefeated`の明示指定がない場合）。
 *   このヒットは適用せず、R-SKL-08の直前結果へ0を記録して次のヒットへ進む
 * - `CONTINUE`: 続行してよい。以降の判定・イベントは返された最新の
 *   `attacker`/`target`を使う（連鎖が会心率・防御力・`AppliedEffect`を
 *   変えていても取りこぼさない）
 *
 * 各イベントの記録直後にこれを行うことで、既に成立しなくなった前提のまま次の
 * 判定へ進んだり、後続イベント（とその連鎖）を余計に発行したりしなくなる。
 */
export type HitRevalidation =
  | { readonly kind: "CONTINUE"; readonly attacker: BattleUnit; readonly target: BattleUnit }
  | { readonly kind: "INTERRUPT" }
  | { readonly kind: "SKIP"; readonly attacker: BattleUnit; readonly target: BattleUnit };

export function revalidateHit(
  context: DamageEventContext,
  workingMap: Map<BattleUnitId, BattleUnit>,
  attackerUnitId: BattleUnitId,
  targetUnitId: BattleUnitId,
): HitRevalidation {
  const attacker = findUnit(workingMap, attackerUnitId, "attacker.battleUnitId");
  if (isDefeated(attacker)) {
    return { kind: "INTERRUPT" };
  }
  const target = findUnit(workingMap, targetUnitId, "hits[].targetBattleUnitId");
  if (!(context.includeDefeated ?? false) && isDefeated(target)) {
    return { kind: "SKIP", attacker, target };
  }
  return { kind: "CONTINUE", attacker, target };
}
