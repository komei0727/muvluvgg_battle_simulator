import { grantEffect } from "../../effects/effect-grant-service.js";
import {
  completeGrant,
  rejectIfImmune,
  type EffectActionHandler,
  type EffectActionOutcome,
} from "./effect-action-handler.js";
import { eventContextOf, grantSourceOf } from "./effect-action-group-context.js";

/**
 * R-EFF-03（M7-001B）: 免疫効果自体を`AppliedEffect`として付与する（`categories`/
 * `statusKinds`（`EFFECT_IMMUNITY_STATUS_GRANULARITY`）/`effectActionDefinitionIds`/
 * `maxBlocks`をそのまま保持し、実行時カウンタ`blockedCount`は0から始める）。
 * `stacking`相当の設定を持たないため、`APPLY_STAT_MOD`/`APPLY_STATUS`と同じ理由で
 * `duplicate: true`に固定する。
 *
 * 免疫効果自身の付与も「新規付与」であり免疫の対象になり得る — Catalogは
 * `SPECIFIC_EFFECT`の`effectActionDefinitionIds`で他の`EFFECT_IMMUNITY`定義IDを
 * 指定できるため（例: 「免疫封印」で対象の特定免疫効果自体の再付与を防ぐ）、
 * 他のkindと同じく免疫判定を通す。
 */
export const resolveEffectImmunity: EffectActionHandler<"EFFECT_IMMUNITY"> = (
  input,
): EffectActionOutcome => {
  const { context, box, application, effectAction, startingEventId } = input;
  const rejected = rejectIfImmune(input, 0);
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
        magnitude: 0,
        durationDefinition: effectAction.payload.duration,
        immunity: {
          categories: effectAction.payload.categories,
          ...(effectAction.payload.statusKinds !== undefined
            ? { statusKinds: effectAction.payload.statusKinds }
            : {}),
          ...(effectAction.payload.effectActionDefinitionIds !== undefined
            ? { effectActionDefinitionIds: effectAction.payload.effectActionDefinitionIds }
            : {}),
          maxBlocks: effectAction.payload.maxBlocks,
          blockedCount: 0,
        },
      },
      startingEventId,
    ),
  );
};
