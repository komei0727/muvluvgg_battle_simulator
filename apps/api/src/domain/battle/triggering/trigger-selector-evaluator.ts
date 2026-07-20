import type { TriggerDefinition } from "../../catalog/definitions/trigger-definition.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { Side } from "../../shared/side.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";

export type EventSelector = TriggerDefinition["sourceSelector"];

/**
 * 本番の`event-recorder.ts`は`sourceUnitId`を設定する一方、`sourceSide`は
 * どの呼び出し元も設定していない（Memory由来などIDを持たない発生源の余地として
 * envelopeにフィールドだけが残っている）。そのため`ALLY`/`ENEMY`の陣営判定は
 * `event.sourceSide`だけに頼らず、まず`sourceUnitId`を`unitsById`で引いた実際の
 * `side`を優先し、それが無い場合だけ`event.sourceSide`にフォールバックする。
 */
function resolveSourceSide(
  event: TriggerCandidateEvent,
  unitsById: ReadonlyMap<BattleUnitId, BattleUnit>,
): Side | undefined {
  if (event.sourceUnitId !== undefined) {
    return unitsById.get(event.sourceUnitId)?.side ?? event.sourceSide;
  }
  return event.sourceSide;
}

function rejectEffectOwner(
  selector: EventSelector,
  path: string,
): asserts selector is Exclude<EventSelector, "EFFECT_OWNER"> {
  if (selector === "EFFECT_OWNER") {
    throw new DomainValidationError(
      path,
      'selector "EFFECT_OWNER" is not supported by this basic PassiveTriggerMatcher (requires AppliedEffect ownership, M7 scope)',
    );
  }
}

/**
 * レビュー指摘[P1]（Issue #144 follow-up）: `TurnStarted`/`TurnCompleting`の
 * ように特定のBattleUnitに帰属しないグローバルな行動外イベントは、
 * `event-recorder.ts`の発行元が`sourceUnitId`/`sourceSide`のどちらも設定
 * しない（`resolveSourceSide`が常に`undefined`を返す）。`PassiveResolved`の
 * ように`sourceUnitId`は持つが`targetUnitIds`を持たないイベント（PS解決は
 * 対象を持つとは限らない）も同様に対象へ帰属しない。production Catalogは
 * 「自身がASを使う前」（`08_ドメインイベント.md`の例）と同じ著者慣習で、
 * こうした帰属先を持たないイベントに対しても「自身のターン開始・終了時」
 * 「味方のPS解決後、自身に」を`sourceSelector`/`targetSelector: SELF`
 * （`TurnStarted`/`TurnCompleting`合計39行、`PassiveResolved`1行）で表現
 * している。他方、`SkillUseStarting`/`DamageApplied`/`PassiveActivated`など
 * 実際にunit起因のイベントは、`sourceUnitId`（対象を持つ種別は
 * `targetUnitIds`も）を必ず設定して発行される（`action-skill-use-
 * resolver.ts`/`damage-application-service.ts`/`passive-activation-
 * service.ts`確認済み）。そのため「`sourceUnitId`も`sourceSide`も持たない」
 * 「`targetUnitIds`を持たない」ことを、それぞれ発生源・対象を特定unitへ
 * 帰属できないイベントの判定に使ってよい — この場合`SELF`は「(帰属先が
 * 存在しないため)所有者自身の視点で成立する」ものとして候補化する。
 * `ALLY`/`ENEMY`はこの場合も`resolveSourceSide`が`undefined`を返すため、
 * これまで通り不成立のままにする（帰属先を持たないイベントに陣営の概念は
 * ない）。
 */
function isSourceUnattributed(event: TriggerCandidateEvent): boolean {
  return event.sourceUnitId === undefined && event.sourceSide === undefined;
}

/** 上記`isSourceUnattributed`と対になる、`targetUnitIds`側の判定。 */
function isTargetUnattributed(event: TriggerCandidateEvent): boolean {
  return event.targetUnitIds === undefined || event.targetUnitIds.length === 0;
}

/**
 * R-PS-01「発生源...をConditionDefinitionで評価する」のうち`sourceSelector`部分。
 * `ALLY`/`ENEMY`はPS所有者自身を含む・含まないの区別を持たず、`resolveSourceSide`
 * が導出した発生源の陣営と所有者の`side`を比較する（自分自身か否かは`SELF`が担う）。
 */
export function evaluateSourceSelector(
  selector: EventSelector,
  owner: BattleUnit,
  event: TriggerCandidateEvent,
  unitsById: ReadonlyMap<BattleUnitId, BattleUnit>,
): boolean {
  rejectEffectOwner(selector, "trigger.sourceSelector");
  switch (selector) {
    case "ANY":
      return true;
    case "SELF":
      return event.sourceUnitId === owner.battleUnitId || isSourceUnattributed(event);
    case "ALLY":
      return resolveSourceSide(event, unitsById) === owner.side;
    case "ENEMY": {
      const side = resolveSourceSide(event, unitsById);
      return side !== undefined && side !== owner.side;
    }
  }
}

/**
 * R-PS-01「...対象...をConditionDefinitionで評価する」のうち`targetSelector`部分。
 * `targetUnitIds`は複数持ちうるため、いずれか1件が条件を満たせば候補にする。
 */
export function evaluateTargetSelector(
  selector: EventSelector,
  owner: BattleUnit,
  event: TriggerCandidateEvent,
  unitsById: ReadonlyMap<BattleUnitId, BattleUnit>,
): boolean {
  rejectEffectOwner(selector, "trigger.targetSelector");
  if (selector === "ANY") {
    return true;
  }
  if (selector === "SELF" && isTargetUnattributed(event)) {
    return true;
  }
  const targetUnitIds = event.targetUnitIds;
  if (targetUnitIds === undefined || targetUnitIds.length === 0) {
    return false;
  }
  return targetUnitIds.some((id) => {
    if (selector === "SELF") {
      return id === owner.battleUnitId;
    }
    const target = unitsById.get(id);
    if (target === undefined) {
      return false;
    }
    return selector === "ALLY" ? target.side === owner.side : target.side !== owner.side;
  });
}
