// docs/ui-design/01_UI要求・画面設計.md §7.5 / 03_API・データ連携設計.md §10.1: 総力戦の
// 結果ヘッダー・戦闘履歴・表示用Rosterを応答から作る純関数。
import { selectRosterOf } from "../../entities/roster.js";
import type { TotalWarRosterEntry } from "../../entities/roster.js";
import { TOTAL_WAR_TURN_LIMIT } from "../../entities/total-war.js";
import type {
  BattleSimulationCatalogResponse,
  TotalWarRequest,
  TotalWarResponse,
  TotalWarStageResponse,
} from "../../shared/api/api-contract.js";

/**
 * `initialState`は両陣営の1番目の編成しか含まないため、`unitRoster`から作る。
 * 並びは`unitRoster`の順（陣営、編成番号、配置順）を保つ。
 */
export function selectTotalWarRoster(
  response: TotalWarResponse,
  catalog: BattleSimulationCatalogResponse,
): readonly TotalWarRosterEntry[] {
  const displayNameById = new Map(
    selectRosterOf(response.unitRoster, catalog).map(
      (entry) => [entry.battleUnitId, entry.displayName] as const,
    ),
  );
  return response.unitRoster.map((unit) => ({
    battleUnitId: unit.battleUnitId,
    unitDefinitionId: unit.unitDefinitionId,
    side: unit.side,
    displayName: displayNameById.get(unit.battleUnitId) ?? unit.unitDefinitionId,
    formationNumber: unit.formationNumber,
    reappearance: unit.reappearance,
    deployed: unit.deployed,
  }));
}

// 通常戦闘の`SIMULTANEOUS_DEFEAT`は勝敗の一種だが、総力戦では引き分けを表す。同じ辞書を
// 流用すると勝敗の読み方を誤らせるため、総力戦は専用の辞書を持つ。未知の値はコードのまま出す。
const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  ALLY_WIN: "ALLY WIN / 味方勝利",
  ALLY_LOSE: "ALLY LOSE / 味方敗北",
  DRAW: "DRAW / 引き分け",
};

const COMPLETION_REASON_LABELS: Readonly<Record<string, string>> = {
  ENEMY_DEFEATED: "敵の全編成を撃破",
  ALLY_DEFEATED: "味方の全編成が撃破",
  SIMULTANEOUS_DEFEAT: "最後の編成どうしが同時全滅（引き分け）",
  TURN_LIMIT_REACHED: `${String(TOTAL_WAR_TURN_LIMIT)}ターン経過（引き分け）`,
};

export interface DefeatedFormationCount {
  readonly defeated: number;
  /** 送信した編成数。応答は撃破数しか持たないため、表示中の結果のリクエストから取る。 */
  readonly total: number;
}

export interface TotalWarStageRow {
  readonly stageNumber: number;
  readonly matchup: string;
  readonly turns: string;
  readonly resultLabel: string;
}

export interface TotalWarResultView {
  readonly outcomeLabel: string;
  readonly completionReasonLabel: string;
  readonly completedTurn: number;
  readonly turnLimit: number;
  readonly defeatedFormations: {
    readonly ally: DefeatedFormationCount;
    readonly enemy: DefeatedFormationCount;
  };
  readonly stages: readonly TotalWarStageRow[];
  readonly battleId: string;
  readonly catalogRevision: string;
}

function stageResultLabel(defeatedSides: readonly string[]): string {
  const allyDefeated = defeatedSides.includes("ALLY");
  const enemyDefeated = defeatedSides.includes("ENEMY");
  const unknown = defeatedSides.filter((side) => side !== "ALLY" && side !== "ENEMY");
  if (unknown.length > 0) {
    return defeatedSides.join(", ");
  }
  if (allyDefeated && enemyDefeated) {
    return "同時全滅";
  }
  if (enemyDefeated) {
    return "敵の編成を撃破";
  }
  if (allyDefeated) {
    return "味方の編成が撃破";
  }
  // 15ターン経過で打ち切られた組み合わせだけが、どちらも全滅しないまま終わる。
  return "決着せず終了";
}

function stageRow(stage: TotalWarStageResponse): TotalWarStageRow {
  return {
    stageNumber: stage.stageNumber,
    matchup: `味方 編成${String(stage.allyFormationNumber)} vs 敵 編成${String(stage.enemyFormationNumber)}`,
    turns:
      stage.startTurn === stage.endTurn
        ? String(stage.startTurn)
        : `${String(stage.startTurn)}〜${String(stage.endTurn)}`,
    resultLabel: stageResultLabel(stage.defeatedSides),
  };
}

export function selectTotalWarResultView(
  response: TotalWarResponse,
  request: TotalWarRequest,
): TotalWarResultView {
  const { result } = response;
  return {
    outcomeLabel: OUTCOME_LABELS[result.outcome] ?? result.outcome,
    completionReasonLabel:
      COMPLETION_REASON_LABELS[result.completionReason] ?? result.completionReason,
    completedTurn: result.completedTurn,
    turnLimit: TOTAL_WAR_TURN_LIMIT,
    defeatedFormations: {
      ally: {
        defeated: result.defeatedFormationCounts.ally,
        total: request.allyFormations.length,
      },
      enemy: {
        defeated: result.defeatedFormationCounts.enemy,
        total: request.enemyFormations.length,
      },
    },
    stages: result.stages.map(stageRow),
    battleId: response.battleId,
    catalogRevision: response.catalogRevision,
  };
}
