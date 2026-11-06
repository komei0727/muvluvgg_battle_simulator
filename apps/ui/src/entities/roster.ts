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

/**
 * 総力戦の表示用Roster（03_API・データ連携設計.md §10.1）。サマリ・詳細の各部品は
 * `RosterEntry`として受け取り、総力戦だけの表示（編成の見出し・再登場・未出撃）は
 * `isTotalWarRosterEntry`で判別する。通常戦闘・戦術演習の行はこれらを持たない。
 */
export interface TotalWarRosterEntry extends RosterEntry {
  readonly formationNumber: number;
  readonly reappearance: boolean;
  readonly deployed: boolean;
}

export function isTotalWarRosterEntry(entry: RosterEntry): entry is TotalWarRosterEntry {
  return "formationNumber" in entry && "deployed" in entry && "reappearance" in entry;
}

/**
 * Roster順に並べた行のうち、編成の見出しを置く位置ならその編成番号を返す。総力戦の行は
 * 陣営・編成番号の順に並ぶため、直前の行と編成が変わる位置が見出しの位置になる。
 */
export function formationHeadingAt(
  entries: readonly RosterEntry[],
  index: number,
): number | undefined {
  const current = entries[index];
  if (current === undefined || !isTotalWarRosterEntry(current)) {
    return undefined;
  }
  const previous = index > 0 ? entries[index - 1] : undefined;
  return previous !== undefined &&
    isTotalWarRosterEntry(previous) &&
    previous.formationNumber === current.formationNumber
    ? undefined
    : current.formationNumber;
}

// docs/ui-design/03_API・データ連携設計.md §10「表示用Roster」の生成手順:
// initialState.units を入力順で走査し、Catalog未解決なら
// displayName = unitDefinitionId とする。
export function selectRoster(
  response: RosterSourceLog,
  catalog: RosterSourceCatalog,
): readonly RosterEntry[] {
  return selectRosterOf(response.initialState.units, catalog);
}

/**
 * 入力のユニット一覧からRosterを作る。通常戦闘・戦術演習は`initialState.units`、
 * 総力戦は`unitRoster`を渡す（総力戦の`initialState`は1番目の編成しか含まない）。
 */
export function selectRosterOf(
  units: readonly RosterSourceUnit[],
  catalog: RosterSourceCatalog,
): readonly RosterEntry[] {
  const catalogByDefinitionId = new Map(
    catalog.units.map((unit) => [unit.unitDefinitionId, unit] as const),
  );

  return units.map((unit) => {
    const definition = catalogByDefinitionId.get(unit.unitDefinitionId);
    return {
      battleUnitId: unit.battleUnitId,
      unitDefinitionId: unit.unitDefinitionId,
      side: unit.side,
      displayName: definition?.displayName ?? unit.unitDefinitionId,
    };
  });
}
