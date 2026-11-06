import { DefinitionImage } from "../../components/DefinitionImage.js";
import { Fragment } from "react";
import type { Side } from "../../entities/battle-draft.js";
import { formationHeadingAt, isTotalWarRosterEntry } from "../../entities/roster.js";
import type { SummaryRow } from "./summary-projector.js";
import styles from "./UnitSummaryTable.module.css";

export interface UnitSummaryTableProps {
  readonly side: Side;
  readonly rows: readonly SummaryRow[];
  readonly imageMap?: Readonly<Record<string, string>>;
}

const SIDE_LABEL: Readonly<Record<Side, string>> = {
  ally: "ALLY UNIT SUMMARY",
  enemy: "ENEMY UNIT SUMMARY",
};

function statusClassName(combatStatus: string): string | undefined {
  if (combatStatus === "ACTIVE") {
    return styles["statusActive"];
  }
  if (combatStatus === "DEFEATED") {
    return styles["statusDefeated"];
  }
  return undefined;
}

const COLUMN_COUNT = 5;

// docs/ui-design/01_UI要求・画面設計.md §7.2/§7.3: DAMAGE/DEFENSE/HEAL/STATUS
// を敵味方別に常設し、Roster順・battleUnitId単位で別行表示する
// (UI-AC-008, UI-AC-009)。総力戦（§7.5）は編成ごとの見出しで区切り、再登場の
// バッジと未出撃を示す（UI-AC-063）。未出撃の行を消さないのは、控えのまま決着した
// ことも編成の判断材料になるためである。
export function UnitSummaryTable({ side, rows, imageMap }: UnitSummaryTableProps) {
  return (
    <section className={styles["side"]}>
      <div className={styles["header"]}>
        <strong className={styles[side === "ally" ? "allyText" : "enemyText"]}>
          {SIDE_LABEL[side]}
        </strong>
      </div>
      {rows.length === 0 ? (
        <p className={styles["empty"]}>ユニットがいません。</p>
      ) : (
        <div className={styles["scrollArea"]}>
          <table className={styles["table"]}>
            <thead>
              <tr>
                <th scope="col">UNIT</th>
                <th scope="col">DAMAGE</th>
                <th scope="col">DEFENSE / 被ダメージ</th>
                <th scope="col" className={styles["heal"]}>
                  HEAL
                </th>
                <th scope="col">STATUS</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ roster, summary }, index) => {
                const formationHeading = formationHeadingAt(
                  rows.map((row) => row.roster),
                  index,
                );
                const totalWar = isTotalWarRosterEntry(roster) ? roster : undefined;
                const undeployed = totalWar?.deployed === false;
                return (
                  <Fragment key={roster.battleUnitId}>
                    {formationHeading !== undefined ? (
                      <tr className={styles["formationHeading"]}>
                        <th scope="colgroup" colSpan={COLUMN_COUNT}>
                          {`編成${String(formationHeading)}`}
                        </th>
                      </tr>
                    ) : null}
                    <tr>
                      <td>
                        <div className={styles["unit"]}>
                          <DefinitionImage
                            definitionId={roster.unitDefinitionId}
                            displayName={roster.displayName}
                            kind="unit"
                            {...(imageMap !== undefined ? { imageMap } : {})}
                          />
                          <span className={styles["name"]}>{roster.displayName}</span>
                          {totalWar?.reappearance === true ? (
                            <span className={styles["badge"]}>再登場 −99%</span>
                          ) : null}
                        </div>
                      </td>
                      <td>{summary.damageDealt.toLocaleString()}</td>
                      <td>{summary.damageTaken.toLocaleString()}</td>
                      <td className={styles["heal"]}>{summary.healingDone.toLocaleString()}</td>
                      {undeployed ? (
                        <td className={styles["statusUndeployed"]}>未出撃</td>
                      ) : (
                        <td className={statusClassName(summary.combatStatus)}>
                          {summary.combatStatus}
                        </td>
                      )}
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
