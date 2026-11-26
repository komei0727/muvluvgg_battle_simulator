import type {
  TacticalExerciseEvaluationRequest,
  TacticalExerciseEvaluationResponse,
  TacticalExerciseEvaluationRunResponse,
} from "../shared/api/api-contract.js";

/** 1試行分の観測値。省略した値は`runIndex`から決まる決定的な既定値になる。 */
export interface EvaluationRunValues {
  readonly totalScore?: number;
  readonly breakCount?: number;
  readonly completedTurn?: number;
  readonly completionReason?: TacticalExerciseEvaluationRunResponse["completionReason"];
  /** 味方枠ごとの与ダメージ。長さは要求の味方編成の枠数に合わせる。 */
  readonly allyDamage?: readonly number[];
  /** 味方枠ごとのブレイク回数。 */
  readonly allyBreaks?: readonly number[];
}

export interface EvaluationResponseOptions {
  readonly catalogRevision?: string;
  readonly engineRevision?: string;
  readonly seedDerivationVersion?: string;
  /** 先頭から何件の要求番号を完了させるか（期限到達の部分結果）。省略時は全件。 */
  readonly completed?: number;
  readonly run?: (runIndex: number, allySlotCount: number) => EvaluationRunValues;
}

function runRecord(
  runIndex: number,
  allyUnitDefinitionIds: readonly string[],
  values: EvaluationRunValues,
): TacticalExerciseEvaluationRunResponse {
  const allyDamage = values.allyDamage ?? allyUnitDefinitionIds.map(() => 500);
  const allyBreaks = values.allyBreaks ?? allyUnitDefinitionIds.map(() => 1);
  return {
    runIndex,
    totalScore: values.totalScore ?? 1000 + runIndex,
    breakCount: values.breakCount ?? allyBreaks.reduce((total, count) => total + count, 0),
    completionReason: values.completionReason ?? "TURN_LIMIT_REACHED",
    completedTurn: values.completedTurn ?? 5,
    units: [
      ...allyUnitDefinitionIds.map((unitDefinitionId, unitIndex) => ({
        side: "ALLY" as const,
        unitIndex,
        unitDefinitionId,
        damageDealt: allyDamage[unitIndex] ?? 0,
        damageTaken: 0,
        healingDone: 0,
        finalHp: 100,
        maximumHp: 100,
        combatStatus: "ACTIVE" as const,
      })),
      {
        side: "ENEMY" as const,
        unitIndex: 0,
        unitDefinitionId: "UNIT_ENEMY",
        damageDealt: 0,
        damageTaken: 0,
        healingDone: 0,
        finalHp: 100,
        maximumHp: 100,
        combatStatus: "ACTIVE" as const,
      },
    ],
    allyUnitBreaks: allyUnitDefinitionIds.map((unitDefinitionId, unitIndex) => ({
      unitIndex,
      unitDefinitionId,
      breakCount: allyBreaks[unitIndex] ?? 0,
    })),
  };
}

/**
 * 要求をそのまま映した大量試行の応答。実サーバーと同じく、要求の`seed`・`caseId`・
 * `runIndices`を返し、完了しなかった番号は`incompleteRunIndices`へ要求順のまま並べる。
 */
export function evaluationResponseFor(
  request: TacticalExerciseEvaluationRequest,
  options: EvaluationResponseOptions = {},
): TacticalExerciseEvaluationResponse {
  const cases = request.cases.map((caseRequest) => {
    const allyIds = caseRequest.allyFormation.units.map((unit) => unit.unitDefinitionId);
    const completed = options.completed ?? caseRequest.runIndices.length;
    return {
      caseId: caseRequest.caseId,
      runs: caseRequest.runIndices
        .slice(0, completed)
        .map((runIndex) =>
          runRecord(runIndex, allyIds, options.run?.(runIndex, allyIds.length) ?? {}),
        ),
      incompleteRunIndices: caseRequest.runIndices.slice(completed),
    };
  });
  const requestedRuns = request.cases.reduce((total, c) => total + c.runIndices.length, 0);
  const completedRuns = cases.reduce((total, c) => total + c.runs.length, 0);
  return {
    schemaVersion: 1,
    seed: request.seed,
    seedDerivationVersion: options.seedDerivationVersion ?? "MULBERRY32_FNV1A_SPLITMIX32_V1",
    catalogRevision: options.catalogRevision ?? "rev-1",
    engineRevision: options.engineRevision ?? "engine-1",
    requestedRuns,
    completedRuns,
    partial: completedRuns < requestedRuns,
    cases,
  };
}
