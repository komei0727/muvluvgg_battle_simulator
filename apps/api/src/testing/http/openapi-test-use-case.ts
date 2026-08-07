import type { BattleSimulationRequestBody } from "../../application/contracts/request.js";
import { toSimulateBattleCommand } from "../../application/simulation/simulate-battle-request-mapper.js";
import { SimulateBattleUseCase } from "../../application/simulation/simulate-battle-use-case.js";
import type { SimulationExecutionContext } from "../../application/simulation/simulation-execution-context.js";
import type { SimulateBattleUseCasePort } from "../../presentation/http/build-server.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import type { BattleCatalog, BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import { ManualClock } from "../clock/manual-clock.js";
import { FixedBattleIdGenerator } from "../id/fixed-battle-id-generator.js";
import { SequenceRandomSourceFactory } from "../random/sequence-random-source-factory.js";

/**
 * OpenAPI文書そのものを検証するテスト（`openapi.test.ts` /
 * `openapi-compatibility.test.ts` / `openapi-baseline.test.ts`）が共有する
 * 最小のUseCase実体。
 *
 * 文書の形は`routes/`と`schemas/`だけで決まりCatalogの中身に依存しないが、
 * `buildServer`はportを要求するため、決定的に完走する最小Catalogを与える。
 */
function unitDefinition(id: string): UnitDefinition {
  return {
    unitDefinitionId: createUnitDefinitionId(id),
    attribute: "AGGRESSIVE",
    unitType: "PHYSICAL",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT", "BACK"],
    baseStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
      actionSpeed: 10,
      maximumAp: 3,
      maximumPp: 3,
    },
    extraGaugeMaximum: 100,
    activeSkillDefinitionIds: [],
    passiveSkillDefinitionIds: [],
    extraSkillDefinitionId: createSkillDefinitionId("SKL_EX"),
    requiredCapabilities: [],
    metadata: { displayName: id, characterName: id, characterId: id, affiliations: [], tags: [] },
  };
}

/** `unitDefinition`の`extraSkillDefinitionId`（"SKL_EX"）が参照するEXスキル。EXゲージは満タンにならないため実際には使用されない。 */
function exSkillDefinition(id: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "EX",
    cost: { resource: "EX_GAUGE", amount: 100 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    requiredCapabilities: [],
    metadata: { displayName: id, tags: [] },
  };
}

class FakeBattleCatalog implements BattleCatalog {
  private readonly units: ReadonlyMap<ReturnType<typeof createUnitDefinitionId>, UnitDefinition>;

  constructor(units: ReadonlyMap<ReturnType<typeof createUnitDefinitionId>, UnitDefinition>) {
    this.units = units;
  }

  loadSnapshot(): BattleCatalogSnapshot {
    return {
      catalogRevision: "rev-1",
      units: this.units,
      skills: new Map([[createSkillDefinitionId("SKL_EX"), exSkillDefinition("SKL_EX")]]),
      effectActions: new Map(),
      memories: new Map(),
      capabilities: new Map(),
    };
  }
}

/** `build-server.test.ts`と同様、Worker経由の実体を薄いdirect adapterで代替する。 */
function toDirectExecutor(useCase: SimulateBattleUseCase): SimulateBattleUseCasePort {
  return {
    execute: (request: BattleSimulationRequestBody, context: SimulationExecutionContext) =>
      Promise.resolve(useCase.execute(toSimulateBattleCommand(request), context)),
  };
}

/** 単一Unit `UNIT_001` だけを持つCatalogで動く`SimulateBattleUseCasePort`。 */
export function buildOpenApiTestUseCase(): SimulateBattleUseCasePort {
  const units = new Map([[createUnitDefinitionId("UNIT_001"), unitDefinition("UNIT_001")]]);
  return toDirectExecutor(
    new SimulateBattleUseCase({
      battleCatalog: new FakeBattleCatalog(units),
      battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
      randomSourceFactory: new SequenceRandomSourceFactory([]),
      clock: new ManualClock(Date.now()),
    }),
  );
}
