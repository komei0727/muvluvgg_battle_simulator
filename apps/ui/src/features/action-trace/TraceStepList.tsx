import { stringOf } from "../../lib/unknown-narrowing.js";
import { resolveDisplayName, type RosterIndex } from "../details/event-presentation.js";
import { sideLabelOf } from "./trace-segment-label.js";
import type {
  HitApplication,
  HitCalculation,
  TraceStep,
  TraceStepKind,
} from "./trace-step-projector.js";
import styles from "./TraceStepList.module.css";

// 01_UI要求・画面設計.md §8.10「処理の一覧」/ 04_コンポーネント・状態管理設計.md §3
// 「TraceStepList」。区間の処理ステップを1行ずつ出し、割り込みの深さで字下げする。ヒットの
// 計算過程・内訳と回復量は投影が読んだ値を出すだけで、再計算しない。

export interface TraceStepListProps {
  readonly steps: readonly TraceStep[];
  /** 処理単位のときの現在のステップ。行動・ターン単位では持たない。 */
  readonly currentStepIndex?: number;
  readonly roster: RosterIndex;
  readonly onSelect: (stepIndex: number) => void;
}

const KIND_ICON: Readonly<Record<TraceStepKind, string>> = {
  ACTION_STARTED: "▶",
  SKILL_USE: "SK",
  TARGETS_SELECTED: "◎",
  ACTIVATION: "PS",
  HIT: "DMG",
  SPECIAL_DAMAGE: "DMG",
  HEAL: "HP",
  EFFECT: "FX",
  CHARGE: "CH",
  DEFEAT: "KO",
  ACTION_COMPLETED: "■",
  SYSTEM: "SYS",
  OTHER: "…",
};

const KIND_CLASS: Readonly<Partial<Record<TraceStepKind, string | undefined>>> = {
  ACTIVATION: styles.iconPassive,
  HIT: styles.iconDamage,
  SPECIAL_DAMAGE: styles.iconDamage,
  HEAL: styles.iconHeal,
  EFFECT: styles.iconEffect,
  DEFEAT: styles.iconDamage,
};

/** R-DMG-01の乗算順（03_API・データ連携設計.md §12.1.1と同じ並び）。 */
const CALCULATION_TERMS: readonly { readonly key: keyof HitCalculation; readonly label: string }[] =
  [
    { key: "attackerAttack", label: "攻撃力" },
    { key: "effectiveDefense", label: "実効防御" },
    { key: "baseDamage", label: "基礎ダメージ" },
    { key: "skillPower", label: "スキル威力" },
    { key: "attributeMultiplier", label: "属性倍率" },
    { key: "criticalMultiplier", label: "会心倍率" },
    { key: "outgoingDamageMultiplier", label: "与ダメージ倍率" },
    { key: "incomingDamageMultiplier", label: "被ダメージ倍率" },
    { key: "actionDamageMultiplier", label: "Action内追加倍率" },
    { key: "confusionDamageMultiplier", label: "混乱倍率" },
    { key: "freezeMultiplier", label: "凍結増幅" },
    { key: "guardRate", label: "肩代わり軽減" },
    { key: "thresholdReductionMultiplier", label: "閾値軽減倍率" },
    { key: "finalDamage", label: "計算ダメージ" },
  ];

const NUMBER_FORMAT = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 4 });

function formatNumber(value: number): string {
  return NUMBER_FORMAT.format(value);
}

function sequenceText(step: TraceStep): string {
  return step.firstSequence === step.lastSequence
    ? `#${step.firstSequence.toString()}`
    : `#${step.firstSequence.toString()}–#${step.lastSequence.toString()}`;
}

/** 起点の発動者。メモリー発動は行動者を求められない（R-MEM-04）ため陣営で出す。 */
function actorOf(step: TraceStep, roster: RosterIndex): string | undefined {
  const origin = step.originEvents[0];
  if (origin?.type === "MEMORY_TRIGGERED") {
    return `メモリー（${sideLabelOf(stringOf(origin["sourceSide"]))}）`;
  }
  if (step.kind === "ACTIVATION" && step.sourceUnitId !== undefined) {
    return resolveDisplayName(roster, step.sourceUnitId);
  }
  return undefined;
}

function applicationTerms(application: HitApplication): readonly string[] {
  const terms: string[] = [];
  if (
    application.typedShieldAbsorbed !== undefined ||
    application.untypedShieldAbsorbed !== undefined
  ) {
    const shield =
      (application.typedShieldAbsorbed ?? 0) + (application.untypedShieldAbsorbed ?? 0);
    terms.push(`シールド吸収 ${formatNumber(shield)}`);
  }
  if (application.subUnitAbsorbed !== undefined) {
    terms.push(`サブユニット吸収 ${formatNumber(application.subUnitAbsorbed)}`);
  }
  if (application.hitPointDamage !== undefined) {
    terms.push(`HPダメージ ${formatNumber(application.hitPointDamage)}`);
  }
  if (application.defeated === true) {
    terms.push("撃破");
  }
  return terms;
}

function HitDetail({ step }: { readonly step: TraceStep }) {
  const hit = step.hit;
  if (hit === undefined) {
    return null;
  }
  const calculation = hit.calculation;
  const terms =
    calculation === undefined
      ? []
      : CALCULATION_TERMS.flatMap(({ key, label }) => {
          const value = calculation[key];
          return typeof value === "number" ? [{ label, value }] : [];
        });
  const application = hit.application !== undefined ? applicationTerms(hit.application) : [];
  return (
    <>
      {terms.length > 0 ? (
        <ul className={styles.calculation} aria-label="計算過程">
          {terms.map((term) => (
            <li key={term.label} className={styles.term}>
              <small>{term.label}</small>
              {formatNumber(term.value)}
            </li>
          ))}
        </ul>
      ) : null}
      {hit.critical === true ? <span className={styles.critical}>会心</span> : null}
      {application.length > 0 ? (
        <ul className={styles.breakdown} aria-label="内訳">
          {application.map((term) => (
            <li key={term}>{term}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function HealDetail({ step, roster }: { readonly step: TraceStep; readonly roster: RosterIndex }) {
  if (step.heals === undefined) {
    return null;
  }
  return (
    <ul className={styles.breakdown} aria-label="回復量">
      {step.heals.map((heal, position) => (
        <li key={position} className={styles.heal}>
          {heal.targetUnitId !== undefined
            ? `${resolveDisplayName(roster, heal.targetUnitId)} `
            : ""}
          +{formatNumber(heal.appliedAmount)}
        </li>
      ))}
    </ul>
  );
}

export function TraceStepList({ steps, currentStepIndex, roster, onSelect }: TraceStepListProps) {
  return (
    <ol className={styles.list} aria-label="処理の一覧">
      {steps.map((step) => {
        const stepMode = currentStepIndex !== undefined;
        const current = stepMode && step.index === currentStepIndex;
        const upcoming = stepMode && step.index > currentStepIndex;
        const depth = Math.min(step.interruptDepth, 3);
        const presentation = step.presentations[0];
        const actor = actorOf(step, roster);
        const others = step.otherEvents.map((event) => event.type);
        return (
          <li
            key={step.index}
            className={[
              styles.step,
              depth > 0 ? styles[`depth${depth.toString()}`] : undefined,
              current ? styles.current : undefined,
              upcoming ? styles.upcoming : undefined,
            ]
              .filter((name) => name !== undefined)
              .join(" ")}
            aria-current={current ? "step" : undefined}
          >
            <button
              type="button"
              className={styles.row}
              onClick={() => {
                onSelect(step.index);
              }}
            >
              <span
                className={[styles.icon, KIND_CLASS[step.kind]]
                  .filter((name) => name !== undefined)
                  .join(" ")}
                aria-hidden="true"
              >
                {KIND_ICON[step.kind]}
              </span>
              <span className={styles.main}>
                <span className={styles.title}>
                  {step.interruptDepth > 0 ? (
                    <span className={styles.interrupt}>割り込み</span>
                  ) : null}
                  {actor !== undefined ? <span className={styles.actor}>{actor}</span> : null}
                  <span className={styles.type}>{presentation?.title ?? step.kind}</span>
                </span>
                {step.presentations.map((item, position) => (
                  <span key={position} className={styles.summary}>
                    {item.summary}
                  </span>
                ))}
                <HitDetail step={step} />
                <HealDetail step={step} roster={roster} />
                {others.length > 0 ? (
                  <span className={styles.others}>その他: {others.join(", ")}</span>
                ) : null}
              </span>
              <span className={styles.sequence}>{sequenceText(step)}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
