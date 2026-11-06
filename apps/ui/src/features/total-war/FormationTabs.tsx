import type { ReactNode } from "react";
import { Button } from "../../components/Button.js";
import { Tabs } from "../../components/Tabs.js";
import { FORMATION_INDICES } from "./total-war-draft.js";
import type { FormationCount, FormationIndex } from "./total-war-draft.js";
import { TOTAL_WAR_MAX_FORMATIONS } from "../../entities/total-war.js";
import type { Side } from "../../entities/battle-draft.js";
import styles from "./FormationTabs.module.css";

export interface FormationTabsProps {
  readonly side: Side;
  readonly count: FormationCount;
  readonly active: FormationIndex;
  /** 送信前検証・422の違反を持つ編成。表示中でない編成の違反に気づけるよう印を付ける。 */
  readonly formationsWithErrors: readonly FormationIndex[];
  readonly disabled: boolean;
  readonly onActivate: (index: FormationIndex) => void;
  readonly onAdd: () => void;
  /** 表示中の編成を削除する。確認は挟まない（既存のリセット操作と同じ）。 */
  readonly onRemove: () => void;
  /** 表示中の編成のエディタ。 */
  readonly children: ReactNode;
}

const SIDE_LABELS: Readonly<Record<Side, string>> = { ally: "味方", enemy: "敵" };

function tabId(side: Side, index: FormationIndex): string {
  return `total-war-${side}-formation-${String(index)}`;
}

/**
 * 01_UI要求・画面設計.md §5.10「編成タブ」。タブの番号はそのまま出撃順である。
 * モードタブと入れ子になるため、タブ群のaccessible nameへ陣営名を含める。
 */
export function FormationTabs({
  side,
  count,
  active,
  formationsWithErrors,
  disabled,
  onActivate,
  onAdd,
  onRemove,
  children,
}: FormationTabsProps) {
  const items = FORMATION_INDICES.slice(0, count).map((index) => ({
    id: tabId(side, index),
    label: `編成${String(index + 1)}${formationsWithErrors.includes(index) ? " 要修正" : ""}`,
  }));

  return (
    <div className={styles["formationTabs"]}>
      <div className={styles["bar"]}>
        <Tabs
          label={`${SIDE_LABELS[side]}の編成`}
          items={items}
          activeId={tabId(side, active)}
          onChange={(id) => {
            const index = FORMATION_INDICES.find((candidate) => tabId(side, candidate) === id);
            if (index !== undefined) {
              onActivate(index);
            }
          }}
        />
        <div className={styles["actions"]}>
          {count < TOTAL_WAR_MAX_FORMATIONS ? (
            <Button variant="ghost" disabled={disabled} onClick={onAdd}>
              編成を追加
            </Button>
          ) : null}
          {count > 1 ? (
            <Button variant="ghost" disabled={disabled} onClick={onRemove}>
              この編成を削除
            </Button>
          ) : null}
        </div>
      </div>
      <div
        role="tabpanel"
        id={`tabpanel-${tabId(side, active)}`}
        aria-labelledby={`tab-${tabId(side, active)}`}
      >
        {children}
      </div>
    </div>
  );
}
