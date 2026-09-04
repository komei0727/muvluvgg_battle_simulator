import { useId, useMemo, useState } from "react";
import { projectSkillTimeline } from "./skill-timeline-projector.js";
import type {
  SkillActivationInstance,
  SkillActivationOutcome,
} from "./skill-timeline-projector.js";
import { EventCausalityTree } from "../details/EventCausalityTree.js";
import { resolveDisplayName } from "../details/event-presentation.js";
import type { RosterIndex } from "../details/event-presentation.js";
import type { BattleLogEventResponse } from "../../shared/api/api-contract.js";
import styles from "./SkillTimelineSection.module.css";

export interface SkillTimelineSectionProps {
  readonly events: readonly BattleLogEventResponse[];
  readonly roster: RosterIndex;
}

/** `effect-trace/EffectTraceSection.tsx`の`MEMORY_ORIGIN_SUFFIX`と表記を揃える。 */
const MEMORY_ORIGIN_SUFFIX = "陣営（メモリー）";

const OUTCOME_LABELS: Readonly<Record<SkillActivationOutcome, string>> = {
  COMPLETED: "完了",
  INTERRUPTED: "中断",
  IN_PROGRESS: "解決中",
};

const UNIT_SELECTION_HINT = "ログに現れたユニットから表示対象を選ぶ。";
const SKILL_SELECTION_HINT = "ログに現れたスキルから表示対象を選ぶ。";

function unitKeyOf(instance: SkillActivationInstance): string {
  return instance.actorUnitId ?? `side-${instance.actorSide ?? ""}`;
}

function actorLabelOf(instance: SkillActivationInstance, roster: RosterIndex): string {
  if (instance.actorUnitId !== undefined) {
    return resolveDisplayName(roster, instance.actorUnitId);
  }
  return instance.actorSide !== undefined ? `${instance.actorSide}${MEMORY_ORIGIN_SUFFIX}` : "-";
}

interface UnitOption {
  readonly key: string;
  readonly label: string;
}

function unitOptionsOf(
  actorUnitIds: readonly string[],
  actorSides: readonly string[],
  roster: RosterIndex,
): readonly UnitOption[] {
  return [
    ...actorUnitIds.map((id) => ({ key: id, label: resolveDisplayName(roster, id) })),
    ...actorSides.map((side) => ({ key: `side-${side}`, label: `${side}${MEMORY_ORIGIN_SUFFIX}` })),
  ];
}

// docs/ui-design/01_UI要求・画面設計.md §8.8（`UI-AC-053`）/ 04_コンポーネント・状態管理設計.md
// `UI-CMP-036`: スキル発動（AS・PS・EX・チャージ解決・Memory発動）の発生順を一覧し、ユニット・
// スキルの2系統フィルタ（AND条件）で絞り込む。行を展開すると、そのスキル解決に属する
// イベント集合だけを渡した既存の`EventCausalityTree`（`UI-CMP-006`）をそのまま埋め込み、
// 因果ツリー表示のロジックを複製しない。
export function SkillTimelineSection({ events, roster }: SkillTimelineSectionProps) {
  const headingId = useId();
  const unitHintId = useId();
  const skillHintId = useId();

  const timeline = useMemo(() => projectSkillTimeline(events), [events]);
  const unitOptions = useMemo(
    () => unitOptionsOf(timeline.actorUnitIds, timeline.actorSides, roster),
    [timeline, roster],
  );

  const [selectedUnitKeys, setSelectedUnitKeys] = useState<ReadonlySet<string>>(
    () => new Set(unitOptions.map((option) => option.key)),
  );
  const [selectedSkillDefinitionIds, setSelectedSkillDefinitionIds] = useState<ReadonlySet<string>>(
    () => new Set(timeline.skillDefinitionIds),
  );
  const [expandedSkillUseIds, setExpandedSkillUseIds] = useState<ReadonlySet<string>>(new Set());

  const visible = timeline.instances.filter(
    (instance) =>
      selectedUnitKeys.has(unitKeyOf(instance)) &&
      selectedSkillDefinitionIds.has(instance.skillDefinitionId),
  );

  function toggleUnit(key: string) {
    setSelectedUnitKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function toggleSkill(skillDefinitionId: string) {
    setSelectedSkillDefinitionIds((current) => {
      const next = new Set(current);
      if (next.has(skillDefinitionId)) {
        next.delete(skillDefinitionId);
      } else {
        next.add(skillDefinitionId);
      }
      return next;
    });
  }

  function toggleExpanded(skillUseId: string) {
    setExpandedSkillUseIds((current) => {
      const next = new Set(current);
      if (next.has(skillUseId)) {
        next.delete(skillUseId);
      } else {
        next.add(skillUseId);
      }
      return next;
    });
  }

  return (
    <section className={styles["section"]} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles["header"]}>
        SKILL TIMELINE / スキル時系列
      </h3>
      {timeline.instances.length === 0 ? (
        <p className={styles["empty"]}>スキルの発動は記録されていません。</p>
      ) : (
        <>
          <fieldset className={styles["selection"]} aria-describedby={unitHintId}>
            <legend className={styles["legendLabel"]}>ユニット</legend>
            <p id={unitHintId} className={styles["hint"]}>
              {UNIT_SELECTION_HINT}
            </p>
            <ul className={styles["selectionList"]}>
              {unitOptions.map((option) => (
                <li key={option.key}>
                  <label className={styles["selectionItem"]}>
                    <input
                      type="checkbox"
                      checked={selectedUnitKeys.has(option.key)}
                      onChange={() => {
                        toggleUnit(option.key);
                      }}
                    />
                    <span>{option.label}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <fieldset className={styles["selection"]} aria-describedby={skillHintId}>
            <legend className={styles["legendLabel"]}>スキル</legend>
            <p id={skillHintId} className={styles["hint"]}>
              {SKILL_SELECTION_HINT}
            </p>
            <ul className={styles["selectionList"]}>
              {timeline.skillDefinitionIds.map((skillDefinitionId) => (
                <li key={skillDefinitionId}>
                  <label className={styles["selectionItem"]}>
                    <input
                      type="checkbox"
                      checked={selectedSkillDefinitionIds.has(skillDefinitionId)}
                      onChange={() => {
                        toggleSkill(skillDefinitionId);
                      }}
                    />
                    <span className={styles["mono"]}>{skillDefinitionId}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          {visible.length === 0 ? (
            <p className={styles["empty"]}>選択したユニット・スキルの発動はありません。</p>
          ) : (
            <div className={styles["scrollArea"]}>
              <ol className={styles["list"]}>
                {visible.map((instance) => {
                  const expanded = expandedSkillUseIds.has(instance.skillUseId);
                  return (
                    <li key={instance.skillUseId}>
                      <button
                        type="button"
                        className={styles["row"]}
                        aria-expanded={expanded}
                        onClick={() => {
                          toggleExpanded(instance.skillUseId);
                        }}
                      >
                        <span className={styles["sequence"]}>
                          #{String(instance.startSequence).padStart(3, "0")}
                        </span>
                        <span>T{instance.turnNumber}</span>
                        <span className={styles["skill"]}>{instance.skillDefinitionId}</span>
                        <span>{actorLabelOf(instance, roster)}</span>
                        <span className={styles["outcome"]}>
                          {OUTCOME_LABELS[instance.outcome]}
                        </span>
                      </button>
                      {expanded ? (
                        <div className={styles["expanded"]}>
                          <p className={styles["expandedLabel"]}>
                            因果ツリー #{instance.startSequence}
                          </p>
                          <EventCausalityTree events={instance.events} roster={roster} />
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
        </>
      )}
    </section>
  );
}
