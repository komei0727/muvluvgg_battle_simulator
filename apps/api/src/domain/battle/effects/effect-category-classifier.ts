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
 * `effect-action-payload.ts`の`STATUS_AILMENT_KINDS`を正本とする
 * （`EFFECT_IMMUNITY.statusKinds`のCatalog factory検証も同じ
 * 値集合で絞り込む必要があり、domain/catalogはdomain/battleへ依存できない
 * ため、catalog側を正本にしてここが再利用する）。
 */
const STATUS_AILMENT_KIND_SET: ReadonlySet<StatusKind> = new Set<StatusKind>(STATUS_AILMENT_KINDS);

/**
 * R-CRT-03（DMG-003A、Issue #295）: `APPLY_STATUS`のうち、
 * 定義済みの状態異常ではないが**保持者を弱化する**ためデバフに分類するもの。
 * 会心不可は保持者自身の攻撃が会心しなくなる効果であり、`戦闘システム.md`
 * 「2. デバフについて」の「相手を不利にする効果」そのものである。production定義
 * （`ACT_TARISA_TROUBLEMAKER_AS1_CRIT_PREVENTION`・
 * `ACT_ANIS_TROUBLEMAKER_PS2_CRIT_PREVENTION`）もraw原文が「会心不可の**デバフ**を
 * 付与する」と明示している。
 *
 * `STATUS`は付けない — `戦闘システム.md`「3. 状態異常について」が列挙する定義済み
 * 状態異常（気絶・炎上・毒・凍結・暗闇）に会心不可は含まれず、同節が「『状態異常解除』
 * 『状態異常無効』などの効果は定義されている状態異常のみが対象となります」と限定して
 * いるためである。
 *
 * 対になる`CRITICAL_GUARANTEE`は保持者の攻撃を強化するため既定どおり`BUFF`のままとする。
 *
 * DMG-009（Issue #193、R-CFS-01/R-DTH-01）: 混乱（`CONFUSION`）と幻惑
 * （`DAMAGE_TO_HEAL`）も同じ扱いにする。どちらも保持者の攻撃を逆陣営へ振り替える／
 * 回復へ変換する弱化効果であり、`戦闘システム.md`「3. 状態異常について」が列挙する
 * 定義済み状態異常（気絶・炎上・毒・凍結・暗闇）には含まれないため、`STATUS`は
 * 付けず`DEBUFF`だけとする。
 */
const DEBUFF_STATUS_KIND_SET: ReadonlySet<StatusKind> = new Set<StatusKind>([
  "CRITICAL_PREVENTION",
  "CONFUSION",
  "DAMAGE_TO_HEAL",
]);

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
      if (effect.statusKind !== undefined && DEBUFF_STATUS_KIND_SET.has(effect.statusKind)) {
        // 会心不可（R-CRT-03）: 状態異常ではないが保持者を弱化するデバフ。
        return new Set<EffectImmunityCategory>(["DEBUFF"]);
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
      // R-EFF-05「バフは正の効果量、デバフは弱化量」の「弱化」は保持者から見た
      // 有利／不利であり、`magnitude`の符号そのものではない。被ダメージ補正
      // （`direction: INCOMING`）は符号の意味が与ダメージ側と逆で、負値
      // （「受けるダメージを75%減少させる」）が保持者を強化し、正値
      // （「受けるダメージを増加させる」）が弱化する。符号だけで決めると
      // 「デバフをすべて解除」が自分の被ダメージ減少バフを剥がし、
      // 「自身にデバフが付与された際に発動」が自分への防御バフで発動し、
      // 被ダメージ増加デバフがデバフ解除・デバフ無効の対象から外れる。
      return new Set<EffectImmunityCategory>([
        "DAMAGE_MOD",
        definition.payload.direction === "INCOMING"
          ? effect.magnitude <= 0
            ? "BUFF"
            : "DEBUFF"
          : polarity,
      ]);
    case "APPLY_PIERCING_MOD":
      // R-DMG-03（DMG-003、Issue #196）: 一時貫通は保持者が行う攻撃を強化する
      // 効果であり常にバフである。`APPLY_CONTINUOUS_DAMAGE`と同じ理由で符号から
      // 導く既定の分岐に任せない — この効果は`magnitude`を使わず0のままのため、
      // 既定の分岐でも偶然`BUFF`にはなるが、それは意味ではなく初期値に依存した
      // 一致でしかない。`DAMAGE_MOD`は付けない（与/被ダメージ倍率ではなく貫通率
      // であり、「与ダメージ補正を解除する」`REMOVE_EFFECTS`の対象ではない）。
      return new Set<EffectImmunityCategory>(["BUFF"]);
    case "APPLY_SHIELD":
      return new Set<EffectImmunityCategory>(["SHIELD"]);
    case "APPLY_SUBUNIT":
      return new Set<EffectImmunityCategory>(["SUBUNIT"]);
    case "APPLY_TARGET_REDIRECT":
    case "APPLY_COVER":
      // R-INT-01/02（DMG-006、Issue #188）: 引き寄せ・肩代わりの状態は**攻撃側**が
      // 保持し（production定義の効果対象はどちらも`TRIGGER_SOURCE`）、その攻撃の
      // 対象と受け手を保持者の意図に反して差し替える。`戦闘システム.md`
      // 「2. デバフについて」の「相手を不利にする効果」そのものであり、
      // `APPLY_CONTINUOUS_DAMAGE`と同じ理由で符号から導く既定の分岐に任せない
      // （どちらも`magnitude`に効果量としての意味を持たない）。
      return new Set<EffectImmunityCategory>(["DEBUFF"]);
    case "APPLY_DAMAGE_LINK":
      // R-INT-01 #3／R-LNK-01〜03（DMG-007、Issue #187）:
      // ダメージリンクは同じkindが**両向きに**使われる唯一の防御介入である。
      // 保持者の被ダメージを敵へ送る`ACT_CHIZURU_DOMESTIC_PS1_DAMAGE_LINK`は
      // 保持者を利し、敵2体を相互リンクさせる`ACT_DOROTHEA_PIONEER_PS1_LINK_TO_*`は
      // 相手を不利にする。`magnitude`（`linkRate`）は常に正のため符号からは導けず、
      // 一律`DEBUFF`にすると千鶴のリンクがデバフ無効で拒否され、解除・条件照会も
      // 逆向きに働く。したがって向きはCatalogが`polarity`として明示し、ここは
      // それをそのまま採る（`APPLY_CONTINUOUS_DAMAGE.continuousDamageKind`と同じ
      // 「既定値を置かず定義に書かせる」方針）。
      return new Set<EffectImmunityCategory>([definition.payload.polarity]);
    case "APPLY_REFLECT":
    case "APPLY_DEATH_SURVIVAL":
      // R-INT-01/03（DMG-006、Issue #188）: 反射・致死耐えは保持者自身を利する
      // 継続効果であり、`APPLY_PIERCING_MOD`と同じ理由で常に`BUFF`とする。
      return new Set<EffectImmunityCategory>(["BUFF"]);
    case "APPLY_MARKER":
      return new Set<EffectImmunityCategory>(["MARKER"]);
    default:
      // APPLY_STAT_MOD等の継続ステータス補正は符号付きmagnitudeで判定する。
      return new Set<EffectImmunityCategory>([polarity]);
  }
}
