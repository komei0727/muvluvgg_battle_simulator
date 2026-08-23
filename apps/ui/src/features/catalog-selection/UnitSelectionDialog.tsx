import { useId, useMemo, useState } from "react";
import { Dialog } from "../../components/Dialog.js";
import type { CatalogUnitSummary } from "../../shared/api/api-contract.js";
import { filterUnits } from "./catalog-filter.js";
import type { UnitFilter } from "./catalog-filter.js";
import { SelectionDialogList } from "./SelectionDialogList.js";
import type { SelectionDialogItem } from "./SelectionDialogList.js";
import { isExerciseEnemyUnit } from "./unit-pool.js";
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

const INITIAL_FILTER: UnitFilter = { query: "" };

/**
 * R-TEX-11 #4: 開催中フラグは表示専用で、選択可否を変えない。演習専用ユニット
 * だけに出す（プレイアブルはフラグ自体を持たない）。
 */
function exerciseBadgeOf(unit: CatalogUnitSummary): readonly string[] {
  if (!isExerciseEnemyUnit(unit)) {
    return [];
  }
  return [unit.exerciseActive === true ? "開催中" : "開催終了"];
}

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

  const items = useMemo<readonly SelectionDialogItem[]>(
    () =>
      filtered.map((unit) => {
        const isCurrent = unit.unitDefinitionId === currentUnitDefinitionId;
        return {
          definitionId: unit.unitDefinitionId,
          displayName: unit.displayName,
          disabled: isEmptySlotAtCapacity && !isCurrent,
          tags: [
            unit.attribute,
            unit.role,
            unit.positionAptitudes.join("/"),
            ...exerciseBadgeOf(unit),
          ],
        };
      }),
    [filtered, currentUnitDefinitionId, isEmptySlotAtCapacity],
  );

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

      <SelectionDialogList
        items={items}
        kind="unit"
        {...(currentUnitDefinitionId !== undefined
          ? { currentDefinitionId: currentUnitDefinitionId }
          : {})}
        {...(imageMap !== undefined ? { imageMap } : {})}
        onSelect={onSelect}
        onRemove={onRemove}
      />
    </Dialog>
  );
}
