import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button.js";
import { flattenDelta } from "./delta-flattener.js";
import type { StateTransitionResponse } from "../simulation/api-contract.js";
import styles from "./StateTransitionTable.module.css";

export interface StateTransitionTableProps {
  readonly transitions: readonly StateTransitionResponse[];
  readonly highlightedIndex?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function targetOf(delta: unknown): string {
  if (!isRecord(delta)) {
    return "-";
  }
  if (delta["battle"] !== undefined) {
    return "battle";
  }
  const units = delta["units"];
  if (isRecord(units)) {
    const battleUnitIds = Object.keys(units);
    return battleUnitIds.length > 0 ? battleUnitIds.join(", ") : "-";
  }
  if (delta["actionQueue"] !== undefined) {
    return "actionQueue";
  }
  return "-";
}

// docs/ui-design/01_UI要求・画面設計.md §8.2: stateTransitionsの配列順のまま
// version before/after、causedBySequence、対象、deltaを表示する。deltaはツ
// リー表示とJSON表示を行単位で切り替えられる。
export function StateTransitionTable({ transitions, highlightedIndex }: StateTransitionTableProps) {
  const [jsonModeIndices, setJsonModeIndices] = useState<ReadonlySet<number>>(new Set());
  const rowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());

  useEffect(() => {
    if (highlightedIndex === undefined) {
      return;
    }
    const row = rowRefs.current.get(highlightedIndex);
    // jsdom (component tests) does not implement scrollIntoView.
    if (row !== undefined && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex]);

  function toggleJsonMode(index: number) {
    setJsonModeIndices((current) => {
      const next = new Set(current);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }

  return (
    <div className={styles["scrollArea"]}>
      <table className={styles["table"]}>
        <thead>
          <tr>
            <th scope="col">VERSION</th>
            <th scope="col">CAUSED BY</th>
            <th scope="col">TARGET</th>
            <th scope="col">DELTA</th>
          </tr>
        </thead>
        <tbody>
          {transitions.map((transition, index) => {
            const stateVersionBefore = transition["stateVersionBefore"];
            const stateVersionAfter = transition["stateVersionAfter"];
            const causedBySequence = transition["causedBySequence"];
            const delta = transition["delta"];
            const isJsonMode = jsonModeIndices.has(index);

            return (
              <tr
                key={index}
                ref={(element) => {
                  if (element) {
                    rowRefs.current.set(index, element);
                  } else {
                    rowRefs.current.delete(index);
                  }
                }}
                className={index === highlightedIndex ? styles["highlighted"] : undefined}
                {...(index === highlightedIndex ? { "data-highlighted": "true" } : {})}
              >
                <td className={styles["mono"]}>
                  {String(stateVersionBefore)} → {String(stateVersionAfter)}
                </td>
                <td className={styles["mono"]}>#{String(causedBySequence)}</td>
                <td className={styles["mono"]}>{targetOf(delta)}</td>
                <td>
                  {isJsonMode ? (
                    <pre>{JSON.stringify(delta, null, 2)}</pre>
                  ) : (
                    <ul>
                      {flattenDelta(delta).map((line) => (
                        <li key={line.path} className={styles["deltaLine"]}>
                          {line.path}: {line.text}
                        </li>
                      ))}
                    </ul>
                  )}
                  <Button
                    variant="ghost"
                    onClick={() => {
                      toggleJsonMode(index);
                    }}
                  >
                    {isJsonMode ? "ツリー表示" : "JSON表示"}
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
