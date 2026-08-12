import { DomainValidationError } from "../../../shared/errors.js";
import type {
  EffectActionApplicationInput,
  EffectActionResolution,
} from "./effect-action-handler.js";
import { resolveDamage } from "./damage-effect-action.js";
import { resolveHeal } from "./heal-effect-action.js";
import { resolveApplyStatus } from "./status-effect-action.js";
import { resolveCooldownManipulation } from "./cooldown-manipulation-effect-action.js";
import { resolveApplyStatMod } from "./stat-mod-effect-action.js";
import {
  resolveApplyResourceGainMod,
  resolveModifyResource,
  resolveModifyResourceCapacity,
} from "./resource-effect-action.js";
import {
  resolveApplyAttackDamageBonus,
  resolveApplyPiercingMod,
  resolveContinuousModifier,
} from "./modifier-effect-action.js";
import { resolveApplyMarker, resolveRemoveMarker } from "./marker-effect-action.js";
import { resolveRemoveEffects } from "./effect-removal-effect-action.js";
import { resolveEffectImmunity } from "./effect-immunity-effect-action.js";
import { resolveApplyShield, resolveApplySubUnit } from "./absorber-effect-action.js";
import { resolveApplyContinuousDamage } from "./continuous-damage-effect-action.js";
import { resolveApplyDamageLink, resolveApplyHealingLink } from "./link-effect-action.js";
import { resolveDefensiveIntervention } from "./defensive-intervention-effect-action.js";

/**
 * `EffectActionDefinition`のkindを、それを実装するハンドラへ振り分ける唯一の分岐。
 * `effect-action-inspection.ts`の`durationOf`と同じ網羅`switch`とし、
 * `effect-action-definition.ts`へ新しいkindが追加された際に、ハンドラの配線漏れを
 * コンパイルエラーとして検出する（`default`の`never`代入）。
 *
 * `default`の実行時throwは、Catalogを経由せず合成された定義がここへ到達した場合の
 * backstopである — 型としては到達不能であり、production Catalogの全kindがハンドラを持つ。
 */
export function* resolveEffectActionByKind(
  input: EffectActionApplicationInput,
): EffectActionResolution {
  const effectAction = input.effectAction;
  switch (effectAction.kind) {
    case "DAMAGE":
      return yield* resolveDamage({ ...input, effectAction });
    case "HEAL":
      return yield* resolveHeal({ ...input, effectAction });
    case "APPLY_STATUS":
      return yield* resolveApplyStatus({ ...input, effectAction });
    case "COOLDOWN_MANIPULATION":
      return resolveCooldownManipulation({ ...input, effectAction });
    case "APPLY_STAT_MOD":
      return yield* resolveApplyStatMod({ ...input, effectAction });
    case "MODIFY_RESOURCE":
      return yield* resolveModifyResource({ ...input, effectAction });
    case "MODIFY_RESOURCE_CAPACITY":
      return yield* resolveModifyResourceCapacity({ ...input, effectAction });
    case "APPLY_RESOURCE_GAIN_MOD":
      return resolveApplyResourceGainMod({ ...input, effectAction });
    case "APPLY_HEALING_MOD":
    case "APPLY_DAMAGE_MOD":
    case "APPLY_CONTINUOUS_HEAL":
      return resolveContinuousModifier({ ...input, effectAction });
    case "APPLY_ATTACK_DAMAGE_BONUS":
      return resolveApplyAttackDamageBonus({ ...input, effectAction });
    case "APPLY_PIERCING_MOD":
      return resolveApplyPiercingMod({ ...input, effectAction });
    case "APPLY_MARKER":
      return resolveApplyMarker({ ...input, effectAction });
    case "REMOVE_MARKER":
      return yield* resolveRemoveMarker({ ...input, effectAction });
    case "REMOVE_EFFECTS":
      return yield* resolveRemoveEffects({ ...input, effectAction });
    case "EFFECT_IMMUNITY":
      return resolveEffectImmunity({ ...input, effectAction });
    case "APPLY_SHIELD":
      return resolveApplyShield({ ...input, effectAction });
    case "APPLY_SUBUNIT":
      return resolveApplySubUnit({ ...input, effectAction });
    case "APPLY_CONTINUOUS_DAMAGE":
      return resolveApplyContinuousDamage({ ...input, effectAction });
    case "APPLY_HEALING_LINK":
      return resolveApplyHealingLink({ ...input, effectAction });
    case "APPLY_DAMAGE_LINK":
      return resolveApplyDamageLink({ ...input, effectAction });
    case "APPLY_TARGET_REDIRECT":
    case "APPLY_COVER":
    case "APPLY_REFLECT":
    case "APPLY_DEATH_SURVIVAL":
      return resolveDefensiveIntervention({ ...input, effectAction });
    default: {
      const exhaustive: never = effectAction;
      throw new DomainValidationError(
        "effectActionDefinitionId",
        `unhandled EffectAction kind: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}
