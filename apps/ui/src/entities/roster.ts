// Mirrors docs/ui-design/03_API・データ連携設計.md §10 (表示用Roster).
//
// 戦闘ユニットの読みモデル。以前は`features/summary/summary-projector.ts`が
// 所有していたが、`features/details`の3モジュール（`action-state-projector.ts`
// `event-presentation.ts` `UnitActionStateSection.tsx`）が型だけでなく
// `selectRoster`自体も直接呼んでおり、`summary`に残すと`details → summary`の
// feature間逆流が残る。型と生成関数を一緒に`entities`へ移し、両featureが
// 同じ依存先を参照する形にする（REF-055）。
//
// `selectRoster`の入力は`shared/api/api-contract.ts`の`BattleLogResponse`／
// `BattleSimulationCatalogResponse`をそのまま受け取れるが、その2つを直接
// importすると`entities`が`shared`へ依存する逆方向の辺ができる
// （02_フロントエンドアーキテクチャ設計.md §5: `entities`はどこへも依存しない）。
// 実際に読む最小限のプロパティだけを構造的型で宣言し、`shared/api`から独立させる
// —— 呼び出し側は既存のwire型の値をそのまま渡せる（構造的部分型として適合する）。

interface RosterSourceUnit {
  readonly battleUnitId: string;
  readonly unitDefinitionId: string;
  readonly side: string;
}

interface RosterSourceLog {
  readonly initialState: { readonly units: readonly RosterSourceUnit[] };
}

interface RosterSourceCatalogUnit {
  readonly unitDefinitionId: string;
  readonly displayName: string;
}

interface RosterSourceCatalog {
  readonly units: readonly RosterSourceCatalogUnit[];
}

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
  response: RosterSourceLog,
  catalog: RosterSourceCatalog,
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
