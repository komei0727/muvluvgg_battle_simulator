import type { ActionKind } from "../../catalog/definitions/catalog-enums.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { FormulaDefinition } from "../../catalog/definitions/formula-definition.js";
import type { EffectInstanceId } from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { AppliedEffect } from "../model/applied-effect.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";

/**
 * R-INT-01「防御介入順」（DMG-006、Issue #188）の**選択**だけを担う純粋関数群。
 * 状態変更もイベント発行も行わない（`damage-application-service.ts`が呼び出し、
 * 成立した介入ごとに`DamageRedirected`／`ReflectedDamageGenerated`／
 * `LethalDamageSurvived`を発行する）。`shield-policy.ts`／`sub-unit-policy.ts`が
 * 吸収の計算だけを担うのと同じ切り分けである。
 *
 * R-INT-01は評価順を次のように定める。
 *
 * 1. `APPLY_TARGET_REDIRECT`（引き寄せ・挑発）
 * 2. `APPLY_COVER`（肩代わり）
 * 3. `APPLY_DAMAGE_LINK`（継続リンク状態、`DMG-007`／Issue #187、R-LNK-01〜03）
 * 4. `APPLY_REFLECT`（反射）
 * 5. `APPLY_DEATH_SURVIVAL`（致死耐え）
 *
 * #1・#2はダメージ計算の**防御側そのもの**を変えるためこの時点で確定させ、
 * #3・#4・#5は成立の判定だけをこの時点で行い（R-INT-01「`DamageWillBeApplied`後、
 * ダメージ確定前に…評価する」）、実際の作用はそれぞれ元ダメージの適用後
 * （R-LNK-01「対象へ算出された最終ダメージをリンク元の量とする」、R-INT-03
 * 「反射は元ダメージの確定後…に発生する」。R-INT-01の評価順どおりリンクが先）と
 * HP適用時に起きる。
 */

/**
 * 引き寄せ・肩代わりの候補が「この攻撃に適用されるか」（`appliesTo.actionKinds`）。
 *
 * 呼び出し側（`damage-application-service.ts`）はR-INT-01の評価点で
 * ある`"DAMAGE"`でしかこの判定を行わないため、Catalogは`["DAMAGE"]`以外の宣言を
 * ロード時点で拒否する（`UNSUPPORTED_DEFENSIVE_INTERVENTION`）。`ANY`の分岐をここに
 * 残すのは、Catalogを経由しない合成定義（単体テスト）と、将来デバフのライフサイクルへ
 * 配線した際に`appliesTo`の意味論をこの関数が正しく持ち続けるためである。
 */
function appliesToActionKind(actionKinds: readonly ActionKind[], actionKind: ActionKind): boolean {
  return actionKinds.includes("ANY") || actionKinds.includes(actionKind);
}

/**
 * R-INT-02第3項「複数の肩代わり候補がある場合の優先順はCapability実装時に具体化する」の
 * 具体化: **付与順の古い順**（先に成立した介入が優先される）。同じ行動の中で後から
 * 発動したPSが既に成立している介入を横取りしないため、結果が後続のPS発動順に依存しない。
 * 引き寄せ（R-INT-01 #1）と致死耐え（#5）にも同じ規約を適用する
 * （`appliedEffects`の配列順＝付与順、R-TGT-10と同じ定義順評価）。
 */
function firstMatching(
  unit: BattleUnit,
  predicate: (effect: AppliedEffect) => boolean,
): AppliedEffect | undefined {
  return unit.appliedEffects.find(predicate);
}

/** R-INT-01 #1: この攻撃の対象を差し替える引き寄せ。 */
export interface TargetRedirectSelection {
  readonly effectInstanceId: EffectInstanceId;
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly redirectToUnitId: BattleUnitId;
}

/**
 * R-INT-01 #1: `attacker`が保持する`APPLY_TARGET_REDIRECT`から、この攻撃へ実際に
 * 適用されるものを1件選ぶ。
 *
 * 次の場合は成立しない（`undefined`）。
 * - `appliesTo.actionKinds`がこの攻撃の種別を含まない
 * - 引き寄せ先が盤面から引けない、または戦闘不能（R-ACTN-01 #2。攻撃は元の対象へ向かう）
 * - 引き寄せ先が既にこの攻撃の対象（差し替える先が同じなら`DamageRedirected`も発行しない）
 */
export function selectTargetRedirect(
  attacker: BattleUnit,
  currentTargetUnitId: BattleUnitId,
  actionKind: ActionKind,
  units: ReadonlyMap<BattleUnitId, BattleUnit>,
): TargetRedirectSelection | undefined {
  const effect = firstMatching(attacker, (candidate) => {
    const redirect = candidate.targetRedirect;
    if (redirect === undefined || !appliesToActionKind(redirect.actionKinds, actionKind)) {
      return false;
    }
    const destination = units.get(redirect.redirectToUnitId);
    return (
      destination !== undefined &&
      !isDefeated(destination) &&
      destination.battleUnitId !== currentTargetUnitId
    );
  });
  return effect?.targetRedirect === undefined
    ? undefined
    : {
        effectInstanceId: effect.effectInstanceId,
        effectActionDefinitionId: effect.effectActionDefinitionId,
        redirectToUnitId: effect.targetRedirect.redirectToUnitId,
      };
}

/** R-INT-01 #2／R-INT-02: 成立した肩代わり。 */
export interface CoverSelection {
  readonly effectInstanceId: EffectInstanceId;
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly covererUnitId: BattleUnitId;
  readonly damageShareRate: number;
  readonly guardRate: number;
}

/**
 * R-INT-01 #2／R-INT-02: `attacker`が保持する`APPLY_COVER`から、この攻撃へ実際に
 * 適用されるものを1件選ぶ。`14_Catalog定義スキーマ.md`「`APPLY_TARGET_REDIRECT`と
 * `APPLY_COVER`を同じ行動で付与する場合、redirect後の攻撃対象に対してcoverを評価する」
 * のとおり、呼び出し側は引き寄せ解決**後**の対象を`currentTargetUnitId`へ渡す。
 *
 * 肩代わり者が既に対象自身の場合も成立させる（`undefined`にしない）— production定義
 * （`ACT_EVIE_ECO_PS1_COVER`、引き寄せと同じPSで自身へ引き寄せてから50%ガードして
 * 肩代わりする）では防御側は変わらないが`guardRate`の軽減は起きるためである。
 * 戦闘不能な肩代わり者は成立させない（R-ACTN-01 #2）。
 */
export function selectCover(
  attacker: BattleUnit,
  currentTargetUnitId: BattleUnitId,
  actionKind: ActionKind,
  units: ReadonlyMap<BattleUnitId, BattleUnit>,
): CoverSelection | undefined {
  const effect = firstMatching(attacker, (candidate) => {
    const cover = candidate.cover;
    if (cover === undefined || !appliesToActionKind(cover.actionKinds, actionKind)) {
      return false;
    }
    const coverer = units.get(cover.covererUnitId);
    return coverer !== undefined && !isDefeated(coverer);
  });
  const cover = effect?.cover;
  if (effect === undefined || cover === undefined) {
    return undefined;
  }
  // 肩代わり者が対象自身で、かつ軽減もしないなら何も変化しない（イベントも発行しない）。
  if (cover.covererUnitId === currentTargetUnitId && cover.guardRate === 0) {
    return undefined;
  }
  return {
    effectInstanceId: effect.effectInstanceId,
    effectActionDefinitionId: effect.effectActionDefinitionId,
    covererUnitId: cover.covererUnitId,
    damageShareRate: cover.damageShareRate,
    guardRate: cover.guardRate,
  };
}

/**
 * R-INT-02第2項「肩代わり時に軽減する割合」: 肩代わりが成立したヒットの確定前
 * ダメージへ`1 - guardRate`を掛ける。Q-DMG-01「計算の途中では丸めず、最終結果で
 * 切り捨てる」に従い、呼び出し側は切り捨て前の値へ適用する。
 */
export function guardedDamage(preTruncationDamage: number, guardRate: number): number {
  return preTruncationDamage * (1 - guardRate);
}

/** R-INT-01 #4／R-INT-03: 元ダメージの適用後に反射を発生させる1インスタンス。 */
export interface ReflectSelection {
  readonly effectInstanceId: EffectInstanceId;
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly formula: FormulaDefinition;
}

/**
 * R-INT-01 #4: `defender`（この攻撃で実際にダメージを受ける側）が保持する
 * `APPLY_REFLECT`をすべて付与順に返す。R-INT-03は反射の件数を制限しないため、
 * 保持している数だけ反射が発生する。
 *
 * R-INT-03第2項「反射からさらに反射を発生させない」の再反射防止は、反射ダメージの
 * 適用経路自体が介入解決を通らないことで満たす（`damage-application-service.ts`）。
 * `allowRecursiveReflect: true`はCatalogロード時点で拒否済み
 * （`UNSUPPORTED_RECURSIVE_REFLECT`）だが、実行時にもこの選択から除外する。
 */
export function selectReflects(defender: BattleUnit): readonly ReflectSelection[] {
  return defender.appliedEffects.flatMap((effect) =>
    effect.reflect !== undefined && !effect.reflect.allowRecursiveReflect
      ? [
          {
            effectInstanceId: effect.effectInstanceId,
            effectActionDefinitionId: effect.effectActionDefinitionId,
            formula: effect.reflect.formula,
          },
        ]
      : [],
  );
}

/** R-INT-01 #3／R-LNK-01〜03: 元ダメージの適用後にリンク先ダメージを発生させる1インスタンス。 */
export interface DamageLinkSelection {
  readonly effectInstanceId: EffectInstanceId;
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly linkToUnitId: BattleUnitId;
  readonly linkRate: number;
}

/**
 * R-INT-01 #3（DMG-007、Issue #187）: `damagedUnit`（この攻撃で実際にダメージを
 * 受ける側＝リンク元）が保持する`APPLY_DAMAGE_LINK`のうち、実際にリンク先ダメージを
 * 発生させられるものを付与順に返す。R-LNK-02は件数を制限せず「対象数で分割しない」と
 * 定めるため、保持している数だけリンクが**それぞれ独立に**発生する
 * （`selectReflects`が反射の件数を制限しないのと同じ）。
 *
 * 次のリンクは成立させない。
 * - 自己リンク（リンク先が保持者自身）: R-LNK-02は「リンクされた**全対象へ**リンク元と
 *   同量を発生させる」と定めており、リンク元自身へ二重に適用することは求めていない。
 *   `allocateHealingLinkTransfers`が自己リンクを恒等として扱うのと同じ規約である
 * - リンク先が盤面から引けない、または戦闘不能（R-ACTN-01 #2）
 *
 * R-LNK-03第2項「`isLinkedDamage=true`のダメージから新たなリンクを発生させない」の
 * 再リンク防止は、リンクダメージの適用経路自体が介入解決を通らないことで満たす
 * （`damage-application-service.ts`、反射の再反射防止とまったく同じ構造）。
 */
export function selectDamageLinks(
  damagedUnit: BattleUnit,
  units: ReadonlyMap<BattleUnitId, BattleUnit>,
): readonly DamageLinkSelection[] {
  return damagedUnit.appliedEffects.flatMap((effect) => {
    const link = effect.damageLink;
    if (link === undefined || link.linkToUnitId === damagedUnit.battleUnitId) {
      return [];
    }
    const destination = units.get(link.linkToUnitId);
    if (destination === undefined || isDefeated(destination)) {
      return [];
    }
    return [
      {
        effectInstanceId: effect.effectInstanceId,
        effectActionDefinitionId: effect.effectActionDefinitionId,
        linkToUnitId: link.linkToUnitId,
        linkRate: link.linkRate,
      },
    ];
  });
}

/** R-INT-01 #5: 致死ダメージを耐える1インスタンス。 */
export interface DeathSurvivalSelection {
  readonly effectInstanceId: EffectInstanceId;
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly survivalHp: FormulaDefinition;
  readonly healAfterSurvival: FormulaDefinition | null;
}

/**
 * R-INT-01 #5: `target`が保持する`APPLY_DEATH_SURVIVAL`から、実際に致死を耐えられる
 * ものを1件選ぶ（付与順の古い順）。
 *
 * R-EFF-07の消費条件（production定義はすべて`consumption.kind: LETHAL_DAMAGE`、
 * `maxCount: 1`）を使い切ったインスタンスは選ばない — 消費残0のインスタンスの実際の
 * 失効は`consumeEffectDuration`が行うが、その失効が完了する前でも耐えてはならない
 * （`shield-policy.ts`が残量0のシールドをプールへ含めないのと同じ規約）。消費条件を
 * 持たないインスタンス（回数無制限）は常に選べる。
 */
export function selectDeathSurvival(target: BattleUnit): DeathSurvivalSelection | undefined {
  const effect = firstMatching(
    target,
    (candidate) =>
      candidate.deathSurvival !== undefined &&
      (candidate.duration.consumptionRemaining === undefined ||
        candidate.duration.consumptionRemaining > 0),
  );
  const deathSurvival = effect?.deathSurvival;
  return effect === undefined || deathSurvival === undefined
    ? undefined
    : {
        effectInstanceId: effect.effectInstanceId,
        effectActionDefinitionId: effect.effectActionDefinitionId,
        survivalHp: deathSurvival.survivalHp,
        healAfterSurvival: deathSurvival.healAfterSurvival,
      };
}
