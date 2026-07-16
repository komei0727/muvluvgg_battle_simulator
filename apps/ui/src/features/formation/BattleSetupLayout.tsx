import type { ReactNode } from "react";
import styles from "./BattleSetupLayout.module.css";

export interface BattleSetupLayoutProps {
  readonly ally: ReactNode;
  readonly enemy: ReactNode;
}

// docs/ui-design/05_非機能・アクセシビリティ設計.md §4: >=1041pxは味方・VS・敵
// を横3列、761px以下は縦積みにする(3列編成自体はFormationEditor/UnitSlotの
// grid-template-columnsが維持する)。VSの区切りはdocs/ui-design/
// battle-simulator-mock.htmlの.vs-dividerを移植した装飾要素。
export function BattleSetupLayout({ ally, enemy }: BattleSetupLayoutProps) {
  return (
    <div className={styles["workspace"]}>
      <div>{ally}</div>
      <div className={styles["vsDivider"]} aria-hidden="true">
        <span className={styles["vsLine"]} />
        <span className={styles["vsLabel"]}>VS</span>
        <span className={styles["vsLine"]} />
      </div>
      <div>{enemy}</div>
    </div>
  );
}
