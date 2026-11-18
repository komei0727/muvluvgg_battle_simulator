import { grantEffect } from "../../effects/effect-grant-service.js";
import { applyMarker } from "../../effects/marker-apply-service.js";
import { FOLLOW_UP_ON_HIT_EFFECT_KINDS } from "../../../catalog/definitions/effect-action-payload.js";
import {
  findBlockingImmunity,
  rejectEffectApplication,
} from "../../effects/effect-immunity-service.js";
import { recalculateCombatStatsSteps } from "../../effects/combat-stat-recalculation-service.js";
import { grantPoisonContinuousDamage } from "../continuous-damage-service.js";
import { CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY } from "../../model/applied-effect.js";
import type { BattleUnit } from "../../model/battle-unit.js";
import type { BattleDomainEvent } from "../../events/domain-event.js";
import { requireUnit } from "../action-resolution-shared.js";
import { eventContextOf, type EffectActionGroupContext } from "./effect-action-group-context.js";
import { evaluateFormula, damageResultsFor } from "../../skill/formula-evaluator.js";
import { DomainValidationError } from "../../../shared/errors.js";
import type { EffectActionDefinitionId } from "../../../catalog/definitions/catalog-ids.js";
import type { DomainEventId } from "../../../shared/event-ids.js";
import type { BattleUnitId } from "../../../shared/ids.js";

/**
 * R-FUP-01第3項（Issue #474）: 追撃ヒットが適用された対象へonHitEffectsの1件を付与する。
 * R-DMG-05 #2a: DAMAGEの`hitConfirmedEffects`も同じ経路で付与する（`riderSourceUnitId`は
 * 渡さず、帰属先は攻撃者になる）。
 *
 * 参照先が`FOLLOW_UP_ON_HIT_EFFECT_KINDS`のいずれかであることは
 * `catalog-integrity.ts`がCatalogロード時点で保証する（production例:
 * `SKL_SUIRAN_CHAOS_PS3`の行動速度-200、`SKL_CHIYURU_MAZE_PS2`の毒3行動）。
 * 付与そのものは各kindの通常解決と同じ経路（`EffectApplied`／`MarkerApplied`・
 * CombatStat再計算・R-DOT-04の毒統合・R-EFF-03の免疫判定）を通る — onHitEffectだけが
 * 別のライフサイクルを持たないようにするためである
 * （`grantSubUnitAdditionalDamageDebuffSteps`と同じ方針）。
 *
 * 付与の帰属先（`sourceUnitId`）はライダーを付与したユニット（`riderSourceUnitId`）
 * とし、不明な場合だけ攻撃者へフォールバックする。`removeOnSourceDefeated`のMarkerが
 * 「付与者が倒れると解除」で見るのもこの帰属先である。Formula評価の`SKILL_SOURCE`は
 * 攻撃者（追撃ヒットを届けた本人）で評価する — 追撃のダメージ計算と同じ
 * 「ステータスは攻撃した味方を参照する」規約に揃える。
 */
export function* grantOnHitEffectSteps(
  context: EffectActionGroupContext,
  units: readonly BattleUnit[],
  targetUnitId: BattleUnitId,
  onHitEffectActionDefinitionId: EffectActionDefinitionId,
  attackerUnitId: BattleUnitId,
  riderSourceUnitId: BattleUnitId | undefined,
  parentEventId: DomainEventId,
): Generator<
  { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
  { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
  readonly BattleUnit[] | undefined
> {
  const definition = context.definitions.effectActions.get(onHitEffectActionDefinitionId);
  if (
    definition === undefined ||
    (definition.kind !== "APPLY_STAT_MOD" &&
      definition.kind !== "APPLY_CONTINUOUS_DAMAGE" &&
      definition.kind !== "APPLY_DAMAGE_MOD" &&
      definition.kind !== "APPLY_MARKER")
  ) {
    throw new DomainValidationError(
      "onHitEffects.effectActionDefinitionId",
      `references "${onHitEffectActionDefinitionId}", which must be one of ${FOLLOW_UP_ON_HIT_EFFECT_KINDS.join("/")} present in the Catalog (catalog-integrity.ts rejects anything else at load time)`,
    );
  }
  const eventContext = eventContextOf(context);
  const eventsStart = context.recorder.getEvents().length;
  const attacker = requireUnit(units, attackerUnitId);
  const target = requireUnit(units, targetUnitId);
  const sourceUnitId = riderSourceUnitId ?? attackerUnitId;
  // `APPLY_MARKER`はFormulaを持たない（通常解決の`resolveApplyMarker`と同じく0）。
  const magnitude =
    definition.kind === "APPLY_MARKER"
      ? 0
      : evaluateFormula(definition.payload.formula, {
          skillSource: attacker,
          target,
          allUnits: units,
          ...(context.exercise !== undefined ? { exercise: context.exercise } : {}),
          lastResults: damageResultsFor(context.damageResults, attackerUnitId, context.skillUseId),
        });
  const blockingImmunity = findBlockingImmunity(
    target,
    { effectActionDefinitionId: onHitEffectActionDefinitionId, magnitude },
    definition,
  );
  if (blockingImmunity !== undefined) {
    const rejection = rejectEffectApplication(
      eventContext,
      units,
      {
        effectActionDefinitionId: onHitEffectActionDefinitionId,
        sourceUnitId,
        targetUnitId,
        blockingEffect: blockingImmunity,
      },
      parentEventId,
    );
    const injected = yield {
      events: context.recorder.getEvents().slice(eventsStart),
      units: rejection.units,
    };
    return { units: injected ?? rejection.units, lastEventId: rejection.lastEventId };
  }
  const grantResult =
    definition.kind === "APPLY_MARKER"
      ? applyMarker(
          eventContext,
          units,
          {
            markerId: definition.payload.markerId,
            sourceUnitId,
            targetUnitId,
            stackPolicy: definition.payload.stack.policy,
            stackMax: definition.payload.stack.max,
            durationDefinition: definition.payload.duration,
            ...(definition.payload.decay !== undefined ? { decay: definition.payload.decay } : {}),
          },
          parentEventId,
        )
      : definition.kind === "APPLY_DAMAGE_MOD"
        ? grantEffect(
            eventContext,
            units,
            {
              definition,
              sourceUnitId,
              targetUnitId,
              duplicate: true,
              magnitude,
              // 通常解決（`resolveContinuousModifier`）と同じく、ヒット時に評価する条件・
              // 閾値は付与時点の値として`AppliedEffect`へ焼き込む。
              damageModifier: {
                direction: definition.payload.direction,
                damageType: definition.payload.damageType,
                ...(definition.payload.condition !== undefined
                  ? { condition: definition.payload.condition }
                  : {}),
                ...(definition.payload.damageThreshold !== undefined
                  ? { damageThreshold: definition.payload.damageThreshold }
                  : {}),
              },
              durationDefinition: definition.payload.duration,
            },
            parentEventId,
          )
        : definition.kind === "APPLY_STAT_MOD"
          ? grantEffect(
              eventContext,
              units,
              {
                definition,
                sourceUnitId,
                targetUnitId,
                duplicate: definition.payload.stacking.mode === "STACKABLE",
                magnitude,
                durationDefinition: definition.payload.duration,
              },
              parentEventId,
            )
          : (() => {
              // R-DOT-01「付与時に付与者の攻撃力をスナップショットとして記録する」:
              // 追撃の付随効果もダメージ計算と同じく攻撃者のステータスを参照する。
              const grantRequest = {
                definition,
                sourceUnitId,
                targetUnitId,
                duplicate: true,
                magnitude,
                continuousDamage: {
                  continuousDamageKind: definition.payload.continuousDamageKind,
                  damageType: definition.payload.damageType,
                },
                durationDefinition: definition.payload.duration,
                snapshot: { [CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY]: attacker.combatStats.attack },
              };
              // R-DOT-04: 毒だけは新規インスタンスを追加せず既存へ統合する（通常付与と同じ）。
              return definition.payload.continuousDamageKind === "POISON"
                ? grantPoisonContinuousDamage(
                    eventContext,
                    units,
                    grantRequest,
                    context.definitions.effectActions,
                    parentEventId,
                  )
                : grantEffect(eventContext, units, grantRequest, parentEventId);
            })();
  // R-TEX-03 #2: 再計算の中間stepを連鎖driverへ返す（`grantSubUnitAdditionalDamageDebuffSteps`
  // と同じ理由 — 同期wrapperでまとめると演習ブレイクの解決順が逆転する）。
  let cursor = eventsStart;
  const recalculationSteps = recalculateCombatStatsSteps(
    eventContext,
    units,
    grantResult.units,
    targetUnitId,
    context.definitions.effectActions,
    grantResult.lastEventId,
    "EFFECT_APPLIED",
  );
  let step = recalculationSteps.next();
  while (!step.done) {
    const injectedMidway = yield {
      events: context.recorder.getEvents().slice(cursor),
      units: step.value.units,
    };
    cursor = context.recorder.getEvents().length;
    step = recalculationSteps.next(injectedMidway ?? step.value.units);
  }
  const injected = yield {
    events: context.recorder.getEvents().slice(cursor),
    units: step.value.units,
  };
  return { units: injected ?? step.value.units, lastEventId: step.value.lastEventId };
}
