import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyCooldownManipulationAction } from "../../domain/battle/lifecycle/cooldown-manipulation-application-service.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { ResolvedEffectApplication } from "../../domain/battle/skill/skill-resolution-service.js";
import { collectEffectActionReferences } from "../../domain/catalog/integrity/catalog-integrity.js";
import { createSkillDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import {
  effectActionFrom,
  loadProductionSnapshot,
  seedRecorder,
  skillFrom,
  testBattleUnit,
} from "../../testing/fixtures/index.js";

/**
 * Issue #129 (COOLDOWN_MANIPULATION): exercises the REAL production
 * `catalog/` skill/effect definitions for the 4 units in
 * `docs/ddd/15_Unit_Memory変換台帳.md`'s `COOLDOWN_MANIPULATION` rows,
 * through the REAL domain executor (`applyCooldownManipulationAction`).
 *
 * These skills also carry other EffectAction kinds (`APPLY_MARKER`,
 * `APPLY_CONTINUOUS_DAMAGE`, `BRANCH` conditions, ...) that the M5 basic
 * turn-action resolver (`action-phase-resolver.ts`) does not yet interpret
 * (M6/M7 scope, see its own `applyEffectActionGroups` doc comment) — so a
 * full `resolveActionPhase` run of these skills isn't possible yet,
 * independent of this Issue. Instead, each case here resolves a
 * `ResolvedEffectApplication` for the specific `COOLDOWN_MANIPULATION`
 * EffectAction the skill references (proven via `collectEffectActionReferences`,
 * the same structural-reference walk `catalog-integrity.ts` uses), targeting
 * the acting unit itself (SELF, by authoring design for all 5 references),
 * and applies it with the REAL `EffectActionDefinition` payload read from
 * `catalog/`. This proves both the catalog-src wiring and the domain
 * executor are correct against unmodified production data.
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

describe("production Catalog COOLDOWN_MANIPULATION (Issue #129)", () => {
  it.each([
    {
      unitId: "UNIT_SAYA_BUNNY",
      sourceSkillId: "SKL_SAYA_BUNNY_EX",
      effectActionId: "ACT_SAYA_BUNNY_EX_CD_RESET",
      targetSkillId: "SKL_SAYA_BUNNY_AS1",
    },
    {
      unitId: "UNIT_CHIYURU_NEWYEAR",
      sourceSkillId: "SKL_CHIYURU_NEWYEAR_EX",
      effectActionId: "ACT_CHIYURU_NEWYEAR_EX_CD_RESET",
      targetSkillId: "SKL_CHIYURU_NEWYEAR_AS1",
    },
    {
      unitId: "UNIT_CHIYURU_NEWYEAR",
      sourceSkillId: "SKL_CHIYURU_NEWYEAR_PS1",
      effectActionId: "ACT_CHIYURU_NEWYEAR_PS1_CD_RESET",
      targetSkillId: "SKL_CHIYURU_NEWYEAR_AS1",
    },
    {
      unitId: "UNIT_AOI_ELEGANT",
      sourceSkillId: "SKL_AOI_ELEGANT_EX",
      effectActionId: "ACT_AOI_ELEGANT_EX_CD_RESET",
      targetSkillId: "SKL_AOI_ELEGANT_PS1",
    },
    {
      unitId: "UNIT_MERU_FLATSPIN",
      sourceSkillId: "SKL_MERU_FLATSPIN_AS1",
      effectActionId: "ACT_MERU_FLATSPIN_AS1_CD_RESET",
      targetSkillId: "SKL_MERU_FLATSPIN_PS1",
    },
  ])(
    "IT-COOLDOWN-MANIP-PROD-001: $sourceSkillId ($unitId) resets $targetSkillId's cooldown via the real $effectActionId payload",
    ({ unitId, sourceSkillId, effectActionId, targetSkillId }) => {
      const snapshot = loadProductionSnapshot(CATALOG_DIR, [unitId]);

      const sourceSkill = skillFrom(snapshot, sourceSkillId);
      expect(sourceSkill).toBeDefined();
      const stepGroups =
        sourceSkill.resolution.kind === "CHARGE"
          ? [sourceSkill.resolution.steps, sourceSkill.resolution.chargeRelease.steps]
          : [sourceSkill.resolution.steps];
      const referencedIds = stepGroups.flatMap((steps) =>
        collectEffectActionReferences(steps).map((ref) => ref.effectActionDefinitionId),
      );
      expect(referencedIds).toContain(effectActionId);

      const effectAction = effectActionFrom(snapshot, effectActionId);
      expect(effectAction.kind).toBe("COOLDOWN_MANIPULATION");
      if (effectAction.kind !== "COOLDOWN_MANIPULATION") {
        return;
      }
      expect(effectAction.payload.targetSkillDefinitionId).toBe(targetSkillId);
      expect(effectAction.payload.operation).toBe("RESET");

      const targetSkill = skillFrom(snapshot, targetSkillId);
      expect(targetSkill).toBeDefined();
      const actor = actorFor(unitId);
      const actorWithCooldown: BattleUnit = {
        ...actor,
        cooldowns: {
          [createSkillDefinitionId(targetSkillId)]: {
            unit: targetSkill.cooldown.unit,
            remaining: targetSkill.cooldown.count,
          },
        },
      };

      const { recorder, rootEventId } = seedRecorder("B_1");
      const resolvedApplication: ResolvedEffectApplication = {
        targetUnitId: actorWithCooldown.battleUnitId,
        effectActionDefinitionId: effectAction.effectActionDefinitionId,
        hitIndex: 1,
      };

      const result = applyCooldownManipulationAction(
        [resolvedApplication],
        effectAction,
        [actorWithCooldown],
        {
          recorder,
          turnNumber: 1,
          cycleNumber: 1,
          actionId: recorder.nextActionId(),
          skillUseId: recorder.nextSkillUseId(),
          resolutionScopeId: recorder.nextResolutionScopeId(),
          rootEventId,
          parentEventId: rootEventId,
          sourceUnitId: actorWithCooldown.battleUnitId,
        },
      );

      expect(result.units[0]!.cooldowns[createSkillDefinitionId(targetSkillId)]?.remaining).toBe(0);
      const reduced = recorder.getEvents().filter((e) => e.eventType === "CooldownReduced");
      expect(reduced).toHaveLength(1);
      expect(reduced[0]!.payload).toMatchObject({
        skillDefinitionId: targetSkillId,
        before: targetSkill.cooldown.count,
        after: 0,
      });
      expect(recorder.getEvents().filter((e) => e.eventType === "CooldownCompleted")).toHaveLength(
        1,
      );
    },
  );
});
