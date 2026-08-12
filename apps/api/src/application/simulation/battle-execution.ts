import { ApplicationError } from "../contracts/application-error.js";
import { toDomainFormationInput } from "./formation-input-mapper.js";
import { runPreflight } from "./simulation-preflight-validator.js";
import type { FormationPairCommand } from "./simulate-battle-command.js";
import type { SimulationExecutionContext } from "./simulation-execution-context.js";
import {
  advanceBattle,
  createBattle,
  startBattle,
  type BattleResult,
} from "../../domain/battle/lifecycle/battle.js";
import {
  captureBattleState,
  captureUnitRoster,
  type BattleStateSnapshot,
  type BattleUnitRosterEntry,
} from "../../domain/battle/lifecycle/battle-state-snapshot.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import type { BattleMode } from "../../domain/battle/model/exercise-runtime.js";
import { createBattleUnitsFromParty } from "../../domain/battle/model/battle-unit.js";
import { createTurnLimit } from "../../domain/battle/model/turn-limit.js";
import { createBattleParty } from "../../domain/formation/formation-factory.js";
import type {
  MemoryDefinitionId,
  UnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { MemoryDefinition } from "../../domain/catalog/definitions/memory-definition.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { BattleCatalog, BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import type { BattleIdGenerator } from "../../domain/ports/battle-id-generator.js";
import type { Clock } from "../../domain/ports/clock.js";
import type { RandomSourceFactory } from "../../domain/ports/random-source-factory.js";
import { DomainValidationError, ExecutionGuardExceededError } from "../../domain/shared/errors.js";
import type { BattleId, BattleUnitId } from "../../domain/shared/ids.js";
import { createBattleUnitId } from "../../domain/shared/ids.js";
import type { Side } from "../../domain/shared/side.js";

/**
 * Battleを完了まで実行するユースケースが共有する依存（`09_アプリケーション設計.md`
 * 「責務一覧」のCatalog・ID生成・乱数・時計）。
 */
export interface BattleExecutionDependencies {
  readonly battleCatalog: BattleCatalog;
  readonly battleIdGenerator: BattleIdGenerator;
  readonly randomSourceFactory: RandomSourceFactory;
  readonly clock: Clock;
}

export interface BattleExecutionOptions {
  readonly mode: BattleMode;
  readonly turnLimit: number;
}

/** 完了したBattleから、結果組み立て（Assembler）が必要とするものだけを取り出した形。 */
export interface ExecutedBattle {
  readonly battleId: BattleId;
  readonly catalogRevision: string;
  readonly result: BattleResult;
  readonly initialState: BattleStateSnapshot;
  readonly finalState: BattleStateSnapshot;
  readonly events: readonly BattleDomainEvent[];
  readonly unitRoster: readonly BattleUnitRosterEntry[];
}

function collectReferencedIds(command: FormationPairCommand): {
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

/**
 * `BattleDefinitions`の`exSkillByUnit`を、`UnitDefinition.extraSkillDefinitionId`
 * とスキル定義のクロージャから構築する（R-ORD-03のEX予約が使用する）。
 * `loadSnapshot`の推移閉包契約により欠落は起こらない前提だが、防御的に検出する。
 */
function buildExSkillByUnit(
  units: BattleCatalogSnapshot["units"],
  skills: BattleCatalogSnapshot["skills"],
): ReadonlyMap<UnitDefinitionId, SkillDefinition> {
  const result = new Map<UnitDefinitionId, SkillDefinition>();
  for (const [unitDefinitionId, unitDefinition] of units) {
    const exSkill = skills.get(unitDefinition.extraSkillDefinitionId);
    if (exSkill === undefined) {
      throw new DomainValidationError(
        `units[${unitDefinitionId}].extraSkillDefinitionId`,
        `references a SkillDefinitionId absent from the loaded Catalog snapshot: "${unitDefinition.extraSkillDefinitionId}"`,
      );
    }
    result.set(unitDefinitionId, exSkill);
  }
  return result;
}

/**
 * R-MEM-02 #1「APIリクエストで指定された Memory の順序」（M7-006、Issue #179）:
 * 各陣営の`memoryDefinitionIds`をリクエストの並びのまま`MemoryDefinition`へ解決する
 * （Setで重複排除する`collectReferencedIds`とは別に、陣営ごとの指定順そのものを
 * Memory候補順の唯一の情報源として保つ）。`loadSnapshot`は参照の推移閉包を返す
 * 契約のため、欠落はCatalogの不変条件違反として防御的に検出する。
 */
function buildMemoriesBySide(
  command: FormationPairCommand,
  memories: BattleCatalogSnapshot["memories"],
): Readonly<Record<Side, readonly MemoryDefinition[]>> {
  const resolve = (
    memoryDefinitionIds: readonly MemoryDefinitionId[],
    path: string,
  ): readonly MemoryDefinition[] =>
    memoryDefinitionIds.map((memoryDefinitionId, index) => {
      const memory = memories.get(memoryDefinitionId);
      if (memory === undefined) {
        throw new DomainValidationError(
          `${path}.memoryDefinitionIds[${index}]`,
          `references a MemoryDefinitionId absent from the loaded Catalog snapshot: "${memoryDefinitionId}"`,
        );
      }
      return memory;
    });
  return {
    ALLY: resolve(command.allyFormation.memoryDefinitionIds, "allyFormation"),
    ENEMY: resolve(command.enemyFormation.memoryDefinitionIds, "enemyFormation"),
  };
}

function buildBattleDefinitions(
  snapshot: BattleCatalogSnapshot,
  command: FormationPairCommand,
): BattleDefinitions {
  return {
    activeSkillsByUnit: buildActiveSkillsByUnit(snapshot.units, snapshot.skills),
    exSkillByUnit: buildExSkillByUnit(snapshot.units, snapshot.skills),
    effectActions: snapshot.effectActions,
    unitDefinitions: snapshot.units,
    skillDefinitions: snapshot.skills,
    memoriesBySide: buildMemoriesBySide(command, snapshot.memories),
  };
}

/**
 * `09_アプリケーション設計.md`「SimulateTacticalExerciseUseCase」が
 * `SimulateBattleUseCase`と共有する実行本体: Catalogスナップショット取得 →
 * preflight検証 → `FormationFactory` → `Battle`生成 → 完了までの実行。戦闘モードと
 * 規定ターン数だけがユースケースごとに異なる（演習は`TACTICAL_EXERCISE`と
 * `EXERCISE_TURN_LIMIT`を渡す）。
 *
 * Command検証（`validateCommandShape`／`validateTacticalExerciseCommandShape`）は
 * 呼び出し側の責務として残す — ユースケースごとに受理条件が異なり（R-TEX-01 #3）、
 * 違反時はCatalogへ一切アクセスせずに返す必要があるためである。
 */
export function executeBattleToCompletion(
  command: FormationPairCommand,
  context: SimulationExecutionContext,
  dependencies: BattleExecutionDependencies,
  options: BattleExecutionOptions,
): ExecutedBattle {
  const { unitDefinitionIds, memoryDefinitionIds } = collectReferencedIds(command);
  const snapshot = dependencies.battleCatalog.loadSnapshot(unitDefinitionIds, memoryDefinitionIds);

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

    const battleId = dependencies.battleIdGenerator.next();
    // 09_アプリケーション設計.md「Battleごとに専用のRandomSourceを生成する」
    // 「リクエスト間で共有しない」: このBattleの生存期間全体で1つだけ生成する。
    const random = dependencies.randomSourceFactory.create();
    // 08_ドメインイベント.md「イベント発行と処理」: BattleごとにEventRecorderを
    // 1つだけ生成し、開始から完了までの全イベントを蓄積させる。
    const recorder = new EventRecorder(battleId);
    let battle = createBattle(
      battleId,
      allyUnits,
      enemyUnits,
      createTurnLimit(options.turnLimit),
      buildBattleDefinitions(snapshot, command),
      options.mode,
    );
    const initialState = captureBattleState(battle);
    const unitRoster = captureUnitRoster(battle);
    battle = startBattle(battle, random, recorder);
    while (battle.status !== "COMPLETED") {
      // `11_インフラストラクチャ設計.md`「キャンセルと期限」段階1（協調的停止）:
      // ターン境界（advanceBattle呼び出し前）という安全な内部境界で
      // deadlineEpochMsを確認する。期限超過を勝敗結果として返さず、
      // ここまでに確定した状態も一切返さない。
      if (dependencies.clock.now() >= context.deadlineEpochMs) {
        throw new ApplicationError("EXECUTION_TIMEOUT", [
          {
            reason: `simulation exceeded its deadline (deadlineEpochMs=${context.deadlineEpochMs})`,
          },
        ]);
      }
      battle = advanceBattle(battle, random, recorder);
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
      result,
      initialState,
      finalState: captureBattleState(battle),
      events: recorder.getEvents(),
      unitRoster,
    };
  } catch (error) {
    if (error instanceof ExecutionGuardExceededError) {
      // 09_アプリケーション設計.md「実行保護」: イベント数・PS深度・効果数の
      // SimulationExecutionGuard上限超過はクライアント入力エラーではなく
      // `EXECUTION_LIMIT_EXCEEDED`（HTTP 503）として返す。
      throw new ApplicationError("EXECUTION_LIMIT_EXCEEDED", [{ reason: error.message }]);
    }
    if (error instanceof DomainValidationError) {
      // 09_アプリケーション設計.md「ドメインエラーの変換」: 編成・値オブジェクト
      // 生成時の入力違反はINVALID_COMMANDへ変換する。事前検証(preflight)を
      // 通過済みのため、通常はここへ到達しない防御的な経路。
      throw new ApplicationError("INVALID_COMMAND", [{ path: error.path, reason: error.message }]);
    }
    throw error;
  }
}
