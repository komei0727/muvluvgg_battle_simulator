import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { grantEffect } from "../domain/battle/effects/effect-grant-service.js";
import { recalculateCombatStats } from "../domain/battle/effects/combat-stat-recalculation-service.js";
import { createBattleUnit, type BattleUnit } from "../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../domain/battle/model/battle-party.js";
import { EventRecorder } from "../domain/battle/events/event-recorder.js";
import { toGlobalCoordinate } from "../domain/battle/model/global-coordinate.js";
import { createBattleId, createBattleUnitId } from "../domain/shared/ids.js";
import { loadCatalogFromDirectory } from "../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * EFF-002 (Issue #165): exercises the REAL production `catalog/`
 * `APPLY_STAT_MOD` `EffectActionDefinition` payload through the REAL domain
 * executors (`grantEffect`/`recalculateCombatStats`), bypassing preflight —
 * `CAP_STAT_MOD` itself stays `PLANNED` (`apps/api/catalog/capabilities.json`)
 * until EFF-003 wires ACTION/TURN duration expiration (PR #208 review [P1]),
 * so no production battle can reach this path yet. This proves both the
 * catalog-src wiring and R-STA-02〜04's CombatStat recalculation are correct
 * against unmodified production data, mirroring
 * `cooldown-manipulation-production-catalog.test.ts` (Issue #129, which
 * exercises `applyCooldownManipulationAction` the same way while
 * `CAP_COOLDOWN_MANIPULATION` was still gated).
 */

const CATALOG_DIR = fileURLToPath(new URL("../../catalog", import.meta.url));

function actorFor(unitDefinitionId: string): BattleUnit {
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId("B_1:unit:1"),
    unitDefinitionId: unitDefinitionId as never,
    attribute: "AGGRESSIVE",
    position: { column: "LEFT", row: "FRONT" },
    globalCoordinate: toGlobalCoordinate("ALLY", { column: "LEFT", row: "FRONT" }),
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
  return createBattleUnit(member, "ALLY", {
    maximumAp: 4,
    maximumPp: 4,
    maximumExtraGauge: 10,
  });
}

describe("production Catalog APPLY_STAT_MOD (EFF-002, R-STA-02〜04/R-EFF-05)", () => {
  it.each([
    { unitId: "UNIT_ANIS_TROUBLEMAKER", effectActionId: "ACT_ANIS_TROUBLEMAKER_AS1_ATK_UP" },
    { unitId: "UNIT_AOI_ELEGANT", effectActionId: "ACT_AOI_ELEGANT_PS2_CRIT_DMG_DOWN" },
    { unitId: "UNIT_CHIYURU_NEWYEAR", effectActionId: "ACT_CHIYURU_NEWYEAR_PS1_MAX_HP_UP" },
    { unitId: "UNIT_CLARA_TSUNDERE", effectActionId: "ACT_CLARA_TSUNDERE_AS2_DEF_DOWN" },
    { unitId: "UNIT_CLARA_TSUNDERE", effectActionId: "ACT_CLARA_TSUNDERE_PS2_SPEED_UP" },
  ])(
    "IT-STAT-MOD-PROD-001: $effectActionId ($unitId) recalculates CombatStat via the real payload",
    ({ unitId, effectActionId }) => {
      const catalog = loadCatalogFromDirectory(CATALOG_DIR);
      const snapshot = catalog.loadSnapshot([unitId as never], []);

      const effectAction = snapshot.effectActions.get(effectActionId as never);
      expect(effectAction?.kind).toBe("APPLY_STAT_MOD");
      if (effectAction?.kind !== "APPLY_STAT_MOD") {
        return;
      }
      expect(effectAction.requiredCapabilities).toContain("CAP_STAT_MOD");
      expect(effectAction.payload.formula.kind).toBe("CONSTANT");
      if (effectAction.payload.formula.kind !== "CONSTANT") {
        return;
      }

      const actor = actorFor(unitId);
      const recorder = new EventRecorder(createBattleId("B_1"));
      const seed = recorder.record({
        eventType: "TurnStarted",
        category: "FACT",
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        payload: { turnNumber: 1 },
      });

      const grantContext = {
        recorder,
        turnNumber: 1,
        cycleNumber: 1,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId: seed.eventId,
      };
      const grantResult = grantEffect(
        grantContext,
        [actor],
        {
          effectActionDefinitionId: effectAction.effectActionDefinitionId,
          sourceId: actor.battleUnitId,
          targetId: actor.battleUnitId,
          duplicate: true,
          magnitude: effectAction.payload.formula.value,
          durationDefinition: effectAction.payload.duration,
        },
        seed.eventId,
      );

      const recalculation = recalculateCombatStats(
        grantContext,
        [actor],
        grantResult.units,
        actor.battleUnitId,
        snapshot.effectActions,
        grantResult.lastEventId,
      );

      const field = (
        {
          MAXIMUM_HP: "maximumHp",
          ATTACK: "attack",
          DEFENSE: "defense",
          CRITICAL_RATE: "criticalRate",
          CRITICAL_DAMAGE_BONUS: "criticalDamageBonus",
          AFFINITY_BONUS: "affinityBonus",
          ACTION_SPEED: "actionSpeed",
        } as const
      )[effectAction.payload.stat];
      const updated = recalculation.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
      const before = actor.combatStats[field];
      const magnitude = effectAction.payload.formula.value;
      const expectedAfter =
        effectAction.payload.valueType === "RATIO" ? before * (1 + magnitude) : before + magnitude;
      expect(updated.combatStats[field]).toBeCloseTo(expectedAfter);

      const changed = recorder.getEvents().filter((e) => e.eventType === "CombatStatChanged");
      expect(changed).toHaveLength(1);
      expect(changed[0]!.payload).toMatchObject({
        battleUnitId: actor.battleUnitId,
        stat: effectAction.payload.stat,
        reason: "EFFECT_APPLIED",
      });
    },
  );
});
