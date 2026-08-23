import type { FormationStatPreviewUnit } from "../../shared/api/api-contract.js";
import styles from "./UnitStatPreview.module.css";

export interface UnitStatPreviewProps {
  readonly id: string;
  readonly status: "unavailable" | "loading" | "failed" | "ready";
  readonly unit?: FormationStatPreviewUnit;
  /**
   * UI-AC-034: 編成ボーナス・配置適性の補正を**適用する前**の値を表示する。
   * 全枠で一括切替するため、状態は枠ではなくページが持つ。
   */
  readonly showBase?: boolean;
}

// docs/ui-design/01_UI要求・画面設計.md §5.8: 表示項目と単位。割合値は
// パーセントポイントで返るためそのまま`%`を付ける。
const RATIO_STATS = new Set(["criticalRate", "criticalDamageBonus", "affinityBonus"]);
const STAT_LABELS: readonly (readonly [keyof FormationStatPreviewUnit["combatStats"], string])[] = [
  ["attack", "攻撃力"],
  ["defense", "防御力"],
  ["actionSpeed", "行動速度"],
  ["criticalRate", "会心率"],
  ["criticalDamageBonus", "会心ダメージ"],
  ["affinityBonus", "有利属性"],
];

/**
 * 表示だけの整形。サーバーはR-NUM-01に従い丸めない値を返すため、桁あふれを
 * 避けてここで丸める（丸めた値を計算へ戻さない）。
 */
function formatNumber(value: number): string {
  return value.toLocaleString("ja-JP", { maximumFractionDigits: 1 });
}

function statusMessage(status: UnitStatPreviewProps["status"]): string {
  switch (status) {
    case "loading":
      return "ステータスを取得中…";
    case "failed":
      return "ステータスを取得できませんでした";
    default:
      return "ステータス未取得";
  }
}

/**
 * UI-AC-027: 1枠ぶんの開始時ステータス。値はサーバーの
 * `POST /api/v1/formation-stat-previews` の応答をそのまま表示し、強化・編成
 * ボーナス・配置適性の計算をUIへ持たない。
 *
 * 取得失敗は`role="alert"`にしない ——戦闘実行は妨げられておらず、緊急でない
 * API失敗にalertを使わない（05_非機能・アクセシビリティ設計.md §6）。
 */
export function UnitStatPreview({ id, status, unit, showBase = false }: UnitStatPreviewProps) {
  // 表示する組を先に決める。補正前が選ばれているのに`enhancedBaseStats`が無い場合
  // （本フィールドより前のAPIが応答した場合）は`undefined`のままにして、補正後の値
  // へ黙って落とさない —— 別の意味の数値を同じ見出しの下に出すことになるため。
  const stats = showBase ? unit?.enhancedBaseStats : unit?.combatStats;
  const maximumHp = showBase ? unit?.enhancedBaseStats?.maximumHp : unit?.maximumHp;

  return (
    <div id={id} className={styles["preview"]}>
      <p className={styles["heading"]}>{showBase ? "補正前ステータス" : "開始時ステータス"}</p>
      {showBase ? <p className={styles["note"]}>編成ボーナス・配置適性の補正なし</p> : null}
      {status === "ready" && stats !== undefined && maximumHp !== undefined ? (
        <dl className={styles["list"]}>
          <div className={styles["row"]}>
            <dt className={styles["term"]}>最大HP</dt>
            <dd className={styles["value"]}>{formatNumber(maximumHp)}</dd>
          </div>
          {STAT_LABELS.map(([key, label]) => (
            <div key={key} className={styles["row"]}>
              <dt className={styles["term"]}>{label}</dt>
              <dd className={styles["value"]}>
                {formatNumber(stats[key])}
                {RATIO_STATS.has(key) ? "%" : ""}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className={styles["message"]}>
          {status === "ready" ? "補正前ステータスは取得できませんでした" : statusMessage(status)}
        </p>
      )}
    </div>
  );
}
