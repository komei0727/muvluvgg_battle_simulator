import { aptitudeMatches } from "../../lib/aptitude.js";
import type { CatalogMemorySummary, CatalogUnitSummary } from "../simulation/api-contract.js";

// docs/ui-design/04_コンポーネント・状態管理設計.md §8: Filter state.
export type CatalogAvailabilityFilter = "all" | "selectable" | "unavailable";

export interface UnitFilter {
  readonly query: string;
  readonly attribute?: string;
  readonly role?: string;
  readonly aptitude?: "FRONT" | "REAR";
  readonly availability: CatalogAvailabilityFilter;
}

export interface MemoryFilter {
  readonly query: string;
  readonly availability: CatalogAvailabilityFilter;
}

interface Availability {
  readonly selectable: boolean;
}

function matchesAvailability(
  entry: Availability,
  availability: CatalogAvailabilityFilter,
): boolean {
  if (availability === "selectable") {
    return entry.selectable;
  }
  if (availability === "unavailable") {
    return !entry.selectable;
  }
  return true;
}

function matchesQuery(query: string, displayName: string, definitionId: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return true;
  }
  return (
    displayName.toLowerCase().includes(normalized) ||
    definitionId.toLowerCase().includes(normalized)
  );
}

function bySelectableThenDisplayNameThenId<
  T extends Availability & { readonly displayName: string },
>(idOf: (entry: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    if (a.selectable !== b.selectable) {
      return a.selectable ? -1 : 1;
    }
    const nameComparison = a.displayName.localeCompare(b.displayName);
    if (nameComparison !== 0) {
      return nameComparison;
    }
    return idOf(a).localeCompare(idOf(b));
  };
}

export function filterUnits(
  units: readonly CatalogUnitSummary[],
  filter: UnitFilter,
): readonly CatalogUnitSummary[] {
  return units
    .filter((unit) => matchesQuery(filter.query, unit.displayName, unit.unitDefinitionId))
    .filter((unit) => filter.attribute === undefined || unit.attribute === filter.attribute)
    .filter((unit) => filter.role === undefined || unit.role === filter.role)
    .filter(
      (unit) =>
        filter.aptitude === undefined || aptitudeMatches(filter.aptitude, unit.positionAptitudes),
    )
    .filter((unit) => matchesAvailability(unit, filter.availability))
    .toSorted(bySelectableThenDisplayNameThenId((unit) => unit.unitDefinitionId));
}

export function filterMemories(
  memories: readonly CatalogMemorySummary[],
  filter: MemoryFilter,
): readonly CatalogMemorySummary[] {
  return memories
    .filter((memory) => matchesQuery(filter.query, memory.displayName, memory.memoryDefinitionId))
    .filter((memory) => matchesAvailability(memory, filter.availability))
    .toSorted(bySelectableThenDisplayNameThenId((memory) => memory.memoryDefinitionId));
}
