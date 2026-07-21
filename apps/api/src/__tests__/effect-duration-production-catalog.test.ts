import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { grantEffect } from "../domain/battle/effects/effect-grant-service.js";
import { recalculateCombatStats } from "../domain/battle/effects/combat-stat-recalculation-service.js";
import {
  emitEffectConsumptionChangedEvents,
  expireEffects,
} from "../domain/battle/effects/duration-expiry-service.js";
import {
  consumeEffectDurations,
  decrementActionEffectDurations,
  decrementTurnEffectDurations,
} from "../domain/battle/model/applied-effect-duration.js";
import { createBattleUnit, type BattleUnit } from "../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../domain/battle/model/battle-party.js";
import { EventRecorder } from "../domain/battle/events/event-recorder.js";
import { toGlobalCoordinate } from "../domain/battle/model/global-coordinate.js";
import { createActionId } from "../domain/shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../domain/shared/ids.js";
import { loadCatalogFromDirectory } from "../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * EFF-003 (Issue #159): exercises the REAL production `catalog/` `APPLY_STAT_MOD`
 * `duration` payloads (ACTION/TURN period, EFFECT_TARGET/EFFECT_SOURCE/BATTLE
 * owner, `NEXT_OUTGOING_ATTACK` consumption) through the REAL domain executors
 * (`decrementActionEffectDurations`/`decrementTurnEffectDurations`/
 * `consumeEffectDurations`/`expireEffects`), mirroring
 * `stat-mod-production-catalog.test.ts` (EFF-002) and
 * `cooldown-manipulation-production-catalog.test.ts` (Issue #129). This proves
 * both the catalog-src wiring and R-EFF-04/06/07's real lifecycle mechanics are
 * correct against unmodified production data — the prerequisite this Issue's
 * DoD requires before flipping `CAP_COMPLEX_EXPIRATION`/`CAP_STAT_MOD` to
 * `IMPLEMENTED` in `capabilities.json`.
 */

const CATALOG_DIR = fileURLToPath(new URL("../../catalog", import.meta.url));

function actorFor(unitDefinitionId: string, id: string): BattleUnit {
  const position = { column: "LEFT", row: "FRONT" } as const;
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: unitDefinitionId as never,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate("ALLY", position),
    combatStats: {
      maximumHp: 1000,
      attack: 100,
      defense: 50,
      criticalRate: 0.1,
      actionSpeed: 100,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
  return createBattleUnit(member, "ALLY", { maximumAp: 4, maximumPp: 4, maximumExtraGauge: 10 });
}

function seedRecorder(): {
  recorder: EventRecorder;
  rootEventId: ReturnType<EventRecorder["record"]>["eventId"];
} {
  const recorder = new EventRecorder(createBattleId("B_1"));
  const seed = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber: 1 },
  });
  return { recorder, rootEventId: seed.eventId };
}

describe("production Catalog ACTION-unit duration decrement (EFF-003, R-EFF-04)", () => {
  it.each([
    {
      unitId: "UNIT_DOROTHEA_PIONEER",
      effectActionId: "ACT_DOROTHEA_PIONEER_AS2_DEF_DOWN",
      expectedOwner: "EFFECT_TARGET" as const,
      stat: "defense" as const,
      // EFFECT_TARGET: self-buff is sufficient to prove the target's own
      // action-end triggers decrement.
      grantToOther: false,
      decrementActorIsSource: false,
    },
    {
      unitId: "UNIT_CLARA_TSUNDERE",
      effectActionId: "ACT_CLARA_TSUNDERE_PS1_DEF_DOWN",
      expectedOwner: "EFFECT_SOURCE" as const,
      stat: "defense" as const,
      // EFFECT_SOURCE: grant cross-unit (source casts on other) so the
      // instance lives on `other`'s registry but decrements on the SOURCE's
      // own action-end, proving `resolveTimeLimitOwnerUnitId` resolution.
      grantToOther: true,
      decrementActorIsSource: true,
    },
    {
      unitId: "UNIT_KARINA_DOWNER",
      effectActionId: "ACT_KARINA_DOWNER_PS1_ATTACKER_ATKDOWN",
      expectedOwner: "BATTLE" as const,
      stat: "attack" as const,
      // BATTLE: decrements on ANY unit's action-end, proven by granting to
      // `other` and completing `owner`'s (a different unit's) action.
      grantToOther: true,
      decrementActorIsSource: true,
    },
  ])(
    "IT-CAP-COMPLEX-EXPIRATION-PROD-001: $effectActionId ($unitId, owner=$expectedOwner) decrements and expires via the real duration payload, reverting CombatStat",
    ({ unitId, effectActionId, expectedOwner, stat, grantToOther, decrementActorIsSource }) => {
      const catalog = loadCatalogFromDirectory(CATALOG_DIR);
      const snapshot = catalog.loadSnapshot([unitId as never], []);
      const effectAction = snapshot.effectActions.get(effectActionId as never);
      expect(effectAction?.kind).toBe("APPLY_STAT_MOD");
      if (effectAction?.kind !== "APPLY_STAT_MOD") {
        return;
      }
      expect(effectAction.payload.duration.timeLimit?.unit).toBe("ACTION");
      expect(effectAction.payload.duration.timeLimit?.owner ?? "EFFECT_TARGET").toBe(expectedOwner);
      expect(effectAction.payload.formula.kind).toBe("CONSTANT");
      if (effectAction.payload.formula.kind !== "CONSTANT") {
        return;
      }

      const source = actorFor(unitId, "source-1");
      const other = actorFor(unitId, "other-1");
      const holder = grantToOther ? other : source;
      const { recorder, rootEventId } = seedRecorder();
      const grantingActionId = createActionId("B_1:action:1");

      // R-EFF-05: the target holds the AppliedEffect regardless of owner.
      const grantResult = grantEffect(
        {
          recorder,
          turnNumber: 1,
          cycleNumber: 1,
          actionId: grantingActionId,
          resolutionScopeId: recorder.nextResolutionScopeId(),
          rootEventId,
        },
        [source, other],
        {
          effectActionDefinitionId: effectAction.effectActionDefinitionId,
          sourceId: source.battleUnitId,
          targetId: holder.battleUnitId,
          duplicate: true,
          magnitude: effectAction.payload.formula.value,
          durationDefinition: effectAction.payload.duration,
        },
        rootEventId,
      );
      let units = grantResult.units;
      const recalculated = recalculateCombatStats(
        {
          recorder,
          turnNumber: 1,
          cycleNumber: 1,
          actionId: grantingActionId,
          resolutionScopeId: recorder.nextResolutionScopeId(),
          rootEventId,
        },
        [source, other],
        units,
        holder.battleUnitId,
        snapshot.effectActions,
        grantResult.lastEventId,
        "EFFECT_APPLIED",
      );
      units = recalculated.units;
      let lastEventId = recalculated.lastEventId;
      const buffedValue = units.find((u) => u.battleUnitId === holder.battleUnitId)!.combatStats[
        stat
      ];
      expect(buffedValue).not.toBe(holder.combatStats[stat]);

      const remaining = effectAction.payload.duration.timeLimit!.count;
      const decrementActorId = decrementActorIsSource ? source.battleUnitId : holder.battleUnitId;
      for (let i = 0; i < remaining; i++) {
        const currentActionId = createActionId(`B_1:action:${i + 2}`);
        const decrement = decrementActionEffectDurations(units, decrementActorId, currentActionId);
        units = decrement.units;
        const seeds = decrement.changes
          .filter((change) => change.after === 0)
          .map((change) => ({
            battleUnitId: change.battleUnitId,
            effectInstanceId: change.effectInstanceId,
            reason: "TIME_LIMIT" as const,
          }));
        if (i === remaining - 1) {
          expect(seeds).toHaveLength(1);
          const expiry = expireEffects(
            {
              recorder,
              turnNumber: 1,
              cycleNumber: 1,
              actionId: currentActionId,
              resolutionScopeId: recorder.nextResolutionScopeId(),
              rootEventId,
            },
            units,
            seeds,
            snapshot.effectActions,
            lastEventId,
          );
          units = expiry.units;
          lastEventId = expiry.lastEventId;
        } else {
          expect(seeds).toHaveLength(0);
        }
      }

      const finalHolder = units.find((u) => u.battleUnitId === holder.battleUnitId)!;
      expect(finalHolder.appliedEffects).toHaveLength(0);
      expect(finalHolder.combatStats[stat]).toBe(holder.combatStats[stat]);
      expect(recorder.getEvents().some((e) => e.eventType === "EffectExpired")).toBe(true);
    },
  );
});

describe("production Catalog TURN-unit duration decrement (EFF-003, R-EFF-06)", () => {
  it.each([
    {
      unitId: "UNIT_SIENA_DIVA",
      effectActionId: "ACT_SIENA_DIVA_PS2_ALLY_CRIT_UP",
      stat: "criticalRate" as const,
    },
  ])(
    "IT-CAP-COMPLEX-EXPIRATION-PROD-002: $effectActionId ($unitId) decrements and expires via the real TURN duration payload",
    ({ unitId, effectActionId, stat }) => {
      const catalog = loadCatalogFromDirectory(CATALOG_DIR);
      const snapshot = catalog.loadSnapshot([unitId as never], []);
      const effectAction = snapshot.effectActions.get(effectActionId as never);
      expect(effectAction?.kind).toBe("APPLY_STAT_MOD");
      if (effectAction?.kind !== "APPLY_STAT_MOD") {
        return;
      }
      expect(effectAction.payload.duration.timeLimit?.unit).toBe("TURN");
      expect(effectAction.payload.formula.kind).toBe("CONSTANT");
      if (effectAction.payload.formula.kind !== "CONSTANT") {
        return;
      }

      const owner = actorFor(unitId, "owner-1");
      const { recorder, rootEventId } = seedRecorder();

      const grantResult = grantEffect(
        {
          recorder,
          turnNumber: 1,
          cycleNumber: 1,
          resolutionScopeId: recorder.nextResolutionScopeId(),
          rootEventId,
        },
        [owner],
        {
          effectActionDefinitionId: effectAction.effectActionDefinitionId,
          sourceId: owner.battleUnitId,
          targetId: owner.battleUnitId,
          duplicate: true,
          magnitude: effectAction.payload.formula.value,
          durationDefinition: effectAction.payload.duration,
        },
        rootEventId,
      );
      let units = grantResult.units;
      const recalculated = recalculateCombatStats(
        {
          recorder,
          turnNumber: 1,
          cycleNumber: 1,
          resolutionScopeId: recorder.nextResolutionScopeId(),
          rootEventId,
        },
        [owner],
        units,
        owner.battleUnitId,
        snapshot.effectActions,
        grantResult.lastEventId,
        "EFFECT_APPLIED",
      );
      units = recalculated.units;

      const remaining = effectAction.payload.duration.timeLimit!.count;
      let lastEventId = recalculated.lastEventId;
      for (let turn = 0; turn < remaining; turn++) {
        const decrement = decrementTurnEffectDurations(units, turn + 2);
        units = decrement.units;
        const seeds = decrement.changes
          .filter((change) => change.after === 0)
          .map((change) => ({
            battleUnitId: change.battleUnitId,
            effectInstanceId: change.effectInstanceId,
            reason: "TIME_LIMIT" as const,
          }));
        if (seeds.length > 0) {
          const expiry = expireEffects(
            {
              recorder,
              turnNumber: turn + 2,
              cycleNumber: 0,
              resolutionScopeId: recorder.nextResolutionScopeId(),
              rootEventId,
            },
            units,
            seeds,
            snapshot.effectActions,
            lastEventId,
          );
          units = expiry.units;
          lastEventId = expiry.lastEventId;
        }
      }

      const finalOwner = units.find((u) => u.battleUnitId === owner.battleUnitId)!;
      expect(finalOwner.appliedEffects).toHaveLength(0);
      expect(finalOwner.combatStats[stat]).toBe(owner.combatStats[stat]);
      expect(recorder.getEvents().some((e) => e.eventType === "EffectExpired")).toBe(true);
    },
  );
});

describe("production Catalog consumption (EFF-003, R-EFF-07)", () => {
  it.each([
    {
      unitId: "UNIT_FEE_ACTOR",
      effectActionId: "ACT_FEE_ACTOR_PS1_CRIT_UP",
      stat: "criticalRate" as const,
    },
  ])(
    "IT-CAP-COMPLEX-EXPIRATION-PROD-003: $effectActionId ($unitId) consumes and expires via the real NEXT_OUTGOING_ATTACK consumption payload",
    ({ unitId, effectActionId, stat }) => {
      const catalog = loadCatalogFromDirectory(CATALOG_DIR);
      const snapshot = catalog.loadSnapshot([unitId as never], []);
      const effectAction = snapshot.effectActions.get(effectActionId as never);
      expect(effectAction?.kind).toBe("APPLY_STAT_MOD");
      if (effectAction?.kind !== "APPLY_STAT_MOD") {
        return;
      }
      expect(effectAction.payload.duration.consumption?.kind).toBe("NEXT_OUTGOING_ATTACK");
      expect(effectAction.payload.formula.kind).toBe("CONSTANT");
      if (effectAction.payload.formula.kind !== "CONSTANT") {
        return;
      }

      const owner = actorFor(unitId, "owner-1");
      const { recorder, rootEventId } = seedRecorder();

      const grantResult = grantEffect(
        {
          recorder,
          turnNumber: 1,
          cycleNumber: 1,
          resolutionScopeId: recorder.nextResolutionScopeId(),
          rootEventId,
        },
        [owner],
        {
          effectActionDefinitionId: effectAction.effectActionDefinitionId,
          sourceId: owner.battleUnitId,
          targetId: owner.battleUnitId,
          duplicate: true,
          magnitude: effectAction.payload.formula.value,
          durationDefinition: effectAction.payload.duration,
        },
        rootEventId,
      );
      let units = grantResult.units;
      const recalculated = recalculateCombatStats(
        {
          recorder,
          turnNumber: 1,
          cycleNumber: 1,
          resolutionScopeId: recorder.nextResolutionScopeId(),
          rootEventId,
        },
        [owner],
        units,
        owner.battleUnitId,
        snapshot.effectActions,
        grantResult.lastEventId,
        "EFFECT_APPLIED",
      );
      units = recalculated.units;

      const consumption = consumeEffectDurations(units, owner.battleUnitId, "NEXT_OUTGOING_ATTACK");
      expect(consumption.changes).toHaveLength(1);
      expect(consumption.changes[0]!.after).toBe(0);
      units = consumption.units;
      const consumptionEventContext = {
        recorder,
        turnNumber: 1,
        cycleNumber: 1,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      };
      const consumptionChangedEventId = emitEffectConsumptionChangedEvents(
        consumptionEventContext,
        units,
        consumption.changes,
        recalculated.lastEventId,
      );

      const expiry = expireEffects(
        consumptionEventContext,
        units,
        [
          {
            battleUnitId: owner.battleUnitId,
            effectInstanceId: consumption.changes[0]!.effectInstanceId,
            reason: "CONSUMPTION",
          },
        ],
        snapshot.effectActions,
        consumptionChangedEventId,
      );
      units = expiry.units;

      const finalOwner = units.find((u) => u.battleUnitId === owner.battleUnitId)!;
      expect(finalOwner.appliedEffects).toHaveLength(0);
      expect(finalOwner.combatStats[stat]).toBeCloseTo(owner.combatStats[stat]);
      expect(recorder.getEvents().some((e) => e.eventType === "EffectConsumptionChanged")).toBe(
        true,
      );
      expect(recorder.getEvents().some((e) => e.eventType === "EffectExpired")).toBe(true);
    },
  );
});

describe("production Catalog linkedEffectGroup cascade (EFF-003, R-EFF-09)", () => {
  it("IT-CAP-COMPLEX-EXPIRATION-PROD-004: UNIT_HARRIET_SAGE's HARRIET_CURSE_LINK cascades ACT_HARRIET_SAGE_AS1_DMGDOWN when ACT_HARRIET_SAGE_AS1_ATKDOWN expires, via the real linkedEffectGroupId payload", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot(["UNIT_HARRIET_SAGE" as never], []);
    const atkDown = snapshot.effectActions.get("ACT_HARRIET_SAGE_AS1_ATKDOWN" as never);
    const dmgDown = snapshot.effectActions.get("ACT_HARRIET_SAGE_AS1_DMGDOWN" as never);
    expect(atkDown?.kind).toBe("APPLY_STAT_MOD");
    expect(dmgDown?.kind).toBe("APPLY_DAMAGE_MOD");
    if (atkDown?.kind !== "APPLY_STAT_MOD" || dmgDown?.kind !== "APPLY_DAMAGE_MOD") {
      return;
    }
    expect(atkDown.requiredCapabilities).toContain("CAP_COMPLEX_EXPIRATION");
    expect(dmgDown.requiredCapabilities).toContain("CAP_COMPLEX_EXPIRATION");
    expect(atkDown.payload.duration.linkedEffectGroupId).toBe("HARRIET_CURSE_LINK");
    expect(dmgDown.payload.duration.linkedEffectGroupId).toBe("HARRIET_CURSE_LINK");
    expect(atkDown.payload.formula.kind).toBe("CONSTANT");
    if (atkDown.payload.formula.kind !== "CONSTANT") {
      return;
    }

    const owner = actorFor("UNIT_HARRIET_SAGE", "owner-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = {
      recorder,
      turnNumber: 1,
      cycleNumber: 1,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      rootEventId,
    };

    const grantAtkDown = grantEffect(
      context,
      [owner],
      {
        effectActionDefinitionId: atkDown.effectActionDefinitionId,
        sourceId: owner.battleUnitId,
        targetId: owner.battleUnitId,
        duplicate: true,
        magnitude: atkDown.payload.formula.value,
        durationDefinition: atkDown.payload.duration,
      },
      rootEventId,
    );
    let units = grantAtkDown.units;
    const grantDmgDown = grantEffect(
      context,
      units,
      {
        effectActionDefinitionId: dmgDown.effectActionDefinitionId,
        sourceId: owner.battleUnitId,
        targetId: owner.battleUnitId,
        duplicate: true,
        // APPLY_DAMAGE_MOD's own formula shape isn't relevant to this
        // duration/cascade proof; `grantEffect` only needs a numeric
        // magnitude, not a resolved formula evaluation.
        magnitude: -0.075,
        durationDefinition: dmgDown.payload.duration,
      },
      grantAtkDown.lastEventId,
    );
    units = grantDmgDown.units;
    const holder = units.find((u) => u.battleUnitId === owner.battleUnitId)!;
    expect(holder.appliedEffects).toHaveLength(2);

    // Simulate the ATKDOWN parent expiring (its own trigger — dispel/
    // REMOVE_EFFECTS, R-EFF-02 — is M7-001 scope, not yet implemented; this
    // proves the cascade mechanism itself against the real linkedGroup data).
    const expiry = expireEffects(
      context,
      units,
      [
        {
          battleUnitId: owner.battleUnitId,
          effectInstanceId: grantAtkDown.appliedEffect.effectInstanceId,
          reason: "TIME_LIMIT",
        },
      ],
      snapshot.effectActions,
      grantDmgDown.lastEventId,
    );
    units = expiry.units;

    const finalHolder = units.find((u) => u.battleUnitId === owner.battleUnitId)!;
    expect(finalHolder.appliedEffects).toHaveLength(0);
    const expiredEvents = recorder.getEvents().filter((e) => e.eventType === "EffectExpired");
    expect(expiredEvents).toHaveLength(2);
    expect(expiredEvents[0]!.payload).toMatchObject({
      effectInstanceId: grantDmgDown.appliedEffect.effectInstanceId,
      reason: "LINKED_GROUP_CASCADE",
      cascaded: true,
    });
    expect(expiredEvents[1]!.payload).toMatchObject({
      effectInstanceId: grantAtkDown.appliedEffect.effectInstanceId,
      reason: "TIME_LIMIT",
      cascaded: false,
    });
  });
});
