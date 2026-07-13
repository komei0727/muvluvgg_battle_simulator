import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer, type SimulateBattleUseCasePort } from "./build-server.js";
import { battleSimulationResponseDocSchema } from "./schemas.js";
import type {
  BattleSimulationResponseBody,
  BattleStateResponseBody,
  BattleUnitStateResponseBody,
  StateTransitionResponseBody,
  ValueChangeBody,
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
 *
 * `12_テスト戦略.md`「差分を一件抜く、逆順にする、重複させると検証が失敗する」
 * 要求のため、単に`after`を上書きするだけでなく、以下を積極的に検証する:
 * 1. 各`stateTransitions[i].stateVersionBefore`が直前の`stateVersionAfter`
 *    （先頭は`initialState.stateVersion`）と連続する。
 * 2. 各`ValueChange.before`が、その時点でReducerが追跡している現在値と一致する
 *    （欠落・逆順・重複はどこかで`before`が現在値とずれて検出される）。
 */
function applyValueChange<T>(current: T, change: ValueChangeBody<T>, path: string): T {
  if (change.before !== current) {
    throw new Error(
      `${path}: ValueChange.before (${JSON.stringify(change.before)}) does not match the Reducer's current value (${JSON.stringify(current)})`,
    );
  }
  return change.after;
}

function applyDelta(
  state: BattleStateResponseBody,
  transition: StateTransitionResponseBody,
  index: number,
): BattleStateResponseBody {
  if (transition.stateVersionBefore !== state.stateVersion) {
    throw new Error(
      `stateTransitions[${index}].stateVersionBefore (${transition.stateVersionBefore}) does not continue from the current stateVersion (${state.stateVersion})`,
    );
  }
  if (transition.stateVersionAfter !== transition.stateVersionBefore + 1) {
    throw new Error(
      `stateTransitions[${index}].stateVersionAfter (${transition.stateVersionAfter}) is not stateVersionBefore + 1`,
    );
  }

  const { delta } = transition;
  const units: readonly BattleUnitStateResponseBody[] = state.units.map((unit) => {
    const unitDelta = delta.units?.[unit.battleUnitId];
    if (unitDelta === undefined) {
      return unit;
    }
    const path = `stateTransitions[${index}].delta.units[${unit.battleUnitId}]`;
    return {
      ...unit,
      combatStatus:
        unitDelta.combatStatus !== undefined
          ? applyValueChange(unit.combatStatus, unitDelta.combatStatus, `${path}.combatStatus`)
          : unit.combatStatus,
      hp:
        unitDelta.hp !== undefined
          ? { ...unit.hp, current: applyValueChange(unit.hp.current, unitDelta.hp, `${path}.hp`) }
          : unit.hp,
      resources: {
        ap:
          unitDelta.resources?.ap !== undefined
            ? {
                ...unit.resources.ap,
                current: applyValueChange(
                  unit.resources.ap.current,
                  unitDelta.resources.ap,
                  `${path}.resources.ap`,
                ),
              }
            : unit.resources.ap,
        pp:
          unitDelta.resources?.pp !== undefined
            ? {
                ...unit.resources.pp,
                current: applyValueChange(
                  unit.resources.pp.current,
                  unitDelta.resources.pp,
                  `${path}.resources.pp`,
                ),
              }
            : unit.resources.pp,
        extraGauge:
          unitDelta.resources?.extraGauge !== undefined
            ? {
                ...unit.resources.extraGauge,
                current: applyValueChange(
                  unit.resources.extraGauge.current,
                  unitDelta.resources.extraGauge,
                  `${path}.resources.extraGauge`,
                ),
              }
            : unit.resources.extraGauge,
      },
    };
  });

  const transitionPath = `stateTransitions[${index}].delta.battle`;
  return {
    ...state,
    stateVersion: transition.stateVersionAfter,
    battleStatus:
      delta.battle?.battleStatus !== undefined
        ? applyValueChange(
            state.battleStatus,
            delta.battle.battleStatus,
            `${transitionPath}.battleStatus`,
          )
        : state.battleStatus,
    turnNumber:
      delta.battle?.turnNumber !== undefined
        ? applyValueChange(
            state.turnNumber,
            delta.battle.turnNumber,
            `${transitionPath}.turnNumber`,
          )
        : state.turnNumber,
    cycleNumber:
      delta.battle?.cycleNumber !== undefined
        ? applyValueChange(
            state.cycleNumber,
            delta.battle.cycleNumber,
            `${transitionPath}.cycleNumber`,
          )
        : state.cycleNumber,
    units,
  };
}

/**
 * `12_テスト戦略.md`「イベントのstateTransitionIndexが対応差分を指す」:
 * `events[].stateTransitionIndex`が指す`stateTransitions`要素の
 * `causedBySequence`が、参照元イベント自身の`sequence`と一致することを
 * 双方向に検証する。
 */
function requireEventTransitionIndexConsistency(body: BattleSimulationResponseBody): void {
  for (const event of body.events) {
    if (event.stateTransitionIndex === undefined) {
      continue;
    }
    const transition = body.stateTransitions[event.stateTransitionIndex];
    if (transition === undefined) {
      throw new Error(
        `event(sequence=${event.sequence}).stateTransitionIndex (${event.stateTransitionIndex}) is out of range for stateTransitions (length ${body.stateTransitions.length})`,
      );
    }
    if (transition.causedBySequence !== event.sequence) {
      throw new Error(
        `event(sequence=${event.sequence}).stateTransitionIndex points to a transition caused by sequence ${transition.causedBySequence}, not itself`,
      );
    }
  }
}

function reconstructFinalState(body: BattleSimulationResponseBody): BattleStateResponseBody {
  requireEventTransitionIndexConsistency(body);
  return body.stateTransitions.reduce(applyDelta, body.initialState);
}

/**
 * `SCN-BTL-001`のlethal-damageシナリオ(#10 acceptance相当)をHTTP経由で
 * 実行する。攻撃側が1撃で防御側を撃破するため、HP/AP変化と撃破の両方を含む
 * `stateTransitions`が得られる。
 */
async function runLethalScenario(): Promise<BattleSimulationResponseBody> {
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
    if (response.statusCode !== 200) {
      throw new Error(`expected 200, got ${response.statusCode}: ${response.body}`);
    }
    return response.json<BattleSimulationResponseBody>();
  } finally {
    await app.close();
  }
}

describe("HTTP response state restoration (independent Reducer)", () => {
  it("API-STATE-RESTORE-001 (10_API設計.md「差分の適用」/12_テスト戦略.md「独立した差分Reducer」): reconstructedFinalState built from the actual HTTP response's initialState + stateTransitions equals its finalState, for a battle with HP/AP/resource changes and a unit defeat", async () => {
    const body = await runLethalScenario();

    // Sanity: this scenario actually changes HP/AP and defeats the enemy —
    // otherwise the restoration below would trivially pass with no deltas.
    expect(body.result.outcome).toBe("ALLY_WIN");
    expect(body.stateTransitions.length).toBeGreaterThan(0);
    const enemyFinal = body.finalState.units.find((u) => u.unitDefinitionId === "UNIT_DEF");
    expect(enemyFinal?.combatStatus).toBe("DEFEATED");
    expect(enemyFinal?.hp.current).toBe(0);

    const reconstructed = reconstructFinalState(body);
    expect(reconstructed).toEqual(body.finalState);

    // This lethal scenario exercises HitConfirmed/CriticalCheckResolved/
    // DamageCalculated/DamageApplied/UnitDefeated — event types the
    // turn-limit scenario in openapi.test.ts's API-OPENAPI-002 never
    // reaches — against the OpenAPI-published per-event `details` schema.
    const ajv = new Ajv({ strict: false });
    const validateDoc = ajv.compile(battleSimulationResponseDocSchema);
    expect(validateDoc(body), JSON.stringify(validateDoc.errors)).toBe(true);
  });

  it("API-STATE-RESTORE-002 (12_テスト戦略.md「差分を...抜く...と検証が失敗する」): rejects a stateTransitions array with a transition removed from the middle (breaks stateVersion continuity)", async () => {
    const body = await runLethalScenario();
    expect(body.stateTransitions.length).toBeGreaterThan(2);
    const withGap = {
      ...body,
      // `events` is cleared so this test isolates the stateVersion-continuity
      // check specifically; otherwise the now-mismatched
      // events[].stateTransitionIndex references would be rejected first
      // (also a correct rejection — API-STATE-RESTORE-005 exercises that
      // event/transition cross-reference invariant on its own).
      events: [],
      stateTransitions: [
        body.stateTransitions[0]!,
        // Drop index 1 — the next transition's stateVersionBefore no longer
        // continues from the reducer's current stateVersion.
        ...body.stateTransitions.slice(2),
      ],
    };

    expect(() => reconstructFinalState(withGap)).toThrow(/does not continue from/);
  });

  it("API-STATE-RESTORE-003 (12_テスト戦略.md「...逆順にする...と検証が失敗する」): rejects a reversed stateTransitions array", async () => {
    const body = await runLethalScenario();
    expect(body.stateTransitions.length).toBeGreaterThan(1);
    const reversed = {
      ...body,
      events: [],
      stateTransitions: [...body.stateTransitions].reverse(),
    };

    expect(() => reconstructFinalState(reversed)).toThrow(/does not continue from/);
  });

  it("API-STATE-RESTORE-004 (12_テスト戦略.md「...重複させると検証が失敗する」): rejects a stateTransitions array with a transition duplicated", async () => {
    const body = await runLethalScenario();
    expect(body.stateTransitions.length).toBeGreaterThan(0);
    const duplicated = {
      ...body,
      events: [],
      stateTransitions: [
        body.stateTransitions[0]!,
        body.stateTransitions[0]!,
        ...body.stateTransitions.slice(1),
      ],
    };

    expect(() => reconstructFinalState(duplicated)).toThrow(/does not continue from/);
  });

  it("API-STATE-RESTORE-004b: rejects stateTransitions whose events[].stateTransitionIndex no longer points back to the transition it claims to have caused (12_テスト戦略.md「イベントのstateTransitionIndexが対応差分を指す」)", async () => {
    const body = await runLethalScenario();
    expect(body.stateTransitions.length).toBeGreaterThan(2);
    // Removing a middle transition, without also fixing up events[], leaves
    // later events' stateTransitionIndex pointing at the wrong transition.
    const withGap = {
      ...body,
      stateTransitions: [body.stateTransitions[0]!, ...body.stateTransitions.slice(2)],
    };

    expect(() => reconstructFinalState(withGap)).toThrow(/stateTransitionIndex/);
  });

  it("API-STATE-RESTORE-005: rejects a transition whose ValueChange.before does not match the Reducer's tracked current value (a corrupted/out-of-order delta that version-continuity alone would not catch)", async () => {
    const body = await runLethalScenario();
    const hpTransitionIndex = body.stateTransitions.findIndex((t) =>
      Object.values(t.delta.units ?? {}).some((u) => u.hp !== undefined),
    );
    expect(hpTransitionIndex).toBeGreaterThanOrEqual(0);
    const original = body.stateTransitions[hpTransitionIndex]!;
    const [battleUnitId, unitDelta] = Object.entries(original.delta.units!).find(
      ([, u]) => u.hp !== undefined,
    )!;
    const corrupted = {
      ...body,
      stateTransitions: body.stateTransitions.map((t, i) =>
        i === hpTransitionIndex
          ? {
              ...t,
              delta: {
                ...t.delta,
                units: {
                  ...t.delta.units,
                  [battleUnitId]: {
                    ...unitDelta,
                    hp: { before: unitDelta.hp!.before + 999, after: unitDelta.hp!.after },
                  },
                },
              },
            }
          : t,
      ),
    };

    expect(() => reconstructFinalState(corrupted)).toThrow(/ValueChange\.before/);
  });
});
