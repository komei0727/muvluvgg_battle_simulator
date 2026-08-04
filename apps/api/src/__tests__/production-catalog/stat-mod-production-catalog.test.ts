import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { grantEffect } from "../../domain/battle/effects/effect-grant-service.js";
import { recalculateCombatStats } from "../../domain/battle/effects/combat-stat-recalculation-service.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import {
  effectActionFrom,
  loadProductionSnapshot,
  seedRecorder,
  testBattleUnit,
} from "../../testing/fixtures/index.js";

/**
 * EFF-002 (Issue #165): exercises the REAL production `catalog/`
 * `APPLY_STAT_MOD` `EffectActionDefinition` payload through the REAL domain
 * executors (`grantEffect`/`recalculateCombatStats`). `CAP_STAT_MOD` has
 * since been flipped to `IMPLEMENTED` by EFF-003 (Issue #159, which wired
 * ACTION/TURN duration expiration — see `effect-duration-production-catalog.test.ts`
 * for the corresponding decrement/expiry proof), so this path is reachable
 * from production battles. This proves the catalog-src wiring and
 * R-STA-02〜04's CombatStat recalculation are correct against unmodified
 * production data, mirroring `cooldown-manipulation-production-catalog.test.ts`
 * (Issue #129).
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

const COMBAT_STATS = {
  maximumHp: 1000,
  attack: 100,
  defense: 50,
  criticalRate: 0.1,
  actionSpeed: 100,
  criticalDamageBonus: 0.5,
  affinityBonus: 0.25,
};

function actorFor(unitDefinitionId: string): BattleUnit {
  return testBattleUnit({
    battleUnitId: "B_1:unit:1",
    unitDefinitionId,
    combatStats: COMBAT_STATS,
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
      const snapshot = loadProductionSnapshot(CATALOG_DIR, [unitId]);

      const effectAction = effectActionFrom(snapshot, effectActionId);
      expect(effectAction.kind).toBe("APPLY_STAT_MOD");
      if (effectAction.kind !== "APPLY_STAT_MOD") {
        return;
      }
      expect(effectAction.requiredCapabilities).toContain("CAP_STAT_MOD");
      expect(effectAction.payload.formula.kind).toBe("CONSTANT");
      if (effectAction.payload.formula.kind !== "CONSTANT") {
        return;
      }

      const actor = actorFor(unitId);
      const { recorder, rootEventId } = seedRecorder("B_1");

      const grantContext = {
        recorder,
        turnNumber: 1,
        cycleNumber: 1,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      };
      const grantResult = grantEffect(
        grantContext,
        [actor],
        {
          definition: effectAction,
          sourceUnitId: actor.battleUnitId,
          targetUnitId: actor.battleUnitId,
          duplicate: true,
          magnitude: effectAction.payload.formula.value,
          durationDefinition: effectAction.payload.duration,
        },
        rootEventId,
      );

      const recalculation = recalculateCombatStats(
        grantContext,
        [actor],
        grantResult.units,
        actor.battleUnitId,
        snapshot.effectActions,
        grantResult.lastEventId,
        "EFFECT_APPLIED",
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
