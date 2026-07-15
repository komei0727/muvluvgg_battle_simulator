import { useId, useMemo, useState } from "react";
import { DefinitionImage } from "../../components/DefinitionImage.js";
import { Dialog } from "../../components/Dialog.js";
import type { CatalogUnitSummary } from "../simulation/api-contract.js";
import { filterUnits } from "./catalog-filter.js";
import type { UnitFilter } from "./catalog-filter.js";
import styles from "./SelectionDialog.module.css";

export interface UnitSelectionDialogProps {
  readonly units: readonly CatalogUnitSummary[];
  readonly currentUnitDefinitionId?: string;
  readonly atCapacity: boolean;
  readonly imageMap?: Readonly<Record<string, string>>;
  readonly onSelect: (unitDefinitionId: string) => void;
  readonly onRemove: () => void;
  readonly onClose: () => void;
}

const INITIAL_FILTER: UnitFilter = { query: "", availability: "all" };

// docs/ui-design/01_UI要求・画面設計.md §5.2, §5.1 (6枠目 capacity notice).
export function UnitSelectionDialog({
  units,
  currentUnitDefinitionId,
  atCapacity,
  imageMap,
  onSelect,
  onRemove,
  onClose,
}: UnitSelectionDialogProps) {
  const titleId = useId();
  const [filter, setFilter] = useState<UnitFilter>(INITIAL_FILTER);

  const attributes = useMemo(
    () => Array.from(new Set(units.map((unit) => unit.attribute))).toSorted(),
    [units],
  );
  const roles = useMemo(
    () => Array.from(new Set(units.map((unit) => unit.role))).toSorted(),
    [units],
  );
  const filtered = useMemo(() => filterUnits(units, filter), [units, filter]);

  const isEmptySlotAtCapacity = atCapacity && currentUnitDefinitionId === undefined;

  return (
    <Dialog titleId={titleId} title="ユニットを選択" onClose={onClose}>
      <div className={styles["tools"]}>
        <input
          type="search"
          value={filter.query}
          onChange={(event) => {
            setFilter((prev) => ({ ...prev, query: event.target.value }));
          }}
          placeholder="ユニット名・定義IDで検索"
          aria-label="ユニットを検索"
        />
        <select
          value={filter.attribute ?? ""}
          onChange={(event) => {
            const value = event.target.value;
            setFilter((prev) => {
              const { attribute: _discarded, ...rest } = prev;
              return value === "" ? rest : { ...rest, attribute: value };
            });
          }}
          aria-label="属性で絞り込み"
        >
          <option value="">すべての属性</option>
          {attributes.map((attribute) => (
            <option key={attribute} value={attribute}>
              {attribute}
            </option>
          ))}
        </select>
        <select
          value={filter.role ?? ""}
          onChange={(event) => {
            const value = event.target.value;
            setFilter((prev) => {
              const { role: _discarded, ...rest } = prev;
              return value === "" ? rest : { ...rest, role: value };
            });
          }}
          aria-label="役割で絞り込み"
        >
          <option value="">すべての役割</option>
          {roles.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      </div>

      {isEmptySlotAtCapacity ? (
        <p role="alert" className={styles["capacityNotice"]}>
          1陣営に設定できるユニットは5体までです。
        </p>
      ) : null}

      {currentUnitDefinitionId !== undefined ? (
        <button type="button" className={styles["removeButton"]} onClick={onRemove}>
          この枠を空にする
        </button>
      ) : null}

      <ul className={styles["list"]}>
        {filtered.map((unit) => {
          const isCurrent = unit.unitDefinitionId === currentUnitDefinitionId;
          const disabled = !unit.selectable || (isEmptySlotAtCapacity && !isCurrent);
          return (
            <li key={unit.unitDefinitionId} className={styles["item"]}>
              <DefinitionImage
                definitionId={unit.unitDefinitionId}
                displayName={unit.displayName}
                kind="unit"
                {...(imageMap !== undefined ? { imageMap } : {})}
              />
              <div className={styles["itemBody"]}>
                <p className={styles["itemName"]}>{unit.displayName}</p>
                <p className={styles["itemId"]}>{unit.unitDefinitionId}</p>
                <div className={styles["itemTags"]}>
                  <span className={styles["tag"]}>{unit.attribute}</span>
                  <span className={styles["tag"]}>{unit.role}</span>
                  <span className={styles["tag"]}>{unit.positionAptitudes.join("/")}</span>
                </div>
                {!unit.selectable ? (
                  <p className={styles["unavailable"]}>
                    未対応: {unit.unavailableCapabilities.join(", ")}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => {
                  onSelect(unit.unitDefinitionId);
                }}
                disabled={disabled}
                aria-label={isCurrent ? `${unit.displayName}選択中` : `${unit.displayName}を選択`}
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
