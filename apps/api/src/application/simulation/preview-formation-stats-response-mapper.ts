import type { FormationStatPreviewResult } from "./preview-formation-stats-use-case.js";
import {
  toCombatStatsResponseBody,
  toFormationPositionResponseBody,
} from "./simulate-battle-response-mapper.js";
import type { BaseStats } from "../../domain/catalog/definitions/unit-definition.js";
import type {
  FormationStatPreviewBaseStatsResponseBody,
  FormationStatPreviewResponseBody,
} from "../contracts/response.js";

const SCHEMA_VERSION = 1;

/**
 * `10_API設計.md`「FormationStatPreviewResponse」: Resultを公開JSON契約へ変換する。
 * 配置表現と割合単位の変換は戦闘状態レスポンスと同じ関数を使い、プレビューと
 * `initialState`が同じ値を同じ単位で公開することを実装上も1か所へ保つ。
 */
export function toFormationStatPreviewResponseBody(
  result: FormationStatPreviewResult,
): FormationStatPreviewResponseBody {
  return {
    schemaVersion: SCHEMA_VERSION,
    catalogRevision: result.catalogRevision,
    units: result.units.map((unit) => ({
      side: unit.side,
      unitDefinitionId: unit.unitDefinitionId,
      formationPosition: toFormationPositionResponseBody(unit.position),
      // `CombatStatsResponse`は`maximumHp`を持たないため、`hp.maximum`と同じ
      // 全精度値をユニット直下で返す（R-NUM-01。表示上の丸めはクライアント側）。
      maximumHp: unit.combatStats.maximumHp,
      combatStats: toCombatStatsResponseBody(unit.combatStats),
      enhancedBaseStats: toEnhancedBaseStatsResponseBody(unit.enhancedBaseStats),
    })),
  };
}

/**
 * R-ENH-06の強化後基本ステータスを公開形へ変換する。`BaseStats` と `CombatStats` は
 * 比率3項目を同じ単位で保持する（R-STA-01の基本値がそのまま合成対象になる）ため、
 * 補正後と同じ `toCombatStatsResponseBody` を通してパーセントポイント変換を1か所に保つ
 * —— 独自の変換を置くと、片方の単位だけが変わっても両者とも「仕様どおり」に見えてしまう。
 * AP/PPは公開対象外なので、ここで落ちる。
 */
function toEnhancedBaseStatsResponseBody(
  baseStats: BaseStats,
): FormationStatPreviewBaseStatsResponseBody {
  return {
    maximumHp: baseStats.maximumHp,
    ...toCombatStatsResponseBody({
      maximumHp: baseStats.maximumHp,
      attack: baseStats.attack,
      defense: baseStats.defense,
      criticalRate: baseStats.criticalRate,
      actionSpeed: baseStats.actionSpeed,
      criticalDamageBonus: baseStats.criticalDamageBonus,
      affinityBonus: baseStats.affinityBonus,
    }),
  };
}
