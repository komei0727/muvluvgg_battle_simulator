import { grantEffect, type GrantEffectRequest } from "../../effects/effect-grant-service.js";
import { DomainValidationError } from "../../../shared/errors.js";
import type { EffectActionDefinition } from "../../../catalog/definitions/effect-action-definition.js";
import type { BattleUnitId } from "../../../shared/ids.js";
import {
  completeGrant,
  rejectIfImmune,
  type EffectActionHandler,
  type EffectActionOutcome,
} from "./effect-action-handler.js";
import { eventContextOf, grantSourceOf, requireActorUnit } from "./effect-action-group-context.js";

/**
 * R-INT-01〜03（DMG-006）: 防御介入系の4kindについて、`grantEffect`へ渡す`magnitude`と
 * kind固有stateを組み立てる。
 *
 * `redirectTo`/`coverer`（実装済みは`SELF`＝この効果を付与するユニット）は付与時点で
 * 解決してインスタンスへ焼き込む。`combat/`は介入の解決時点でTargetBindingも
 * トリガーcontextも引けないためで、`APPLY_HEALING_LINK.transferTo`とまったく同じ理由・
 * 同じ制限である。未対応の形はCatalogロード時点で拒否済み
 * （`catalog-integrity.ts`の`UNSUPPORTED_TARGET_REDIRECT_DESTINATION`／
 * `UNSUPPORTED_COVER_*`／`UNSUPPORTED_REFLECT_*`）だが、Catalogを経由しない合成定義に
 * 対する実行時backstopもここへ残す。
 *
 * `magnitude`は`AppliedEffect`共通の「符号付き効果量」であり、この4kindでは補正値としての
 * 意味を持たない。監査で意味のある単一の数値を持つ`APPLY_COVER`だけ`damageShareRate`を
 * 入れ（`APPLY_HEALING_LINK`が`transferRate`を入れるのと同じ規約）、残りは0にする。
 * バフ／デバフの分類は`magnitude`の符号ではなくkindから決まる
 * （`effect-category-classifier.ts`）ため、この0が分類へ影響することはない。
 */
function buildDefensiveInterventionGrant(
  effectAction: Extract<
    EffectActionDefinition,
    { kind: "APPLY_TARGET_REDIRECT" | "APPLY_COVER" | "APPLY_REFLECT" | "APPLY_DEATH_SURVIVAL" }
  >,
  actorUnitId: BattleUnitId,
): {
  readonly magnitude: number;
  readonly state: Partial<
    Pick<GrantEffectRequest, "targetRedirect" | "cover" | "reflect" | "deathSurvival">
  >;
} {
  switch (effectAction.kind) {
    case "APPLY_TARGET_REDIRECT": {
      if (effectAction.payload.redirectTo.kind !== "SELF") {
        throw new DomainValidationError(
          "effectActionDefinitionId",
          `APPLY_TARGET_REDIRECT payload.redirectTo.kind "${effectAction.payload.redirectTo.kind}" is not supported (R-INT-01 implements "SELF" only)`,
        );
      }
      return {
        magnitude: 0,
        state: {
          targetRedirect: {
            redirectToUnitId: actorUnitId,
            actionKinds: effectAction.payload.appliesTo.actionKinds,
          },
        },
      };
    }
    case "APPLY_COVER": {
      if (effectAction.payload.coverer.kind !== "SELF") {
        throw new DomainValidationError(
          "effectActionDefinitionId",
          `APPLY_COVER payload.coverer.kind "${effectAction.payload.coverer.kind}" is not supported (R-INT-02 implements "SELF" only)`,
        );
      }
      if (effectAction.payload.damageShareRate !== 1) {
        throw new DomainValidationError(
          "effectActionDefinitionId",
          `APPLY_COVER payload.damageShareRate ${effectAction.payload.damageShareRate} is not supported (R-INT-02 implements 1 only — a partial share would split one hit across two defenders, which R-INT-02 does not define)`,
        );
      }
      return {
        magnitude: effectAction.payload.damageShareRate,
        state: {
          cover: {
            covererUnitId: actorUnitId,
            damageShareRate: effectAction.payload.damageShareRate,
            guardRate: effectAction.payload.guardRate,
            actionKinds: effectAction.payload.appliesTo.actionKinds,
          },
        },
      };
    }
    case "APPLY_REFLECT": {
      if (effectAction.payload.reflectTo.kind !== "TRIGGER_SOURCE") {
        throw new DomainValidationError(
          "effectActionDefinitionId",
          `APPLY_REFLECT payload.reflectTo.kind "${effectAction.payload.reflectTo.kind}" is not supported (R-INT-03 implements "TRIGGER_SOURCE" only)`,
        );
      }
      if (effectAction.payload.allowRecursiveReflect) {
        throw new DomainValidationError(
          "effectActionDefinitionId",
          'APPLY_REFLECT payload.allowRecursiveReflect: true is not supported (R-INT-03 "反射からさらに反射を発生させない")',
        );
      }
      return {
        magnitude: 0,
        state: {
          reflect: {
            formula: effectAction.payload.formula,
            allowRecursiveReflect: effectAction.payload.allowRecursiveReflect,
          },
        },
      };
    }
    case "APPLY_DEATH_SURVIVAL":
      return {
        magnitude: 0,
        state: {
          deathSurvival: {
            survivalHp: effectAction.payload.survivalHp,
            healAfterSurvival: effectAction.payload.healAfterSurvival,
          },
        },
      };
  }
}

/**
 * R-INT-01〜03（DMG-006）: 防御介入系の4kindを`AppliedEffect`として付与する。実際の介入は
 * `combat/damage-application-service.ts`が`DamageWillBeApplied`の後（引き寄せ・肩代わり・
 * 反射）とHP適用時（致死耐え）に解決する。付与時点で確定させるのは、その時点にしか
 * 解決できない参照（`redirectTo`/`coverer`のユニットID）だけである
 * （`APPLY_HEALING_LINK`の`transferTo`と同じ「付与時snapshot」規約）。
 *
 * 重複規則は`APPLY_SHIELD`と同じくR-EFF-01の一般規則どおり常に新規インスタンス
 * （`duplicate: true`）。CombatStatsは変えないため再計算は呼ばない。
 */
export const resolveDefensiveIntervention: EffectActionHandler<
  "APPLY_TARGET_REDIRECT" | "APPLY_COVER" | "APPLY_REFLECT" | "APPLY_DEATH_SURVIVAL"
> = (input): EffectActionOutcome => {
  const { context, box, application, effectAction, startingEventId } = input;
  const grant = buildDefensiveInterventionGrant(
    effectAction,
    requireActorUnit(context, box).battleUnitId,
  );
  const rejected = rejectIfImmune(input, grant.magnitude);
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
        targetId: application.targetBattleUnitId,
        duplicate: true,
        magnitude: grant.magnitude,
        ...grant.state,
        durationDefinition: effectAction.payload.duration,
      },
      startingEventId,
    ),
  );
};
