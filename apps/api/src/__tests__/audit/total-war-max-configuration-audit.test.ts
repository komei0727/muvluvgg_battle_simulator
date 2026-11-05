import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIMULATION_EXECUTION_LIMITS,
  type SimulationExecutionLimits,
} from "../../application/simulation/battle-execution.js";
import type { FormationInput } from "../../application/simulation/simulate-battle-command.js";
import type { SimulateTotalWarCommand } from "../../application/simulation/simulate-total-war-command.js";
import { SimulateTotalWarUseCase } from "../../application/simulation/simulate-total-war-use-case.js";
import {
  createMemoryDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import { GetBattleSimulationCatalogUseCase } from "../../application/catalog/get-battle-simulation-catalog-use-case.js";
import {
  loadBattleCatalogDirectory,
  loadCatalogFromDirectory,
} from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { Mulberry32SeededRandomSourceProvider } from "../../infrastructure/random/seeded-random-source.js";
import { SystemClock } from "../../infrastructure/time/system-clock.js";
import { FixedBattleIdGenerator } from "../../testing/id/fixed-battle-id-generator.js";
import { allProductionUnitIds } from "../../testing/scenario/run-production-battle.js";

/**
 * 総力戦の最大構成（各陣営3編成×5体×6メモリー、通算15ターン）が、本番と同じ実行保護
 * （`DEFAULT_SIMULATION_EXECUTION_LIMITS`）と期限（`SIMULATION_TIMEOUT_MS`の既定値）の
 * もとで完走することを確かめる。盤面に同時に立つのは常に10体で、ターン数は通常戦闘の
 * 上限99より小さいため、上限値は通常戦闘のものをそのまま使えることをここで実証する。
 */
const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
/** `bootstrap/config.ts`の`SIMULATION_TIMEOUT_MS`既定値。 */
const DEFAULT_SIMULATION_TIMEOUT_MS = 50_000;
const FORMATIONS_PER_SIDE = 3;
const UNITS_PER_FORMATION = 5;
const MEMORIES_PER_FORMATION = 6;
/** 全ユニットのHPへ掛けるモジュール補正の割合。15ターン戦っても全滅しない大きさにする。 */
const DURABLE_HP_RATIO = 10_000;
const POSITIONS = [
  { column: 0, row: "FRONT" },
  { column: 1, row: "FRONT" },
  { column: 2, row: "FRONT" },
  { column: 0, row: "REAR" },
  { column: 1, row: "REAR" },
] as const;

function allProductionMemoryIds(): readonly string[] {
  const result = new GetBattleSimulationCatalogUseCase({
    battleCatalogDirectory: loadBattleCatalogDirectory(CATALOG_DIR),
  }).execute();
  return result.memories.map((memory) => String(memory.memoryDefinitionId)).sort();
}

/**
 * 陣営1つ分の3編成。ユニットとメモリーは`offset`から順に取り、Catalogの末尾で先頭へ
 * 折り返す。1編成内の重複（R-TWR-01 #3・#4）は起こらず、編成をまたぐ重複は再登場
 * （R-TWR-02）として受理される。
 */
function sideFormations(
  unitIds: readonly string[],
  memoryIds: readonly string[],
  offset: number,
): readonly FormationInput[] {
  return Array.from({ length: FORMATIONS_PER_SIDE }, (_, formationIndex) => {
    const base = offset + formationIndex * UNITS_PER_FORMATION;
    return {
      slots: POSITIONS.map((position, slotIndex) => ({
        unitDefinitionId: createUnitDefinitionId(unitIds[(base + slotIndex) % unitIds.length]!),
        position,
      })),
      memoryDefinitionIds: Array.from({ length: MEMORIES_PER_FORMATION }, (_, memoryIndex) =>
        createMemoryDefinitionId(
          memoryIds[
            (offset + formationIndex * MEMORIES_PER_FORMATION + memoryIndex) % memoryIds.length
          ]!,
        ),
      ),
    };
  });
}

function runMaxConfiguration(
  command: SimulateTotalWarCommand,
  seed: string,
  executionLimits: SimulationExecutionLimits = DEFAULT_SIMULATION_EXECUTION_LIMITS,
) {
  const clock = new SystemClock();
  const useCase = new SimulateTotalWarUseCase({
    battleCatalog: loadCatalogFromDirectory(CATALOG_DIR),
    battleIdGenerator: new FixedBattleIdGenerator([`B_${seed}`]),
    randomSourceFactory: new Mulberry32SeededRandomSourceProvider().forRun(seed, 0),
    clock,
    executionLimits,
  });
  const startedAt = clock.now();
  const result = useCase.execute(command, {
    requestId: seed,
    deadlineEpochMs: startedAt + DEFAULT_SIMULATION_TIMEOUT_MS,
  });
  return { result, durationMs: clock.now() - startedAt };
}

describe("total war maximum configuration audit", () => {
  const unitIds = allProductionUnitIds(CATALOG_DIR);
  const memoryIds = allProductionMemoryIds();

  it("IT-AUDIT-TWMAX-001 [R-TWR-01, R-TWR-06]: 3 formations x 5 units x 6 memories per side completes within 15 turns under the default execution limits and timeout", () => {
    expect(unitIds.length).toBeGreaterThanOrEqual(FORMATIONS_PER_SIDE * UNITS_PER_FORMATION * 2);

    // 異なる組み合わせで複数回走らせ、早期決着だけでなく長引く対戦も含める。
    const matchups = [0, 7, 19].map((offset) => ({
      offset,
      command: {
        allyFormations: sideFormations(unitIds, memoryIds, offset),
        enemyFormations: sideFormations(
          unitIds,
          memoryIds,
          offset + FORMATIONS_PER_SIDE * UNITS_PER_FORMATION,
        ),
        logLevel: "DETAILED" as const,
      },
    }));

    for (const { offset, command } of matchups) {
      const { result, durationMs } = runMaxConfiguration(command, `twmax-${offset}`);

      expect(result.completedTurn).toBeLessThanOrEqual(15);
      expect(["ALLY_WIN", "ALLY_LOSE", "DRAW"]).toContain(result.outcome);
      expect(result.unitRoster).toHaveLength(FORMATIONS_PER_SIDE * UNITS_PER_FORMATION * 2);
      expect(result.events.length).toBeLessThan(DEFAULT_SIMULATION_EXECUTION_LIMITS.maxTotalEvents);
      expect(durationMs).toBeLessThan(DEFAULT_SIMULATION_TIMEOUT_MS);
      console.info(
        JSON.stringify({
          testId: "IT-AUDIT-TWMAX-001",
          offset,
          outcome: result.outcome,
          completionReason: result.completionReason,
          completedTurn: result.completedTurn,
          stages: result.stages.length,
          events: result.events.length,
          durationMs: Math.round(durationMs),
        }),
      );
    }
  });

  it("IT-AUDIT-TWMAX-002 [R-TWR-02, R-TWR-06]: the same maximum configuration with every formation reusing the same five units (all later ones reappear) also completes", () => {
    const sameUnits = (offset: number): readonly FormationInput[] => {
      const formations = sideFormations(unitIds, memoryIds, offset);
      return formations.map((formation) => ({ ...formation, slots: formations[0]!.slots }));
    };

    const { result } = runMaxConfiguration(
      {
        allyFormations: sameUnits(0),
        enemyFormations: sameUnits(FORMATIONS_PER_SIDE * UNITS_PER_FORMATION),
        logLevel: "DETAILED",
      },
      "twmax-reappearance",
    );

    expect(result.completedTurn).toBeLessThanOrEqual(15);
    expect(result.unitRoster.filter((entry) => entry.reappearance)).toHaveLength(
      (FORMATIONS_PER_SIDE - 1) * UNITS_PER_FORMATION * 2,
    );
  });

  it("IT-AUDIT-TWMAX-003 [R-TWR-01, R-TWR-06] (R-TWR-06 #1): a maximum configuration whose units are made durable enough to survive runs the full 15 turns to the turn limit under the default limits and timeout", () => {
    // 本番Catalogの編成どうしは攻撃有利で数ターンのうちに決着するため、モジュール補正
    // （R-ENH-08）でHPだけを大きくし、最も長い経路（15ターン目の時間切れ）を通す。
    const durable = (formations: readonly FormationInput[]): readonly FormationInput[] =>
      formations.map((formation) => ({
        ...formation,
        // R-ENH-01: ユニットの強化指定は、所属する編成が強化指定を持つときだけ受理される。
        enhancement: {},
        slots: formation.slots.map((slot) => ({
          ...slot,
          enhancement: { module: { hp: { ratio: DURABLE_HP_RATIO } } },
        })),
      }));

    const { result, durationMs } = runMaxConfiguration(
      {
        allyFormations: durable(sideFormations(unitIds, memoryIds, 0)),
        enemyFormations: durable(
          sideFormations(unitIds, memoryIds, FORMATIONS_PER_SIDE * UNITS_PER_FORMATION),
        ),
        logLevel: "DETAILED",
      },
      "twmax-durable",
    );

    expect(result).toMatchObject({
      outcome: "DRAW",
      completionReason: "TURN_LIMIT_REACHED",
      completedTurn: 15,
    });
    expect(durationMs).toBeLessThan(DEFAULT_SIMULATION_TIMEOUT_MS);
    console.info(
      JSON.stringify({
        testId: "IT-AUDIT-TWMAX-003",
        events: result.events.length,
        stateTransitions: result.stateTransitions.length,
        durationMs: Math.round(durationMs),
      }),
    );
  });
});
