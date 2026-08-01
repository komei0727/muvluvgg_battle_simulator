import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import {
  STATUS_AILMENT_CONTINUOUS_DAMAGE_KINDS,
  type ContinuousDamageKind,
  type EffectImmunityCategory,
} from "../../catalog/definitions/catalog-enums.js";
import {
  STATUS_AILMENT_KINDS,
  type StatusKind,
} from "../../catalog/definitions/effect-action-payload.js";
import type { AppliedEffect } from "../model/applied-effect.js";

/**
 * R-STS-01「状態異常はデバフの一種とする」/`14_Catalog定義スキーマ.md`「状態異常」:
 * `APPLY_STATUS`のうち、解除・無効判定で`STATUS`カテゴリの対象になる本来の
 * 状態異常（気絶・凍結・暗闇）。それ以外の`APPLY_STATUS`（STEALTH・EVASION・
 * DAMAGE_IMMUNITY等）は対象自身にとって有利なため、`BUFF`として扱う。
 * `effect-action-payload.ts`の`STATUS_AILMENT_KINDS`を正本とする（PR #245
 * 再レビュー[P2]: `EFFECT_IMMUNITY.statusKinds`のCatalog factory検証も同じ
 * 値集合で絞り込む必要があり、domain/catalogはdomain/battleへ依存できない
 * ため、catalog側を正本にしてここが再利用する）。
 */
const STATUS_AILMENT_KIND_SET: ReadonlySet<StatusKind> = new Set<StatusKind>(STATUS_AILMENT_KINDS);

/**
 * RES-004-STATUS-CONDITION（Issue #224）: `APPLY_CONTINUOUS_DAMAGE`のうち`STATUS`
 * カテゴリの対象になる種別（炎上・毒）。`STATUS_AILMENT_KINDS`（`APPLY_STATUS`側）と
 * 同じ理由でCatalog側（`catalog-enums.ts`）を正本とし、ここが再利用する。
 */
const STATUS_AILMENT_CONTINUOUS_DAMAGE_KIND_SET: ReadonlySet<ContinuousDamageKind> =
  new Set<ContinuousDamageKind>(STATUS_AILMENT_CONTINUOUS_DAMAGE_KINDS);

/**
 * R-EFF-02 #2「バフ、デバフ、状態異常、シールドなど一致する効果を抽出する」:
 * ある`AppliedEffect`が属する解除カテゴリ集合を導く純粋関数。`REMOVE_EFFECTS`/
 * `EFFECT_IMMUNITY`が共有する`categories`（`EffectImmunityCategory`）のうち、
 * `MARKER`（`MarkerState`は`AppliedEffect`ではなく`REMOVE_MARKER`で扱う）と
 * `SPECIFIC_EFFECT`（`effectActionDefinitionId`の直接一致で判定するため分類軸
 * ではない）を除いた intrinsic なカテゴリだけを返す。
 *
 * バフ／デバフの判定はR-EFF-05「バフは正の効果量、デバフは弱化量」および
 * 既存API（`simulate-battle-response-mapper.ts`の`category`）と同じく符号付き
 * `magnitude`から導く。状態異常（`STATUS`）はR-STS-01により`DEBUFF`も兼ねる。
 *
 * M7-001（Issue #181）時点で実際に`AppliedEffect`として付与され得るのは
 * `APPLY_STAT_MOD`と`APPLY_STATUS`（現状STEALTHのみ）だが、`APPLY_DAMAGE_MOD`・
 * `APPLY_SHIELD`・`APPLY_SUBUNIT`が実ライフサイクルへ配線された時点でも正しく
 * 分類できるよう、定義kindから決まる固有カテゴリ（`DAMAGE_MOD`/`SHIELD`/
 * `SUBUNIT`）も併せて返す。
 *
 * M7-001B（Issue #243、R-EFF-03）: `EFFECT_IMMUNITY`の付与拒否判定
 * （`effect-immunity-service.ts`）も、まだ`AppliedEffect`として存在しない
 * 「これから付与しようとしている効果」の候補カテゴリを求めるためにこの関数を
 * 再利用する — `APPLY_MARKER`はCatalog付与前の候補としてしか呼ばれない
 * （`MarkerState`は`AppliedEffect`ではないため、既存効果の解除判定
 * `effect-removal-service.ts`側からは`APPLY_MARKER`のdefinitionが渡ることはない）。
 */
export function effectCategoriesOf(
  effect: Pick<AppliedEffect, "magnitude" | "statusKind">,
  definition: EffectActionDefinition,
): ReadonlySet<EffectImmunityCategory> {
  const polarity: EffectImmunityCategory = effect.magnitude >= 0 ? "BUFF" : "DEBUFF";

  switch (definition.kind) {
    case "APPLY_STATUS": {
      if (effect.statusKind !== undefined && STATUS_AILMENT_KIND_SET.has(effect.statusKind)) {
        return new Set<EffectImmunityCategory>(["STATUS", "DEBUFF"]);
      }
      // STEALTH等、対象に有利な状態は状態異常ではなくバフとして扱う。
      return new Set<EffectImmunityCategory>(["BUFF"]);
    }
    case "APPLY_CONTINUOUS_DAMAGE":
      // R-DOT-01（DMG-008、Issue #189）: 継続ダメージは保持者へダメージを与える
      // 効果であり、常にデバフである。`magnitude`（ダメージ量）は正の値のため、
      // 符号から導く既定の分岐に任せるとバフとして分類され、production の
      // デバフ解除（`REMOVE_EFFECTS` の `categories: ["DEBUFF"]`）が炎上・毒を
      // 解除できなくなる。`APPLY_SHIELD`等と同じく定義kindから固定で決める。
      //
      // RES-004-STATUS-CONDITION（Issue #224）: 炎上・毒には`STATUS`も付ける。
      // M7-001E（Issue #248）時点では「炎上・毒を状態異常として扱うかはR-DOT-01〜04が
      // 規定していない」として保留していたが、`01_ユビキタス言語.md`「状態異常」と
      // `戦闘システム.md`「3. 状態異常について」がどちらも炎上・毒を定義された状態異常
      // として列挙しているため、R-STS-01の状態異常解除・状態異常無効、および
      // `TARGET_HAS_EFFECT.categories: ["STATUS"]`による「対象が状態異常にある場合」の
      // 照会（`SKL_CHIYURU_MAZE_EX`等）はこれらを含めなければならない。どの種別が
      // 状態異常かは`STATUS_AILMENT_CONTINUOUS_DAMAGE_KINDS`を正本にする（`FIXED`は
      // 名前付きの状態異常ではないため従来どおり`DEBUFF`だけ）。
      return STATUS_AILMENT_CONTINUOUS_DAMAGE_KIND_SET.has(definition.payload.continuousDamageKind)
        ? new Set<EffectImmunityCategory>(["STATUS", "DEBUFF"])
        : new Set<EffectImmunityCategory>(["DEBUFF"]);
    case "APPLY_DAMAGE_MOD":
      return new Set<EffectImmunityCategory>(["DAMAGE_MOD", polarity]);
    case "APPLY_SHIELD":
      return new Set<EffectImmunityCategory>(["SHIELD"]);
    case "APPLY_SUBUNIT":
      return new Set<EffectImmunityCategory>(["SUBUNIT"]);
    case "APPLY_MARKER":
      return new Set<EffectImmunityCategory>(["MARKER"]);
    default:
      // APPLY_STAT_MOD等の継続ステータス補正は符号付きmagnitudeで判定する。
      return new Set<EffectImmunityCategory>([polarity]);
  }
}
