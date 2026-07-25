import { GetBattleSimulationCatalogUseCase } from "../../application/catalog/get-battle-simulation-catalog-use-case.js";
import type { SimulateBattleCommand } from "../../application/simulation/simulate-battle-command.js";
import type { SimulateBattleResult } from "../../application/simulation/simulation-result-assembler.js";
import { SimulateBattleUseCase } from "../../application/simulation/simulate-battle-use-case.js";
import { createUnitDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import type { RandomSource } from "../../domain/ports/random-source.js";
import type { RandomSourceFactory } from "../../domain/ports/random-source-factory.js";
import {
  loadBattleCatalogDirectory,
  loadCatalogFromDirectory,
} from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { ManualClock } from "../clock/manual-clock.js";
import { FixedBattleIdGenerator } from "../id/fixed-battle-id-generator.js";

/** 枯渇しない決定的RandomSource（常に同じ値を返す）。完走の決定化にのみ使う。 */
class ConstantRandomSourceFactory implements RandomSourceFactory {
  private readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
  create(): RandomSource {
    const value = this.value;
    return { next: () => value };
  }
}

/** GET一覧APIが `selectable: true` と報告する production Unit の定義IDを返す。 */
export function selectableProductionUnitIds(catalogDir: string): readonly string[] {
  const directory = loadBattleCatalogDirectory(catalogDir);
  const result = new GetBattleSimulationCatalogUseCase({
    battleCatalogDirectory: directory,
  }).execute();
  return result.units
    .filter((unit) => unit.selectable)
    .map((unit) => String(unit.unitDefinitionId))
    .sort();
}

export interface ProductionBattleOptions {
  readonly turnLimit?: number;
  readonly randomValue?: number;
  readonly battleId?: string;
}

/**
 * 実 `catalog/` をロードし、指定Unitを味方・敵に据えた1対1戦闘を実Formation/Battle/
 * Observationで完走させる（`kei-jackknife-...` テストの前段を汎用化）。乱数はconstant
 * sourceで決定化し、turnLimitで必ず停止する。golden battle 回帰層の実行部。
 */
export function runProductionUnitBattle(
  catalogDir: string,
  unitDefinitionId: string,
  options: ProductionBattleOptions = {},
): SimulateBattleResult {
  const battleCatalog = loadCatalogFromDirectory(catalogDir);
  const slot = {
    unitDefinitionId: createUnitDefinitionId(unitDefinitionId),
    position: { column: 0 as const, row: "FRONT" as const },
  };
  const command: SimulateBattleCommand = {
    allyFormation: { slots: [slot], memoryDefinitionIds: [] },
    enemyFormation: { slots: [slot], memoryDefinitionIds: [] },
    turnLimit: options.turnLimit ?? 5,
    logLevel: "DETAILED",
  };
  const useCase = new SimulateBattleUseCase({
    battleCatalog,
    battleIdGenerator: new FixedBattleIdGenerator([options.battleId ?? "B_GOLDEN"]),
    randomSourceFactory: new ConstantRandomSourceFactory(options.randomValue ?? 0.5),
    clock: new ManualClock(0),
  });
  return useCase.execute(command, {
    requestId: "golden-battle",
    deadlineEpochMs: Number.MAX_SAFE_INTEGER,
  });
}
