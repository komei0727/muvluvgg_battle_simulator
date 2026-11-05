import {
  buildSharedBattleDefinitions,
  DEFAULT_SIMULATION_EXECUTION_LIMITS,
  resolveFormationMemories,
  runBattleToCompletion,
  toExecutionApplicationError,
  type BattleExecutionDependencies,
  type CompletedBattleRun,
} from "./battle-execution.js";
import { toDomainFormationInput } from "./formation-input-mapper.js";
import type { FormationInput } from "./simulate-battle-command.js";
import {
  TOTAL_WAR_TURN_LIMIT,
  type SimulateTotalWarCommand,
} from "./simulate-total-war-command.js";
import { runTotalWarPreflight } from "./simulation-preflight-validator.js";
import type { SimulationExecutionContext } from "./simulation-execution-context.js";
import {
  createTotalWarBattle,
  type TotalWarSideFormationMemories,
  type TotalWarSideFormationUnits,
} from "../../domain/battle/lifecycle/battle.js";
import { createBattleUnitsFromParty } from "../../domain/battle/model/battle-unit.js";
import { createTurnLimit } from "../../domain/battle/model/turn-limit.js";
import { createBattleParty } from "../../domain/formation/formation-factory.js";
import {
  resolveReappearanceMultipliers,
  validateTotalWarFormations,
} from "../../domain/formation/total-war-formation-policy.js";
import type {
  MemoryDefinitionId,
  UnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import { createBattleUnitId, type BattleId, type BattleUnitId } from "../../domain/shared/ids.js";
import type { Side } from "../../domain/shared/side.js";

/** 完了した総力戦から、結果組み立て（Assembler）が必要とするものを取り出した形。 */
export interface ExecutedTotalWar extends CompletedBattleRun {
  readonly battleId: BattleId;
  readonly catalogRevision: string;
  /** R-TWR-02: 再登場ユニットとして基礎値補正を掛けた参加枠。 */
  readonly reappearanceBattleUnitIds: ReadonlySet<BattleUnitId>;
}

interface SideFormations {
  readonly units: TotalWarSideFormationUnits;
  readonly memories: TotalWarSideFormationMemories;
  readonly reappearanceBattleUnitIds: readonly BattleUnitId[];
}

function collectReferencedIds(command: SimulateTotalWarCommand): {
  unitDefinitionIds: UnitDefinitionId[];
  memoryDefinitionIds: MemoryDefinitionId[];
} {
  const unitDefinitionIds = new Set<UnitDefinitionId>();
  const memoryDefinitionIds = new Set<MemoryDefinitionId>();
  for (const formation of [...command.allyFormations, ...command.enemyFormations]) {
    formation.slots.forEach((slot) => unitDefinitionIds.add(slot.unitDefinitionId));
    formation.memoryDefinitionIds.forEach((id) => memoryDefinitionIds.add(id));
  }
  return {
    unitDefinitionIds: [...unitDefinitionIds],
    memoryDefinitionIds: [...memoryDefinitionIds],
  };
}

/**
 * 1陣営の全編成を出撃順に生成する。`BattleUnitId`は陣営内で全編成を通した通し番号にし
 * （`09_アプリケーション設計.md`「編成の生成」）、再登場の係数（R-TWR-02）はDomainの
 * `resolveReappearanceMultipliers`が陣営ごとに決める。
 */
function buildSideFormations(
  side: Side,
  formations: readonly FormationInput[],
  snapshot: BattleCatalogSnapshot,
  path: string,
): SideFormations {
  const prefix = side === "ALLY" ? "ally" : "enemy";
  const domainFormations = formations.map(toDomainFormationInput);
  // R-TWR-01: Command検証と同じ規則を、集約を作る直前の不変条件としてDomainで通す。
  validateTotalWarFormations(domainFormations, new Set(snapshot.memories.keys()), path);
  const multipliers = resolveReappearanceMultipliers(domainFormations);

  let nextNumber = 1;
  const reappearanceBattleUnitIds: BattleUnitId[] = [];
  const units = domainFormations.map((formation, formationIndex) => {
    const formationPath = `${path}[${formationIndex}]`;
    const formationMultipliers = multipliers[formationIndex]!;
    const battleUnitIds = formation.slots.map(() =>
      createBattleUnitId(`${prefix}:${nextNumber++}`),
    );
    battleUnitIds.forEach((battleUnitId, slotIndex) => {
      if (formationMultipliers[slotIndex] !== 1) {
        reappearanceBattleUnitIds.push(battleUnitId);
      }
    });
    const party = createBattleParty(
      side,
      formation,
      battleUnitIds,
      snapshot.units,
      snapshot.memories,
      formationPath,
      formationMultipliers,
    );
    return createBattleUnitsFromParty(party, snapshot.units);
  });
  const memories = formations.map((formation, formationIndex) =>
    resolveFormationMemories(
      formation.memoryDefinitionIds,
      snapshot.memories,
      `${path}[${formationIndex}]`,
    ),
  );

  return { units, memories, reappearanceBattleUnitIds };
}

/**
 * `09_アプリケーション設計.md`「SimulateTotalWarUseCase」の実行本体: Catalogスナップショット
 * 取得 → 全編成分の参照検証 → 編成ごとの`FormationFactory` → `createTotalWarBattle` →
 * 完了までの実行。実行ループ・期限・実行保護の分類は他のモードと共有する。
 *
 * Command検証（`validateTotalWarCommandShape`）は呼び出し側の責務とする — 違反時は
 * Catalogへ一切アクセスせずに返す必要があるためである。
 */
export function executeTotalWarToCompletion(
  command: SimulateTotalWarCommand,
  context: SimulationExecutionContext,
  dependencies: BattleExecutionDependencies,
): ExecutedTotalWar {
  const { unitDefinitionIds, memoryDefinitionIds } = collectReferencedIds(command);
  const snapshot = dependencies.battleCatalog.loadSnapshot(unitDefinitionIds, memoryDefinitionIds);
  const executionLimits = dependencies.executionLimits ?? DEFAULT_SIMULATION_EXECUTION_LIMITS;

  runTotalWarPreflight(command, snapshot);

  try {
    const ally = buildSideFormations("ALLY", command.allyFormations, snapshot, "allyFormations");
    const enemy = buildSideFormations(
      "ENEMY",
      command.enemyFormations,
      snapshot,
      "enemyFormations",
    );

    const battle = createTotalWarBattle(
      dependencies.battleIdGenerator.next(),
      { ALLY: ally.units, ENEMY: enemy.units },
      createTurnLimit(TOTAL_WAR_TURN_LIMIT),
      buildSharedBattleDefinitions(snapshot, executionLimits),
      { ALLY: ally.memories, ENEMY: enemy.memories },
    );
    const ran = runBattleToCompletion(battle, context, dependencies, executionLimits);

    return {
      battleId: battle.battleId,
      catalogRevision: snapshot.catalogRevision,
      ...ran,
      reappearanceBattleUnitIds: new Set([
        ...ally.reappearanceBattleUnitIds,
        ...enemy.reappearanceBattleUnitIds,
      ]),
    };
  } catch (error) {
    throw toExecutionApplicationError(error);
  }
}
