import type { FormationStatPreviewUnit } from "../simulation/api-contract.js";
import styles from "./UnitStatPreview.module.css";

export interface UnitStatPreviewProps {
  readonly id: string;
  readonly status: "unavailable" | "loading" | "failed" | "ready";
  readonly unit?: FormationStatPreviewUnit;
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
export function UnitStatPreview({ id, status, unit }: UnitStatPreviewProps) {
  return (
    <div id={id} className={styles["preview"]}>
      <p className={styles["heading"]}>開始時ステータス</p>
      {status === "ready" && unit !== undefined ? (
        <dl className={styles["list"]}>
          <div className={styles["row"]}>
            <dt className={styles["term"]}>最大HP</dt>
            <dd className={styles["value"]}>{formatNumber(unit.maximumHp)}</dd>
          </div>
          {STAT_LABELS.map(([key, label]) => (
            <div key={key} className={styles["row"]}>
              <dt className={styles["term"]}>{label}</dt>
              <dd className={styles["value"]}>
                {formatNumber(unit.combatStats[key])}
                {RATIO_STATS.has(key) ? "%" : ""}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className={styles["message"]}>{statusMessage(status)}</p>
      )}
    </div>
  );
}
