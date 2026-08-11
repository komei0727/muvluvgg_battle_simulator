import { useId, useState } from "react";
import { Dialog } from "../../components/Dialog.js";
import type { UiViolation } from "./draft-validation.js";
import { GEAR_GRADES, GEAR_STATS, GEAR_TIERS } from "./types.js";
import type { GearGrade, GearInput, GearStat, GearTier, UnitEnhancementInput } from "./types.js";
import styles from "./UnitEnhancementDialog.module.css";

export interface UnitEnhancementDialogProps {
  readonly unitDisplayName: string;
  readonly slotKey: string;
  readonly enhancement: UnitEnhancementInput;
  readonly violations: readonly UiViolation[];
  readonly onLevelChange: (value: number | "") => void;
  readonly onGearChange: (gearIndex: number, gear?: GearInput) => void;
  readonly onClose: () => void;
}

const GEAR_STAT_LABELS: Readonly<Record<GearStat, string>> = {
  MAXIMUM_HP: "HP",
  ATTACK: "攻撃力",
  DEFENSE: "防御力",
  ACTION_SPEED: "行動速度",
  CRITICAL_RATE: "会心率",
  CRITICAL_DAMAGE_BONUS: "会心ダメージ",
  AFFINITY_BONUS: "属性相性",
};

/**
 * この枠のviolationだけを拾う。クライアント検証のpathは送信DTOのindexを持たない
 * 固定文字列、サーバー違反のpathは`units/{n}/...`のindex付きになるため、
 * slotKeyで枠を絞ったうえでsuffixで照合する（03_API・データ連携設計.md §13）。
 */
function levelMessages(violations: readonly UiViolation[], slotKey: string): readonly string[] {
  return Array.from(
    new Set(
      violations
        .filter(
          (violation) =>
            violation.slotKey === slotKey &&
            violation.severity === "error" &&
            violation.path.endsWith("/enhancement/level"),
        )
        .map((violation) => violation.message),
    ),
  );
}

function gearMessages(
  violations: readonly UiViolation[],
  slotKey: string,
  gearIndex: number,
): readonly string[] {
  return Array.from(
    new Set(
      violations
        .filter(
          (violation) =>
            violation.slotKey === slotKey &&
            violation.severity === "error" &&
            violation.gearIndex === gearIndex,
        )
        .map((violation) => violation.message),
    ),
  );
}

/** 選択途中のギア。3つ揃うまで確定させないため、各項目が未設定になり得る。 */
interface GearSelection {
  readonly stat?: GearStat | undefined;
  readonly tier?: GearTier | undefined;
  readonly grade?: GearGrade | undefined;
}

interface GearSlotFieldsProps {
  readonly gearIndex: number;
  readonly gear: GearInput | undefined;
  readonly invalid: boolean;
  readonly errorId: string | undefined;
  readonly onChange: (gear?: GearInput) => void;
}

/**
 * UI-AC-025: 空枠を許容するため、stat・tier・gradeが揃ったときだけギアとして
 * 確定させる。途中の選択は枠を空のまま扱い、リクエストへ出さない。
 */
function GearSlotFields({ gearIndex, gear, invalid, errorId, onChange }: GearSlotFieldsProps) {
  const statId = useId();
  const tierId = useId();
  const gradeId = useId();
  const slotNumber = gearIndex + 1;
  // 3つ揃うまではギアとして確定できないが、選択途中の値は画面に残す必要が
  // あるため、未確定の組み合わせだけをこのcomponentが持つ。draftへは確定した
  // ギアだけを渡す（request-mapperが空枠として扱えるようにするため）。
  const [selection, setSelection] = useState<GearSelection>(gear ?? {});

  // 「未設定へ戻した」と「触っていない」を区別するため、キーの有無で判定する
  // （`?? selection.tier` だと未設定への変更が直前の値へ戻ってしまう）。
  function emit(next: {
    readonly stat?: GearStat | undefined;
    readonly tier?: GearTier | undefined;
    readonly grade?: GearGrade | undefined;
  }): void {
    const updated: GearSelection = {
      ...selection,
      ...("stat" in next ? { stat: next.stat } : {}),
      ...("tier" in next ? { tier: next.tier } : {}),
      ...("grade" in next ? { grade: next.grade } : {}),
    };
    setSelection(updated);
    const { stat, tier, grade } = updated;
    if (stat === undefined || tier === undefined || grade === undefined) {
      onChange(undefined);
      return;
    }
    onChange({ stat, tier, grade });
  }

  return (
    <div className={styles["gearSlot"]}>
      <p className={styles["gearLabel"]}>ギア{slotNumber}</p>
      <div className={styles["gearFields"]}>
        <div className={styles["field"]}>
          <label htmlFor={statId}>ギア{slotNumber} の対象ステータス</label>
          <select
            id={statId}
            value={selection.stat ?? ""}
            aria-invalid={invalid}
            aria-describedby={errorId}
            onChange={(event) => {
              const raw = event.target.value;
              emit({ stat: raw === "" ? undefined : (raw as GearStat) });
            }}
          >
            <option value="">未設定</option>
            {GEAR_STATS.map((stat) => (
              <option key={stat} value={stat}>
                {GEAR_STAT_LABELS[stat]}
              </option>
            ))}
          </select>
        </div>
        <div className={styles["field"]}>
          <label htmlFor={tierId}>ギア{slotNumber} の種別</label>
          <select
            id={tierId}
            value={selection.tier ?? ""}
            aria-invalid={invalid}
            aria-describedby={errorId}
            onChange={(event) => {
              const raw = event.target.value;
              emit(raw === "" ? { tier: undefined } : { tier: raw as GearTier });
            }}
          >
            <option value="">未設定</option>
            {GEAR_TIERS.map((tier) => (
              <option key={tier} value={tier}>
                ギア{tier}
              </option>
            ))}
          </select>
        </div>
        <div className={styles["field"]}>
          <label htmlFor={gradeId}>ギア{slotNumber} のランク</label>
          <select
            id={gradeId}
            value={selection.grade ?? ""}
            aria-invalid={invalid}
            aria-describedby={errorId}
            onChange={(event) => {
              const raw = event.target.value;
              emit(raw === "" ? { grade: undefined } : { grade: raw as GearGrade });
            }}
          >
            <option value="">未設定</option>
            {GEAR_GRADES.map((grade) => (
              <option key={grade} value={grade}>
                {grade}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

/**
 * docs/ui-design/01_UI要求・画面設計.md §5.7: 選択済みユニット枠から開く
 * ユニット強化ダイアログ。陣営の強化トグルOFF時はそもそも開かない
 * （`formationReducer`が`selectionOpened`を無視し、起動操作も無効化する）。
 * 成長値を持たないユニットへのレベル指定は事前検証せず、サーバーの422を
 * 該当入力へ表示する。
 */
export function UnitEnhancementDialog({
  unitDisplayName,
  slotKey,
  enhancement,
  violations,
  onLevelChange,
  onGearChange,
  onClose,
}: UnitEnhancementDialogProps) {
  const titleId = useId();
  const levelId = useId();
  const levelErrorId = useId();
  const gearErrorIdPrefix = useId();
  const levelErrors = levelMessages(violations, slotKey);

  return (
    <Dialog titleId={titleId} title={`${unitDisplayName}の強化`} onClose={onClose}>
      <div className={styles["content"]}>
        <div className={styles["field"]}>
          <label htmlFor={levelId}>現在レベル</label>
          <input
            id={levelId}
            type="number"
            min={1}
            value={enhancement.level}
            aria-invalid={levelErrors.length > 0}
            aria-describedby={levelErrors.length > 0 ? levelErrorId : undefined}
            onChange={(event) => {
              const raw = event.target.value;
              onLevelChange(raw === "" ? "" : Number(raw));
            }}
          />
          {levelErrors.length > 0 ? (
            <p id={levelErrorId} className={styles["fieldError"]}>
              {levelErrors.join(" ")}
            </p>
          ) : null}
        </div>

        <div className={styles["gears"]}>
          {enhancement.gears.map((gear, gearIndex) => {
            const messages = gearMessages(violations, slotKey, gearIndex);
            const errorId = `${gearErrorIdPrefix}-${String(gearIndex)}`;
            return (
              <div key={gearIndex}>
                <GearSlotFields
                  gearIndex={gearIndex}
                  gear={gear}
                  invalid={messages.length > 0}
                  errorId={messages.length > 0 ? errorId : undefined}
                  onChange={(next) => {
                    onGearChange(gearIndex, next);
                  }}
                />
                {messages.length > 0 ? (
                  <p id={errorId} className={styles["fieldError"]}>
                    {messages.join(" ")}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}
