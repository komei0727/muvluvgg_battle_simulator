import { describe, expect, it } from "vitest";
import { resolveReservationRemovals } from "./action-reservation-removal-resolver.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import type { ActionReservation } from "../action/action-queue.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import { createActionId, createEffectInstanceId } from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createRuntimeCounterId,
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";

const UNIT_TEST_ID = createUnitDefinitionId("UNIT_TEST");
const UNIT_TEST_DEFINITION: UnitDefinition = {
  unitDefinitionId: UNIT_TEST_ID,
  attribute: "AGGRESSIVE",
  unitType: "PHYSICAL",
  role: "PHYSICAL_ATTACKER",
  positionAptitudes: ["FRONT", "BACK"],
  baseStats: {
    maximumHp: 100,
    attack: 10,
    defense: 10,
    criticalRate: 0,
    criticalDamageBonus: 0.5,
    affinityBonus: 0,
    actionSpeed: 10,
    maximumAp: 1,
    maximumPp: 3,
  },
  extraGaugeMaximum: 10,
  activeSkillDefinitionIds: [],
  passiveSkillDefinitionIds: [],
  extraSkillDefinitionId: createSkillDefinitionId("SKL_EX"),
  requiredCapabilities: [],
  metadata: {
    displayName: "Test Unit",
    characterName: "Test Character",
    characterId: "CHAR_TEST",
    affiliations: [],
    tags: [],
  },
};

/** Never resolved in this test — only `charge !== undefined` and `isFrozen` matter for R-ORD-01 eligibility. */
const HELD_CHARGE_SKILL: SkillDefinition = {
  skillDefinitionId: createSkillDefinitionId("SKL_HELD"),
  skillType: "AS",
  cost: { resource: "AP", amount: 1 },
  activationCondition: { kind: "TRUE" },
  triggers: [],
  counterUpdates: [],
  resolution: {
    kind: "CHARGE",
    targetBindings: [],
    steps: [],
    chargeRelease: { targetBindings: [], steps: [] },
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
  metadata: { displayName: "Held", tags: [] },
};

function unit(
  id: string,
  side: Side,
  overrides: {
    currentAp?: number;
    currentExtraGauge?: number;
    maximumExtraGauge?: number;
    currentHp?: number;
  } = {},
): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_TEST"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  const limits = {
    maximumAp: 1,
    maximumPp: 3,
    maximumExtraGauge: overrides.maximumExtraGauge ?? 10,
  };
  const built = createBattleUnit(member, side, limits);
  return {
    ...built,
    currentAp: overrides.currentAp ?? built.currentAp,
    currentExtraGauge: overrides.currentExtraGauge ?? built.currentExtraGauge,
    currentHp: overrides.currentHp ?? built.currentHp,
  };
}

function definitionsOf(): BattleDefinitions {
  return {
    activeSkillsByUnit: new Map(),
    exSkillByUnit: new Map(),
    effectActions: new Map(),
    unitDefinitions: new Map([[UNIT_TEST_ID, UNIT_TEST_DEFINITION]]),
    skillDefinitions: new Map(),
  };
}

function reservationOf(battleUnitId: BattleUnit["battleUnitId"]): ActionReservation {
  return { battleUnitId, reservedActionKind: "AS" };
}

/**
 * Issue #251（レビュー指摘[P2]）: 除去自身のPS/Memory反応連鎖が「別予約を
 * 適格化する」ケース。動的な`APPLY_STATUS FREEZE`付与は`effect-action-group-resolver.ts`
 * が未対応（`STEALTH`/`STUN`のみ対応）なため、代わりにEFF-005/Issue #162の
 * `AppliedEffect`スコープ`counterUpdates`＋`expiration.conditions`（`RUNTIME_COUNTER`）
 * を使い、`ActionReservationRemoved`自体をトリガーに既存の凍結を即時失効させる
 * fixtureで検証する（レビュー提案）。
 */
function frozenChargeHeldEffect(
  counterId: ReturnType<typeof createRuntimeCounterId>,
): AppliedEffect {
  const definitionId = createEffectActionDefinitionId("ACT_FREEZE");
  return {
    effectInstanceId: createEffectInstanceId("effect-freeze"),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate: true,
    sourceId: createBattleUnitId("E"),
    targetId: createBattleUnitId("E"),
    magnitude: 0,
    categories: ["DEBUFF", "STATUS"],
    statusKind: "FREEZE",
    duration: {
      definition: {
        timeLimit: { unit: "ACTION", count: 99 },
        dispellable: true,
        linkedEffectGroupId: null,
        counterUpdates: [
          {
            kind: "INCREMENT",
            counter: counterId,
            scope: "APPLIED_EFFECT",
            trigger: {
              eventType: "ActionReservationRemoved",
              category: "FACT",
              sourceSelector: "ANY",
              targetSelector: "ANY",
              condition: { kind: "TRUE" },
            },
            amount: 1,
          },
        ],
        expiration: {
          conditions: [{ kind: "RUNTIME_COUNTER", counter: counterId, op: "GTE", value: 1 }],
        },
      },
      counters: {},
    },
    appliedTurnNumber: 1,
  };
}

describe("resolveReservationRemovals", () => {
  it("UT-R-ORD-01-009 (Issue #251, レビュー指摘[P2]): a removal's own reaction chain can restore another reservation's eligibility before the next candidate is judged — a unit whose only eligibility source (a pending charge) is impeded by a pre-existing freeze that expires as a direct reaction to the removal is spared, not removed", () => {
    const counterId = createRuntimeCounterId("RUNTIME_COUNTER_FREEZE_EXPIRY");
    // B: no AP, no full EX, no charge — unconditionally ineligible from the
    // start, so it is the first (and only initially-decidable) removal target.
    const unitB = unit("B", "ALLY", { currentAp: 0, currentExtraGauge: 0 });
    // E: no AP, no full EX; its only eligibility source is a pending charge,
    // currently impeded by a pre-existing FREEZE (so E starts out just as
    // ineligible as B) whose own expiration.conditions (RUNTIME_COUNTER)
    // clears the moment B's removal fires ActionReservationRemoved.
    const unitE: BattleUnit = {
      ...unit("E", "ALLY", { currentAp: 0, currentExtraGauge: 0 }),
      charge: {
        skill: HELD_CHARGE_SKILL,
        startedActionId: createActionId("B_1:action:1"),
      },
      appliedEffects: [frozenChargeHeldEffect(counterId)],
    };

    const recorder = new EventRecorder(createBattleId("B_1"));
    const seed = recorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { turnNumber: 1 },
    });

    const result = resolveReservationRemovals(
      [reservationOf(unitB.battleUnitId), reservationOf(unitE.battleUnitId)],
      [unitB, unitE],
      {
        definitions: definitionsOf(),
        random: new SequenceRandomSource([]),
        recorder,
        turnNumber: 1,
        cycleNumber: 1,
        parentEventId: seed.eventId,
        rootEventId: seed.eventId,
      },
    );

    // Only B was removed — E's freeze expired as a direct reaction to B's own
    // removal, restoring E's charge-based eligibility before the next
    // candidate was judged, so E was never even considered ineligible again.
    expect(result.remaining.map((r) => r.battleUnitId)).toEqual([unitE.battleUnitId]);
    const removedEvents = recorder
      .getEvents()
      .filter((e) => e.eventType === "ActionReservationRemoved");
    expect(removedEvents.map((e) => e.sourceUnitId)).toEqual([unitB.battleUnitId]);

    const finalE = result.units.find((u) => u.battleUnitId === unitE.battleUnitId)!;
    expect(finalE.appliedEffects).toHaveLength(0);
    expect(finalE.charge).toBeDefined();
  });
});
