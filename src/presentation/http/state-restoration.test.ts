import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer, type SimulateBattleUseCasePort } from "./build-server.js";
import type {
  BattleSimulationResponseBody,
  BattleStateResponseBody,
  BattleUnitStateResponseBody,
  StateTransitionResponseBody,
} from "../../application/http-contract.js";
import { SimulateBattleUseCase } from "../../application/simulate-battle-use-case.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
} from "../../domain/catalog/catalog-ids.js";
import type { EffectActionDefinition } from "../../domain/catalog/effect-action-definition.js";
import type { SkillDefinition } from "../../domain/catalog/skill-definition.js";
import type { TargetSelectorDefinition } from "../../domain/catalog/target-selector-definition.js";
import type { UnitDefinition } from "../../domain/catalog/unit-definition.js";
import type { BattleCatalog, BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import { FixedBattleIdGenerator } from "../../testing/id/fixed-battle-id-generator.js";
import { SequenceRandomSourceFactory } from "../../testing/random/sequence-random-source-factory.js";

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

const ENEMY_ALL: TargetSelectorDefinition = {
  kind: "SELECT",
  side: "ENEMY",
  count: "ALL",
  filters: [],
  order: ["DEFAULT"],
  includeDefeated: false,
};

function attackSkill(id: string, effectActionId: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [{ targetBindingId: createTargetBindingId("TGT_1"), selector: ENEMY_ALL }],
      steps: [
        {
          kind: "ACTION",
          condition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(effectActionId) }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    requiredCapabilities: [],
    metadata: { displayName: "Attack", tags: [] },
  };
}

function damageEffectAction(id: string): EffectActionDefinition {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: 1 },
      hitCount: 1,
      critical: { mode: "NORMAL" },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

class FakeBattleCatalog implements BattleCatalog {
  private readonly units: ReadonlyMap<ReturnType<typeof createUnitDefinitionId>, UnitDefinition>;
  private readonly skills: ReadonlyMap<ReturnType<typeof createSkillDefinitionId>, SkillDefinition>;
  private readonly effectActions: ReadonlyMap<
    ReturnType<typeof createEffectActionDefinitionId>,
    EffectActionDefinition
  >;

  constructor(
    units: ReadonlyMap<ReturnType<typeof createUnitDefinitionId>, UnitDefinition>,
    skills: ReadonlyMap<ReturnType<typeof createSkillDefinitionId>, SkillDefinition>,
    effectActions: ReadonlyMap<
      ReturnType<typeof createEffectActionDefinitionId>,
      EffectActionDefinition
    >,
  ) {
    this.units = units;
    this.skills = skills;
    this.effectActions = effectActions;
  }

  loadSnapshot(): BattleCatalogSnapshot {
    return {
      catalogRevision: "rev-1",
      units: this.units,
      skills: this.skills,
      effectActions: this.effectActions,
      memories: new Map(),
      capabilities: new Map(),
    };
  }
}

/**
 * `12_テスト戦略.md`「独立した差分Reducer」: productionのBattleObservationや
 * ResultAssemblerを一切呼び出さず、HTTPレスポンスの`stateTransitions`だけを
 * 見て`initialState`から`finalState`を独自に再構築する。Response Mapperが
 * 行うネスト変換（`resources.{ap,pp,extraGauge}`）や`combatStatus`の導出に
 * 欠陥があっても、Application内部のReducerテストでは検出できないため、
 * この復元は必ず実際のHTTPレスポンスbodyへ対して行う。
 */
function applyDelta(
  state: BattleStateResponseBody,
  transition: StateTransitionResponseBody,
): BattleStateResponseBody {
  const { delta } = transition;
  const units: readonly BattleUnitStateResponseBody[] = state.units.map((unit) => {
    const unitDelta = delta.units?.[unit.battleUnitId];
    if (unitDelta === undefined) {
      return unit;
    }
    return {
      ...unit,
      combatStatus: unitDelta.combatStatus?.after ?? unit.combatStatus,
      hp: unitDelta.hp !== undefined ? { ...unit.hp, current: unitDelta.hp.after } : unit.hp,
      resources: {
        ap:
          unitDelta.resources?.ap !== undefined
            ? { ...unit.resources.ap, current: unitDelta.resources.ap.after }
            : unit.resources.ap,
        pp:
          unitDelta.resources?.pp !== undefined
            ? { ...unit.resources.pp, current: unitDelta.resources.pp.after }
            : unit.resources.pp,
        extraGauge:
          unitDelta.resources?.extraGauge !== undefined
            ? { ...unit.resources.extraGauge, current: unitDelta.resources.extraGauge.after }
            : unit.resources.extraGauge,
      },
    };
  });

  return {
    ...state,
    stateVersion: transition.stateVersionAfter,
    battleStatus: delta.battle?.battleStatus?.after ?? state.battleStatus,
    turnNumber: delta.battle?.turnNumber?.after ?? state.turnNumber,
    cycleNumber: delta.battle?.cycleNumber?.after ?? state.cycleNumber,
    units,
  };
}

function reconstructFinalState(body: BattleSimulationResponseBody): BattleStateResponseBody {
  return body.stateTransitions.reduce(applyDelta, body.initialState);
}

describe("HTTP response state restoration (independent Reducer)", () => {
  it("API-STATE-RESTORE-001 (10_API設計.md「差分の適用」/12_テスト戦略.md「独立した差分Reducer」): reconstructedFinalState built from the actual HTTP response's initialState + stateTransitions equals its finalState, for a battle with HP/AP/resource changes and a unit defeat", async () => {
    const skillId = "SKL_LETHAL";
    const effectActionId = "ACT_LETHAL";
    const attackerUnit: UnitDefinition = {
      ...unitDefinition("UNIT_ATK"),
      baseStats: { ...unitDefinition("UNIT_ATK").baseStats, maximumAp: 1, attack: 999 },
      activeSkillDefinitionIds: [createSkillDefinitionId(skillId)],
    };
    const defenderUnit: UnitDefinition = {
      ...unitDefinition("UNIT_DEF"),
      baseStats: { ...unitDefinition("UNIT_DEF").baseStats, maximumHp: 10, defense: 0 },
    };
    const units = new Map([
      [createUnitDefinitionId("UNIT_ATK"), attackerUnit],
      [createUnitDefinitionId("UNIT_DEF"), defenderUnit],
    ]);
    const skills = new Map([
      [createSkillDefinitionId(skillId), attackSkill(skillId, effectActionId)],
    ]);
    const effectActions = new Map([
      [createEffectActionDefinitionId(effectActionId), damageEffectAction(effectActionId)],
    ]);

    const useCase: SimulateBattleUseCasePort = new SimulateBattleUseCase({
      battleCatalog: new FakeBattleCatalog(units, skills, effectActions),
      battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
      randomSourceFactory: new SequenceRandomSourceFactory([0.99]),
    });
    const app: FastifyInstance = await buildServer(useCase);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/battle-simulations",
        payload: {
          allyFormation: {
            units: [{ unitDefinitionId: "UNIT_ATK", position: { column: 0, row: "FRONT" } }],
            memoryDefinitionIds: [],
          },
          enemyFormation: {
            units: [{ unitDefinitionId: "UNIT_DEF", position: { column: 0, row: "FRONT" } }],
            memoryDefinitionIds: [],
          },
          turnLimit: 5,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<BattleSimulationResponseBody>();

      // Sanity: this scenario actually changes HP/AP and defeats the enemy —
      // otherwise the restoration below would trivially pass with no deltas.
      expect(body.result.outcome).toBe("ALLY_WIN");
      expect(body.stateTransitions.length).toBeGreaterThan(0);
      const enemyFinal = body.finalState.units.find((u) => u.unitDefinitionId === "UNIT_DEF");
      expect(enemyFinal?.combatStatus).toBe("DEFEATED");
      expect(enemyFinal?.hp.current).toBe(0);

      const reconstructed = reconstructFinalState(body);
      expect(reconstructed).toEqual(body.finalState);
    } finally {
      await app.close();
    }
  });
});
