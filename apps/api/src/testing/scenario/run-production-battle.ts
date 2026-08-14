import { GetBattleSimulationCatalogUseCase } from "../../application/catalog/get-battle-simulation-catalog-use-case.js";
import type { SimulateBattleCommand } from "../../application/simulation/simulate-battle-command.js";
import type { SimulateTacticalExerciseCommand } from "../../application/simulation/simulate-tactical-exercise-command.js";
import type { SimulateBattleResult } from "../../application/simulation/simulation-result-assembler.js";
import { SimulateBattleUseCase } from "../../application/simulation/simulate-battle-use-case.js";
import { SimulateTacticalExerciseUseCase } from "../../application/simulation/simulate-tactical-exercise-use-case.js";
import { createUnitDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import type { RandomSource } from "../../domain/ports/random-source.js";
import type { RandomSourceFactory } from "../../domain/ports/random-source-factory.js";
import {
  loadBattleCatalogDirectory,
  loadCatalogFromDirectory,
} from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import {
  requireFullObservation,
  type FullObservationBattleResult,
  type FullObservationExerciseResult,
} from "./run-scenario.js";
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

/**
 * 通常戦闘で編成可能な production Unit（`PLAYABLE`）の定義IDを全件返す。
 * R-TEX-11: `EXERCISE_ENEMY`は通常戦闘へ編成できないため、通常戦闘を完走させる
 * golden・監査・doc-schema層はこの一覧を使う。
 */
export function allProductionUnitIds(catalogDir: string): readonly string[] {
  return allProductionUnitIdsByCategory(catalogDir, "PLAYABLE");
}

/** 戦術演習の敵としてだけ編成できる production Unit（`EXERCISE_ENEMY`）の定義ID全件。 */
export function allExerciseEnemyProductionUnitIds(catalogDir: string): readonly string[] {
  return allProductionUnitIdsByCategory(catalogDir, "EXERCISE_ENEMY");
}

function allProductionUnitIdsByCategory(catalogDir: string, category: string): readonly string[] {
  const directory = loadBattleCatalogDirectory(catalogDir);
  const result = new GetBattleSimulationCatalogUseCase({
    battleCatalogDirectory: directory,
  }).execute();
  return result.units
    .filter((unit) => unit.category === category)
    .map((unit) => String(unit.unitDefinitionId))
    .sort();
}

export interface ProductionBattleOptions {
  readonly turnLimit?: number;
  readonly randomValue?: number;
  readonly battleId?: string;
  readonly logLevel?: SimulateBattleCommand["logLevel"];
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
): FullObservationBattleResult {
  const battleCatalog = loadCatalogFromDirectory(catalogDir);
  const slot = {
    unitDefinitionId: createUnitDefinitionId(unitDefinitionId),
    position: { column: 0 as const, row: "FRONT" as const },
  };
  const command: SimulateBattleCommand = {
    allyFormation: { slots: [slot], memoryDefinitionIds: [] },
    enemyFormation: { slots: [slot], memoryDefinitionIds: [] },
    turnLimit: options.turnLimit ?? 5,
    logLevel: options.logLevel ?? "DETAILED",
  };
  const useCase = new SimulateBattleUseCase({
    battleCatalog,
    battleIdGenerator: new FixedBattleIdGenerator([options.battleId ?? "B_GOLDEN"]),
    randomSourceFactory: new ConstantRandomSourceFactory(options.randomValue ?? 0.5),
    clock: new ManualClock(0),
  });
  return requireFullObservation(
    useCase.execute(command, {
      requestId: "golden-battle",
      deadlineEpochMs: Number.MAX_SAFE_INTEGER,
    }),
  );
}

/** 6スロット（前列3・後列3）を左から詰めて割り当てる。 */
function partySlots(unitDefinitionIds: readonly string[]): SimulateBattleCommand["allyFormation"] {
  const columns = [0, 1, 2] as const;
  return {
    slots: unitDefinitionIds.map((id, index) => ({
      unitDefinitionId: createUnitDefinitionId(id),
      position: {
        column: columns[index % 3]!,
        row: index < 3 ? ("FRONT" as const) : ("REAR" as const),
      },
    })),
    memoryDefinitionIds: [],
  };
}

/**
 * 異なる production ユニットを混成した編成同士の実戦闘。1対1ミラー戦
 * （{@link runProductionUnitBattle}）では現れない「別ユニットの定義同士が同じ盤面で
 * 噛み合うか」を通す層。行適性（`positionAptitudes`）は配置制限ではなく統計ペナルティ
 * （R-STA-01）なので、任意の組み合わせを任意の位置へ置ける。
 */
export function runProductionPartyBattle(
  catalogDir: string,
  parties: { readonly ally: readonly string[]; readonly enemy: readonly string[] },
  options: ProductionBattleOptions = {},
): FullObservationBattleResult {
  const battleCatalog = loadCatalogFromDirectory(catalogDir);
  const command: SimulateBattleCommand = {
    allyFormation: partySlots(parties.ally),
    enemyFormation: partySlots(parties.enemy),
    turnLimit: options.turnLimit ?? 5,
    logLevel: options.logLevel ?? "DETAILED",
  };
  const useCase = new SimulateBattleUseCase({
    battleCatalog,
    battleIdGenerator: new FixedBattleIdGenerator([options.battleId ?? "B_GOLDEN_PARTY"]),
    randomSourceFactory: new ConstantRandomSourceFactory(options.randomValue ?? 0.5),
    clock: new ManualClock(0),
  });
  return requireFullObservation(
    useCase.execute(command, {
      requestId: "golden-party-battle",
      deadlineEpochMs: Number.MAX_SAFE_INTEGER,
    }),
  );
}

/**
 * 実 `catalog/` 上で戦術演習（`TACTICAL_EXERCISE`）を完走させる。味方は
 * {@link runProductionPartyBattle} と同じ詰め方の混成パーティ、敵は演習ユニット1体
 * （R-TEX-01 #3）。演習ユニット追加ごとの golden 回帰層の実行部。
 */
export function runProductionExerciseBattle(
  catalogDir: string,
  matchup: { readonly ally: readonly string[]; readonly enemyUnitDefinitionId: string },
  options: Pick<ProductionBattleOptions, "randomValue" | "battleId" | "logLevel"> = {},
): FullObservationExerciseResult {
  const battleCatalog = loadCatalogFromDirectory(catalogDir);
  const command: SimulateTacticalExerciseCommand = {
    allyFormation: partySlots(matchup.ally),
    enemyFormation: {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId(matchup.enemyUnitDefinitionId),
          position: { column: 0 as const, row: "FRONT" as const },
        },
      ],
      memoryDefinitionIds: [],
    },
    logLevel: options.logLevel ?? "DETAILED",
  };
  const useCase = new SimulateTacticalExerciseUseCase({
    battleCatalog,
    battleIdGenerator: new FixedBattleIdGenerator([options.battleId ?? "B_GOLDEN_TEX"]),
    randomSourceFactory: new ConstantRandomSourceFactory(options.randomValue ?? 0.5),
    clock: new ManualClock(0),
  });
  return requireFullObservation(
    useCase.execute(command, {
      requestId: "golden-exercise-battle",
      deadlineEpochMs: Number.MAX_SAFE_INTEGER,
    }),
  );
}

/**
 * Catalogを一度だけロードし、同じ定義グラフで戦闘を繰り返し実行するrunnerを返す
 * （`11_インフラストラクチャ設計.md`「Workerごとにcatalogを一度だけ読み込む」に整合。
 * 負荷・耐久テストで1戦あたりコストからcatalogロードを除外するため）。
 */
export function createProductionBattleRunner(
  catalogDir: string,
  unitDefinitionId: string,
  options: ProductionBattleOptions = {},
): (battleId: string) => SimulateBattleResult {
  const battleCatalog = loadCatalogFromDirectory(catalogDir);
  const slot = {
    unitDefinitionId: createUnitDefinitionId(unitDefinitionId),
    position: { column: 0 as const, row: "FRONT" as const },
  };
  const command: SimulateBattleCommand = {
    allyFormation: { slots: [slot], memoryDefinitionIds: [] },
    enemyFormation: { slots: [slot], memoryDefinitionIds: [] },
    turnLimit: options.turnLimit ?? 5,
    logLevel: options.logLevel ?? "DETAILED",
  };
  const randomSourceFactory = new ConstantRandomSourceFactory(options.randomValue ?? 0.5);
  const clock = new ManualClock(0);
  return (battleId: string): FullObservationBattleResult => {
    const useCase = new SimulateBattleUseCase({
      battleCatalog,
      battleIdGenerator: new FixedBattleIdGenerator([battleId]),
      randomSourceFactory,
      clock,
    });
    return requireFullObservation(
      useCase.execute(command, {
        requestId: `soak-${battleId}`,
        deadlineEpochMs: Number.MAX_SAFE_INTEGER,
      }),
    );
  };
}
