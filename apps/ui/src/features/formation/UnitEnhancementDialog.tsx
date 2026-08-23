import { useId, useState } from "react";
import { Dialog } from "../../components/Dialog.js";
import type { UiViolation } from "./draft-validation.js";
import {
  GEAR_GRADES,
  GEAR_STAT_LABELS,
  GEAR_STATS,
  GEAR_TIERS,
  MAX_GEARS_PER_STAT,
  gearStatCounts,
} from "./types.js";
import { isLevelLinked } from "./level-link.js";
import type {
  GearGrade,
  GearInput,
  GearStat,
  GearTier,
  SideEnhancementInput,
  UnitEnhancementInput,
} from "./types.js";
import type { CatalogGearEffect } from "../../shared/api/api-contract.js";
import styles from "./UnitEnhancementDialog.module.css";

export interface UnitEnhancementDialogProps {
  readonly unitDisplayName: string;
  readonly slotKey: string;
  readonly enhancement: UnitEnhancementInput;
  readonly violations: readonly UiViolation[];
  /**
   * Catalog応答が公開するギア効果表（R-ENH-04 #3）。UIは表を持たず、届いた値を
   * 表示するだけにする——効果表の正本はAPI側にあり、二重管理は静かにずれるため。
   * 公開しない旧APIと組み合わせたときはランク名だけの表示へフォールバックする。
   */
  readonly gearEffects?: readonly CatalogGearEffect[];
  /**
   * UI-AC-037: この枠が属する陣営の強化入力。リンク中はレベルを編集させない。
   * `levelLink`だけを受け取って`enabled: true`を決め打ちすると、「ダイアログは
   * トグルONのときしか開かない」という前提が呼び出し側と離れた場所に埋まる。
   */
  readonly sideEnhancement: SideEnhancementInput;
  readonly onLevelChange: (value: number | "") => void;
  readonly onGearChange: (gearIndex: number, gear?: GearInput) => void;
  readonly onLinkExclusionChange: (excluded: boolean) => void;
  readonly onClose: () => void;
}

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
  severity: UiViolation["severity"],
): readonly string[] {
  return Array.from(
    new Set(
      violations
        .filter(
          (violation) =>
            violation.slotKey === slotKey &&
            violation.severity === severity &&
            violation.gearIndex === gearIndex,
        )
        .map((violation) => violation.message),
    ),
  );
}

/**
 * R-ENH-06: 割合補正（HP・攻撃力・防御力・行動速度）とポイント加算（会心率・
 * 会心ダメージ・属性相性）は同じ数値でも意味が違うため、単位で区別する。
 * 種別は応答の`application`をそのまま使い、UI側で分類を持たない。
 */
const GEAR_APPLICATION_UNITS: Readonly<Record<string, string>> = {
  RATIO: "%",
  POINT: "%pt",
};

/** 表の値をそのまま出す（丸めない）。`0.75` → `+0.75%`、`1〜3.33` → `+1〜3.33%`。 */
function formatIncrease(points: readonly number[], application: string): string | undefined {
  const unit = GEAR_APPLICATION_UNITS[application];
  if (unit === undefined || points.length === 0) {
    return undefined;
  }
  const minimum = Math.min(...points);
  const maximum = Math.max(...points);
  const value = minimum === maximum ? String(minimum) : `${String(minimum)}〜${String(maximum)}`;
  return `+${value}${unit}`;
}

/**
 * 選択済みのstatに対応する行だけを引く。tier・gradeの片方が未選択の間は、
 * もう一方の軸を跨いだ範囲を示す——組み合わせが確定していない段階でも
 * 「どのランクがどれだけ上がるのか」を読み取れるようにするため。
 */
function gearOptionLabels(
  effect: CatalogGearEffect | undefined,
  axis: "tier" | "grade",
  fixed: string | undefined,
): Readonly<Record<string, string | undefined>> {
  if (effect === undefined) {
    return {};
  }
  const other = axis === "tier" ? "grade" : "tier";
  const byKey = new Map<string, number[]>();
  for (const value of effect.values) {
    if (fixed !== undefined && value[other] !== fixed) {
      continue;
    }
    const key = value[axis];
    byKey.set(key, [...(byKey.get(key) ?? []), value.percentagePoints]);
  }
  return Object.fromEntries(
    [...byKey].map(([key, points]) => [key, formatIncrease(points, effect.application)]),
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
  /** エラー・警告など、この枠の3つのselectへ結びつける説明のid列。 */
  readonly describedBy: string | undefined;
  /** このユニットが確定済みギアで使っているステータス別の枚数（この枠の分も含む）。 */
  readonly statCounts: ReadonlyMap<GearStat, number>;
  readonly gearEffects: readonly CatalogGearEffect[] | undefined;
  readonly onChange: (gear?: GearInput) => void;
}

/**
 * UI-AC-025: 空枠を許容するため、stat・tier・gradeが揃ったときだけギアとして
 * 確定させる。途中の選択は枠を空のまま扱い、リクエストへ出さない。
 */
function GearSlotFields({
  gearIndex,
  gear,
  invalid,
  describedBy,
  statCounts,
  gearEffects,
  onChange,
}: GearSlotFieldsProps) {
  const statId = useId();
  const tierId = useId();
  const gradeId = useId();
  const statExhaustedId = useId();
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

  const effect = gearEffects?.find((candidate) => candidate.stat === selection.stat);
  const tierLabels = gearOptionLabels(effect, "tier", selection.grade);
  const gradeLabels = gearOptionLabels(effect, "grade", selection.tier);
  // 同一ステータス3枚の上限（`MAX_GEARS_PER_STAT`）に達したステータスは選べない。
  // この枠が既に持っているステータスだけは残す — 外すと、同じ値のまま種別・ランクを
  // 変えられなくなる（`statCounts`はこの枠自身の1枚も数えているため、上限ちょうどの
  // ときに自分の値が消える）。
  const selectableStats = GEAR_STATS.filter(
    (stat) => (statCounts.get(stat) ?? 0) < MAX_GEARS_PER_STAT || stat === selection.stat,
  );
  const statExhausted = selectableStats.length === 0;

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
            aria-describedby={
              [describedBy, statExhausted ? statExhaustedId : undefined]
                .filter((id): id is string => id !== undefined)
                .join(" ") || undefined
            }
            onChange={(event) => {
              const raw = event.target.value;
              emit({ stat: raw === "" ? undefined : (raw as GearStat) });
            }}
          >
            <option value="">未設定</option>
            {selectableStats.map((stat) => (
              <option key={stat} value={stat}>
                {GEAR_STAT_LABELS[stat]}
              </option>
            ))}
          </select>
          {/*
            選べるステータスが1つも無い枠でも入力欄は消さない。消すと枠数が画面上で
            変わり、どのギア枠の話なのかが追えなくなる（空枠のまま理由を示す）。
          */}
          {statExhausted ? (
            <p id={statExhaustedId} className={styles["hint"]}>
              選べるステータスがありません
            </p>
          ) : null}
        </div>
        <div className={styles["field"]}>
          <label htmlFor={tierId}>ギア{slotNumber} の種別</label>
          <select
            id={tierId}
            value={selection.tier ?? ""}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            onChange={(event) => {
              const raw = event.target.value;
              emit(raw === "" ? { tier: undefined } : { tier: raw as GearTier });
            }}
          >
            <option value="">未設定</option>
            {GEAR_TIERS.map((tier) => (
              <option key={tier} value={tier}>
                ギア{tier}
                {tierLabels[tier] === undefined ? "" : `（${tierLabels[tier]}）`}
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
            aria-describedby={describedBy}
            onChange={(event) => {
              const raw = event.target.value;
              emit(raw === "" ? { grade: undefined } : { grade: raw as GearGrade });
            }}
          >
            <option value="">未設定</option>
            {GEAR_GRADES.map((grade) => (
              <option key={grade} value={grade}>
                {grade}
                {gradeLabels[grade] === undefined ? "" : `（${gradeLabels[grade]}）`}
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
  gearEffects,
  sideEnhancement,
  onLevelChange,
  onGearChange,
  onLinkExclusionChange,
  onClose,
}: UnitEnhancementDialogProps) {
  const titleId = useId();
  const levelId = useId();
  const levelErrorId = useId();
  const levelHintId = useId();
  const levelWayOutId = useId();
  const linkExclusionId = useId();
  const gearErrorIdPrefix = useId();
  const levelErrors = levelMessages(violations, slotKey);
  // 上限（`MAX_GEARS_PER_STAT`）の判定はユニット単位のため、9枠を1度だけ数えて配る。
  const statCounts = gearStatCounts(enhancement.gears);
  const { levelLink } = sideEnhancement;
  const linked = isLevelLinked(enhancement, sideEnhancement);
  // UI-AC-039: 逃げ道の文言も入力へ結びつける。`readOnly`を選んだ理由（focusできる
  // ままにして説明を読み上げへ残す）は、エラー文だけでなく解決手段にも同じく効く。
  const showsWayOut = linked && levelErrors.length > 0;
  const describedBy = [
    levelErrors.length > 0 ? levelErrorId : undefined,
    linked ? levelHintId : undefined,
    showsWayOut ? levelWayOutId : undefined,
  ].filter((id): id is string => id !== undefined);

  return (
    <Dialog titleId={titleId} title={`${unitDisplayName}の強化`} onClose={onClose}>
      <div className={styles["content"]}>
        <div className={styles["field"]}>
          <label htmlFor={levelId}>現在レベル</label>
          <input
            id={levelId}
            type="number"
            min={1}
            // 参照時解決（`level-link.ts`）。リンク中は枠の値を保持したまま、
            // 実際に送るリンクレベルを見せる。
            value={linked ? levelLink.level : enhancement.level}
            // `disabled`にはしない——focusできなくなると、この入力へ結びつけた
            // サーバー違反の説明が読み上げから外れる（UI-AC-039）。
            readOnly={linked}
            aria-invalid={levelErrors.length > 0}
            aria-describedby={describedBy.length > 0 ? describedBy.join(" ") : undefined}
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
          {linked ? (
            <p id={levelHintId} className={styles["hint"]}>
              レベルリンク中（Lv{levelLink.level === "" ? "—" : levelLink.level}
              ）。個別に変えるには「レベルリンクから外す」を選んでください。
            </p>
          ) : null}
          {/*
            UI-AC-039: 成長値（levelGrowth）を持たないユニットへ200以外を指定すると
            APIが422で拒否する（R-ENH-05 #5）。UIは事前検証しない方針なので、
            解決手段が機能内にあること（外して200へ戻す）をここで示す。
          */}
          {showsWayOut ? (
            <p id={levelWayOutId} className={styles["hint"]}>
              成長値を持たないユニットはレベル200だけを受け付けます。「レベルリンクから外す」を選び、レベルを200に戻してください。
            </p>
          ) : null}
        </div>

        {levelLink.enabled ? (
          <label className={styles["linkExclusion"]} htmlFor={linkExclusionId}>
            <input
              id={linkExclusionId}
              type="checkbox"
              checked={enhancement.linkExcluded}
              onChange={(event) => {
                onLinkExclusionChange(event.target.checked);
              }}
            />
            レベルリンクから外す
          </label>
        ) : null}

        {gearEffects === undefined ? null : (
          <p className={styles["gearNotation"]}>
            %は基本値への割合補正、%ptは値そのものへの加算です。
          </p>
        )}

        <div className={styles["gears"]}>
          {enhancement.gears.map((gear, gearIndex) => {
            const messages = gearMessages(violations, slotKey, gearIndex, "error");
            const warnings = gearMessages(violations, slotKey, gearIndex, "warning");
            const errorId = `${gearErrorIdPrefix}-${String(gearIndex)}`;
            const warningId = `${gearErrorIdPrefix}-warning-${String(gearIndex)}`;
            const describedBy = [
              messages.length > 0 ? errorId : undefined,
              warnings.length > 0 ? warningId : undefined,
            ].filter((id): id is string => id !== undefined);
            return (
              <div key={gearIndex}>
                <GearSlotFields
                  gearIndex={gearIndex}
                  gear={gear}
                  invalid={messages.length > 0}
                  describedBy={describedBy.length > 0 ? describedBy.join(" ") : undefined}
                  statCounts={statCounts}
                  gearEffects={gearEffects}
                  onChange={(next) => {
                    onGearChange(gearIndex, next);
                  }}
                />
                {messages.length > 0 ? (
                  <p id={errorId} className={styles["fieldError"]}>
                    {messages.join(" ")}
                  </p>
                ) : null}
                {/*
                  同一ステータス3枚の上限超過（`GEAR_STAT_COUNT_OVER_LIMIT`）はこの段では
                  送信を止めない警告のため、`aria-invalid`は立てない。既存の保存データが
                  上限を超えていても実行できる必要がある（APIはまだ受理する）。
                */}
                {warnings.length > 0 ? (
                  <p id={warningId} className={styles["fieldWarning"]}>
                    {warnings.join(" ")}
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
