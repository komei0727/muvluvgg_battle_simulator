import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_BATTLE_EVALUATION_LIMITS } from "../../application/simulation/evaluate-battles-command.js";
import { toBattleEvaluationResponseBody } from "../../application/simulation/evaluate-battles-mapper.js";
import { EvaluateBattlesUseCase } from "../../application/simulation/evaluate-battles-use-case.js";
import { DEFAULT_TOTAL_WAR_EVALUATION_LIMITS } from "../../application/simulation/evaluate-total-wars-command.js";
import { toTotalWarEvaluationResponseBody } from "../../application/simulation/evaluate-total-wars-mapper.js";
import { EvaluateTotalWarsUseCase } from "../../application/simulation/evaluate-total-wars-use-case.js";
import type { EvaluationRequestLimits } from "../../application/simulation/evaluation-command.js";
import type { FormationInput } from "../../application/simulation/simulate-battle-command.js";
import {
  createMemoryDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { UuidBattleIdGenerator } from "../../infrastructure/identity/uuid-battle-id-generator.js";
import { Mulberry32SeededRandomSourceProvider } from "../../infrastructure/random/seeded-random-source.js";
import { SystemClock } from "../../infrastructure/time/system-clock.js";
import { MEMORY_HEAVY_FORMATION } from "../../testing/scenario/memory-heavy-formation.js";
import { allProductionUnitIds } from "../../testing/scenario/run-production-battle.js";

/**
 * 大量試行APIの baseline（`12_テスト戦略.md`「負荷・耐久テスト」）。
 *
 * 形式別の`*_MAX_TOTAL_RUNS`の既定値は「本番Cloud Runが明示する`SIMULATION_TIMEOUT_MS=30秒`
 * の7割に、代表的な重い編成で上限いっぱいの要求が収まる」ように実測から決めた。前提が
 * 崩れれば上限まで要求したリクエストが常に部分結果になるため、ここで固定する。長期戦
 * （HPを極端に増やした99ターン戦闘など）は1試行で数秒かかり、上限の根拠にはしない — その
 * 要求は部分結果になるのが正しい挙動である。
 *
 * 応答サイズも記録する。試行ごとに全参加枠の集計を返すため、総力戦は通常戦闘の約3倍になる。
 */
const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const SIMULATION_TIMEOUT_MS = 30_000;
const DEADLINE_BUDGET_RATIO = 0.7;
const CASE_COUNT = 4;
const POSITIONS = [
  { column: 0, row: "FRONT" },
  { column: 1, row: "FRONT" },
  { column: 2, row: "FRONT" },
  { column: 0, row: "REAR" },
  { column: 1, row: "REAR" },
] as const;

function formation(unitIds: readonly string[], memoryIds: readonly string[]): FormationInput {
  return {
    slots: unitIds.map((unitId, index) => ({
      unitDefinitionId: createUnitDefinitionId(unitId),
      position: POSITIONS[index]!,
    })),
    memoryDefinitionIds: memoryIds.map((memoryId) => createMemoryDefinitionId(memoryId)),
  };
}

function dependencies(limits: EvaluationRequestLimits) {
  return {
    battleCatalog: loadCatalogFromDirectory(CATALOG_DIR),
    battleIdGenerator: new UuidBattleIdGenerator(),
    clock: new SystemClock(),
    seededRandomSourceProvider: new Mulberry32SeededRandomSourceProvider(),
    runtimeInfo: { engineRevision: "load" },
    limits,
  };
}

/** 上限いっぱいの試行をケースへ均等に割り振る（ケースごとに番号は0から）。 */
function runIndicesFor(maxTotalRuns: number): number[] {
  return Array.from({ length: Math.floor(maxTotalRuns / CASE_COUNT) }, (_, index) => index);
}

function report(
  baseline: string,
  requestedRuns: number,
  completedRuns: number,
  elapsedMs: number,
  body: unknown,
) {
  console.log(
    JSON.stringify({
      baseline,
      requestedRuns,
      completedRuns,
      elapsedMs,
      msPerRun: Number((elapsedMs / Math.max(completedRuns, 1)).toFixed(2)),
      budgetMs: SIMULATION_TIMEOUT_MS * DEADLINE_BUDGET_RATIO,
      responseBytes: Buffer.byteLength(JSON.stringify(body)),
    }),
  );
}

describe("seeded evaluation load baseline", () => {
  it("LOAD-BEVAL-001: a battle request at BATTLE_EVALUATION_MAX_TOTAL_RUNS with the memory-heaviest 5v5 completes inside the deadline budget", () => {
    const heavy = MEMORY_HEAVY_FORMATION;
    const runIndices = runIndicesFor(DEFAULT_BATTLE_EVALUATION_LIMITS.maxTotalRuns);
    const cases = Array.from({ length: CASE_COUNT }, (_, caseIndex) => ({
      caseId: `heavy-${caseIndex}`,
      allyFormation: formation(heavy.ally, heavy.allyMemories),
      enemyFormation: formation(heavy.enemy, heavy.enemyMemories),
      turnLimit: 99,
      runIndices: runIndices.map((runIndex) => runIndex + caseIndex * runIndices.length),
    }));

    const startedAt = Date.now();
    const result = new EvaluateBattlesUseCase(
      dependencies(DEFAULT_BATTLE_EVALUATION_LIMITS),
    ).execute(
      { seed: "load-beval-001", cases },
      // 予算超過を部分結果ではなく所要時間として観測するため、期限は予算より広く取る。
      { requestId: "load-beval-001", deadlineEpochMs: startedAt + SIMULATION_TIMEOUT_MS * 4 },
    );
    const elapsedMs = Date.now() - startedAt;
    report(
      "LOAD-BEVAL-001",
      result.requestedRuns,
      result.completedRuns,
      elapsedMs,
      toBattleEvaluationResponseBody(result),
    );

    expect(result.partial).toBe(false);
    expect(elapsedMs).toBeLessThan(SIMULATION_TIMEOUT_MS * DEADLINE_BUDGET_RATIO);
  });

  it("LOAD-TWEVAL-001: a total war request at TOTAL_WAR_EVALUATION_MAX_TOTAL_RUNS with 3 formations x 5 units x 6 memories per side completes inside the deadline budget", () => {
    const unitIds = allProductionUnitIds(CATALOG_DIR);
    const memories = MEMORY_HEAVY_FORMATION.allyMemories;
    const side = (offset: number) =>
      [0, 1, 2].map((formationIndex) =>
        formation(
          unitIds.slice(offset + formationIndex * 5, offset + formationIndex * 5 + 5),
          memories,
        ),
      );
    const runIndices = runIndicesFor(DEFAULT_TOTAL_WAR_EVALUATION_LIMITS.maxTotalRuns);
    const cases = Array.from({ length: CASE_COUNT }, (_, caseIndex) => ({
      caseId: `max-${caseIndex}`,
      allyFormations: side(caseIndex * 5),
      enemyFormations: side(15 + caseIndex * 5),
      runIndices,
    }));

    const startedAt = Date.now();
    const result = new EvaluateTotalWarsUseCase(
      dependencies(DEFAULT_TOTAL_WAR_EVALUATION_LIMITS),
    ).execute(
      { seed: "load-tweval-001", cases },
      { requestId: "load-tweval-001", deadlineEpochMs: startedAt + SIMULATION_TIMEOUT_MS * 4 },
    );
    const elapsedMs = Date.now() - startedAt;
    report(
      "LOAD-TWEVAL-001",
      result.requestedRuns,
      result.completedRuns,
      elapsedMs,
      toTotalWarEvaluationResponseBody(result),
    );

    expect(result.partial).toBe(false);
    expect(elapsedMs).toBeLessThan(SIMULATION_TIMEOUT_MS * DEADLINE_BUDGET_RATIO);
  });
});
