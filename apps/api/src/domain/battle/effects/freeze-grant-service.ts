import {
  grantEffect,
  type GrantEffectContext,
  type GrantEffectRequest,
} from "./effect-grant-service.js";
import { requireUnit, type BattleUnit } from "../model/battle-unit.js";
import type { AppliedEffect } from "../model/applied-effect.js";
import type { DomainEventId } from "../../shared/event-ids.js";

export interface GrantFreezeResult {
  readonly units: readonly BattleUnit[];
  readonly appliedEffect: AppliedEffect;
  readonly lastEventId: DomainEventId;
}

/**
 * R-STS-03「再付与時に期間延長や増幅率加算を行わない」: `grantStunStatus`
 * （残り回数が長い方を一つだけ残す）とは異なり、対象が既に有効なFREEZEの
 * `AppliedEffect`を保持している場合、新しい付与の内容（期間・増幅率）を一切
 * 反映せず既存インスタンスをそのまま維持する（no-op、イベントも発行しない）。
 * 対象が未だFREEZEを持たない場合だけ`grantEffect`をそのまま呼び出す。
 * 「チャージをキャンセルしない」は`grantEffect`自身がチャージへ一切触れない
 * ため、呼び出し元（`effect-action-group-resolver.ts`）に`STUN`分岐のような
 * 追加のChargeCancelled処理を持たせないことで自然に満たす。
 */
export function grantFreezeStatus(
  context: GrantEffectContext,
  units: readonly BattleUnit[],
  request: GrantEffectRequest,
  parentEventId: DomainEventId,
): GrantFreezeResult {
  const target = requireUnit(units, request.targetUnitId);
  const existing = target.appliedEffects.find((effect) => effect.statusKind === "FREEZE");

  if (existing !== undefined) {
    return { units, appliedEffect: existing, lastEventId: parentEventId };
  }

  return grantEffect(context, units, request, parentEventId);
}
