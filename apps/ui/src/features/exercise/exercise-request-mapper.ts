// Mirrors docs/ui-design/03_API・データ連携設計.md §2.3 and docs/ddd/10_API設計.md
// 「TacticalExerciseRequest」: 編成部分は戦闘シミュレーションと同じ`FormationRequest`
// を再利用し、`turnLimit`を持たない。

import { buildFormation } from "../formation/request-mapper.js";
import type { FormationRequest, RequestBuildResult } from "../formation/request-mapper.js";
import { enhancementForSide } from "../formation/types.js";
import type { BattleDraft, LogLevel, SideEnhancementInput } from "../formation/types.js";

export interface TacticalExerciseRequest {
  readonly allyFormation: FormationRequest;
  readonly enemyFormation: FormationRequest;
  readonly options: { readonly logLevel: LogLevel };
}

const EXERCISE_ENEMY_UNIT_COUNT = 1;

/**
 * UI-AC-041: 単一実行は「ログを読むための1回」であり、演習の画面からログレベルの
 * 選択そのものが無くなった（Issue #539）。`SUMMARY`を選ぶ動機だった「大量実行して
 * 集計を見る」は統計実行が担うため、draftに残っている値に依らず`DETAILED`で送る。
 */
const SINGLE_RUN_LOG_LEVEL: LogLevel = "DETAILED";

/**
 * UI-AC-020: 演習の敵は強化を持たない（`R-TEX-01` #1）。画面が敵強化の入力を
 * 出さないことに依存せず、リクエスト生成側でも強化無効として組み立てる。
 * `enabled: false` は陣営単位の`enhancement`とユニット単位の`enhancement`の
 * 両方を出力対象から外す（`request-mapper.ts` の`buildFormation`）。
 */
function disabledEnhancement(enhancement: SideEnhancementInput): SideEnhancementInput {
  return { ...enhancement, enabled: false };
}

/**
 * UI-API-014: `turnLimit`を出力せず、敵ちょうど1体・敵メモリー0件を送信前に強制する。
 * 演習モードの画面は敵枠を1つしか出さないが、リクエスト生成側でも制約を満たさない
 * draftを組み立てないことで、画面の作りに依存せず契約違反の送信を防ぐ。
 */
export function buildTacticalExerciseRequest(
  draft: BattleDraft,
): RequestBuildResult<TacticalExerciseRequest> {
  const ally = buildFormation(
    "ally",
    draft.allySlots,
    draft.allyMemoryDefinitionIds,
    enhancementForSide(draft, "ally"),
  );
  const enemy = buildFormation(
    "enemy",
    draft.enemySlots,
    draft.enemyMemoryDefinitionIds,
    disabledEnhancement(enhancementForSide(draft, "enemy")),
  );
  if (ally === undefined || enemy === undefined) {
    return { ok: false };
  }
  if (enemy.formation.units.length !== EXERCISE_ENEMY_UNIT_COUNT) {
    return { ok: false };
  }
  if (enemy.formation.memoryDefinitionIds.length > 0) {
    return { ok: false };
  }

  return {
    ok: true,
    request: {
      allyFormation: ally.formation,
      enemyFormation: enemy.formation,
      options: { logLevel: SINGLE_RUN_LOG_LEVEL },
    },
    allyUnitSlotKeys: ally.unitSlotKeys,
    enemyUnitSlotKeys: enemy.unitSlotKeys,
    allyMemorySlotKeys: ally.memorySlotKeys,
    enemyMemorySlotKeys: enemy.memorySlotKeys,
    allyGearSlotIndices: ally.gearSlotIndices,
    enemyGearSlotIndices: enemy.gearSlotIndices,
  };
}

/**
 * `10_API設計.md`「TacticalExerciseEvaluationRequest」。統計実行の1チャンク分の本文。
 * `options`（`logLevel`）を持たない —— 返るのは試行ごとの数値だけで、イベント列も
 * 状態遷移も返らないため、公開レベルという概念自体が無い。
 */
export interface TacticalExerciseEvaluationRequest {
  readonly enemyFormation: FormationRequest;
  readonly candidates: readonly { readonly allyFormation: FormationRequest }[];
  readonly runsPerCandidate: number;
  /**
   * 送信seed。省略するとサーバーが生成する（Q-TEX-17）が、統計実行はチャンクごとに
   * `#<runOffset>`を付けた別seedを送る必要があるため常に指定する。
   */
  readonly seed: string;
}

export interface TacticalExerciseEvaluationRequestOptions {
  readonly runsPerCandidate: number;
  readonly seed: string;
}

/**
 * 一括評価の本文を組み立てる。編成部分・敵の制約は単一実行（`buildTacticalExerciseRequest`）
 * と完全に同じものを使う —— 統計実行と単一実行で編成の解釈が分かれると、単一実行で
 * ログを確かめてから統計を取る使い方が成立しない。候補は常に1件で、複数編成の比較は
 * この画面の役目ではない。
 */
export function buildTacticalExerciseEvaluationRequest(
  draft: BattleDraft,
  { runsPerCandidate, seed }: TacticalExerciseEvaluationRequestOptions,
): RequestBuildResult<TacticalExerciseEvaluationRequest> {
  const single = buildTacticalExerciseRequest(draft);
  if (!single.ok) {
    return { ok: false };
  }
  const { allyFormation, enemyFormation } = single.request;

  return {
    ...single,
    request: {
      enemyFormation,
      candidates: [{ allyFormation }],
      runsPerCandidate,
      seed,
    },
  };
}

/**
 * 送信した編成部分のJSON表現。実行回数とシードは含めない —— この2つは結果表示に
 * 出ているため、画面から読み取れない編成の変化だけを比べる。
 *
 * `buildFormation`が同じdraftから同じキー順・同じ並びのリクエストを組み立てるので、
 * 文字列比較がそのまま構造比較になる（`selectIsResultDirty`と同じ考え）。実行時と
 * 現在のdraftで別々に組み立てると、片方にキーを足したときに常時不一致になる。
 */
export function evaluationFormationSignature(request: TacticalExerciseEvaluationRequest): string {
  return JSON.stringify({
    enemyFormation: request.enemyFormation,
    candidates: request.candidates,
  });
}
