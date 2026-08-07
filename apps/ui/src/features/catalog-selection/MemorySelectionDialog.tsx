import { useId, useMemo, useState } from "react";
import { Dialog } from "../../components/Dialog.js";
import type { CatalogMemorySummary } from "../simulation/api-contract.js";
import { filterMemories } from "./catalog-filter.js";
import type { MemoryFilter } from "./catalog-filter.js";
import { SelectionDialogList } from "./SelectionDialogList.js";
import type { SelectionDialogItem } from "./SelectionDialogList.js";
import styles from "./SelectionDialog.module.css";

export interface MemorySelectionDialogProps {
  readonly memories: readonly CatalogMemorySummary[];
  readonly currentMemoryDefinitionId?: string;
  readonly imageMap?: Readonly<Record<string, string>>;
  readonly onSelect: (memoryDefinitionId: string) => void;
  readonly onRemove: () => void;
  readonly onClose: () => void;
}

const INITIAL_FILTER: MemoryFilter = { query: "" };

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

  const items = useMemo<readonly SelectionDialogItem[]>(
    () =>
      filtered.map((memory) => ({
        definitionId: memory.memoryDefinitionId,
        displayName: memory.displayName,
        disabled: false,
      })),
    [filtered],
  );

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

      <SelectionDialogList
        items={items}
        kind="memory"
        {...(currentMemoryDefinitionId !== undefined
          ? { currentDefinitionId: currentMemoryDefinitionId }
          : {})}
        {...(imageMap !== undefined ? { imageMap } : {})}
        onSelect={onSelect}
        onRemove={onRemove}
      />
    </Dialog>
  );
}
