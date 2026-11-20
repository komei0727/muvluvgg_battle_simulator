import { describe, expect, it } from "vitest";
import { PassiveActivationRuntime } from "./passive-activation-service.js";
import { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import {
  contextOf,
  definitionsOf,
  passiveSkillOf,
  recordTurnStarted,
  unit,
  unitDefinitionOf,
} from "../../../testing/fixtures/passive-activation-runtime.js";

/**
 * Issue #858（R-ATM-03 #1）: トップレベルの攻撃前の発動機会でも、候補は各観測の
 * 状態保守の直後の状態で検出する。全観測の状態保守を先に済ませてから検出すると、
 * 観測ごとに進むcounterを条件にするPSが取りこぼされる。
 */
describe("PassiveActivationRuntime.onPreAttackObservations (R-ATM-03, Issue #858)", () => {
  const guardianDefinitionId = createUnitDefinitionId("UNIT_PRE_ATTACK_GUARDIAN");
  const attackerDefinitionId = createUnitDefinitionId("UNIT_PRE_ATTACK_ATTACKER");
  const counterId = createRuntimeCounterId("RUNTIME_COUNTER_OBSERVED");

  /** 攻撃前観測ごとにcounterを1加算し、counterが1の観測でだけ候補になるPS。 */
  function firstObservationGuard(): SkillDefinition {
    const base = passiveSkillOf("SKL_FIRST_OBSERVATION_GUARD", {
      ppCost: 1,
      triggers: [
        {
          eventType: "UnitBeingAttacked",
          category: "TIMING",
          sourceSelector: "ENEMY",
          targetSelector: "ANY",
          condition: { kind: "RUNTIME_COUNTER", counter: counterId, op: "EQ", value: 1 },
        },
      ],
    });
    return {
      ...base,
      counterUpdates: [
        {
          kind: "INCREMENT",
          counter: counterId,
          scope: "SKILL_RUNTIME",
          trigger: {
            eventType: "UnitBeingAttacked",
            category: "TIMING",
            sourceSelector: "ENEMY",
            targetSelector: "ANY",
            condition: { kind: "TRUE" },
          },
          amount: 1,
        },
      ],
    };
  }

  function observation(
    recorder: EventRecorder,
    turnStarted: BattleDomainEvent,
    targetUnitId: string,
  ): BattleDomainEvent {
    return recorder.record({
      eventType: "UnitBeingAttacked",
      category: "TIMING",
      turnNumber: 1,
      cycleNumber: 0,
      skillUseId: recorder.nextSkillUseId(),
      resolutionScopeId: turnStarted.resolutionScopeId,
      parentEventId: turnStarted.eventId,
      rootEventId: turnStarted.eventId,
      sourceUnitId: createBattleUnitId("ATTACKER"),
      targetUnitIds: [createBattleUnitId(targetUnitId)],
      payload: {
        skillDefinitionId: createSkillDefinitionId("SKL_TEST_ATTACK"),
        targetUnitId: createBattleUnitId(targetUnitId),
        damageTypes: ["PHYSICAL"],
      },
    });
  }

  it("UT-R-ATM-03-014 [R-ATM-03]: 観測ごとに進むcounterを条件にする攻撃前PSは、その観測の時点の状態で候補になる", () => {
    const guard = firstObservationGuard();
    const guardian = unit("GUARDIAN", "ALLY", {
      unitDefinitionId: guardianDefinitionId,
      currentPp: 3,
    });
    const ally = unit("ALLY_TARGET", "ALLY");
    const attacker = unit("ATTACKER", "ENEMY", { unitDefinitionId: attackerDefinitionId });
    const definitions = definitionsOf(
      new Map([
        [guardianDefinitionId, unitDefinitionOf(guardianDefinitionId, [guard.skillDefinitionId])],
        [attackerDefinitionId, unitDefinitionOf(attackerDefinitionId, [])],
        [createUnitDefinitionId("UNIT_A"), unitDefinitionOf(createUnitDefinitionId("UNIT_A"), [])],
      ]),
      new Map([[guard.skillDefinitionId, guard]]),
    );
    const recorder = new EventRecorder(createBattleId("B_PRE_ATTACK_RUNTIME"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(contextOf(recorder, definitions, turnStarted), [
      guardian,
      ally,
      attacker,
    ]);
    const events = [
      observation(recorder, turnStarted, "ALLY_TARGET"),
      observation(recorder, turnStarted, "GUARDIAN"),
    ];

    runtime.onPreAttackObservations(events, runtime.currentUnits, turnStarted.eventId);

    const activated = recorder
      .getEvents()
      .filter((event) => event.eventType === "PassiveActivated");
    expect(activated).toHaveLength(1);
  });
});
