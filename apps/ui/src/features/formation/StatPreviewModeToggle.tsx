import { useId } from "react";
import styles from "./StatPreviewModeToggle.module.css";

export interface StatPreviewModeToggleProps {
  readonly showBaseStats: boolean;
  readonly onChange: (showBaseStats: boolean) => void;
}

/**
 * UI-AC-034（01_UI要求・画面設計.md §5.8）: 枠hover／focusで出すステータスを、
 * 補正込みと補正前で切り替える。
 *
 * 両陣営・全枠で1つの切替を共有するため、`FormationEditor`（陣営ごとに描画される）
 * ではなく編成レイアウトの外側へ置く。プレビューのpopover内にも置かない ——
 * `UnitStatPreview`は`pointer-events: none`で、枠から離れると閉じるためである。
 */
export function StatPreviewModeToggle({ showBaseStats, onChange }: StatPreviewModeToggleProps) {
  const toggleId = useId();

  return (
    <div className={styles["bar"]}>
      <label className={styles["toggle"]} htmlFor={toggleId}>
        <input
          id={toggleId}
          type="checkbox"
          checked={showBaseStats}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
        補正前のステータスを表示
      </label>
      <p className={styles["hint"]}>
        枠にカーソルを合わせたときの表示を、編成ボーナス・配置適性の補正前の値に切り替えます。
      </p>
    </div>
  );
}
