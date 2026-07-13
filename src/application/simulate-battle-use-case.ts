import { ApplicationError } from "./application-error.js";
import { toDomainFormationInput } from "./formation-input-mapper.js";
import { runPreflight } from "./simulation-preflight-validator.js";
import { validateCommandShape, type SimulateBattleCommand } from "./simulate-battle-command.js";
import { advanceBattle, createBattle, startBattle } from "../domain/battle/battle.js";
import { createBattleUnitsFromParty } from "../domain/battle/battle-unit.js";
import { createBattleParty } from "../domain/battle/formation-factory.js";
import { createTurnLimit } from "../domain/battle/turn-limit.js";
import type { CompletionReason, BattleOutcome } from "../domain/battle/victory-policy.js";
import type { MemoryDefinitionId, UnitDefinitionId } from "../domain/catalog/catalog-ids.js";
import type { BattleIdGenerator } from "../domain/ports/battle-id-generator.js";
import type { BattleCatalog } from "../domain/ports/battle-catalog.js";
import { DomainValidationError } from "../domain/shared/errors.js";
import type { BattleId, BattleUnitId } from "../domain/shared/ids.js";
import { createBattleUnitId } from "../domain/shared/ids.js";

export interface SimulateBattleResult {
  readonly battleId: BattleId;
  readonly catalogRevision: string;
  readonly outcome: BattleOutcome;
  readonly completionReason: CompletionReason;
  readonly completedTurn: number;
}

export interface SimulateBattleUseCaseDependencies {
  readonly battleCatalog: BattleCatalog;
  readonly battleIdGenerator: BattleIdGenerator;
}

function collectReferencedIds(command: SimulateBattleCommand): {
  unitDefinitionIds: UnitDefinitionId[];
  memoryDefinitionIds: MemoryDefinitionId[];
} {
  const unitDefinitionIds = new Set<UnitDefinitionId>();
  const memoryDefinitionIds = new Set<MemoryDefinitionId>();
  for (const formation of [command.allyFormation, command.enemyFormation]) {
    for (const slot of formation.slots) {
      unitDefinitionIds.add(slot.unitDefinitionId);
    }
    for (const memoryDefinitionId of formation.memoryDefinitionIds) {
      memoryDefinitionIds.add(memoryDefinitionId);
    }
  }
  return {
    unitDefinitionIds: [...unitDefinitionIds],
    memoryDefinitionIds: [...memoryDefinitionIds],
  };
}

/** `09_アプリケーション設計.md`: 各陣営の入力枠へ一意なBattleUnitIdを割り当てる。入力順はID生成だけに使う。 */
function assignBattleUnitIds(prefix: "ally" | "enemy", count: number): BattleUnitId[] {
  return Array.from({ length: count }, (_, index) => createBattleUnitId(`${prefix}:${index + 1}`));
}

/**
 * `09_アプリケーション設計.md` の SimulateBattleUseCase。`13_実装計画.md`
 * 「M3 最小戦闘縦切り」のライフサイクル部分のみを扱う。ActionQueue・AS選択・
 * ダメージ・イベントログ・BattleObservationは後続Issue（#14/#9/#10）で拡張する。
 */
export class SimulateBattleUseCase {
  private readonly battleCatalog: BattleCatalog;
  private readonly battleIdGenerator: BattleIdGenerator;

  constructor(dependencies: SimulateBattleUseCaseDependencies) {
    this.battleCatalog = dependencies.battleCatalog;
    this.battleIdGenerator = dependencies.battleIdGenerator;
  }

  execute(command: SimulateBattleCommand): SimulateBattleResult {
    const shapeViolations = validateCommandShape(command);
    if (shapeViolations.length > 0) {
      throw new ApplicationError("INVALID_COMMAND", shapeViolations);
    }

    const { unitDefinitionIds, memoryDefinitionIds } = collectReferencedIds(command);
    const snapshot = this.battleCatalog.loadSnapshot(unitDefinitionIds, memoryDefinitionIds);

    runPreflight(command, snapshot);

    try {
      const allyBattleUnitIds = assignBattleUnitIds("ally", command.allyFormation.slots.length);
      const enemyBattleUnitIds = assignBattleUnitIds("enemy", command.enemyFormation.slots.length);

      const allyParty = createBattleParty(
        "ALLY",
        toDomainFormationInput(command.allyFormation),
        allyBattleUnitIds,
        snapshot.units,
        snapshot.memories,
        "allyFormation",
      );
      const enemyParty = createBattleParty(
        "ENEMY",
        toDomainFormationInput(command.enemyFormation),
        enemyBattleUnitIds,
        snapshot.units,
        snapshot.memories,
        "enemyFormation",
      );

      const allyUnits = createBattleUnitsFromParty(allyParty, snapshot.units);
      const enemyUnits = createBattleUnitsFromParty(enemyParty, snapshot.units);

      const battleId = this.battleIdGenerator.next();
      let battle = createBattle(
        battleId,
        allyUnits,
        enemyUnits,
        createTurnLimit(command.turnLimit),
      );
      battle = startBattle(battle);
      while (battle.status !== "COMPLETED") {
        battle = advanceBattle(battle);
      }

      const result = battle.result;
      if (result === undefined) {
        throw new ApplicationError("INTERNAL_INVARIANT_VIOLATION", [
          { reason: "Battle reached COMPLETED without a result" },
        ]);
      }

      return {
        battleId,
        catalogRevision: snapshot.catalogRevision,
        outcome: result.outcome,
        completionReason: result.completionReason,
        completedTurn: result.completedTurn,
      };
    } catch (error) {
      if (error instanceof DomainValidationError) {
        // 09_アプリケーション設計.md「ドメインエラーの変換」: 編成・値オブジェクト
        // 生成時の入力違反はINVALID_COMMANDへ変換する。事前検証(preflight)を
        // 通過済みのため、通常はここへ到達しない防御的な経路。
        throw new ApplicationError("INVALID_COMMAND", [
          { path: error.path, reason: error.message },
        ]);
      }
      throw error;
    }
  }
}
