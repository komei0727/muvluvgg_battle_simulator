import { describe, expect, it } from "vitest";
import { ApplicationError } from "../../application/contracts/application-error.js";
import { createCapabilityDefinition } from "../../domain/catalog/capability/capability-definition.js";
import {
  createCapabilityId,
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { TargetSelectorDefinition } from "../../domain/catalog/definitions/target-selector-definition.js";
import { reduceStateDeltas } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import { createBattleUnitId } from "../../domain/shared/ids.js";
import { CatalogBuilder } from "../../testing/scenario/catalog-builder.js";
import {
  attackSkill,
  battleCommand,
  damageEffectAction,
  formationSlot,
  unitDefinition,
} from "../../testing/scenario/definition-builders.js";
import { runScenario } from "../../testing/scenario/run-scenario.js";

/**
 * harness ベースの Battle シナリオ（`12_テスト戦略.md`「基準シナリオ」）。散在する既存の
 * `SCN-BTL-*` とは別に、`runScenario` + `CatalogBuilder` を実運用へ載せる集約先。
 * ルール未実装の SCN-BTL-015〜018（シールド/リンク/DoT/状態異常）は該当ルール実装後に追加する。
 */
describe("battle scenarios (harness)", () => {
  it("SCN-BTL-022: a definition graph requiring an unimplemented Capability is rejected with UNSUPPORTED_RULE before the battle starts", () => {
    const capabilityId = createCapabilityId("CAP_UNSUPPORTED");
    const gatedUnit = unitDefinition("UNIT_GATED", { requiredCapabilities: [capabilityId] });
    const catalog = new CatalogBuilder()
      .withUnit(gatedUnit)
      .withCapability(
        createCapabilityDefinition({
          capabilityId: "CAP_UNSUPPORTED",
          schemaStatus: "SUPPORTED",
          runtimeStatus: "PLANNED",
          implementationTaskId: "TEST-SCN-022",
          description: "not yet implemented",
          verification: {
            productionDefinitionIds: ["TEST_DEFINITION"],
            testCaseIds: ["TEST-SCN-022"],
          },
        }),
      )
      .build();

    const command = battleCommand({
      allyFormation: { slots: [formationSlot("UNIT_GATED", 0)], memoryDefinitionIds: [] },
      enemyFormation: { slots: [formationSlot("UNIT_GATED", 0)], memoryDefinitionIds: [] },
    });

    try {
      runScenario({ catalog, command });
      expect.fail("expected runScenario to reject the unsupported Capability");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe("UNSUPPORTED_RULE");
    }
  });

  it("SCN-BTL-001 (Issue #10 acceptance): a full battle's event log satisfies sequence/parent/root determinism, and the independent StateDelta Reducer restores finalState from initialState + transitions", async () => {
    const { reduceStateDeltas } =
      await import("../../domain/battle/lifecycle/state-delta-reducer.js");
    const skillId = "SKL_ATTACK";
    const effectActionId = "ACT_ATTACK";
    // UNIT_001 (activeSkillDefinitionIds: []) always WAITs, exercising both
    // ActionStarted effectiveActionType values ("AS" and "WAIT") in one battle.
    const catalog = new CatalogBuilder()
      .withUnit(
        unitDefinition("UNIT_ATK", {
          baseStats: { maximumAp: 1 },
          activeSkillDefinitionIds: [createSkillDefinitionId(skillId)],
        }),
        unitDefinition("UNIT_001"),
      )
      .withSkill(attackSkill(skillId, effectActionId))
      .withEffectAction(damageEffectAction(effectActionId))
      .build();

    const result = runScenario({
      catalog,
      command: battleCommand({
        allyFormation: { slots: [formationSlot("UNIT_ATK", 0)], memoryDefinitionIds: [] },
        enemyFormation: { slots: [formationSlot("UNIT_001", 0)], memoryDefinitionIds: [] },
        turnLimit: 1,
      }),
      randomValues: [0.99],
      battleIds: ["B_1"],
    });

    // Non-lethal attack (UNIT_ATK attack 10 - UNIT_001 defense 10 -> 1 damage
    // floor, 100 HP survives) that stays RUNNING through TURN_ENDING, then
    // resolves on the turn-limit boundary — exercising the full M3 event set.
    expect(result.outcome).toBe("ALLY_LOSE");
    expect(result.completionReason).toBe("TURN_LIMIT_REACHED");

    const { events, stateTransitions, initialState, finalState } = result;

    // Event ordering (invariant list #1): sequence is 1..N with no gaps or duplicates.
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, index) => index + 1));

    // sequence is unique within the battle (BattleLogEvent has no eventId; it
    // is the public identifier).
    expect(new Set(events.map((e) => e.sequence)).size).toBe(events.length);

    // Parent/root determinism (10_API設計.md BattleLogEventResponse):
    // a child's sequence exceeds its resolved parentSequence, a root event is
    // its own rootSequence, and a child shares its parent's rootSequence.
    const bySequence = new Map(events.map((e) => [e.sequence, e]));
    for (const event of events) {
      if (event.parentSequence === undefined) {
        expect(event.rootSequence).toBe(event.sequence);
        continue;
      }
      const parent = bySequence.get(event.parentSequence);
      expect(parent).toBeDefined();
      expect(event.sequence).toBeGreaterThan(event.parentSequence);
      expect(event.rootSequence).toBe(parent!.rootSequence);
    }

    // The full M3 event catalog plus ActionWaited (M5/issue #20) except
    // UnitDefeated (this attack is non-lethal by design, to also exercise
    // TurnCompleting/TurnCompleted/turn-limit completion in the same run) is
    // exercised by this one non-lethal-attack + mandatory-WAIT +
    // turn-limit-completion battle. UnitDefeated is covered separately below
    // by the lethal-path test.
    // `type` is the design's UPPER_SNAKE_CASE public form of the internal eventType.
    expect(new Set(events.map((e) => e.type))).toEqual(
      new Set([
        "BATTLE_STARTED",
        "TURN_STARTED",
        "RESOURCES_RECOVERED",
        "ACTION_QUEUE_CREATED",
        "ACTION_STARTED",
        "ACTION_WAITED",
        "RESOURCE_CHANGED",
        "TARGETS_SELECTED",
        "SKILL_USE_STARTING",
        "SKILL_USE_STARTED",
        "EFFECT_STEP_STARTING",
        "EFFECT_ACTION_STARTING",
        "UNIT_BEING_ATTACKED",
        "HIT_CONFIRMED",
        "CRITICAL_CHECK_RESOLVED",
        "DAMAGE_WILL_BE_APPLIED",
        "DAMAGE_CALCULATED",
        "HIT_POINT_REDUCED",
        "DAMAGE_APPLIED",
        "EFFECT_ACTION_COMPLETED",
        "EFFECT_STEP_COMPLETED",
        "SKILL_USE_COMPLETED",
        "ACTION_COMPLETING",
        "ACTION_COMPLETED",
        "TURN_COMPLETING",
        "TURN_COMPLETED",
        "BATTLE_COMPLETED",
      ]),
    );

    // Events carrying a stateDelta reference their StateTransition by its
    // 0-based position in stateTransitions (10_API設計.md
    // 「stateTransitionIndex」), and never duplicate the delta content on the
    // event itself.
    for (const event of events) {
      expect(event).not.toHaveProperty("stateDelta");
      if (event.stateTransitionIndex !== undefined) {
        expect(stateTransitions[event.stateTransitionIndex]?.causedBySequence).toBe(event.sequence);
      }
    }

    // SCN-BTL-001/SCN-BTL-021: initialState + stateTransitions = finalState,
    // verified through an independent Reducer (not Battle's own advance/resolve
    // logic). This includes the battle outcome itself (`result`), which is real
    // Battle aggregate state (`Battle.result`), not just status/turn/units.
    const restored = reduceStateDeltas(
      initialState,
      stateTransitions.map((t) => t.stateDelta),
    );
    expect(restored).toEqual(finalState);
    expect(finalState.status).toBe("COMPLETED");
    expect(finalState.result).toEqual({
      outcome: "ALLY_LOSE",
      completionReason: "TURN_LIMIT_REACHED",
      completedTurn: 1,
    });
  });

  it("SCN-BTL-001 (Issue #10 acceptance, lethal path): a lethal AS attack emits DamageApplied -> UnitDefeated -> BattleCompleted in causal order, with UnitDefeated's payload naming the defeated unit and the causing DamageApplied event", () => {
    const skillId = "SKL_LETHAL";
    const effectActionId = "ACT_LETHAL";
    const catalog = new CatalogBuilder()
      .withUnit(
        unitDefinition("UNIT_ATK", {
          baseStats: { maximumAp: 1, attack: 999 },
          activeSkillDefinitionIds: [createSkillDefinitionId(skillId)],
        }),
        unitDefinition("UNIT_DEF", { baseStats: { maximumHp: 10, defense: 0 } }),
      )
      .withSkill(attackSkill(skillId, effectActionId))
      .withEffectAction(damageEffectAction(effectActionId))
      .build();

    const result = runScenario({
      catalog,
      command: battleCommand({
        allyFormation: { slots: [formationSlot("UNIT_ATK", 0)], memoryDefinitionIds: [] },
        enemyFormation: { slots: [formationSlot("UNIT_DEF", 0)], memoryDefinitionIds: [] },
        turnLimit: 5,
      }),
      randomValues: [0.99],
      battleIds: ["B_1"],
    });

    expect(result.outcome).toBe("ALLY_WIN");
    expect(result.completionReason).toBe("ENEMY_DEFEATED");

    const { events } = result;
    const eventTypes = events.map((e) => e.type);
    const damageAppliedIndex = eventTypes.indexOf("DAMAGE_APPLIED");
    const unitDefeatedIndex = eventTypes.indexOf("UNIT_DEFEATED");
    const battleCompletedIndex = eventTypes.indexOf("BATTLE_COMPLETED");

    expect(damageAppliedIndex).toBeGreaterThanOrEqual(0);
    expect(unitDefeatedIndex).toBeGreaterThan(damageAppliedIndex);
    expect(battleCompletedIndex).toBeGreaterThan(unitDefeatedIndex);

    const damageApplied = events[damageAppliedIndex]!;
    const unitDefeated = events[unitDefeatedIndex]!;
    expect(damageApplied.details).toMatchObject({ defeated: true });
    // Causal link at the public level: UnitDefeated's parentSequence points
    // back to the DamageApplied event that caused it.
    expect(unitDefeated.parentSequence).toBe(damageApplied.sequence);
    expect(unitDefeated.details).toMatchObject({ unitId: createBattleUnitId("enemy:1") });
  });

  it("SCN-BTL-008 (Issue #34 acceptance): a defender's PS triggered by DamageApplied consumes PP and increases the EX gauge by the same amount, recorded via ResourceChanged/PassiveActivated/PassiveResolved", () => {
    const skillId = "SKL_ATTACK";
    const effectActionId = "ACT_ATTACK";
    const passiveSkillId = "SKL_PS_ON_DAMAGED";
    const passiveSkill: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId(passiveSkillId),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "DamageApplied",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "SELF",
          condition: { kind: "TRUE" },
        },
      ],
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
      metadata: { displayName: passiveSkillId, tags: [] },
    };
    const catalog = new CatalogBuilder()
      .withUnit(
        unitDefinition("UNIT_ATK", {
          baseStats: { maximumAp: 1 },
          activeSkillDefinitionIds: [createSkillDefinitionId(skillId)],
        }),
        unitDefinition("UNIT_PS_DEF", {
          baseStats: { maximumHp: 1000, maximumPp: 3 },
          extraGaugeMaximum: 10,
          passiveSkillDefinitionIds: [createSkillDefinitionId(passiveSkillId)],
        }),
      )
      .withSkill(attackSkill(skillId, effectActionId), passiveSkill)
      .withEffectAction(damageEffectAction(effectActionId))
      .build();

    const result = runScenario({
      catalog,
      command: battleCommand({
        allyFormation: { slots: [formationSlot("UNIT_ATK", 0)], memoryDefinitionIds: [] },
        enemyFormation: { slots: [formationSlot("UNIT_PS_DEF", 0)], memoryDefinitionIds: [] },
        turnLimit: 1,
      }),
      randomValues: [0.99],
      battleIds: ["B_1"],
    });

    const { events, finalState } = result;
    const defenderUnitId = createBattleUnitId("enemy:1");

    // Non-lethal attack (UNIT_ATK attack 10 - UNIT_PS_DEF defense 10 -> 1
    // damage floor, 1000 HP survives) so the PS resolves without interruption.
    const eventTypes = events.map((e) => e.type);
    const damageAppliedIndex = eventTypes.indexOf("DAMAGE_APPLIED");
    const passiveActivatedIndex = eventTypes.indexOf("PASSIVE_ACTIVATED");
    const passiveResolvedIndex = eventTypes.indexOf("PASSIVE_RESOLVED");
    expect(damageAppliedIndex).toBeGreaterThanOrEqual(0);
    // R-SKL-01/02: the PS resolves immediately, before the attacker's action completes.
    expect(passiveActivatedIndex).toBeGreaterThan(damageAppliedIndex);
    expect(passiveResolvedIndex).toBeGreaterThan(passiveActivatedIndex);

    const passiveActivated = events[passiveActivatedIndex]!;
    expect(passiveActivated.details).toMatchObject({
      actorUnitId: defenderUnitId,
      skillDefinitionId: createSkillDefinitionId(passiveSkillId),
      // TURN_STARTING recovers PP to maximumPp (3) before the action phase.
      ppBefore: 3,
      ppAfter: 2,
      exBefore: 0,
      exAfter: 1,
    });

    // Restrict to the window between DamageApplied and PassiveActivated so the
    // defender's own later WAIT action (which also emits AP/EX ResourceChanged
    // for itself, R-ACT-03) doesn't get mixed into the PS's own resource change.
    const resourceChangedForDefender = events
      .slice(damageAppliedIndex, passiveActivatedIndex)
      .filter(
        (e) =>
          e.type === "RESOURCE_CHANGED" &&
          (e.details as { battleUnitId: string }).battleUnitId === defenderUnitId,
      );
    expect(
      resourceChangedForDefender.map((e) => (e.details as { resource: string }).resource),
    ).toEqual(["PP", "EX_GAUGE"]);
    expect(resourceChangedForDefender[0]!.details).toMatchObject({
      before: 3,
      after: 2,
      delta: -1,
      reason: "SKILL_COST",
    });
    expect(resourceChangedForDefender[1]!.details).toMatchObject({
      before: 0,
      after: 1,
      delta: 1,
      reason: "EX_GAIN",
    });

    expect(finalState.units[defenderUnitId]!.pp).toBe(2);
    // +1 from the PS's own activation, then +1 per subsequent mandatory WAIT
    // in the defender's own action phase (maximumAp 3, no active skill, R-ACT-03).
    expect(finalState.units[defenderUnitId]!.extraGauge).toBe(4);
  });

  it("SCN-BTL-023 (Issue #251 acceptance): a same-cycle DEFEATED reservation removal, whose own PS reaction chain further changes state, still satisfies the full-battle invariants (parent/root determinism, independent StateDelta reapplication) enforced end-to-end by the public use case", () => {
    const skillId = "SKL_KILL_NEAREST";
    const effectActionId = "ACT_KILL_NEAREST";
    const passiveSkillId = "SKL_PS_ON_RESERVATION_REMOVED";
    const nearestEnemy: TargetSelectorDefinition = {
      kind: "SELECT",
      side: "ENEMY",
      count: 1,
      filters: [],
      order: ["DEFAULT"],
      includeDefeated: false,
    };
    const killSkill: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId(skillId),
      skillType: "AS",
      cost: { resource: "AP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [],
      counterUpdates: [],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [
          { targetBindingId: createTargetBindingId("TGT_1"), selector: nearestEnemy },
        ],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
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
      metadata: { displayName: "Kill nearest", tags: [] },
    };
    // Issue #251: reacts to ActionReservationRemoved (the DEFEATED removal of
    // the doomed enemy, decided and recorded by the dedicated
    // action-reservation-removal-resolver before the doomed unit's own turn
    // is ever reached) — its own PP/EX ResourceChanged changes are exactly
    // the kind of reaction-chain StateDelta whose independent reapplication
    // `assembleSimulationResult` verifies unconditionally for every battle.
    const passiveSkill: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId(passiveSkillId),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "ActionReservationRemoved",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
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
      metadata: { displayName: passiveSkillId, tags: [] },
    };
    const catalog = new CatalogBuilder()
      .withUnit(
        unitDefinition("UNIT_ATK", {
          baseStats: { maximumAp: 1, attack: 999, actionSpeed: 20, maximumPp: 3 },
          extraGaugeMaximum: 10,
          activeSkillDefinitionIds: [createSkillDefinitionId(skillId)],
          passiveSkillDefinitionIds: [createSkillDefinitionId(passiveSkillId)],
        }),
        unitDefinition("UNIT_DOOMED", {
          baseStats: { maximumHp: 10, defense: 0, actionSpeed: 10 },
        }),
        unitDefinition("UNIT_SURVIVOR", { baseStats: { actionSpeed: 5 } }),
      )
      .withSkill(killSkill, passiveSkill)
      .withEffectAction(damageEffectAction(effectActionId, 1, "PREVENTED"))
      .build();

    const result = runScenario({
      catalog,
      command: battleCommand({
        allyFormation: { slots: [formationSlot("UNIT_ATK", 0)], memoryDefinitionIds: [] },
        enemyFormation: {
          slots: [formationSlot("UNIT_DOOMED", 0), formationSlot("UNIT_SURVIVOR", 1)],
          memoryDefinitionIds: [],
        },
        turnLimit: 1,
      }),
      randomValues: [],
      battleIds: ["B_1"],
    });

    const { events, stateTransitions, initialState, finalState } = result;
    const doomedUnitId = createBattleUnitId("enemy:1");

    // The doomed enemy is defeated before its own reservation is reached and
    // never acts — the reservation-removal fixed-point resolver discarded it
    // outright, DEFEATED, rather than letting it execute a stale reservation.
    expect(
      events.some(
        (e) =>
          e.type === "ACTION_STARTED" &&
          (e.details as { actorUnitId: string }).actorUnitId === doomedUnitId,
      ),
    ).toBe(false);
    const removed = events.find(
      (e) =>
        e.type === "ACTION_RESERVATION_REMOVED" &&
        (e.details as { battleUnitId: string }).battleUnitId === doomedUnitId,
    )!;
    expect(removed.details).toMatchObject({ reason: "DEFEATED" });
    // The attacker's PS, triggered by that removal, activates within the
    // same battle — proving ActionReservationRemoved reaches PS/Memory
    // candidate resolution end-to-end (not just at the internal-API level
    // the UT-R-ORD-01-* suite already covers).
    const passiveActivated = events.find((e) => e.type === "PASSIVE_ACTIVATED")!;
    expect(passiveActivated.details).toMatchObject({
      skillDefinitionId: createSkillDefinitionId(passiveSkillId),
    });
    expect(passiveActivated.sequence).toBeGreaterThan(removed.sequence);

    // Parent/root determinism (10_API設計.md BattleLogEventResponse), same
    // invariant SCN-BTL-001 checks generally — verified here specifically
    // across a chain that includes ActionReservationRemoved and its own PS
    // reaction (Issue #251's causal-cursor contract).
    const bySequence = new Map(events.map((e) => [e.sequence, e]));
    for (const event of events) {
      if (event.parentSequence === undefined) {
        expect(event.rootSequence).toBe(event.sequence);
        continue;
      }
      const parent = bySequence.get(event.parentSequence);
      expect(parent).toBeDefined();
      expect(event.sequence).toBeGreaterThan(event.parentSequence);
      expect(event.rootSequence).toBe(parent!.rootSequence);
    }
    // The PS activation's ancestor chain traces back to the removal that
    // triggered it (walking parentSequence, since PassiveActivated's direct
    // parent may be an intermediate step of its own activation rather than
    // the trigger event itself).
    let ancestor = passiveActivated;
    while (ancestor.parentSequence !== undefined && ancestor.sequence !== removed.sequence) {
      ancestor = bySequence.get(ancestor.parentSequence)!;
    }
    expect(ancestor.sequence).toBe(removed.sequence);

    // Independent StateDelta Reducer restores finalState from
    // initialState + stateTransitions — `assembleSimulationResult` already
    // enforces this unconditionally (throwing INTERNAL_INVARIANT_VIOLATION
    // otherwise), so merely completing without throwing already proves it
    // for this removal-heavy path; re-asserted directly here per
    // `12_テスト戦略.md`「独立した差分Reducer」.
    const restored = reduceStateDeltas(
      initialState,
      stateTransitions.map((t) => t.stateDelta),
    );
    expect(restored).toEqual(finalState);
  });
});
