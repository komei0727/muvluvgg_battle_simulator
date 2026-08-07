import type { DurationDefinition } from "../definitions/duration-definition.js";
import type { EffectActionDefinition } from "../definitions/effect-action-definition.js";

/**
 * `EffectActionDefinition`のkind横断アクセサ。kindごとのpayload形状を知っているのは
 * このmoduleだけで、検証本体（`effect-action-integrity.ts`／`memory-integrity.ts`）は
 * ここを経由する。
 */

/**
 * `DurationDefinition`を運ぶkindだけ値を返す（`APPLY_MARKER`を含む）。
 * `duration`本体をkindを問わず取り出す。網羅`switch`とし、新しいkindが
 * `effect-action-definition.ts`へ追加された際にこの関数の更新漏れをコンパイル
 * エラーとして検出する。
 */
export function durationOf(effectAction: EffectActionDefinition): DurationDefinition | undefined {
  switch (effectAction.kind) {
    case "APPLY_CONTINUOUS_HEAL":
    case "APPLY_CONTINUOUS_DAMAGE":
    case "APPLY_STAT_MOD":
    case "APPLY_DAMAGE_MOD":
    case "APPLY_HEALING_MOD":
    case "MODIFY_RESOURCE_CAPACITY":
    case "APPLY_STATUS":
    case "APPLY_SHIELD":
    case "EFFECT_IMMUNITY":
    case "APPLY_DEATH_SURVIVAL":
    case "APPLY_TARGET_REDIRECT":
    case "APPLY_COVER":
    case "APPLY_REFLECT":
    case "APPLY_MARKER":
    case "APPLY_ATTACK_DAMAGE_BONUS":
    case "APPLY_RESOURCE_GAIN_MOD":
    case "APPLY_HEALING_LINK":
    case "APPLY_DAMAGE_LINK":
    case "APPLY_PIERCING_MOD":
    case "APPLY_SUBUNIT":
      // `APPLY_SUBUNIT`は`SUBUNIT_DURATION`（DMG-005、Issue #190）でサブユニット自身も
      // 存続期間を持つ継続効果になった（`ApplySubunitPayload.duration`）。
      return effectAction.payload.duration;
    case "DAMAGE":
    case "HEAL":
    case "MODIFY_RESOURCE":
    case "REMOVE_EFFECTS":
    case "REMOVE_MARKER":
    case "COOLDOWN_MANIPULATION":
      return undefined;
    default: {
      const exhaustive: never = effectAction;
      throw new Error(`unhandled EffectActionDefinition kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
