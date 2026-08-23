// Mirrors docs/ui-design/01_UI要求・画面設計.md `UI-UC-006` step 5 と
// 04_コンポーネント・状態管理設計.md `UI-CMP-012`: 演習結果の表示値をpure function
// として導出し、componentはこの投影だけを描画する（`UI-CMP-005`）。
import { EXERCISE_TURN_LIMIT } from "../../entities/tactical-exercise.js";
import type {
  BattleSimulationCatalogResponse,
  ExerciseResultResponse,
} from "../../shared/api/api-contract.js";

export interface ExerciseBreakRow {
  readonly breakNumber: number;
  readonly turnNumber: number;
  readonly cumulativeScoreAtBreak: number;
  /** 発生源ユニットの表示名。Catalog未解決は定義ID、発生源なしは`MEMORY_SOURCE_LABEL`。 */
  readonly sourceLabel: string;
}

export interface ExerciseResultView {
  readonly totalScore: number;
  readonly breakCount: number;
  readonly completionReasonLabel: string;
  readonly completedTurn: number;
  readonly turnLimit: number;
  /** 発生順（ブレイク番号の昇順）。ブレイク0回では空配列。 */
  readonly breaks: readonly ExerciseBreakRow[];
}

// docs/ddd/10_API設計.md「ExerciseResultResponse」: 演習の終了理由はこの2値だが、
// 未知の列挙値はコードのまま見せて画面を壊さない（`UI-AC-011`と同じ方針）。
const COMPLETION_REASON_LABELS: Readonly<Record<string, string>> = {
  TURN_LIMIT_REACHED: "ターン上限到達",
  ALLY_DEFEATED: "味方陣営全滅",
};

// R-MEM-04: メモリー由来の継続ダメージのように発生源ユニットを持たないブレイクが
// あり、そのときAPIは`sourceUnitDefinitionId`を省略する。この項目より前にデプロイ
// されたAPIの応答も同じ経路を通るため、省略を欠損ではなくメモリー由来として読む。
const MEMORY_SOURCE_LABEL = "メモリー効果";

/** `SubmissionFeedback`の1行要約。演習は勝敗を持たないためスコアで代替する。 */
export function describeExerciseResult(result: ExerciseResultResponse): string {
  const view = selectExerciseResultView(result);
  return `スコア ${view.totalScore.toLocaleString()} / ブレイク ${view.breakCount}回 / ${view.completionReasonLabel} (turn ${view.completedTurn})`;
}

export function selectExerciseResultView(
  result: ExerciseResultResponse,
  catalog?: BattleSimulationCatalogResponse,
): ExerciseResultView {
  // Catalogがreload中・未取得のときも履歴自体は出す（`BattleSummarySection`の
  // displayName fallbackと同じ方針）。
  const displayNameByDefinitionId = new Map(
    (catalog?.units ?? []).map((unit) => [unit.unitDefinitionId, unit.displayName] as const),
  );

  return {
    totalScore: result.totalScore,
    breakCount: result.breakCount,
    completionReasonLabel:
      COMPLETION_REASON_LABELS[result.completionReason] ?? result.completionReason,
    completedTurn: result.completedTurn,
    turnLimit: EXERCISE_TURN_LIMIT,
    breaks: result.breaks
      .map((entry) => ({
        breakNumber: entry.breakNumber,
        turnNumber: entry.turnNumber,
        cumulativeScoreAtBreak: entry.cumulativeScoreAtBreak,
        sourceLabel:
          entry.sourceUnitDefinitionId === undefined
            ? MEMORY_SOURCE_LABEL
            : (displayNameByDefinitionId.get(entry.sourceUnitDefinitionId) ??
              entry.sourceUnitDefinitionId),
      }))
      .toSorted((a, b) => a.breakNumber - b.breakNumber),
  };
}
