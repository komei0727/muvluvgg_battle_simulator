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

const OUTCOME_LABELS: Readonly<Record<SkillActivationOutcome, string>> = {
  COMPLETED: "完了",
  INTERRUPTED: "中断",
  IN_PROGRESS: "解決中",
};

const UNIT_SELECTION_HINT = "ログに現れたユニットから表示対象を選ぶ。";
const SKILL_SELECTION_HINT = "ログに現れたスキルから表示対象を選ぶ。";

interface UnitOption {
  readonly key: string;
  readonly label: string;
}

function unitOptionsOf(
  actorUnitIds: readonly string[],
  roster: RosterIndex,
): readonly UnitOption[] {
  return actorUnitIds.map((id) => ({ key: id, label: resolveDisplayName(roster, id) }));
}

/**
 * ユニットの絞り込みに連動して「スキル」欄をも絞る（カスケード）。選択中のユニットが
 * 誰も持たないスキルは一覧から消し、その選択状態(`selectedSkillDefinitionIds`)には触れない
 * ——ユニットを再選択したときに以前の選択が復元されるようにするため。
 */
function skillDefinitionIdsOwnedBy(
  instances: readonly SkillActivationInstance[],
  selectedUnitKeys: ReadonlySet<string>,
): readonly string[] {
  const owned = new Set<string>();
  for (const instance of instances) {
    if (selectedUnitKeys.has(instance.actorUnitId)) {
      owned.add(instance.skillDefinitionId);
    }
  }
  return [...owned].sort();
}

// docs/ui-design/01_UI要求・画面設計.md §8.8（`UI-AC-053`）/ 04_コンポーネント・状態管理設計.md
// `UI-CMP-036`: スキル発動（AS・PS・EX・チャージ解決）の発生順を一覧し、ユニット・スキルの
// 2系統フィルタ（AND条件）で絞り込む。ユニットを外すと、そのユニット専有のスキルは
// 「スキル」欄からも消える（カスケード）——2つの欄を無関係な独立フィルタのままにすると、
// 既に非表示のユニットのスキルがチェック可能なまま残り、選んでも何も起きない項目が並んで
// 紛らわしいため。行を展開すると、そのスキル解決に属するイベント集合だけを渡した既存の
// `EventCausalityTree`（`UI-CMP-006`）をそのまま埋め込み、因果ツリー表示のロジックを
// 複製しない。
export function SkillTimelineSection({ events, roster }: SkillTimelineSectionProps) {
  const headingId = useId();
  const unitHintId = useId();
  const skillHintId = useId();

  const timeline = useMemo(() => projectSkillTimeline(events), [events]);
  const unitOptions = useMemo(
    () => unitOptionsOf(timeline.actorUnitIds, roster),
    [timeline, roster],
  );

  const [selectedUnitKeys, setSelectedUnitKeys] = useState<ReadonlySet<string>>(
    () => new Set(timeline.actorUnitIds),
  );
  const [selectedSkillDefinitionIds, setSelectedSkillDefinitionIds] = useState<ReadonlySet<string>>(
    () => new Set(timeline.skillDefinitionIds),
  );
  const [expandedSkillUseIds, setExpandedSkillUseIds] = useState<ReadonlySet<string>>(new Set());

  // 再実行中、`BattleDetailsSection`はこのcomponentをunmountせず`events`だけを差し替える
  // （前回の成功結果を表示し続けたまま）。フィルタ・展開状態が前回の発動群のIDを保持したままだと、
  // 新しい発動群のIDと一致せず全行が「選択したユニット・スキルの発動はありません」になる。
  // `events`が変わった実際のrenderで検出し、次の描画が起きる前に全選択へ戻す
  // （Reactの「レンダー中に前回のpropsと比較してstateを調整する」パターン。key remountより
  // 影響範囲がこのcomponent内に閉じる）。
  const [previousEvents, setPreviousEvents] = useState(events);
  if (events !== previousEvents) {
    setPreviousEvents(events);
    setSelectedUnitKeys(new Set(timeline.actorUnitIds));
    setSelectedSkillDefinitionIds(new Set(timeline.skillDefinitionIds));
    setExpandedSkillUseIds(new Set());
  }

  const visibleSkillDefinitionIds = useMemo(
    () => skillDefinitionIdsOwnedBy(timeline.instances, selectedUnitKeys),
    [timeline, selectedUnitKeys],
  );

  const visible = timeline.instances.filter(
    (instance) =>
      selectedUnitKeys.has(instance.actorUnitId) &&
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
              {visibleSkillDefinitionIds.map((skillDefinitionId) => (
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
                        <span>{resolveDisplayName(roster, instance.actorUnitId)}</span>
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
