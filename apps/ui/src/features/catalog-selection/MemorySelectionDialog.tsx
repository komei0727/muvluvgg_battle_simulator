import { useId, useMemo, useState } from "react";
import { DefinitionImage } from "../../components/DefinitionImage.js";
import { Dialog } from "../../components/Dialog.js";
import type { CatalogMemorySummary } from "../simulation/api-contract.js";
import { filterMemories } from "./catalog-filter.js";
import type { MemoryFilter } from "./catalog-filter.js";
import styles from "./SelectionDialog.module.css";

export interface MemorySelectionDialogProps {
  readonly memories: readonly CatalogMemorySummary[];
  readonly currentMemoryDefinitionId?: string;
  readonly imageMap?: Readonly<Record<string, string>>;
  readonly onSelect: (memoryDefinitionId: string) => void;
  readonly onRemove: () => void;
  readonly onClose: () => void;
}

const INITIAL_FILTER: MemoryFilter = { query: "", availability: "all" };

// docs/ui-design/04_コンポーネント・状態管理設計.md §3 MemorySelectionDialog:
// "Unit版と同じ基本挙動とし、属性・ロールfilterは持たない".
export function MemorySelectionDialog({
  memories,
  currentMemoryDefinitionId,
  imageMap,
  onSelect,
  onRemove,
  onClose,
}: MemorySelectionDialogProps) {
  const titleId = useId();
  const [filter, setFilter] = useState<MemoryFilter>(INITIAL_FILTER);

  const filtered = useMemo(() => filterMemories(memories, filter), [memories, filter]);

  return (
    <Dialog titleId={titleId} title="メモリーを選択" onClose={onClose}>
      <div className={`${styles["tools"] ?? ""} ${styles["toolsSingleColumn"] ?? ""}`}>
        <input
          type="search"
          value={filter.query}
          onChange={(event) => {
            setFilter((prev) => ({ ...prev, query: event.target.value }));
          }}
          placeholder="メモリー名・定義IDで検索"
          aria-label="メモリーを検索"
        />
      </div>

      {currentMemoryDefinitionId !== undefined ? (
        <button type="button" className={styles["removeButton"]} onClick={onRemove}>
          この枠を空にする
        </button>
      ) : null}

      <ul className={styles["list"]}>
        {filtered.map((memory) => {
          const isCurrent = memory.memoryDefinitionId === currentMemoryDefinitionId;
          return (
            <li key={memory.memoryDefinitionId} className={styles["item"]}>
              <DefinitionImage
                definitionId={memory.memoryDefinitionId}
                displayName={memory.displayName}
                kind="memory"
                {...(imageMap !== undefined ? { imageMap } : {})}
              />
              <div className={styles["itemBody"]}>
                <p className={styles["itemName"]}>{memory.displayName}</p>
                <p className={styles["itemId"]}>{memory.memoryDefinitionId}</p>
                {!memory.selectable ? (
                  <p className={styles["unavailable"]}>
                    未対応: {memory.unavailableCapabilities.join(", ")}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => {
                  onSelect(memory.memoryDefinitionId);
                }}
                disabled={!memory.selectable}
                aria-label={
                  isCurrent ? `${memory.displayName}選択中` : `${memory.displayName}を選択`
                }
              >
                {isCurrent ? "選択中" : "選択"}
              </button>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
