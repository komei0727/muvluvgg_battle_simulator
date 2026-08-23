// Mirrors docs/ui-design/03_API・データ連携設計.md §10 (表示用Roster).
//
// 戦闘ユニットの読みモデル。以前は`features/summary/summary-projector.ts`が
// 所有していたが、`features/details`の3モジュール（`action-state-projector.ts`
// `event-presentation.ts` `UnitActionStateSection.tsx`）が型だけでなく
// `selectRoster`自体も直接呼んでおり、`summary`に残すと`details → summary`の
// feature間逆流が残る。型と生成関数を一緒に`entities`へ移し、両featureが
// 同じ依存先を参照する形にする（REF-055）。
import type {
  BattleLogResponse,
  BattleSimulationCatalogResponse,
} from "../shared/api/api-contract.js";

export interface RosterEntry {
  readonly battleUnitId: string;
  readonly unitDefinitionId: string;
  readonly side: string;
  readonly displayName: string;
}

// docs/ui-design/03_API・データ連携設計.md §10「表示用Roster」の生成手順:
// initialState.units を入力順で走査し、Catalog未解決なら
// displayName = unitDefinitionId とする。
export function selectRoster(
  response: BattleLogResponse,
  catalog: BattleSimulationCatalogResponse,
): readonly RosterEntry[] {
  const catalogByDefinitionId = new Map(
    catalog.units.map((unit) => [unit.unitDefinitionId, unit] as const),
  );

  return response.initialState.units.map((unit) => {
    const definition = catalogByDefinitionId.get(unit.unitDefinitionId);
    return {
      battleUnitId: unit.battleUnitId,
      unitDefinitionId: unit.unitDefinitionId,
      side: unit.side,
      displayName: definition?.displayName ?? unit.unitDefinitionId,
    };
  });
}
