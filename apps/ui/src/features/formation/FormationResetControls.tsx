import { Button } from "../../components/Button.js";
import styles from "./FormationResetControls.module.css";

export interface FormationResetControlsProps {
  readonly disabled: boolean;
  readonly onResetDraft: () => void;
  readonly onClearPlayerData: () => void;
}

/**
 * 01_UI要求・画面設計.md §5.9 のリセット2操作。何を消すかの決定は
 * `use-formation-persistence.ts` が持ち、ここは押下intentだけを通知する。
 */
export function FormationResetControls({
  disabled,
  onResetDraft,
  onClearPlayerData,
}: FormationResetControlsProps) {
  return (
    <div className={styles["controls"]}>
      <Button variant="ghost" disabled={disabled} onClick={onResetDraft}>
        編成をクリア
      </Button>
      <Button variant="ghost" disabled={disabled} onClick={onClearPlayerData}>
        保存した育成データをクリア
      </Button>
      <p className={styles["hint"]}>
        入力はこのブラウザに自動保存されます。育成データ（学園レベル・レベル・ギア）は味方のみ記憶します。
      </p>
    </div>
  );
}
