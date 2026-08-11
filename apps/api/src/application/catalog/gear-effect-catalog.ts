import { createHash } from "node:crypto";
import {
  GEAR_EFFECT_PERCENTAGE_POINTS,
  GEAR_GRADES,
  GEAR_STAT_APPLICATIONS,
  GEAR_TIERS,
  type GearGrade,
  type GearStatApplication,
  type GearTier,
} from "../../domain/battle/model/gear-customization-policy.js";
import { STAT_KINDS, type StatKind } from "../../domain/catalog/definitions/catalog-enums.js";

/** `09_アプリケーション設計.md`「BattleSimulationGearEffectValue」。 */
export interface BattleSimulationGearEffectValue {
  readonly tier: GearTier;
  readonly grade: GearGrade;
  /**
   * R-ENH-04 #3の効果表の値をパーセントポイントのまま公開する。内部表現の小数
   * （`/100`後）へ変換しないのは、設計書の表と字面で突き合わせられる形を保つため。
   */
  readonly percentagePoints: number;
}

/** `09_アプリケーション設計.md`「BattleSimulationGearEffect」。 */
export interface BattleSimulationGearEffect {
  readonly stat: StatKind;
  /** R-ENH-06: 割合補正（`RATIO`）かポイント加算（`POINT`）か。 */
  readonly application: GearStatApplication;
  readonly values: readonly BattleSimulationGearEffectValue[];
}

/**
 * R-ENH-04 #3のギア効果表を表示用の素の表として射影する。値の再計算・丸め・
 * 単位変換は行わず、Domainの正本をそのまま並べ替えるだけにとどめる
 * ——クライアントが効果表を持たずに済むことがこの射影の目的であり、
 * 公開値がDomainの適用結果と一致することは`APP-CATALOG-GEAR-001`が機械検証する。
 */
export function buildGearEffects(): readonly BattleSimulationGearEffect[] {
  return STAT_KINDS.map((stat) => ({
    stat,
    application: GEAR_STAT_APPLICATIONS[stat],
    values: GEAR_TIERS.flatMap((tier) =>
      GEAR_GRADES.map((grade) => ({
        tier,
        grade,
        percentagePoints: GEAR_EFFECT_PERCENTAGE_POINTS[stat][tier][grade],
      })),
    ),
  }));
}

/**
 * 効果表はCatalogファイルではなくコード定数であり、`catalogRevision`に紐づかない。
 * ETagを`catalogRevision`だけから導出すると、効果表だけを変えたデプロイでETagが
 * 変わらず、`If-None-Match`が一致し続けてクライアントが古い表を保持してしまう。
 * ETagは不透明な文字列でありクライアント契約を変えずに導出元を広げられるため、
 * 表のfingerprintを導出元へ加える（`10_API設計.md`「ETag」）。
 */
export function gearEffectsFingerprint(gearEffects: readonly BattleSimulationGearEffect[]): string {
  const canonical = gearEffects
    .map(
      (effect) =>
        `${effect.stat}:${effect.application}:${effect.values
          .map((value) => `${value.tier}${value.grade}=${String(value.percentagePoints)}`)
          .join(",")}`,
    )
    .join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}
