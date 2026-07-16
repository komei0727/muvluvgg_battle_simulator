import { describe, expect, it } from "vitest";
import { resolveActionPhase } from "./action-phase-resolver.js";
import { createBattleUnit, type BattleUnit, type BattleUnitResourceLimits } from "./battle-unit.js";
import type { BattleDefinitions } from "./battle-definitions.js";
import type { BattlePartyMember } from "./battle-party.js";
import { EventRecorder } from "./events/event-recorder.js";
import { createActionPoint, createExtraGauge, createHitPoint } from "./resource-gauge.js";
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
import type { Cooldown, SkillDefinition } from "../catalog/skill-definition.js";
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
    currentAp?: number;
    currentExtraGauge?: number;
    currentHp?: number;
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
  return {
    ...built,
    currentAp: createActionPoint(overrides.currentAp ?? limits.maximumAp, limits.maximumAp),
    currentExtraGauge: createExtraGauge(overrides.currentExtraGauge ?? 0, limits.maximumExtraGauge),
    currentHp: createHitPoint(
      overrides.currentHp ?? member.combatStats.maximumHp,
      member.combatStats.maximumHp,
    ),
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
  cooldown: Cooldown = { unit: "ACTION", count: 0 },
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
    cooldown,
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

function exSkill(
  effectActionId: string,
  gaugeAmount: number,
  selector: TargetSelectorDefinition = ENEMY_ALL,
): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(`SKL_EX_${effectActionId}`),
    skillType: "EX",
    cost: { resource: "EX_GAUGE", amount: gaugeAmount },
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
    metadata: { displayName: "Ex", tags: [] },
  };
}

function chargeSkill(
  effectActionId: string,
  apCost = 1,
  selector: TargetSelectorDefinition = ENEMY_ALL,
  cooldown: Cooldown = { unit: "ACTION", count: 0 },
): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(`SKL_CHARGE_${effectActionId}`),
    skillType: "AS",
    cost: { resource: "AP", amount: apCost },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    resolution: {
      kind: "CHARGE",
      targetBindings: [],
      steps: [],
      chargeRelease: {
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
    },
    cooldown,
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

function definitionsOf(
  activeSkillsByUnit: ReadonlyMap<UnitDefinitionId, readonly SkillDefinition[]>,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  exSkillByUnit: ReadonlyMap<UnitDefinitionId, SkillDefinition> = new Map(),
): BattleDefinitions {
  return { activeSkillsByUnit, exSkillByUnit, effectActions };
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

    // 06_戦闘状態遷移.md「待機」#1: 実効行動WAIT確定後にActionWaitedを発行する。
    const waited = ctx.recorder
      .getEvents()
      .filter((e) => e.eventType === "ActionWaited" && e.sourceUnitId === ally.battleUnitId);
    expect(waited.length).toBeGreaterThan(0);
    expect(waited[0]!.payload).toEqual({
      actorUnitId: ally.battleUnitId,
      waitReason: "NO_USABLE_ACTIVE_SKILL",
      consumedResource: "AP",
      consumedAmount: 1,
    });
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

  it("UT-ACTION-PHASE-005 (R-ACT-01 #5 / R-ACT-03 EX行): a reserved EX skill consumes the full EX gauge (not AP) and applies DAMAGE to the target", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_EX_ATTACKER");
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_EX_ATTACKER",
      attack: 30,
      limits: { maximumAp: 0, maximumExtraGauge: 50 },
      currentExtraGauge: 50,
    });
    const enemy = unit("ENEMY_1", "ENEMY", {
      defense: 10,
      maximumHp: 100,
      limits: { maximumAp: 0 },
    });
    const effectAction = damageEffectAction("ACT_EX_ATTACK");
    const definitions = definitionsOf(
      new Map(),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
      new Map([[unitDefinitionId, exSkill("ACT_EX_ATTACK", 50)]]),
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

    expect(result.allyUnits[0]!.currentExtraGauge).toBe(0);
    expect(result.allyUnits[0]!.currentAp).toBe(0); // EX does not consume AP (R-ACT-03).
    expect(result.enemyUnits[0]!.currentHp).toBe(80);

    const actionStarted = ctx.recorder
      .getEvents()
      .find((e) => e.eventType === "ActionStarted" && e.sourceUnitId === ally.battleUnitId)!;
    expect(actionStarted.payload).toMatchObject({
      reservedActionType: "EX",
      effectiveActionType: "EX",
      exBefore: 50,
      exAfter: 0,
    });
  });

  it("UT-ACTION-PHASE-005B (Q-EX-04 / R-ORD-03: Queue再生成後の予約種別切り替え): a unit with AP still remaining after EX drains the gauge requeues next cycle with an AS reservation and actually uses it (PR #127 review [P2])", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_EX_THEN_AS");
    // AP is 1 (not consumed by EX) and the EX gauge starts full: cycle 1 must
    // reserve EX (R-ORD-03), and only after the gauge drains does cycle 2's
    // fresh queue re-evaluate the reservation as AS (Q-EX-04: EX使用後にAPが
    // 残れば次の行動順QueueでASを使用できる).
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_EX_THEN_AS",
      attack: 30,
      limits: { maximumAp: 1, maximumExtraGauge: 50 },
      currentExtraGauge: 50,
    });
    const enemy = unit("ENEMY_1", "ENEMY", {
      defense: 0,
      maximumHp: 1000,
      limits: { maximumAp: 0 },
    });
    const exEffectAction = damageEffectAction("ACT_EX_ATTACK");
    const asEffectAction = damageEffectAction("ACT_AS_ATTACK");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [attackSkill("ACT_AS_ATTACK", 1)]]]),
      new Map([
        [exEffectAction.effectActionDefinitionId, exEffectAction],
        [asEffectAction.effectActionDefinitionId, asEffectAction],
      ]),
      new Map([[unitDefinitionId, exSkill("ACT_EX_ATTACK", 50)]]),
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

    expect(result.allyUnits[0]!.currentExtraGauge).toBe(0);
    expect(result.allyUnits[0]!.currentAp).toBe(0); // consumed by the AS use in cycle 2.
    expect(result.enemyUnits[0]!.currentHp).toBe(1000 - 30 - 30); // one EX hit + one AS hit.

    const events = ctx.recorder.getEvents();

    const queuesCreated = events.filter((e) => e.eventType === "ActionQueueCreated");
    expect(queuesCreated.map((e) => e.payload.cycleNumber)).toEqual([1, 2]);
    expect(
      queuesCreated.map(
        (e) =>
          e.payload.reservations.find((r) => r.battleUnitId === ally.battleUnitId)
            ?.reservedActionKind,
      ),
    ).toEqual(["EX", "AS"]);

    const actionsStarted = events
      .filter((e) => e.eventType === "ActionStarted")
      .filter((e) => e.sourceUnitId === ally.battleUnitId);
    expect(
      actionsStarted.map((e) => ({
        cycleNumber: e.cycleNumber,
        reservedActionType: e.payload.reservedActionType,
        effectiveActionType: e.payload.effectiveActionType,
      })),
    ).toEqual([
      { cycleNumber: 1, reservedActionType: "EX", effectiveActionType: "EX" },
      { cycleNumber: 2, reservedActionType: "AS", effectiveActionType: "AS" },
    ]);
  });

  it("UT-ACTION-PHASE-006 (Q-BTL-06): a reserved EX skill with no resolvable target WAITs, draining the full EX gauge instead of AP", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_EX_LONELY");
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_EX_LONELY",
      limits: { maximumAp: 0, maximumExtraGauge: 50 },
      currentExtraGauge: 50,
    });
    // The only enemy is already defeated, so the EX skill's enemy-target
    // selector (R-TGT-01 #2 excludes defeated units) resolves to zero candidates.
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 }, currentHp: 0 });
    const definitions = definitionsOf(
      new Map(),
      new Map(),
      new Map([[unitDefinitionId, exSkill("ACT_EX_UNUSED", 50)]]),
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

    expect(result.allyUnits[0]!.currentExtraGauge).toBe(0);
    expect(result.allyUnits[0]!.currentAp).toBe(0);

    const waited = ctx.recorder
      .getEvents()
      .find((e) => e.eventType === "ActionWaited" && e.sourceUnitId === ally.battleUnitId)!;
    expect(waited.payload).toEqual({
      actorUnitId: ally.battleUnitId,
      waitReason: "EX_UNUSABLE",
      consumedResource: "EX_GAUGE",
      consumedAmount: 50,
    });
  });

  it("UT-ACTION-PHASE-007 (Q-BTL-04/06_戦闘状態遷移.md 戦闘不能者の除去): a reservation for a unit defeated earlier in the same queue is skipped, not processed, and emits ActionReservationRemoved", () => {
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

    // 06_戦闘状態遷移.md「戦闘不能者の除去」: 除去はActionCompleted直後に即時発行される。
    const removed = ctx.recorder
      .getEvents()
      .find(
        (e) =>
          e.eventType === "ActionReservationRemoved" &&
          e.sourceUnitId === createBattleUnitId("ENEMY_1"),
      )!;
    expect(removed.payload).toEqual({
      battleUnitId: createBattleUnitId("ENEMY_1"),
      reason: "DEFEATED",
    });
  });

  it("UT-ACTION-PHASE-008 (defense-in-depth: R-ACT-03 now forbids cost 0 at Catalog validation, but this constructs a BattleDefinitions directly, bypassing createCost/JSON Schema): a 0-AP-cost AS that never depletes its user's AP is bounded by a cycle-count safety guard instead of looping until the (very large) target HP is exhausted", () => {
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

  it("UT-ACTION-PHASE-009 (R-SKL-04): using a skill with an ACTION-unit cooldown sets it, and CooldownStarted is not emitted for the default count-0 fixture skills", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_COOLDOWN");
    const skill = attackSkill("ACT_CD_ATTACK", 1, ENEMY_ALL, { unit: "ACTION", count: 2 });
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_COOLDOWN",
      limits: { maximumAp: 1 },
    });
    const enemy = unit("ENEMY_1", "ENEMY", { defense: 0 });
    const effectAction = damageEffectAction("ACT_CD_ATTACK");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [skill]]]),
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

    const cooldownEntry = result.allyUnits[0]!.cooldowns[skill.skillDefinitionId];
    expect(cooldownEntry).toMatchObject({ unit: "ACTION", remaining: 2 });
    expect(typeof cooldownEntry?.setActionId).toBe("string");

    const started = ctx.recorder
      .getEvents()
      .filter((e) => e.eventType === "CooldownStarted" && e.sourceUnitId === ally.battleUnitId);
    expect(started).toHaveLength(1);
    expect(started[0]!.payload).toMatchObject({
      skillDefinitionId: skill.skillDefinitionId,
      unit: "ACTION",
      initialRemaining: 2,
    });
  });

  it("UT-ACTION-PHASE-010 (R-SKL-04): does not emit CooldownStarted for a skill whose cooldown.count is 0", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_NO_COOLDOWN");
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_NO_COOLDOWN",
      limits: { maximumAp: 1 },
    });
    const enemy = unit("ENEMY_1", "ENEMY", { defense: 0 });
    const effectAction = damageEffectAction("ACT_NO_CD_ATTACK");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [attackSkill("ACT_NO_CD_ATTACK", 1)]]]),
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

    expect(result.allyUnits[0]!.cooldowns).toEqual({});
    expect(ctx.recorder.getEvents().filter((e) => e.eventType === "CooldownStarted")).toHaveLength(
      0,
    );
  });

  it("UT-ACTION-PHASE-011 (R-SKL-04): does not decrement a cooldown set during the same action, but decrements it at the end of the actor's next own action", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_COOLDOWN_DECREMENT");
    // apCost 2 with 3 starting AP: cycle 1 affords the skill (sets
    // remaining=1, no decrement this same action). Cycle 2 only has 1 AP
    // left, so the skill (cooldown gating is M7 scope; this is purely an AP
    // shortfall) is unaffordable and the unit WAITs instead - but
    // ActionCompleting still runs the decrement for the actor's own
    // cooldowns regardless of what action they took this cycle.
    const skill = attackSkill("ACT_CD2_ATTACK", 2, ENEMY_ALL, { unit: "ACTION", count: 1 });
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_COOLDOWN_DECREMENT",
      limits: { maximumAp: 3 },
    });
    const enemy = unit("ENEMY_1", "ENEMY", {
      defense: 0,
      maximumHp: 1000,
      limits: { maximumAp: 0 },
    });
    const effectAction = damageEffectAction("ACT_CD2_ATTACK");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [skill]]]),
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

    const cooldownEntry = result.allyUnits[0]!.cooldowns[skill.skillDefinitionId];
    expect(cooldownEntry).toMatchObject({ unit: "ACTION", remaining: 0 });
    expect(typeof cooldownEntry?.setActionId).toBe("string");

    const reduced = ctx.recorder
      .getEvents()
      .filter((e) => e.eventType === "CooldownReduced" && e.sourceUnitId === ally.battleUnitId);
    expect(reduced).toHaveLength(1);
    expect(reduced[0]!.payload).toMatchObject({
      skillDefinitionId: skill.skillDefinitionId,
      before: 1,
      after: 0,
    });
    expect(
      ctx.recorder
        .getEvents()
        .filter((e) => e.eventType === "CooldownCompleted" && e.sourceUnitId === ally.battleUnitId),
    ).toHaveLength(1);
  });

  it("UT-ACTION-PHASE-012 (R-SKL-05): selecting a CHARGE skill starts a charge (consumes cost, no effects yet) as one action, and the next action opportunity releases it as a separate action with distinct ActionIds", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_CHARGER");
    const skill = chargeSkill("ACT_CHARGE_HIT", 1);
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_CHARGER",
      attack: 30,
      limits: { maximumAp: 1 },
    });
    const enemy = unit("ENEMY_1", "ENEMY", { defense: 0, maximumHp: 1000 });
    const effectAction = damageEffectAction("ACT_CHARGE_HIT");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [skill]]]),
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

    // Cost consumed once at charge start; release consumes nothing.
    expect(result.allyUnits[0]!.currentAp).toBe(0);
    expect(result.allyUnits[0]!.charge).toBeUndefined();
    expect(result.enemyUnits[0]!.currentHp).toBe(1000 - 30);

    const events = ctx.recorder.getEvents();
    const chargeStarted = events.filter((e) => e.eventType === "ChargeStarted");
    const chargeReleased = events.filter((e) => e.eventType === "ChargeReleased");
    expect(chargeStarted).toHaveLength(1);
    expect(chargeReleased).toHaveLength(1);
    expect(chargeStarted[0]!.payload).toMatchObject({
      actorUnitId: ally.battleUnitId,
      skillDefinitionId: skill.skillDefinitionId,
    });
    expect(chargeReleased[0]!.payload).toMatchObject({
      actorUnitId: ally.battleUnitId,
      skillDefinitionId: skill.skillDefinitionId,
    });

    // Charge start and release are distinct actions (R-SKL-05: "チャージ開始とは別の一つの行動").
    const startActionId = chargeStarted[0]!.actionId;
    const releaseActionId = chargeReleased[0]!.actionId;
    expect(startActionId).toBeDefined();
    expect(releaseActionId).toBeDefined();
    expect(startActionId).not.toBe(releaseActionId);

    const actionsCompleted = events
      .filter((e) => e.eventType === "ActionCompleted")
      .filter((e) => e.sourceUnitId === ally.battleUnitId);
    expect(actionsCompleted.map((e) => e.payload.effectiveActionType)).toEqual([
      "AS",
      "CHARGE_RELEASE",
    ]);
  });

  it("UT-ACTION-PHASE-013 (R-SKL-05): charge start sets the original skill's cooldown, scoped to the charge-start action; the release action (a later action for this actor) then decrements it like any other own-action-end", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_CHARGER_CD");
    const skill = chargeSkill("ACT_CHARGE_CD_HIT", 1, ENEMY_ALL, { unit: "ACTION", count: 2 });
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_CHARGER_CD",
      limits: { maximumAp: 1 },
    });
    const enemy = unit("ENEMY_1", "ENEMY", { defense: 0, maximumHp: 1000 });
    const effectAction = damageEffectAction("ACT_CHARGE_CD_HIT");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [skill]]]),
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

    const events = ctx.recorder.getEvents();
    const started = events.filter((e) => e.eventType === "CooldownStarted");
    expect(started).toHaveLength(1);
    expect(started[0]!.payload).toMatchObject({
      skillDefinitionId: skill.skillDefinitionId,
      unit: "ACTION",
      initialRemaining: 2,
    });
    // The charge-release action is itself a later own-action-end for this
    // actor, so it decrements the cooldown set during the earlier
    // charge-start action (R-SKL-04 COMPLETING runs on every action).
    const reduced = events.filter((e) => e.eventType === "CooldownReduced");
    expect(reduced).toHaveLength(1);
    expect(reduced[0]!.payload).toMatchObject({
      skillDefinitionId: skill.skillDefinitionId,
      before: 2,
      after: 1,
    });
    const cooldownEntry = result.allyUnits[0]!.cooldowns[skill.skillDefinitionId];
    expect(cooldownEntry).toMatchObject({ unit: "ACTION", remaining: 1 });
    expect(typeof cooldownEntry?.setActionId).toBe("string");
  });

  it("UT-ACTION-PHASE-014 (R-SKL-05): repeated charge start+release cycles (2 cycles per AP spent, instead of 1) do not trip the cycle-count safety guard", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_REPEAT_CHARGER");
    // No cooldown, so the same CHARGE skill is immediately selectable again
    // after each release. 2 AP means 2 full charge/release pairs = 4 cycles,
    // which exceeds the pre-charge bound (maximumAp total + 1 = 3).
    const skill = chargeSkill("ACT_REPEAT_CHARGE", 1);
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_REPEAT_CHARGER",
      attack: 10,
      limits: { maximumAp: 2 },
    });
    const enemy = unit("ENEMY_1", "ENEMY", {
      defense: 0,
      maximumHp: 1000,
      limits: { maximumAp: 0 },
    });
    const effectAction = damageEffectAction("ACT_REPEAT_CHARGE");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [skill]]]),
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
    expect(result.enemyUnits[0]!.currentHp).toBe(1000 - 10 - 10);
    expect(ctx.recorder.getEvents().filter((e) => e.eventType === "ChargeReleased")).toHaveLength(
      2,
    );
  });
});
