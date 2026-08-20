import { useId, useMemo, useState } from "react";
import { projectEffectTrace } from "./effect-trace-projector.js";
import type { EffectTraceInstance, EffectTraceOutcome } from "./effect-trace-projector.js";
import { FOCUSED_EFFECT_ACTION_DEFINITION_IDS } from "./focused-effects.js";
import { resolveDisplayName } from "../details/event-presentation.js";
import type { RosterIndex } from "../details/event-presentation.js";
import type { BattleLogEventResponse } from "../simulation/api-contract.js";
import styles from "./EffectTraceSection.module.css";

export interface EffectTraceSectionProps {
  readonly events: readonly BattleLogEventResponse[];
  readonly roster: RosterIndex;
}

const NO_VALUE_PLACEHOLDER = "-";

/** `effect-event-formatters.ts`の`resolveOrigin`と同じ規約: 発生源がユニットでなければ陣営で表す。 */
const MEMORY_ORIGIN_SUFFIX = "陣営のMemory";

const OUTCOME_LABELS: Readonly<Record<EffectTraceOutcome, string>> = {
  CONSUMED: "消費された",
  BREAK_REMOVED: "ブレイクで解除",
  UNUSED_EXPIRED: "未消費で失効",
  PARTIALLY_CONSUMED_EXPIRED: "消費を残して終了",
  ONGOING: "継続中",
  ENDED: "失効・解除",
};

// バーの色はこのクラス名で分ける。文言（`OUTCOME_LABELS`）を必ず併記するため、色だけが
// 持つ情報は無い（05_非機能・アクセシビリティ設計.md）。
const OUTCOME_CLASS_NAMES: Readonly<Record<EffectTraceOutcome, string>> = {
  CONSUMED: "barConsumed",
  BREAK_REMOVED: "barBreakRemoved",
  UNUSED_EXPIRED: "barUnusedExpired",
  PARTIALLY_CONSUMED_EXPIRED: "barPartiallyConsumedExpired",
  ONGOING: "barOngoing",
  ENDED: "barEnded",
};

const LEGEND_ORDER: readonly EffectTraceOutcome[] = [
  "CONSUMED",
  "BREAK_REMOVED",
  "UNUSED_EXPIRED",
  "PARTIALLY_CONSUMED_EXPIRED",
  "ONGOING",
  "ENDED",
];

const SELECTION_HINT =
  "ログに現れた効果から追跡対象を選ぶ。初期選択は、解決順で対象が変わりスコアが動く注目効果である。";

function originLabelOf(instance: EffectTraceInstance, roster: RosterIndex): string {
  if (instance.originUnitId !== undefined) {
    return resolveDisplayName(roster, instance.originUnitId);
  }
  return instance.originSide !== undefined
    ? `${instance.originSide}${MEMORY_ORIGIN_SUFFIX}`
    : NO_VALUE_PLACEHOLDER;
}

/** 消費者は発生順に並べる。同じインスタンスを複数回消費し得る（`consumptionMaxCount` > 1）。 */
function consumerLabelOf(instance: EffectTraceInstance, roster: RosterIndex): string {
  if (instance.consumptions.length === 0) {
    return NO_VALUE_PLACEHOLDER;
  }
  return instance.consumptions
    .map((consumption) =>
      consumption.consumerUnitId !== undefined
        ? `T${consumption.turnNumber.toString()} ${resolveDisplayName(roster, consumption.consumerUnitId)}`
        : `T${consumption.turnNumber.toString()} ${NO_VALUE_PLACEHOLDER}`,
    )
    .join(" / ");
}

/**
 * 消費条件を持つインスタンスの使用量を「消費回数/上限」で表す。上限が読めない場合（消費条件を
 * 持たない付与、または`consumptionMaxCount`を持たない古い応答）は数を出さない —— 分母を1と
 * 決め打つと、使い切ったのか残したのかを取り違える。
 */
function consumptionCountLabelOf(instance: EffectTraceInstance): string {
  if (instance.consumptionMaxCount === undefined) {
    return NO_VALUE_PLACEHOLDER;
  }
  return `${instance.consumptions.length.toString()}/${instance.consumptionMaxCount.toString()}`;
}

function endLabelOf(instance: EffectTraceInstance): string {
  const outcome = OUTCOME_LABELS[instance.outcome];
  if (instance.endReason === undefined) {
    return outcome;
  }
  return `${outcome}（${instance.endReason}）`;
}

interface SwimlaneRow {
  readonly instance: EffectTraceInstance;
  /** 保持ユニットの先頭行だけが保持セルを持つ（同じ保持者の行をrowspanでまとめる）。 */
  readonly holderRowSpan?: number;
}

/** 保持ユニットごとに行をまとめる。行の並びは保持者の初出順・その中は付与順。 */
function toSwimlaneRows(instances: readonly EffectTraceInstance[]): readonly SwimlaneRow[] {
  const byHolder = new Map<string, EffectTraceInstance[]>();
  for (const instance of instances) {
    const held = byHolder.get(instance.holderUnitId);
    if (held === undefined) {
      byHolder.set(instance.holderUnitId, [instance]);
    } else {
      held.push(instance);
    }
  }
  return [...byHolder.values()].flatMap((held) =>
    held.map((instance, index) => ({
      instance,
      ...(index === 0 ? { holderRowSpan: held.length } : {}),
    })),
  );
}

/**
 * 1インスタンスのバーが占めるターン列。終端を持たないインスタンス（継続中）は最後の
 * 観測ターンまで伸ばす。列に無いターンへ付与された場合でも、表の幅を超えない範囲へ丸める。
 */
function barSpanOf(
  instance: EffectTraceInstance,
  turnNumbers: readonly number[],
): { readonly lead: number; readonly span: number; readonly trail: number } {
  const firstTurn = turnNumbers[0] ?? 1;
  const lastTurn = turnNumbers[turnNumbers.length - 1] ?? firstTurn;
  const start = Math.min(Math.max(instance.appliedTurnNumber, firstTurn), lastTurn);
  const end = Math.min(Math.max(instance.endedTurnNumber ?? lastTurn, start), lastTurn);
  const lead = start - firstTurn;
  const span = end - start + 1;
  return { lead, span, trail: turnNumbers.length - lead - span };
}

// docs/ui-design/01_UI要求・画面設計.md §8.6（`UI-AC-045`）/ 04_コンポーネント・状態管理設計.md
// `UI-CMP-027`: 効果インスタンスの一生をスイムレーンと明細表で並べる。行は**保持ユニット**
// である（デバフは敵が保持し、消費者は味方なので、消費者はバーの中と明細表へ出す）。
//
// スイムレーンはCSS Modulesと`colSpan`だけで組む。`index.html`のCSPが`style-src 'self'`
// であり、inline styleを持つ図はブラウザで描画されないため（統計チャートと同じ制約）。
export function EffectTraceSection({ events, roster }: EffectTraceSectionProps) {
  const headingId = useId();
  const selectionHintId = useId();
  const trace = useMemo(() => projectEffectTrace(events), [events]);

  // 初期選択はプリセットのうちログに現れたものだけ。現れなかったプリセットを選択状態で
  // 持つと、追加・削除の一覧に無いものが選ばれていることになる。
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        trace.effectActionDefinitionIds.filter((id) =>
          FOCUSED_EFFECT_ACTION_DEFINITION_IDS.includes(id),
        ),
      ),
  );

  const visible = trace.instances.filter((instance) =>
    selectedIds.has(instance.effectActionDefinitionId),
  );
  const rows = toSwimlaneRows(visible);

  function toggle(effectActionDefinitionId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(effectActionDefinitionId)) {
        next.delete(effectActionDefinitionId);
      } else {
        next.add(effectActionDefinitionId);
      }
      return next;
    });
  }

  return (
    <section className={styles["section"]} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles["header"]}>
        EFFECT TRACE / 効果トレース
      </h3>
      {trace.effectActionDefinitionIds.length === 0 ? (
        <p className={styles["empty"]}>効果の付与は記録されていません。</p>
      ) : (
        <>
          <fieldset className={styles["selection"]} aria-describedby={selectionHintId}>
            <legend className={styles["legendLabel"]}>追跡対象</legend>
            <p id={selectionHintId} className={styles["hint"]}>
              {SELECTION_HINT}
            </p>
            <ul className={styles["selectionList"]}>
              {trace.effectActionDefinitionIds.map((effectActionDefinitionId) => (
                <li key={effectActionDefinitionId}>
                  <label className={styles["selectionItem"]}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(effectActionDefinitionId)}
                      onChange={() => {
                        toggle(effectActionDefinitionId);
                      }}
                    />
                    <span className={styles["mono"]}>{effectActionDefinitionId}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          {visible.length === 0 ? (
            <p className={styles["empty"]}>選択した効果は付与されませんでした。</p>
          ) : (
            <>
              <ul className={styles["legend"]}>
                {LEGEND_ORDER.map((outcome) => (
                  <li key={outcome} className={styles["legendItem"]}>
                    <span
                      aria-hidden="true"
                      className={[styles["swatch"], styles[OUTCOME_CLASS_NAMES[outcome]]].join(" ")}
                    />
                    {OUTCOME_LABELS[outcome]}
                  </li>
                ))}
              </ul>
              <div className={styles["scrollArea"]}>
                <table className={styles["swimlane"]} aria-label="効果トレース スイムレーン">
                  <thead>
                    <tr>
                      <th scope="col">保持</th>
                      <th scope="col">効果</th>
                      {trace.turnNumbers.map((turnNumber) => (
                        <th scope="col" key={turnNumber} className={styles["turnColumn"]}>
                          T{turnNumber}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ instance, holderRowSpan }) => {
                      const { lead, span, trail } = barSpanOf(instance, trace.turnNumbers);
                      return (
                        <tr key={instance.effectInstanceId}>
                          {holderRowSpan !== undefined ? (
                            <th scope="row" rowSpan={holderRowSpan}>
                              {resolveDisplayName(roster, instance.holderUnitId)}
                            </th>
                          ) : null}
                          <td className={styles["mono"]}>{instance.effectActionDefinitionId}</td>
                          {lead > 0 ? <td colSpan={lead} /> : null}
                          <td colSpan={span} className={styles["barCell"]}>
                            <span
                              className={[
                                styles["bar"],
                                styles[OUTCOME_CLASS_NAMES[instance.outcome]],
                              ].join(" ")}
                            >
                              {consumerLabelOf(instance, roster) !== NO_VALUE_PLACEHOLDER
                                ? `${OUTCOME_LABELS[instance.outcome]} ▸ ${consumerLabelOf(instance, roster)}`
                                : OUTCOME_LABELS[instance.outcome]}
                            </span>
                          </td>
                          {trail > 0 ? <td colSpan={trail} /> : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className={styles["scrollArea"]}>
                <table className={styles["details"]} aria-label="効果トレース明細">
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">ターン</th>
                      <th scope="col">効果</th>
                      <th scope="col">保持</th>
                      <th scope="col">付与元</th>
                      <th scope="col">終了理由</th>
                      <th scope="col">消費</th>
                      <th scope="col">消費者</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((instance) => (
                      <tr key={instance.effectInstanceId}>
                        <td className={styles["mono"]}>#{instance.appliedSequence}</td>
                        <td className={styles["mono"]}>
                          {instance.endedTurnNumber !== undefined
                            ? `T${instance.appliedTurnNumber.toString()} → T${instance.endedTurnNumber.toString()}`
                            : `T${instance.appliedTurnNumber.toString()} →`}
                        </td>
                        <td className={styles["mono"]}>{instance.effectActionDefinitionId}</td>
                        <td>{resolveDisplayName(roster, instance.holderUnitId)}</td>
                        <td>{originLabelOf(instance, roster)}</td>
                        <td>{endLabelOf(instance)}</td>
                        <td className={styles["mono"]}>{consumptionCountLabelOf(instance)}</td>
                        <td>{consumerLabelOf(instance, roster)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
