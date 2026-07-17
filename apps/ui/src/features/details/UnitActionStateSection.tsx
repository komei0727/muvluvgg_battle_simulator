import { useMemo } from "react";
import { selectUnitActionStates } from "./action-state-projector.js";
import { selectRoster } from "../summary/summary-projector.js";
import type { RosterEntry } from "../summary/summary-projector.js";
import type { UnitActionState } from "./action-state-projector.js";
import type { LogLevel } from "../formation/types.js";
import type {
  BattleSimulationCatalogResponse,
  BattleSimulationResponse,
} from "../simulation/api-contract.js";
import styles from "./UnitActionStateSection.module.css";

export interface UnitActionStateSectionProps {
  readonly response: BattleSimulationResponse;
  readonly catalog?: BattleSimulationCatalogResponse;
  readonly logLevel: LogLevel;
}

const EMPTY_CATALOG: BattleSimulationCatalogResponse = {
  schemaVersion: 1,
  catalogRevision: "",
  units: [],
  memories: [],
};

const NO_VALUE_PLACEHOLDER = "-";

function resourceText(value: UnitActionState["ap"]): string {
  return value !== undefined ? `${value.current} / ${value.maximum}` : NO_VALUE_PLACEHOLDER;
}

interface Row {
  readonly roster: RosterEntry;
  readonly actionState: UnitActionState;
}

// docs/ui-design/07_UI実装・拡張計画.md §9完了条件: M5追加eventを意味のある
// 文言で表示し、cooldown/charge状態をbattleUnitId単位で追跡できる。
// action-state-projector.tsが選んだ値（AP/EXはfinalState.resourcesから、
// cooldown/chargeはfinalState.units[]、それが無い旧fixtureだけevents[]から）
// をそのまま表示する。
function UnitActionStateGroup({
  side,
  rows,
}: {
  readonly side: "ally" | "enemy";
  readonly rows: readonly Row[];
}) {
  const label = side === "ally" ? "ALLY ACTION STATE" : "ENEMY ACTION STATE";
  const labelClassName = styles[side === "ally" ? "allyText" : "enemyText"];
  return (
    <section className={styles["side"]}>
      <div className={styles["header"]}>
        <strong className={labelClassName}>{label}</strong>
      </div>
      {rows.length === 0 ? (
        <p className={styles["empty"]}>ユニットがいません。</p>
      ) : (
        <ul className={styles["list"]}>
          {rows.map(({ roster, actionState }) => (
            <li key={roster.battleUnitId} className={styles["unit"]}>
              <div className={styles["unitHeader"]}>
                <span className={styles["name"]}>{roster.displayName}</span>
                <span className={styles["resources"]}>
                  <span>AP {resourceText(actionState.ap)}</span>
                  <span>EX {resourceText(actionState.extraGauge)}</span>
                </span>
              </div>
              {!actionState.cooldownChargeKnown ? (
                <p className={styles["muted"]}>クールタイム/チャージ: SUMMARYログのため不明</p>
              ) : actionState.cooldowns.length === 0 ? (
                <p className={styles["muted"]}>クールタイムなし</p>
              ) : (
                <ul className={styles["cooldownList"]}>
                  {actionState.cooldowns.map((cooldown) => (
                    <li key={cooldown.skillDefinitionId}>
                      {cooldown.skillDefinitionId}: 残り{cooldown.remaining}
                    </li>
                  ))}
                </ul>
              )}
              {actionState.cooldownChargeKnown && actionState.charge !== undefined ? (
                <p className={styles["charge"]}>
                  チャージ中: {actionState.charge.skillDefinitionId}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function UnitActionStateSection({
  response,
  catalog,
  logLevel,
}: UnitActionStateSectionProps) {
  const roster = useMemo(
    () => selectRoster(response, catalog ?? EMPTY_CATALOG),
    [response, catalog],
  );
  const actionStates = useMemo(
    () => selectUnitActionStates(response, roster, logLevel),
    [response, roster, logLevel],
  );

  const rows: readonly Row[] = useMemo(() => {
    const actionStateByBattleUnitId = new Map(
      actionStates.map((state) => [state.battleUnitId, state] as const),
    );
    return roster.map((entry) => ({
      roster: entry,
      actionState: actionStateByBattleUnitId.get(entry.battleUnitId) ?? {
        battleUnitId: entry.battleUnitId,
        cooldowns: [],
        cooldownChargeKnown: logLevel !== "SUMMARY",
      },
    }));
  }, [roster, actionStates, logLevel]);

  const allyRows = rows.filter((row) => row.roster.side !== "ENEMY");
  const enemyRows = rows.filter((row) => row.roster.side === "ENEMY");

  return (
    <div className={styles["grid"]}>
      <UnitActionStateGroup side="ally" rows={allyRows} />
      <UnitActionStateGroup side="enemy" rows={enemyRows} />
    </div>
  );
}
