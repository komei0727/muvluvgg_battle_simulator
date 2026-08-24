import { grantEffect } from "../../effects/effect-grant-service.js";
import { DomainValidationError } from "../../../shared/errors.js";
import type { EffectActionDefinition } from "../../../catalog/definitions/effect-action-definition.js";
import type { BattleUnitId } from "../../../shared/ids.js";
import {
  completeGrant,
  rejectIfImmune,
  skippedOutcome,
  type EffectActionHandler,
  type EffectActionOutcome,
} from "./effect-action-handler.js";
import {
  eventContextOf,
  grantSourceOf,
  requireActorUnit,
  type EffectActionGroupContext,
  type UnitsBox,
} from "./effect-action-group-context.js";

/**
 * R-HEAL-04（M7-005-HEAL-LINK、production例: `SKL_ELENA_MOODMAKER_AS1`
 * 「対象が得られる回復効果を100%自身に転送する」）: 転送先を付与時点で解決し、
 * 転送率とともに`AppliedEffect.healingLink`へ焼き込む（`APPLY_ATTACK_DAMAGE_BONUS`と
 * 同じ「付与時snapshot」規約 — 回復適用時点にはTargetBindingもトリガーcontextも
 * 残っていない）。`transferTo`が`SELF`以外の定義はCatalogロード時点で
 * `UNSUPPORTED_HEALING_LINK_TRANSFER_TARGET`として拒否済みだが、Catalogを経由しない
 * 合成定義に対する実行時backstopも残す。`magnitude`は監査用に転送率をそのまま持つ
 * （`APPLY_RESOURCE_GAIN_MOD`と同じ「符号付き割合をmagnitudeへ」の規約）。
 * CombatStatsは変えないため再計算は呼ばない。
 */
export const resolveApplyHealingLink: EffectActionHandler<"APPLY_HEALING_LINK"> = (
  input,
): EffectActionOutcome => {
  const { context, box, application, effectAction, startingEventId } = input;
  if (effectAction.payload.transferTo.kind !== "SELF") {
    throw new DomainValidationError(
      "effectActionDefinitionId",
      `APPLY_HEALING_LINK payload.transferTo.kind "${effectAction.payload.transferTo.kind}" is not supported (R-HEAL-04 implements "SELF" only)`,
    );
  }
  const magnitude = effectAction.payload.transferRate;
  const rejected = rejectIfImmune(input, magnitude);
  if (rejected !== undefined) {
    return rejected;
  }
  return completeGrant(
    input,
    grantEffect(
      eventContextOf(context),
      box.units,
      {
        definition: effectAction,
        ...grantSourceOf(context),
        targetUnitId: application.targetUnitId,
        duplicate: true,
        magnitude,
        healingLink: {
          transferToUnitId: requireActorUnit(context, box).battleUnitId,
          transferRate: effectAction.payload.transferRate,
        },
        durationDefinition: effectAction.payload.duration,
      },
      startingEventId,
    ),
  );
};

/**
 * R-LNK-01/02（DMG-007）: `APPLY_DAMAGE_LINK.linkTo`を付与時点でリンク先ユニットへ
 * 解決する。`AppliedEffect.damageLink.linkToUnitId`は単一ユニットであり、実装済みの
 * 参照はどちらも付与時点に確定しているものだけである。
 *
 * - `SELF`: 付与者自身（`APPLY_HEALING_LINK.transferTo: SELF`と同じ意味 —
 *   効果対象ではなく**付与した側**）
 * - `BINDING`: このEffectSequenceが解決済みのTargetBindingの先頭1体。
 *   `DAMAGE_LINK_UNBOUNDED_BINDING`（`catalog-integrity.ts`）が「宣言済みで、
 *   高々1体へ解決するbinding」であることをロード時に保証しているため、実行時に
 *   2体目が現れることはない。0件へ解決した場合だけ`undefined`を返し、呼び出し側が
 *   `SKIPPED`として何も付与しない
 *
 * それ以外のkindはCatalogロード時点で拒否済み（`UNSUPPORTED_DEFENSIVE_INTERVENTION`）
 * だが、Catalogを経由しない合成定義に対する実行時backstopとして明確に拒否する。
 */
function resolveDamageLinkDestination(
  effectAction: Extract<EffectActionDefinition, { kind: "APPLY_DAMAGE_LINK" }>,
  context: EffectActionGroupContext,
  box: UnitsBox,
): BattleUnitId | undefined {
  const linkTo = effectAction.payload.linkTo;
  if (linkTo.kind === "SELF") {
    return requireActorUnit(context, box).battleUnitId;
  }
  if (linkTo.kind !== "BINDING" || linkTo.targetBindingId === undefined) {
    throw new DomainValidationError(
      "effectActionDefinitionId",
      `APPLY_DAMAGE_LINK payload.linkTo.kind "${linkTo.kind}" is not supported (R-LNK-01/02 implements "SELF" and "BINDING" only)`,
    );
  }
  return context.resolvedBindings?.get(linkTo.targetBindingId)?.units[0]?.battleUnitId;
}

/**
 * R-INT-01 #3／R-LNK-01〜03（DMG-007、production例: `SKL_SUIRAN_CASINO_AS1`
 * 「自身以外の味方が受けたダメージの50%を自身に転送」／`SKL_DOROTHEA_PIONEER_PS1`
 * 「対象同士が受けたダメージの35%を共有しあう」／`SKL_CHIZURU_DOMESTIC_PS1`
 * 「自身が受けたダメージの35%を対象に送り込む」）: リンク先を付与時点で解決し、
 * 割合とともに`AppliedEffect.damageLink`へ焼き込む（`APPLY_HEALING_LINK`と同じ
 * 「付与時snapshot」規約）。`magnitude`は監査用に割合をそのまま持つ。CombatStatsは
 * 変えないため再計算は呼ばない。
 */
export const resolveApplyDamageLink: EffectActionHandler<"APPLY_DAMAGE_LINK"> = (
  input,
): EffectActionOutcome => {
  const { context, box, application, effectAction, startingEventId } = input;
  const linkToUnitId = resolveDamageLinkDestination(effectAction, context, box);
  if (linkToUnitId === undefined) {
    // `BINDING`が0件へ解決した（候補が全滅した等）場合、焼き込むリンク先が存在しない。
    // R-SKL-08の対象0件と同じく`SKIPPED`として記録し、何も付与しない — 既定のリンク先へ
    // 黙って寄せると定義に無い相手へリンクが張られるためである。
    return skippedOutcome(input);
  }
  const magnitude = effectAction.payload.linkRate;
  const rejected = rejectIfImmune(input, magnitude);
  if (rejected !== undefined) {
    return rejected;
  }
  return completeGrant(
    input,
    grantEffect(
      eventContextOf(context),
      box.units,
      {
        definition: effectAction,
        ...grantSourceOf(context),
        targetUnitId: application.targetUnitId,
        duplicate: true,
        magnitude,
        damageLink: { linkToUnitId, linkRate: effectAction.payload.linkRate },
        durationDefinition: effectAction.payload.duration,
      },
      startingEventId,
    ),
  );
};
