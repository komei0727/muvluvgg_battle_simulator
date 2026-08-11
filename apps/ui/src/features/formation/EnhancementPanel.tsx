import { useId } from "react";
import type { UiViolation } from "./draft-validation.js";
import { ENHANCEMENT_ATTRIBUTES, ENHANCEMENT_UNIT_TYPES } from "./types.js";
import type {
  EnhancementAttribute,
  EnhancementUnitType,
  Side,
  SideEnhancementInput,
} from "./types.js";
import styles from "./EnhancementPanel.module.css";

export interface EnhancementPanelProps {
  readonly side: Side;
  readonly enhancement: SideEnhancementInput;
  readonly violations: readonly UiViolation[];
  readonly disabled: boolean;
  readonly onToggle: (enabled: boolean) => void;
  readonly onAcademyLevelChange: (
    group: "unitTypes" | "attributes",
    key: string,
    value: number | "",
  ) => void;
}

const UNIT_TYPE_LABELS: Readonly<Record<EnhancementUnitType, string>> = {
  PHYSICAL: "物理",
  ENERGY: "EN",
  AGILE: "敏捷",
};

const ATTRIBUTE_LABELS: Readonly<Record<EnhancementAttribute, string>> = {
  AGGRESSIVE: "アグレッシブ",
  SHY: "シャイ",
  CUTE: "キュート",
  SMART: "スマート",
  COMICAL: "コミカル",
  CLEVER: "クレバー",
};

function messagesForPath(violations: readonly UiViolation[], path: string): readonly string[] {
  return Array.from(
    new Set(
      violations
        .filter((violation) => violation.path === path && violation.severity === "error")
        .map((violation) => violation.message),
    ),
  );
}

interface AcademyLevelFieldProps {
  readonly label: string;
  readonly path: string;
  readonly value: number | "";
  readonly disabled: boolean;
  readonly violations: readonly UiViolation[];
  readonly onChange: (value: number | "") => void;
}

// ExecutionParameterForm と同じ入力・違反表示パターン（UI-CMP-014）。
function AcademyLevelField({
  label,
  path,
  value,
  disabled,
  violations,
  onChange,
}: AcademyLevelFieldProps) {
  const inputId = useId();
  const errorId = useId();
  const messages = messagesForPath(violations, path);

  return (
    <div className={styles["field"]}>
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        type="number"
        min={1}
        value={value}
        disabled={disabled}
        aria-invalid={messages.length > 0}
        aria-describedby={messages.length > 0 ? errorId : undefined}
        onChange={(event) => {
          const raw = event.target.value;
          onChange(raw === "" ? "" : Number(raw));
        }}
      />
      {messages.length > 0 ? (
        <p id={errorId} className={styles["fieldError"]}>
          {messages.join(" ")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * docs/ui-design/01_UI要求・画面設計.md §5.6: 陣営フッターの強化トグルと
 * 学園レベル9入力。UI-AC-023: トグルOFFが既定で、OFFの陣営は`enhancement`を
 * リクエストへ含めない（判定は request-mapper.ts が持ち、ここは入力だけを扱う）。
 * トグルOFFでも入力値は破棄せず、無効化して表示し続ける（UI-CMP-014）。
 */
export function EnhancementPanel({
  side,
  enhancement,
  violations,
  disabled,
  onToggle,
  onAcademyLevelChange,
}: EnhancementPanelProps) {
  const toggleId = useId();
  const headingId = useId();
  const formationPath = side === "ally" ? "/allyFormation" : "/enemyFormation";
  const inputsDisabled = disabled || !enhancement.enabled;
  const sideLabelEn = side === "ally" ? "ALLY" : "ENEMY";

  return (
    <section className={styles["panel"]} aria-labelledby={headingId}>
      <div className={styles["heading"]}>
        <p id={headingId} className={styles["subheading"]}>
          {sideLabelEn} ENHANCEMENT / 学園レベル
        </p>
        <label className={styles["toggle"]} htmlFor={toggleId}>
          <input
            id={toggleId}
            type="checkbox"
            checked={enhancement.enabled}
            disabled={disabled}
            onChange={(event) => {
              onToggle(event.target.checked);
            }}
          />
          強化を有効にする
        </label>
      </div>

      {enhancement.enabled ? null : (
        <p className={styles["hint"]}>
          強化をONにすると、ユニットごとのレベル・ギアを編集できます。
        </p>
      )}

      <div className={styles["levels"]}>
        {ENHANCEMENT_UNIT_TYPES.map((unitType) => (
          <AcademyLevelField
            key={unitType}
            label={UNIT_TYPE_LABELS[unitType]}
            path={`${formationPath}/enhancement/academyLevels/unitTypes/${unitType}`}
            value={enhancement.academyLevels.unitTypes[unitType]}
            disabled={inputsDisabled}
            violations={violations}
            onChange={(value) => {
              onAcademyLevelChange("unitTypes", unitType, value);
            }}
          />
        ))}
        {ENHANCEMENT_ATTRIBUTES.map((attribute) => (
          <AcademyLevelField
            key={attribute}
            label={ATTRIBUTE_LABELS[attribute]}
            path={`${formationPath}/enhancement/academyLevels/attributes/${attribute}`}
            value={enhancement.academyLevels.attributes[attribute]}
            disabled={inputsDisabled}
            violations={violations}
            onChange={(value) => {
              onAcademyLevelChange("attributes", attribute, value);
            }}
          />
        ))}
      </div>
    </section>
  );
}
