import { describe, expect, it } from "vitest";
import { resolveActionPhase } from "./action-phase-resolver.js";
import { createBattleUnit, type BattleUnit, type BattleUnitResourceLimits } from "./battle-unit.js";
import type { BattleDefinitions } from "./battle-definitions.js";
import type { BattlePartyMember } from "./battle-party.js";
import { EventRecorder } from "./events/event-recorder.js";
import { createActionPoint } from "./resource-gauge.js";
import { createBattleId, createBattleUnitId } from "../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
  type EffectActionDefinitionId,
  type UnitDefinitionId,
} from "../catalog/catalog-ids.js";
import type { FormationPosition } from "./formation-input.js";
import { toGlobalCoordinate } from "./global-coordinate.js";
import type { Side } from "./side.js";
import type { SkillDefinition } from "../catalog/skill-definition.js";
import type { TargetSelectorDefinition } from "../catalog/target-selector-definition.js";
import type { EffectActionDefinition } from "../catalog/effect-action-definition.js";
import { DomainValidationError } from "../shared/errors.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";

function unit(
  id: string,
  side: Side,
  overrides: {
    unitDefinitionId?: string;
    attack?: number;
    defense?: number;
    maximumHp?: number;
    actionSpeed?: number;
    limits?: Partial<BattleUnitResourceLimits>;
  } = {},
): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId(overrides.unitDefinitionId ?? "UNIT_001"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: overrides.maximumHp ?? 100,
      attack: overrides.attack ?? 30,
      defense: overrides.defense ?? 10,
      criticalRate: 0,
      actionSpeed: overrides.actionSpeed ?? 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  const limits: BattleUnitResourceLimits = {
    maximumAp: 1,
    maximumPp: 3,
    maximumExtraGauge: 100,
    ...overrides.limits,
  };
  const built = createBattleUnit(member, side, limits);
  return { ...built, currentAp: createActionPoint(limits.maximumAp, limits.maximumAp) };
}

const ENEMY_ALL: TargetSelectorDefinition = {
  kind: "SELECT",
  side: "ENEMY",
  count: "ALL",
  filters: [],
  order: ["DEFAULT"],
  includeDefeated: false,
};

/** DEFAULT order picks the nearest enemy first; ties fall back to input array order (stable sort). */
const ENEMY_NEAREST: TargetSelectorDefinition = {
  kind: "SELECT",
  side: "ENEMY",
  count: 1,
  filters: [],
  order: ["DEFAULT"],
  includeDefeated: false,
};

function damageEffectAction(
  id: string,
  criticalMode: "NORMAL" | "GUARANTEED" | "PREVENTED" = "PREVENTED",
): EffectActionDefinition {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: 1 },
      hitCount: 1,
      critical: { mode: criticalMode },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

function healEffectAction(id: string): EffectActionDefinition {
  return {
    kind: "HEAL",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: { formula: { kind: "CONSTANT", value: 10 }, overheal: "DISCARD" },
  };
}

function attackSkill(
  effectActionId: string,
  apCost = 1,
  selector: TargetSelectorDefinition = ENEMY_ALL,
): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(`SKL_${effectActionId}`),
    skillType: "AS",
    cost: { resource: "AP", amount: apCost },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [{ targetBindingId: createTargetBindingId("TGT_1"), selector }],
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

function definitionsOf(
  activeSkillsByUnit: ReadonlyMap<UnitDefinitionId, readonly SkillDefinition[]>,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
): BattleDefinitions {
  return { activeSkillsByUnit, effectActions };
}

const NO_SKILLS: BattleDefinitions = definitionsOf(new Map(), new Map());

/**
 * `resolveActionPhase`は通常`advanceBattle`のTURN_STARTING（TurnStarted→
 * ResourcesRecovered）の後に呼ばれる。単体テストではその前提イベントを
 * 最小限再現し、recorder・turnNumber・親子連鎖の起点だけを提供する。
 */
function actionPhaseContext(turnNumber = 1) {
  const recorder = new EventRecorder(createBattleId("B_1"));
  const turnStarted = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber },
  });
  return {
    recorder,
    turnNumber,
    turnRootEventId: turnStarted.eventId,
    turnScopeParentEventId: turnStarted.eventId,
  };
}

describe("resolveActionPhase", () => {
  it("UT-ACTION-PHASE-001: a unit with no active skills WAITs (consuming 1 AP) until it runs out of AP, leaving HP untouched", () => {
    const ally = unit("ALLY_1", "ALLY", { limits: { maximumAp: 2 } });
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 2 } });
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [ally],
      [enemy],
      NO_SKILLS,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    expect(result.result).toBeUndefined();
    expect(result.allyUnits[0]!.currentAp).toBe(0);
    expect(result.enemyUnits[0]!.currentAp).toBe(0);
    expect(result.allyUnits[0]!.currentHp).toBe(ally.currentHp);
    expect(result.enemyUnits[0]!.currentHp).toBe(enemy.currentHp);
  });

  it("UT-ACTION-PHASE-002: a usable AS skill consumes its AP cost and applies DAMAGE to the target", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_ATTACKER");
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_ATTACKER",
      attack: 30,
      limits: { maximumAp: 1 },
    });
    const enemy = unit("ENEMY_1", "ENEMY", {
      defense: 10,
      maximumHp: 100,
      limits: { maximumAp: 0 },
    });
    const effectAction = damageEffectAction("ACT_ATTACK");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [attackSkill("ACT_ATTACK", 1)]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    expect(result.allyUnits[0]!.currentAp).toBe(0);
    expect(result.enemyUnits[0]!.currentHp).toBe(80);
    expect(result.result).toBeUndefined();
  });

  it("UT-ACTION-PHASE-003 (R-END-01 timing #1): resolving victory mid-phase stops processing the remaining queue immediately", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_ATTACKER");
    // ALLY_1 acts first (higher actionSpeed) and one-shots the only enemy; ALLY_2 must never get to act.
    const allyFast = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_ATTACKER",
      attack: 999,
      actionSpeed: 20,
      limits: { maximumAp: 1 },
    });
    const allySlow = unit("ALLY_2", "ALLY", { actionSpeed: 5, limits: { maximumAp: 1 } });
    const enemy = unit("ENEMY_1", "ENEMY", { defense: 0, maximumHp: 10, limits: { maximumAp: 0 } });
    const effectAction = damageEffectAction("ACT_ATTACK");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [attackSkill("ACT_ATTACK", 1)]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [allyFast, allySlow],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    expect(result.result).toEqual({ outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED" });
    const updatedSlowAlly = result.allyUnits.find(
      (u) => u.battleUnitId === createBattleUnitId("ALLY_2"),
    )!;
    expect(updatedSlowAlly.currentAp).toBe(1); // untouched: the phase stopped before ALLY_2's turn.
  });

  it("UT-ACTION-PHASE-004: throws when a resolved plan targets a non-DAMAGE EffectAction (M6/M7 scope)", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_HEALER");
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_HEALER",
      limits: { maximumAp: 1 },
    });
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 } });
    const effectAction = healEffectAction("ACT_HEAL");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [attackSkill("ACT_HEAL", 1)]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    expect(() =>
      resolveActionPhase(
        [ally],
        [enemy],
        definitions,
        random,
        ctx.recorder,
        ctx.turnNumber,
        ctx.turnRootEventId,
        ctx.turnScopeParentEventId,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-ACTION-PHASE-005: throws when a queue reservation is EX (M6 scope)", () => {
    const ally = unit("ALLY_1", "ALLY", { limits: { maximumAp: 1, maximumExtraGauge: 0 } });
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 } });
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    expect(() =>
      resolveActionPhase(
        [ally],
        [enemy],
        NO_SKILLS,
        random,
        ctx.recorder,
        ctx.turnNumber,
        ctx.turnRootEventId,
        ctx.turnScopeParentEventId,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-ACTION-PHASE-006 (Q-BTL-04/06_戦闘状態遷移.md 戦闘不能者の除去): a reservation for a unit defeated earlier in the same queue is skipped, not processed", () => {
    const attackerDefId = createUnitDefinitionId("UNIT_ATTACKER");
    // ALLY_1 acts first (highest actionSpeed) and one-shots ENEMY_1, whose own
    // reservation (also an attacker) comes later in the same queue. ENEMY_2
    // survives so the phase does not stop early on a victory check.
    const allyFast = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_ATTACKER",
      attack: 999,
      actionSpeed: 20,
      limits: { maximumAp: 1 },
    });
    const enemyDoomed = unit("ENEMY_1", "ENEMY", {
      unitDefinitionId: "UNIT_ATTACKER",
      attack: 999,
      defense: 0,
      maximumHp: 10,
      actionSpeed: 15,
      limits: { maximumAp: 1 },
    });
    const enemySurvivor = unit("ENEMY_2", "ENEMY", { actionSpeed: 10, limits: { maximumAp: 0 } });
    const effectAction = damageEffectAction("ACT_ATTACK");
    // ALLY_1 targets only the nearest enemy (ENEMY_1, first in the enemyUnits
    // array) so ENEMY_2 survives and the phase does not end on a victory check.
    const definitions = definitionsOf(
      new Map([[attackerDefId, [attackSkill("ACT_ATTACK", 1, ENEMY_NEAREST)]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [allyFast],
      [enemyDoomed, enemySurvivor],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const updatedAlly = result.allyUnits.find(
      (u) => u.battleUnitId === createBattleUnitId("ALLY_1"),
    )!;
    // ENEMY_1 was defeated before its own reservation was reached, so it never got to attack.
    expect(updatedAlly.currentHp).toBe(allyFast.currentHp);
    const updatedDoomed = result.enemyUnits.find(
      (u) => u.battleUnitId === createBattleUnitId("ENEMY_1"),
    )!;
    // The reservation was discarded outright, not consumed as a WAIT either.
    expect(updatedDoomed.currentAp).toBe(1);
  });

  it("UT-ACTION-PHASE-007 (defense-in-depth: R-ACT-03 now forbids cost 0 at Catalog validation, but this constructs a BattleDefinitions directly, bypassing createCost/JSON Schema): a 0-AP-cost AS that never depletes its user's AP is bounded by a cycle-count safety guard instead of looping until the (very large) target HP is exhausted", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_FREE_ATTACKER");
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_FREE_ATTACKER",
      attack: 1,
      limits: { maximumAp: 1 },
    });
    // HP large enough that natural HP-based termination would take far more
    // cycles than the safety guard's bound (maximumAp total + 1 = 3 here).
    const enemy = unit("ENEMY_1", "ENEMY", { defense: 0, maximumHp: 1_000_000 });
    const effectAction = damageEffectAction("ACT_FREE_ATTACK");
    // apCost: 0 -> consumeAp is a no-op, so this unit is re-queued every cycle.
    // A valid Catalog can no longer produce this (createCost/JSON Schema now
    // require amount >= 1), so this test exercises the resolver's own
    // defensive guard directly via a hand-built SkillDefinition.
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [attackSkill("ACT_FREE_ATTACK", 0)]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    expect(() =>
      resolveActionPhase(
        [ally],
        [enemy],
        definitions,
        random,
        ctx.recorder,
        ctx.turnNumber,
        ctx.turnRootEventId,
        ctx.turnScopeParentEventId,
      ),
    ).toThrow(DomainValidationError);
  });
});
