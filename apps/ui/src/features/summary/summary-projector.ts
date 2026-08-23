// Mirrors docs/ui-design/03_API・データ連携設計.md §10 (表示用Roster), §11
// (サマリ集計). ユニット別集計はサーバーが確定させた `unitSummaries`
// (docs/ddd/10_API設計.md「UnitBattleSummaryResponse」) をそのまま読む。
//
// 以前はUIが `DAMAGE_APPLIED`/`HEAL_APPLIED`/`HEALING_TRANSFERRED` を畳み込んで
// いたが、その方式には塞げない欠落が2つあった。継続ダメージ
// (`CONTINUOUS_DAMAGE_APPLIED`) を経路ごと取りこぼしDoT主体のユニットが0に見える
// こと、そして `SUMMARY` ではこれらのイベント自体が公開されないため全ユニットが
// 警告なく0表示になることである。集計の正本はサーバー側にしかない。

import type {
  BattleLogResponse,
  BattleResultResponse,
  BattleSimulationCatalogResponse,
} from "../../shared/api/api-contract.js";

/** `SubmissionFeedback`の1行要約。演習側の対応は`describeExerciseResult`。 */
export function describeBattleResult(result: BattleResultResponse): string {
  return `${result.outcome} / ${result.completionReason} (turn ${result.completedTurn})`;
}

export interface RosterEntry {
  readonly battleUnitId: string;
  readonly unitDefinitionId: string;
  readonly side: string;
  readonly displayName: string;
}

export interface UnitBattleSummary {
  readonly battleUnitId: string;
  readonly damageDealt: number;
  readonly damageTaken: number;
  readonly healingDone: number;
  readonly combatStatus: string;
  readonly finalHp: number;
  readonly maximumHp: number;
}

export interface SummaryRow {
  readonly roster: RosterEntry;
  readonly summary: UnitBattleSummary;
}

export interface SummaryProjection {
  readonly allyRows: readonly SummaryRow[];
  readonly enemyRows: readonly SummaryRow[];
  readonly hasProjectionWarning: boolean;
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

// `unitSummaries`がRosterの全ユニットを覆うことは response-validator.ts が成功
// レスポンス全体の受理条件として検証済みであり、ここへ来る時点で行が欠けることは
// ない。それでも欠落を0埋め＋警告として扱うのは、検証を通らない経路（テスト用の
// 部分fixtureや将来の呼び出し元追加）で、対応表を持たない行だけが正しい値のように
// 見えるのを防ぐためである。
export function selectBattleSummary(
  response: BattleLogResponse,
  catalog: BattleSimulationCatalogResponse,
): SummaryProjection {
  const roster = selectRoster(response, catalog);
  const summaryByUnitId = new Map(
    response.unitSummaries.map((summary) => [summary.battleUnitId, summary] as const),
  );

  const allyRows: SummaryRow[] = [];
  const enemyRows: SummaryRow[] = [];
  let warned = false;
  for (const entry of roster) {
    const served = summaryByUnitId.get(entry.battleUnitId);
    if (served === undefined) {
      warned = true;
    }
    const summary: UnitBattleSummary = {
      battleUnitId: entry.battleUnitId,
      damageDealt: served?.damageDealt ?? 0,
      damageTaken: served?.damageTaken ?? 0,
      healingDone: served?.healingDone ?? 0,
      combatStatus: served?.combatStatus ?? "UNKNOWN",
      finalHp: served?.finalHp ?? 0,
      maximumHp: served?.maximumHp ?? 0,
    };
    const row: SummaryRow = { roster: entry, summary };
    // 陣営は表示用Roster（`initialState`）が正本。`unitSummaries[].side`と
    // 二重に持つが、行の並びと表の左右はRoster側の`side`で決まる。
    if (entry.side === "ENEMY") {
      enemyRows.push(row);
    } else {
      allyRows.push(row);
    }
  }

  return { allyRows, enemyRows, hasProjectionWarning: warned };
}
