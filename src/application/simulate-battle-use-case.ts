import { ApplicationError } from "./application-error.js";
import { toDomainFormationInput } from "./formation-input-mapper.js";
import {
  assembleSimulationResult,
  type SimulateBattleResult,
} from "./simulation-result-assembler.js";
import { runPreflight } from "./simulation-preflight-validator.js";
import { validateCommandShape, type SimulateBattleCommand } from "./simulate-battle-command.js";
import { advanceBattle, createBattle, startBattle } from "../domain/battle/battle.js";
import type { BattleDefinitions } from "../domain/battle/battle-definitions.js";
import { createBattleUnitsFromParty } from "../domain/battle/battle-unit.js";
import { captureBattleState } from "../domain/battle/events/battle-state-snapshot.js";
import { EventRecorder } from "../domain/battle/events/event-recorder.js";
import { createBattleParty } from "../domain/battle/formation-factory.js";
import { createTurnLimit } from "../domain/battle/turn-limit.js";
import type { MemoryDefinitionId, UnitDefinitionId } from "../domain/catalog/catalog-ids.js";
import type { SkillDefinition } from "../domain/catalog/skill-definition.js";
import type { BattleIdGenerator } from "../domain/ports/battle-id-generator.js";
import type { BattleCatalog, BattleCatalogSnapshot } from "../domain/ports/battle-catalog.js";
import type { RandomSourceFactory } from "../domain/ports/random-source-factory.js";
import { DomainValidationError } from "../domain/shared/errors.js";
import type { BattleUnitId } from "../domain/shared/ids.js";
import { createBattleUnitId } from "../domain/shared/ids.js";

export interface SimulateBattleUseCaseDependencies {
  readonly battleCatalog: BattleCatalog;
  readonly battleIdGenerator: BattleIdGenerator;
  readonly randomSourceFactory: RandomSourceFactory;
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
 * `BattleDefinitions`の`activeSkillsByUnit`を、`BattleCatalogSnapshot`が持つ
 * `UnitDefinition.activeSkillDefinitionIds`とスキル定義のクロージャから構築する。
 * `loadSnapshot`はUnit定義が参照する定義の推移閉包を返す契約のため、ここでの
 * 欠落はCatalogの不変条件違反として防御的に検出する。
 */
function buildActiveSkillsByUnit(
  units: BattleCatalogSnapshot["units"],
  skills: BattleCatalogSnapshot["skills"],
): ReadonlyMap<UnitDefinitionId, readonly SkillDefinition[]> {
  const result = new Map<UnitDefinitionId, readonly SkillDefinition[]>();
  for (const [unitDefinitionId, unitDefinition] of units) {
    const activeSkills = unitDefinition.activeSkillDefinitionIds.map((skillDefinitionId) => {
      const skill = skills.get(skillDefinitionId);
      if (skill === undefined) {
        throw new DomainValidationError(
          `units[${unitDefinitionId}].activeSkillDefinitionIds`,
          `references a SkillDefinitionId absent from the loaded Catalog snapshot: "${skillDefinitionId}"`,
        );
      }
      return skill;
    });
    result.set(unitDefinitionId, activeSkills);
  }
  return result;
}

function buildBattleDefinitions(snapshot: BattleCatalogSnapshot): BattleDefinitions {
  return {
    activeSkillsByUnit: buildActiveSkillsByUnit(snapshot.units, snapshot.skills),
    effectActions: snapshot.effectActions,
  };
}

/**
 * `09_アプリケーション設計.md` の SimulateBattleUseCase。`13_実装計画.md`
 * 「M3 最小戦闘縦切り」のうち、ActionQueue・AS選択・命中・会心・ダメージ・
 * 勝敗までを扱う。イベントログ・BattleObservationは後続Issue（#10）で拡張する。
 */
export class SimulateBattleUseCase {
  private readonly battleCatalog: BattleCatalog;
  private readonly battleIdGenerator: BattleIdGenerator;
  private readonly randomSourceFactory: RandomSourceFactory;

  constructor(dependencies: SimulateBattleUseCaseDependencies) {
    this.battleCatalog = dependencies.battleCatalog;
    this.battleIdGenerator = dependencies.battleIdGenerator;
    this.randomSourceFactory = dependencies.randomSourceFactory;
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
      // 09_アプリケーション設計.md「Battleごとに専用のRandomSourceを生成する」
      // 「リクエスト間で共有しない」: このBattleの生存期間全体で1つだけ生成する。
      const random = this.randomSourceFactory.create();
      // 08_ドメインイベント.md「イベント発行と処理」: BattleごとにEventRecorderを
      // 1つだけ生成し、開始から完了までの全イベントを蓄積させる。
      const recorder = new EventRecorder(battleId);
      let battle = createBattle(
        battleId,
        allyUnits,
        enemyUnits,
        createTurnLimit(command.turnLimit),
        buildBattleDefinitions(snapshot),
      );
      const initialState = captureBattleState(battle);
      battle = startBattle(battle, recorder);
      while (battle.status !== "COMPLETED") {
        battle = advanceBattle(battle, random, recorder);
      }

      const result = battle.result;
      if (result === undefined) {
        throw new ApplicationError("INTERNAL_INVARIANT_VIOLATION", [
          { reason: "Battle reached COMPLETED without a result" },
        ]);
      }

      return assembleSimulationResult({
        battleId,
        catalogRevision: snapshot.catalogRevision,
        logLevel: command.logLevel,
        result,
        initialState,
        finalState: captureBattleState(battle),
        events: recorder.getEvents(),
      });
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
