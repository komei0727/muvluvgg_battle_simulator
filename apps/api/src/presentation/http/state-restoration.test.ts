import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer, type SimulateBattleUseCasePort } from "./build-server.js";
import { battleSimulationResponseDocSchema } from "./schemas.js";
import type {
  BattleSimulationRequestBody,
  BattleSimulationResponseBody,
  BattleStateResponseBody,
  BattleUnitStateResponseBody,
  ChargeStateResponseBody,
  CooldownStateResponseBody,
  StateTransitionResponseBody,
  UnitStateDeltaResponseBody,
  ValueChangeBody,
} from "../../application/http-contract.js";
import { toSimulateBattleCommand } from "../../application/simulate-battle-request-mapper.js";
import { SimulateBattleUseCase } from "../../application/simulate-battle-use-case.js";
import type { SimulationExecutionContext } from "../../application/simulation-execution-context.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { TargetSelectorDefinition } from "../../domain/catalog/definitions/target-selector-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import type { BattleCatalog, BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import { ManualClock } from "../../testing/clock/manual-clock.js";
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

/** `unitDefinition`の`extraSkillDefinitionId`（"SKL_EX"）が参照するEXスキル。EXゲージは満タンにならないため実際には使用されない。 */
function exSkillDefinition(id: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "EX",
    cost: { resource: "EX_GAUGE", amount: 100 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
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
/**
 * `10_API設計.md`「UnitStateDeltaResponse.cooldowns」(`EntityCollectionDelta`)を
 * `BattleUnitStateResponseBody.cooldowns`（残数>0のスキルだけの配列）へ適用する。
 */
function applyCooldownsDelta(
  current: readonly CooldownStateResponseBody[],
  delta: UnitStateDeltaResponseBody["cooldowns"],
): readonly CooldownStateResponseBody[] {
  if (delta === undefined) {
    return current;
  }
  let next = [...current];
  for (const entry of delta.added) {
    next = [...next, entry as CooldownStateResponseBody];
  }
  for (const entry of delta.updated) {
    next = next.map((cooldown) =>
      cooldown.skillDefinitionId === entry.id
        ? { ...cooldown, remaining: entry.after as number }
        : cooldown,
    );
  }
  for (const entry of delta.removed) {
    next = next.filter((cooldown) => cooldown.skillDefinitionId !== entry.id);
  }
  return next;
}

/** `10_API設計.md`「UnitStateDeltaResponse.charge」(`ValueChange`)を適用する。`after: null`はチャージ終了(省略)を表す。 */
function applyChargeDelta(
  current: ChargeStateResponseBody | undefined,
  delta: UnitStateDeltaResponseBody["charge"],
): ChargeStateResponseBody | undefined {
  if (delta === undefined) {
    return current;
  }
  return delta.after === null ? undefined : (delta.after as ChargeStateResponseBody);
}

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
    const charge = applyChargeDelta(unit.charge, unitDelta.charge);
    // `unit.charge` (spread via `...rest`) must not leak through when `charge`
    // was cleared to `undefined` — plain object spread only adds/overwrites
    // keys, it never deletes a key already present on the spread source.
    const { charge: _staleCharge, ...rest } = unit;
    return {
      ...rest,
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
      cooldowns: applyCooldownsDelta(unit.cooldowns, unitDelta.cooldowns),
      ...(charge !== undefined ? { charge } : {}),
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
 * `events[].stateTransitionIndex`と`stateTransitions[].causedBySequence`の
 * 対応を双方向に検証する。
 *
 * 1. 順方向 — `event.stateTransitionIndex`が指す`stateTransitions`要素の
 *    `causedBySequence`が、参照元イベント自身の`sequence`と一致する。
 * 2. 逆方向 — `stateTransitions[i].causedBySequence`と同じ`sequence`を持つ
 *    イベントが`events`に公開されている場合（SUMMARYなどで原因イベントが
 *    非公開になることは許容する）、そのイベントの`stateTransitionIndex`が
 *    `i`を指す。順方向だけの検証では、「原因イベントは公開されているのに
 *    `stateTransitionIndex`が欠落・別indexを指す」壊れ方を見逃す
 *    （`stateTransitionIndex`を持たないイベントは単に読み飛ばすだけなので）。
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

  const eventsBySequence = new Map(body.events.map((event) => [event.sequence, event]));
  body.stateTransitions.forEach((transition, index) => {
    const causingEvent = eventsBySequence.get(transition.causedBySequence);
    if (causingEvent === undefined) {
      // The causing event is not published at this logLevel — allowed
      // (`10_API設計.md`「SUMMARYで原因イベントが非公開でも、causedBySequenceは
      // 元のイベント連番を保持する」）。
      return;
    }
    if (causingEvent.stateTransitionIndex !== index) {
      throw new Error(
        `stateTransitions[${index}] is caused by sequence ${transition.causedBySequence}, but that published event's stateTransitionIndex is ${String(causingEvent.stateTransitionIndex)}, not ${index}`,
      );
    }
  });
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
    [createSkillDefinitionId("SKL_EX"), exSkillDefinition("SKL_EX")],
  ]);
  const effectActions = new Map([
    [createEffectActionDefinitionId(effectActionId), damageEffectAction(effectActionId)],
  ]);

  const useCase: SimulateBattleUseCasePort = {
    execute: (request: BattleSimulationRequestBody, context: SimulationExecutionContext) =>
      Promise.resolve(
        new SimulateBattleUseCase({
          battleCatalog: new FakeBattleCatalog(units, skills, effectActions),
          battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
          randomSourceFactory: new SequenceRandomSourceFactory([0.99]),
          clock: new ManualClock(Date.now()),
        }).execute(toSimulateBattleCommand(request), context),
      ),
  };
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

/** `action-phase-resolver.test.ts`のchargeSkillと同形（R-SKL-05）: 発動はチャージ開始とは別行動、`cooldown`は開始行動へ設定される。 */
function chargeSkill(id: string, effectActionId: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    resolution: {
      kind: "CHARGE",
      targetBindings: [],
      steps: [],
      chargeRelease: {
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
    },
    cooldown: { unit: "ACTION", count: 2 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    requiredCapabilities: [],
    metadata: { displayName: "Charge", tags: [] },
  };
}

/**
 * `action-phase-resolver.test.ts`のUT-ACTION-PHASE-013と同じ配置(`maximumAp: 1`、
 * cooldown count 2)をHTTP経由で実行する。ChargeStarted→ChargeReleasedで
 * cooldown/chargeの両方が動くため、`stateTransitions`のcooldowns
 * (`EntityCollectionDelta`)とcharge(`ValueChange`)の両方を一度に検証できる。
 * charge解放行動自体がACTION単位クールタイムを1減らすため(R-SKL-04
 * COMPLETING)、finalStateには`remaining: 1`のcooldownが残る
 * （M5レビュー2巡目[P1]: これが`setAtTurnNumber`必須のままだと直列化に
 * 失敗しうるケース）。
 */
async function runChargeAndCooldownScenario(): Promise<BattleSimulationResponseBody> {
  const skillId = "SKL_CHARGE_CD";
  const effectActionId = "ACT_CHARGE_CD";
  const attackerUnit: UnitDefinition = {
    ...unitDefinition("UNIT_CHARGER"),
    baseStats: { ...unitDefinition("UNIT_CHARGER").baseStats, maximumAp: 1, attack: 30 },
    activeSkillDefinitionIds: [createSkillDefinitionId(skillId)],
  };
  const defenderUnit: UnitDefinition = {
    ...unitDefinition("UNIT_DEF"),
    baseStats: { ...unitDefinition("UNIT_DEF").baseStats, maximumHp: 1000, defense: 0 },
  };
  const units = new Map([
    [createUnitDefinitionId("UNIT_CHARGER"), attackerUnit],
    [createUnitDefinitionId("UNIT_DEF"), defenderUnit],
  ]);
  const skills = new Map([
    [createSkillDefinitionId(skillId), chargeSkill(skillId, effectActionId)],
    [createSkillDefinitionId("SKL_EX"), exSkillDefinition("SKL_EX")],
  ]);
  const effectActions = new Map([
    [createEffectActionDefinitionId(effectActionId), damageEffectAction(effectActionId)],
  ]);

  const useCase: SimulateBattleUseCasePort = {
    execute: (request: BattleSimulationRequestBody, context: SimulationExecutionContext) =>
      Promise.resolve(
        new SimulateBattleUseCase({
          battleCatalog: new FakeBattleCatalog(units, skills, effectActions),
          battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
          // AP recovers each turn, so the actor runs a charge-start/release
          // cycle in every one of the 3 turns — each release hit draws once
          // for its critical check (NORMAL mode). A few extra values are
          // supplied as headroom.
          randomSourceFactory: new SequenceRandomSourceFactory([0.99, 0.99, 0.99, 0.99, 0.99]),
          clock: new ManualClock(Date.now()),
        }).execute(toSimulateBattleCommand(request), context),
      ),
  };
  const app: FastifyInstance = await buildServer(useCase);

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/battle-simulations",
      payload: {
        allyFormation: {
          units: [{ unitDefinitionId: "UNIT_CHARGER", position: { column: 0, row: "FRONT" } }],
          memoryDefinitionIds: [],
        },
        enemyFormation: {
          units: [{ unitDefinitionId: "UNIT_DEF", position: { column: 0, row: "FRONT" } }],
          memoryDefinitionIds: [],
        },
        turnLimit: 3,
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

  it("API-STATE-RESTORE-006 (M5 review round 2 [P1] fix): a ChargeStarted->ChargeReleased scenario serializes successfully (an ACTION-unit cooldown surviving into finalState previously violated the response schema's unconditional setAtTurnNumber requirement), and reconstructedFinalState built from stateTransitions alone (cooldowns/charge included) equals finalState", async () => {
    const body = await runChargeAndCooldownScenario();

    // Sanity: this scenario actually leaves an active ACTION-unit cooldown
    // and completes the charge lifecycle — otherwise the restoration below
    // would trivially pass with no cooldowns/charge deltas at all.
    const chargerFinal = body.finalState.units.find((u) => u.unitDefinitionId === "UNIT_CHARGER");
    expect(chargerFinal?.cooldowns).toHaveLength(1);
    const cooldown = chargerFinal!.cooldowns[0]!;
    expect(cooldown.unit).toBe("ACTION");
    expect(cooldown.remaining).toBe(1);
    if (cooldown.unit !== "ACTION") {
      throw new Error("expected an ACTION-unit cooldown");
    }
    expect(typeof cooldown.setAtActionId).toBe("string");
    expect(chargerFinal?.charge).toBeUndefined(); // released by the end of the battle.
    const defenderFinal = body.finalState.units.find((u) => u.unitDefinitionId === "UNIT_DEF");
    expect(defenderFinal?.hp.current).toBeLessThan(1000); // the charge release actually hit.

    const reconstructed = reconstructFinalState(body);
    expect(reconstructed).toEqual(body.finalState);

    // Also exercises COOLDOWN_STARTED/REDUCED and CHARGE_STARTED/RELEASED
    // against the OpenAPI-published per-event `details` schema.
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

  it("API-STATE-RESTORE-004c: rejects a stateTransitions array where a transition's causedBySequence names a *published* event, but that event's own stateTransitionIndex was dropped (the reverse direction of the event<->transition cross-reference — a forward-only check misses this)", async () => {
    const body = await runLethalScenario();
    const ownerIndex = body.events.findIndex((event) => event.stateTransitionIndex !== undefined);
    expect(ownerIndex).toBeGreaterThanOrEqual(0);
    const owner = body.events[ownerIndex]!;
    // The transition still claims `causedBySequence: owner.sequence`, and
    // `owner` is still present in `events` (not hidden by logLevel) — but its
    // own `stateTransitionIndex` no longer points back. A reducer that only
    // walks events[] forward (event -> transition) never notices this,
    // because it simply skips events with no stateTransitionIndex to follow.
    const { stateTransitionIndex: _dropped, ...ownerWithoutIndex } = owner;
    const corrupted = {
      ...body,
      events: body.events.map((event, i) => (i === ownerIndex ? ownerWithoutIndex : event)),
    };

    expect(() => reconstructFinalState(corrupted)).toThrow(/stateTransitionIndex/);
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
