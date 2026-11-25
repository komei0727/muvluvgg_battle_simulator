import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  FormationInput,
  SimulateBattleCommand,
} from "../../application/simulation/simulate-battle-command.js";
import { SimulateBattleUseCase } from "../../application/simulation/simulate-battle-use-case.js";
import {
  createMemoryDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { Mulberry32SeededRandomSourceProvider } from "../../infrastructure/random/seeded-random-source.js";
import { ManualClock } from "../../testing/clock/manual-clock.js";
import { FixedBattleIdGenerator } from "../../testing/id/fixed-battle-id-generator.js";
import { MEMORY_HEAVY_FORMATION } from "../../testing/scenario/memory-heavy-formation.js";

/**
 * 両陣営がメモリーを積んだ通常戦闘が、本番と同じ実行保護
 * （`DEFAULT_SIMULATION_EXECUTION_LIMITS`）のもとで完走することを確かめる。
 * 戦闘開始時の1解決スコープには、両陣営のメモリーが味方全体・敵全体へ付与する効果と
 * 戦闘開始時PSの効果がまとめて積まれるため、メモリーなしの編成だけで決めた上限では
 * 正常な戦闘が`EXECUTION_LIMIT_EXCEEDED`で落ちる。
 */
const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
/** カバレッジ計測下では本番Catalogの戦闘が既定値（5秒）を超えうる。 */
const AUDIT_TEST_TIMEOUT_MS = 60_000;

const PACKED_POSITIONS = [
  [0, "FRONT"],
  [1, "FRONT"],
  [2, "FRONT"],
  [0, "REAR"],
  [1, "REAR"],
] as const;

type Slot = readonly [unitDefinitionId: string, column: 0 | 1 | 2, row: "FRONT" | "REAR"];

function formation(slots: readonly Slot[], memories: readonly string[]): FormationInput {
  return {
    slots: slots.map(([unitDefinitionId, column, row]) => ({
      unitDefinitionId: createUnitDefinitionId(unitDefinitionId),
      position: { column, row },
    })),
    memoryDefinitionIds: memories.map((id) => createMemoryDefinitionId(id)),
  };
}

function runBattle(command: SimulateBattleCommand, seed: string) {
  return new SimulateBattleUseCase({
    battleCatalog: loadCatalogFromDirectory(CATALOG_DIR),
    battleIdGenerator: new FixedBattleIdGenerator([`B_${seed}`]),
    randomSourceFactory: new Mulberry32SeededRandomSourceProvider().forRun(seed, 0),
    clock: new ManualClock(0),
  }).execute(command, { requestId: seed, deadlineEpochMs: Number.MAX_SAFE_INTEGER });
}

describe("memory-heavy formations under the default execution limits", () => {
  it(
    "IT-AUDIT-MEMSCOPE-001: both sides carrying memories (ally 4, enemy 6) resolve the battle-start scope and complete instead of failing with EXECUTION_LIMIT_EXCEEDED",
    () => {
      const command: SimulateBattleCommand = {
        allyFormation: formation(
          [
            ["UNIT_DOROTHEA_GRACE", 0, "FRONT"],
            ["UNIT_LAYLA_ENTREPRENEUR", 2, "REAR"],
            ["UNIT_URUU_SUMMER", 1, "FRONT"],
            ["UNIT_HIIRO_FREEWOLF", 2, "FRONT"],
            ["UNIT_LILY_SINGER", 0, "REAR"],
          ],
          [
            "MEM_FATHERS_AND_MY_WISH",
            "MEM_STRANGERS",
            "MEM_NEW_PATH_FOR_THE_WORLD",
            "MEM_ENCOUNTER_WITH_GIRLS",
          ],
        ),
        enemyFormation: formation(
          [
            ["UNIT_ELENA_MOODMAKER", 1, "REAR"],
            ["UNIT_CHIZURU_DOMESTIC", 0, "FRONT"],
            ["UNIT_OLGA_VETERAN", 1, "FRONT"],
            ["UNIT_ANIS_TROUBLEMAKER", 0, "REAR"],
            ["UNIT_URUU_SUMMER", 2, "FRONT"],
          ],
          [
            "MEM_OJOSAMA_MANNERS",
            "MEM_STRANGERS",
            "MEM_NEW_PATH_FOR_THE_WORLD",
            "MEM_ELOPEMENT_FULL_THROTTLE",
            "MEM_FUUKI_IINKAI",
            "MEM_PYXIS_MA_SOEUR",
          ],
        ),
        turnLimit: 15,
        logLevel: "DETAILED",
      };

      const result = runBattle(command, "memscope-001");

      expect(["ALLY_WIN", "ALLY_LOSE", "DRAW"]).toContain(result.outcome);
    },
    AUDIT_TEST_TIMEOUT_MS,
  );

  it(
    "IT-AUDIT-MEMSCOPE-002: the known memory-heavy maximum (both sides 6 memories plus the units with the most battle-start grants) completes under the default execution limits",
    () => {
      const packed = (unitIds: readonly string[]): readonly Slot[] =>
        unitIds.map((unitId, index) => [unitId, ...PACKED_POSITIONS[index]!] as const);
      const command: SimulateBattleCommand = {
        allyFormation: formation(
          packed(MEMORY_HEAVY_FORMATION.ally),
          MEMORY_HEAVY_FORMATION.allyMemories,
        ),
        enemyFormation: formation(
          packed(MEMORY_HEAVY_FORMATION.enemy),
          MEMORY_HEAVY_FORMATION.enemyMemories,
        ),
        turnLimit: 99,
        logLevel: "DETAILED",
      };

      const result = runBattle(command, "memscope-002");

      expect(["ALLY_WIN", "ALLY_LOSE", "DRAW"]).toContain(result.outcome);
    },
    AUDIT_TEST_TIMEOUT_MS,
  );
});
