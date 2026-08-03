import type { BattleUnit } from "../model/battle-unit.js";
import {
  selectCover,
  selectDamageLinks,
  selectReflects,
  selectTargetRedirect,
  type DamageLinkSelection,
  type ReflectSelection,
} from "./defensive-intervention-policy.js";
import type { DamageEventContext, DamageStep } from "./damage-event-context.js";
import { findUnit, notifyOrYieldNewEvents, revalidateHit } from "./damage-hit-chain.js";
import type { DomainEventId, EffectInstanceId } from "../../shared/event-ids.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";

/**
 * R-INT-01（DMG-006）: `DamageWillBeApplied`の連鎖まで解決し終えた1ヒットについて、
 * 防御介入の解決結果を返す。`INTERRUPT`（使用者の戦闘不能）と`SKIP`（差し替え後の
 * 防御側が戦闘不能）は`observeHitSteps`と同じ意味を持ち、どちらもR-SKL-08の直前結果への
 * 0記録は呼び出し側が行う。
 */
export type DefensiveInterventionResolution =
  | {
      readonly kind: "RESOLVED";
      /** 引き寄せ・肩代わりを反映した最終的な防御側（R-INT-02第1項）。 */
      readonly defenderUnitId: BattleUnitId;
      /** R-INT-02第2項の軽減率。肩代わりが成立していなければ0。 */
      readonly guardRate: number;
      /**
       * R-INT-01 #3: 元ダメージの適用**後**に発生させるリンク（R-LNK-01〜03、DMG-007）。
       * R-INT-01の評価順どおり反射より前に発生させる。
       */
      readonly damageLinks: readonly DamageLinkSelection[];
      /** R-INT-01 #4: 元ダメージの適用**後**に発生させる反射（R-INT-03第1項）。 */
      readonly reflects: readonly ReflectSelection[];
      readonly lastEventId: DomainEventId;
    }
  | { readonly kind: "INTERRUPT"; readonly lastEventId: DomainEventId }
  | { readonly kind: "SKIP"; readonly lastEventId: DomainEventId };

/**
 * R-INT-01「防御介入順」（DMG-006）: `DamageWillBeApplied`の後・ダメージ確定前に、
 * 防御介入系状態を規定の順で評価する。
 *
 * 1. `APPLY_TARGET_REDIRECT`（引き寄せ・挑発）: 攻撃側が保持する引き寄せで防御側を
 *    差し替え、`DamageRedirected`（`reason: TARGET_REDIRECT`）を発行する
 * 2. `APPLY_COVER`（肩代わり）: `14_Catalog定義スキーマ.md`のとおり**redirect後の対象**に
 *    対して評価し、防御側を肩代わり者へ差し替える（R-INT-02第1項）。軽減率
 *    （`guardRate`）は呼び出し側がダメージ計算の最後に適用する
 * 3. `APPLY_DAMAGE_LINK`（継続リンク状態、DMG-007、R-LNK-01〜03）:
 *    成立判定だけをここで行い、実際のリンク先ダメージは元ダメージの適用後・反射より前に
 *    発生させる（R-LNK-01「対象へ算出された最終ダメージをリンク元の量とする。シールド・
 *    HPへの振り分け前の量を使用する」）
 * 4. `APPLY_REFLECT`（反射）: 成立判定だけをここで行い、実際の反射ダメージは元ダメージの
 *    適用後に発生させる（R-INT-03第1項「反射は元ダメージの確定後…に発生する」）
 * 5. `APPLY_DEATH_SURVIVAL`（致死耐え）: 「致死かどうか」はHPへ適用する量が確定して
 *    初めて決まるため、成立判定はHP適用時点（`applyConfirmedDamageSteps`）で行う。
 *    #4との相対順序は保たれる — 反射は元ダメージ（耐えた結果を含む）の適用後に
 *    初めて発生するためである
 *
 * 各介入の`DamageRedirected`は`FACT`であり、他のヒット内イベントと同じ規約で記録直後に
 * PS/Memory即時連鎖へ届け、次の介入へ進む前に前提を再検証する（`08_ドメインイベント.md`
 * 「TIMINGイベント後の再検証」と同じ扱い — 連鎖が引き寄せ先を倒しうる）。
 */
export function* resolveDefensiveInterventionsSteps(
  context: DamageEventContext,
  working: Map<BattleUnitId, BattleUnit>,
  attackerUnitId: BattleUnitId,
  targetUnitId: BattleUnitId,
  hitContext: {
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    readonly hitIndex: number;
  },
  parentEventId: DomainEventId,
): Generator<DamageStep, DefensiveInterventionResolution, readonly BattleUnit[] | undefined> {
  let lastEventId = parentEventId;
  let defenderUnitId = targetUnitId;
  let guardRate = 0;

  const emitRedirected = (
    reason: "TARGET_REDIRECT" | "COVER",
    originalTargetUnitId: BattleUnitId,
    newTargetUnitId: BattleUnitId,
    cause: {
      readonly effectInstanceId: EffectInstanceId;
      readonly definitionId: EffectActionDefinitionId;
    },
    coverRates?: { readonly damageShareRate: number; readonly guardRate: number },
  ): DomainEventId =>
    context.recorder.record({
      eventType: "DamageRedirected",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: context.skillUseId,
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: lastEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: attackerUnitId,
      targetUnitIds: [newTargetUnitId],
      payload: {
        effectActionDefinitionId: hitContext.effectActionDefinitionId,
        hitIndex: hitContext.hitIndex,
        reason,
        originalTargetUnitId,
        newTargetUnitId,
        effectInstanceId: cause.effectInstanceId,
        causeEffectActionDefinitionId: cause.definitionId,
        ...(coverRates ?? {}),
      },
    }).eventId;

  // R-INT-01 #1: 引き寄せ。攻撃側が保持する`APPLY_TARGET_REDIRECT`から選ぶ。
  const attackerBeforeRedirect = findUnit(working, attackerUnitId, "attacker.battleUnitId");
  const redirect = selectTargetRedirect(attackerBeforeRedirect, defenderUnitId, "DAMAGE", working);
  if (redirect !== undefined) {
    const eventsStart = context.recorder.getEvents().length;
    lastEventId = emitRedirected("TARGET_REDIRECT", defenderUnitId, redirect.redirectToUnitId, {
      effectInstanceId: redirect.effectInstanceId,
      definitionId: redirect.effectActionDefinitionId,
    });
    defenderUnitId = redirect.redirectToUnitId;
    yield* notifyOrYieldNewEvents(context, working, eventsStart);
    const revalidation = revalidateHit(context, working, attackerUnitId, defenderUnitId);
    if (revalidation.kind !== "CONTINUE") {
      return { kind: revalidation.kind, lastEventId };
    }
  }

  // R-INT-01 #2: 肩代わり。redirect後の対象に対して評価する。
  const attackerBeforeCover = findUnit(working, attackerUnitId, "attacker.battleUnitId");
  const cover = selectCover(attackerBeforeCover, defenderUnitId, "DAMAGE", working);
  if (cover !== undefined) {
    const eventsStart = context.recorder.getEvents().length;
    lastEventId = emitRedirected(
      "COVER",
      defenderUnitId,
      cover.covererUnitId,
      {
        effectInstanceId: cover.effectInstanceId,
        definitionId: cover.effectActionDefinitionId,
      },
      { damageShareRate: cover.damageShareRate, guardRate: cover.guardRate },
    );
    defenderUnitId = cover.covererUnitId;
    guardRate = cover.guardRate;
    yield* notifyOrYieldNewEvents(context, working, eventsStart);
    const revalidation = revalidateHit(context, working, attackerUnitId, defenderUnitId);
    if (revalidation.kind !== "CONTINUE") {
      return { kind: revalidation.kind, lastEventId };
    }
  }

  // R-INT-01 #3: リンクの成立判定（DMG-007）。最終的な防御側＝実際にダメージを受ける側が
  // 保持する`APPLY_DAMAGE_LINK`を採る（R-LNK-01「対象へ算出された最終ダメージをリンク元の
  // 量とする」のリンク元はこの防御側である）。
  // R-INT-01 #4: 反射の成立判定。最終的な防御側が保持する`APPLY_REFLECT`を採る。
  const defender = findUnit(working, defenderUnitId, "hits[].targetBattleUnitId");
  return {
    kind: "RESOLVED",
    defenderUnitId,
    guardRate,
    damageLinks: selectDamageLinks(defender, working),
    reflects: selectReflects(defender),
    lastEventId,
  };
}
