import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBattleUnit } from "../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../domain/battle/model/battle-party.js";
import { toGlobalCoordinate } from "../domain/battle/model/global-coordinate.js";
import { createBattleUnitId } from "../domain/shared/ids.js";
import { detectRuntimeCounterUpdates } from "../domain/battle/triggering/runtime-counter-matcher.js";
import { evaluateTriggerCondition } from "../domain/battle/triggering/trigger-condition-evaluator.js";
import type { TriggerCandidateEvent } from "../domain/battle/triggering/trigger-event.js";
import type { Side } from "../domain/shared/side.js";
import { loadCatalogFromDirectory } from "../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * Issue #143 review re-fix [P1]: the 3 `CUMULATIVE_DAMAGE_THRESHOLD_TRIGGER`
 * PS (Chiyuru PS2 / Chizuru PS3 / Tatiana PS1) must activate only when a hit
 * actually crosses the max-HP-ratio threshold, not on every carry-only hit.
 * `RuntimeCounterChanged` now fires for both cases (for traceability — see
 * `docs/ddd/14_Catalog定義スキーマ.md`「counterUpdates」), so the REAL
 * production `catalog/` trigger condition (unmodified, loaded from disk) must
 * itself discriminate the two cases via an AND'd `valueChanged` check. This
 * exercises exactly that condition object against both a sub-threshold and a
 * threshold-crossing `RuntimeCounterChanged` payload, proving the fix (before
 * it, both cases matched — the bug this Issue's review caught).
 */

const CATALOG_DIR = fileURLToPath(new URL("../../catalog", import.meta.url));

function actorFor(
  unitDefinitionId: string,
  side: Side,
  battleUnitId: string,
  maximumHp: number,
): ReturnType<typeof createBattleUnit> {
  const position = { column: "LEFT", row: "FRONT" } as const;
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(battleUnitId),
    unitDefinitionId: unitDefinitionId as never,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp,
      attack: 100,
      defense: 50,
      criticalRate: 0.1,
      actionSpeed: 100,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
  return createBattleUnit(member, side, { maximumAp: 4, maximumPp: 4, maximumExtraGauge: 10 });
}

function damageEvent(
  sourceUnitId: ReturnType<typeof createBattleUnitId>,
  targetUnitId: ReturnType<typeof createBattleUnitId>,
  hitPointDamage: number,
): TriggerCandidateEvent {
  return {
    eventType: "DamageApplied",
    category: "FACT",
    sourceUnitId,
    targetUnitIds: [targetUnitId],
    payload: { hitPointDamage },
  };
}

describe("production Catalog CUMULATIVE_DAMAGE_THRESHOLD_TRIGGER gating on valueChanged (Issue #143 review re-fix [P1])", () => {
  it.each([
    { unitId: "UNIT_CHIYURU_NEWYEAR", skillId: "SKL_CHIYURU_NEWYEAR_PS2", maxHpRatio: 0.4 },
    { unitId: "UNIT_CHIZURU_DOMESTIC", skillId: "SKL_CHIZURU_DOMESTIC_PS3", maxHpRatio: 0.85 },
    { unitId: "UNIT_TATIANA_SAGE", skillId: "SKL_TATIANA_SAGE_PS1", maxHpRatio: 0.2 },
  ])(
    "IT-CAT-PROD-010: $skillId's ($unitId) real RuntimeCounterChanged trigger condition rejects a sub-threshold (carry-only) hit and accepts a threshold-crossing hit",
    ({ unitId, skillId, maxHpRatio }) => {
      const catalog = loadCatalogFromDirectory(CATALOG_DIR);
      const snapshot = catalog.loadSnapshot([unitId as never], []);
      const unitDefinition = snapshot.units.get(unitId as never);
      expect(unitDefinition).toBeDefined();
      const skill = snapshot.skills.get(skillId as never);
      expect(skill).toBeDefined();
      const trigger = skill!.triggers[0];
      expect(trigger?.eventType).toBe("RuntimeCounterChanged");

      const maximumHp = unitDefinition!.baseStats.maximumHp;
      const threshold = maximumHp * maxHpRatio;
      const owner = actorFor(unitId, "ALLY", "B_1:unit:1", maximumHp);
      const enemy = actorFor(unitId, "ENEMY", "B_1:unit:2", maximumHp);
      const unitDefinitions = snapshot.units;
      const skillDefinitions = snapshot.skills;

      // Sub-threshold hit: carry moves but the public value doesn't cross ->
      // RuntimeCounterChanged fires (valueChanged: false) for traceability,
      // but the real trigger condition must reject it.
      const subThreshold = detectRuntimeCounterUpdates({
        event: damageEvent(enemy.battleUnitId, owner.battleUnitId, threshold / 2),
        units: [owner, enemy],
        unitDefinitions,
        skillDefinitions,
      });
      expect(subThreshold.changes).toHaveLength(1);
      expect(subThreshold.changes[0]?.valueChanged).toBe(false);
      expect(
        evaluateTriggerCondition(
          trigger!.condition,
          {
            payload: {
              counter: subThreshold.changes[0]!.counter,
              valueChanged: subThreshold.changes[0]!.valueChanged,
            },
          },
          { owner, skillDefinitionId: skill!.skillDefinitionId },
        ),
      ).toBe(false);

      // Threshold-crossing hit: the public value actually changes -> the
      // real trigger condition must accept it.
      const crossing = detectRuntimeCounterUpdates({
        event: damageEvent(enemy.battleUnitId, owner.battleUnitId, threshold * 2),
        units: [owner, enemy],
        unitDefinitions,
        skillDefinitions,
      });
      expect(crossing.changes).toHaveLength(1);
      expect(crossing.changes[0]?.valueChanged).toBe(true);
      expect(
        evaluateTriggerCondition(
          trigger!.condition,
          {
            payload: {
              counter: crossing.changes[0]!.counter,
              valueChanged: crossing.changes[0]!.valueChanged,
            },
          },
          { owner, skillDefinitionId: skill!.skillDefinitionId },
        ),
      ).toBe(true);
    },
  );
});
