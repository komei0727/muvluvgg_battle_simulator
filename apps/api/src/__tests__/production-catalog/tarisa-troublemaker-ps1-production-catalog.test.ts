import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PassiveActivationRuntime } from "../../domain/battle/lifecycle/passive-activation-service.js";
import { applyDamageAction } from "../../domain/battle/combat/damage-application-service.js";
import { applyMarker } from "../../domain/battle/effects/marker-apply-service.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import type { ActionId } from "../../domain/shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import { reduceStateDeltas } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import {
  definitionsWith,
  effectActionFrom,
  initialSnapshotFor,
  loadProductionSnapshot,
  seedRecorder,
  skillFrom,
  testBattleUnit,
  testUnitDefinition,
} from "../../testing/fixtures/index.js";

/**
 * M7-001D (Issue #247, CAP_TRIGGER_PAYLOAD_IN_RESOLUTION): exercises the REAL,
 * unmodified `SKL_TARISA_TROUBLEMAKER_PS1` through the REAL trigger pipeline —
 * a genuine `DamageApplied` event produced by `applyDamageAction` feeds
 * `PassiveActivationRuntime.onFactEvent`, which must resolve the new
 * conditional second ACTION step (`stepCondition: EVENT_PAYLOAD field:
 * calculatedDamage op:LTE value:10`) using the *same* triggering event's
 * payload the unconditional first step's Marker/stat-mod actions already ran
 * under. Proves both branches (removal fires / does not fire) against
 * unmodified production data, closing `docs/ddd/15_Unit_Memory変換台帳.md`'s
 * last `TRIGGER_PAYLOAD_IN_RESOLUTION` row without approximation.
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const TARISA_UNIT_ID = "UNIT_TARISA_TROUBLEMAKER";
const TARISA_PS1_ID = "SKL_TARISA_TROUBLEMAKER_PS1";
const MARKER_ID = "MARKER_TARISA_TROUBLEMAKER_FIGHTING_SPIRIT";
const ENEMY_UNIT_ID = "UNIT_TEST_TARISA_ENEMY";
const ATTACK_EFFECT_ID = "ACT_TEST_TARISA_ATTACK";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

const COMBAT_STATS = {
  maximumHp: 1000,
  attack: 100,
  defense: 50,
  criticalRate: 0,
  actionSpeed: 100,
  criticalDamageBonus: 0.5,
  affinityBonus: 0.25,
};

const ENEMY_DEFINITION = testUnitDefinition(ENEMY_UNIT_ID, {
  baseStats: {
    maximumHp: COMBAT_STATS.maximumHp,
    attack: COMBAT_STATS.attack,
    defense: COMBAT_STATS.defense,
    criticalDamageBonus: COMBAT_STATS.criticalDamageBonus,
    affinityBonus: COMBAT_STATS.affinityBonus,
    actionSpeed: COMBAT_STATS.actionSpeed,
    maximumAp: LIMITS.maximumAp,
    maximumPp: LIMITS.maximumPp,
  },
  extraGaugeMaximum: LIMITS.maximumExtraGauge,
});

/** Real DAMAGE effect action whose `calculatedDamage` is `attackerAttack - defenderDefense` (power 1, no crit/attribute noise). */
function attackEffectAction(power: number): Extract<EffectActionDefinition, { kind: "DAMAGE" }> {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(ATTACK_EFFECT_ID),
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power },
      hitCount: 1,
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

const snapshotOf = (units: readonly BattleUnit[]) =>
  initialSnapshotFor(units, { include: ["effects", "markers"] });

describe("production Catalog SKL_TARISA_TROUBLEMAKER_PS1 (M7-001D, Issue #247, CAP_TRIGGER_PAYLOAD_IN_RESOLUTION)", () => {
  function setup(defense: number) {
    const snapshot = loadProductionSnapshot(CATALOG_DIR, [TARISA_UNIT_ID]);
    const skill = skillFrom(snapshot, TARISA_PS1_ID);
    const markerAction = effectActionFrom(snapshot, "ACT_TARISA_TROUBLEMAKER_PS1_MARKER");
    expect(markerAction.kind).toBe("APPLY_MARKER");
    if (markerAction.kind !== "APPLY_MARKER") {
      throw new Error("unreachable");
    }
    const removeMarkerAction = effectActionFrom(
      snapshot,
      "ACT_TARISA_TROUBLEMAKER_PS1_REMOVE_MARKER",
    );
    expect(removeMarkerAction.kind).toBe("REMOVE_MARKER");
    if (removeMarkerAction.kind !== "REMOVE_MARKER") {
      throw new Error("unreachable");
    }
    expect(removeMarkerAction.payload).toEqual({ markerId: MARKER_ID, count: 3 });

    const tarisa = testBattleUnit({
      battleUnitId: "ally:tarisa",
      unitDefinitionId: TARISA_UNIT_ID,
      side: "ALLY",
      position: { column: "CENTER", row: "FRONT" },
      combatStats: { ...COMBAT_STATS, attack: 15 },
      limits: LIMITS,
      overrides: { currentPp: LIMITS.maximumPp },
    });
    const enemy = testBattleUnit({
      battleUnitId: "enemy:1",
      unitDefinitionId: ENEMY_UNIT_ID,
      side: "ENEMY",
      position: { column: "CENTER", row: "FRONT" },
      combatStats: { ...COMBAT_STATS, defense },
      limits: LIMITS,
    });

    const definitions = definitionsWith(snapshot, { units: [ENEMY_DEFINITION] });

    const { recorder, seed, resolutionScopeId } = seedRecorder("B_1");

    // Seed 5 pre-existing "Fighting Spirit" stacks via the REAL production
    // APPLY_MARKER definition (as if Tarisa had already attacked 5 times this
    // battle), so the conditional REMOVE_MARKER's `count: 3` is observable
    // against a non-trivial stack count.
    let units: readonly BattleUnit[] = [tarisa, enemy];
    let lastEventId = seed.eventId;
    for (let i = 0; i < 5; i += 1) {
      const grant = applyMarker(
        { recorder, turnNumber: 1, cycleNumber: 1, resolutionScopeId, rootEventId: seed.eventId },
        units,
        {
          markerId: markerAction.payload.markerId,
          sourceUnitId: tarisa.battleUnitId,
          targetUnitId: tarisa.battleUnitId,
          stackPolicy: markerAction.payload.stack.policy,
          stackMax: markerAction.payload.stack.max,
          durationDefinition: markerAction.payload.duration,
        },
        lastEventId,
      );
      units = grant.units;
      lastEventId = grant.lastEventId;
    }
    const tarisaWithStacks = units.find((u) => u.battleUnitId === tarisa.battleUnitId)!;
    expect(tarisaWithStacks.markerStates.find((m) => m.markerId === MARKER_ID)?.stackCount).toBe(5);

    return {
      skill,
      definitions,
      recorder,
      resolutionScopeId,
      units,
      tarisa: tarisaWithStacks,
      enemy,
    };
  }

  function fireAttack(
    setupResult: ReturnType<typeof setup>,
    power: number,
  ): {
    readonly damageApplied: BattleDomainEvent;
    readonly units: readonly BattleUnit[];
    readonly actionId: ActionId;
  } {
    const { recorder, resolutionScopeId, units, tarisa, enemy } = setupResult;
    const actionId = recorder.nextActionId();
    const actionStarted = recorder.record({
      eventType: "ActionStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      actionId,
      resolutionScopeId,
      payload: {
        actorUnitId: tarisa.battleUnitId,
        reservedActionType: "AS",
        effectiveActionType: "AS",
        apBefore: 1,
        apAfter: 0,
        exBefore: 0,
        exAfter: 0,
      },
    });
    const attack = attackEffectAction(power);
    const damageResult = applyDamageAction(
      tarisa,
      [
        {
          targetUnitId: enemy.battleUnitId,
          effectActionDefinitionId: attack.effectActionDefinitionId,
          hitIndex: 1,
        },
      ],
      attack,
      units,
      new SequenceRandomSource([]),
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 1,
        actionId,
        skillUseId: recorder.nextSkillUseId(),
        resolutionScopeId,
        rootEventId: actionStarted.eventId,
        parentEventId: actionStarted.eventId,
        skillDefinitionId: createSkillDefinitionId("SKL_TEST_TARISA_ATTACKER"),
      },
    );
    const damageApplied = recorder.getEvents().find((e) => e.eventType === "DamageApplied")!;
    expect(damageApplied.sourceUnitId).toBe(tarisa.battleUnitId);
    return { damageApplied, units: damageResult.units, actionId };
  }

  it("IT-CAP-TRIGGER-PAYLOAD-RES-PROD-001: calculatedDamage<=10 grants the unconditional Marker+ATK stack AND removes 3 stacks of Fighting Spirit via the conditional EVENT_PAYLOAD step (5 + 1 - 3 = 3)", () => {
    const setupResult = setup(10);
    const { damageApplied, units, actionId } = fireAttack(setupResult, 1); // attack 15 - defense 10 = 5 <= 10
    expect((damageApplied.payload as { calculatedDamage: number }).calculatedDamage).toBe(5);

    const runtime = new PassiveActivationRuntime(
      {
        definitions: setupResult.definitions,
        random: new SequenceRandomSource([]),
        recorder: setupResult.recorder,
        turnNumber: 1,
        cycleNumber: 1,
        resolutionScopeId: setupResult.resolutionScopeId,
        rootEventId: damageApplied.eventId,
        actionId,
      },
      units,
    );
    const updatedUnits = runtime.onFactEvent(damageApplied, units).units;

    const passiveActivated = setupResult.recorder
      .getEvents()
      .find(
        (e) =>
          e.eventType === "PassiveActivated" &&
          (e.payload as { skillDefinitionId: string }).skillDefinitionId === TARISA_PS1_ID,
      );
    expect(passiveActivated).toBeDefined();

    const finalTarisa = updatedUnits.find(
      (u) => u.battleUnitId === setupResult.tarisa.battleUnitId,
    )!;
    expect(finalTarisa.markerStates.find((m) => m.markerId === MARKER_ID)?.stackCount).toBe(3);
    // The unconditional ATK stat mod also ran in the same activation.
    expect(
      finalTarisa.appliedEffects.some(
        (effect) => effect.effectActionDefinitionId === "ACT_TARISA_TROUBLEMAKER_PS1_ATK_UP",
      ),
    ).toBe(true);
  });

  it("IT-CAP-TRIGGER-PAYLOAD-RES-PROD-002: calculatedDamage>10 still grants the unconditional Marker+ATK stack but does NOT remove any Fighting Spirit stacks (5 + 1 = 6)", () => {
    const setupResult = setup(0);
    const { damageApplied, units, actionId } = fireAttack(setupResult, 1); // attack 15 - defense 0 = 15 > 10
    expect((damageApplied.payload as { calculatedDamage: number }).calculatedDamage).toBe(15);

    const runtime = new PassiveActivationRuntime(
      {
        definitions: setupResult.definitions,
        random: new SequenceRandomSource([]),
        recorder: setupResult.recorder,
        turnNumber: 1,
        cycleNumber: 1,
        resolutionScopeId: setupResult.resolutionScopeId,
        rootEventId: damageApplied.eventId,
        actionId,
      },
      units,
    );
    const updatedUnits = runtime.onFactEvent(damageApplied, units).units;

    const finalTarisa = updatedUnits.find(
      (u) => u.battleUnitId === setupResult.tarisa.battleUnitId,
    )!;
    expect(finalTarisa.markerStates.find((m) => m.markerId === MARKER_ID)?.stackCount).toBe(6);
  });

  it("IT-CAP-TRIGGER-PAYLOAD-RES-PROD-003 (independent Reducer restoration): applying only the StateDeltas emitted by an EVENT_PAYLOAD-gated activation to the pre-activation snapshot reconstructs the same final live state", () => {
    const setupResult = setup(10);
    const before = setupResult.recorder.getEvents().length;
    const initial = snapshotOf(setupResult.units);
    const { damageApplied, units, actionId } = fireAttack(setupResult, 1);

    const runtime = new PassiveActivationRuntime(
      {
        definitions: setupResult.definitions,
        random: new SequenceRandomSource([]),
        recorder: setupResult.recorder,
        turnNumber: 1,
        cycleNumber: 1,
        resolutionScopeId: setupResult.resolutionScopeId,
        rootEventId: damageApplied.eventId,
        actionId,
      },
      units,
    );
    const updatedUnits = runtime.onFactEvent(damageApplied, units).units;

    // Two `MarkerUpdated` events fire in this activation: the unconditional
    // grant's own +1 update (5 -> 6) and the conditional removal's -3 update
    // (6 -> 3). Sanity-check both exist before trusting the deltas below.
    const markerUpdatedEvents = setupResult.recorder
      .getEvents()
      .slice(before)
      .filter(
        (e) =>
          e.eventType === "MarkerUpdated" &&
          (e.payload as { markerId: string }).markerId === MARKER_ID,
      );
    expect(markerUpdatedEvents).toHaveLength(2);
    expect(
      (markerUpdatedEvents[1]!.payload as { stackBefore: number; stackAfter: number }).stackBefore,
    ).toBe(6);
    expect(
      (markerUpdatedEvents[1]!.payload as { stackBefore: number; stackAfter: number }).stackAfter,
    ).toBe(3);

    // Independent restoration: only the StateDeltas emitted from this point
    // (the real attack's DAMAGE-family deltas plus the PS's own
    // grant+removal deltas), applied to the pre-activation snapshot.
    const deltas = setupResult.recorder
      .getEvents()
      .slice(before)
      .flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta]));
    const reconstructed = reduceStateDeltas(initial, deltas);

    expect(reconstructed).toEqual(snapshotOf(updatedUnits));
    expect(
      reconstructed.units[setupResult.tarisa.battleUnitId]?.markers?.find(
        (m) => m.markerId === MARKER_ID,
      )?.stackCount,
    ).toBe(3);
  });
});
