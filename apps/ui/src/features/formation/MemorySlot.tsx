import { DefinitionImage } from "../../components/DefinitionImage.js";
import type { CatalogMemorySummary } from "../simulation/api-contract.js";
import styles from "./MemorySlot.module.css";

export interface MemorySlotProps {
  readonly index: number;
  readonly memory?: CatalogMemorySummary;
  readonly hasError: boolean;
  readonly disabled: boolean;
  readonly imageMap?: Readonly<Record<string, string>>;
  readonly onOpen: () => void;
}

export function MemorySlot({
  index,
  memory,
  hasError,
  disabled,
  imageMap,
  onOpen,
}: MemorySlotProps) {
  const label = `メモリー${index + 1}`;
  const baseName =
    memory === undefined ? `${label}を追加` : `${label}: ${memory.displayName}を変更`;
  const accessibleName = hasError ? `${baseName}、入力エラーがあります` : baseName;

  return (
    <button
      type="button"
      className={[
        styles["slot"],
        memory !== undefined ? styles["filled"] : undefined,
        hasError ? styles["error"] : undefined,
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={onOpen}
      disabled={disabled}
      aria-label={accessibleName}
    >
      <span className={styles["index"]} aria-hidden="true">
        {index + 1}
      </span>
      {memory === undefined ? (
        <span className={styles["plus"]} aria-hidden="true">
          ＋
        </span>
      ) : (
        <>
          <DefinitionImage
            definitionId={memory.memoryDefinitionId}
            displayName={memory.displayName}
            kind="memory"
            {...(imageMap !== undefined ? { imageMap } : {})}
          />
          <span className={styles["label"]}>{memory.displayName}</span>
        </>
      )}
    </button>
  );
}
