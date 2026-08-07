import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyMarker } from "../../domain/battle/effects/marker-apply-service.js";
import { removeMarkers } from "../../domain/battle/effects/marker-removal-service.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import {
  effectActionFrom,
  loadProductionSnapshot,
  seedRecorder,
  testBattleUnit,
} from "../../testing/fixtures/index.js";

/**
 * EFF-004 (Issue #160): exercises REAL production `catalog/` `APPLY_MARKER`/
 * `REMOVE_MARKER` `EffectActionDefinition` payloads through the REAL domain
 * executors (`marker-apply-service.ts`/`marker-removal-service.ts`), mirroring
 * `stat-mod-production-catalog.test.ts` (EFF-002). Proves R-EFF-10's four
 * stack policies (ADD/KEEP_EXISTING/REFRESH/REPLACE) and explicit removal
 * against unmodified production data. `CAP_MARKER` is flipped to
 * `IMPLEMENTED` alongside this test (`catalog-src/capabilities.json`).
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

function actorFor(unitDefinitionId: string, battleUnitId: string): BattleUnit {
  return testBattleUnit({ battleUnitId, unitDefinitionId, combatStats: COMBAT_STATS });
}

function newContext() {
  const { recorder, rootEventId } = seedRecorder("B_1");
  return {
    recorder,
    context: {
      recorder,
      turnNumber: 1,
      cycleNumber: 1,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      rootEventId,
    },
  };
}

describe("production Catalog APPLY_MARKER (EFF-004, R-EFF-10)", () => {
  it.each([
    { unitId: "UNIT_DOROTHEA_PIONEER", effectActionId: "ACT_DOROTHEA_PIONEER_AS1_MARKER" },
    { unitId: "UNIT_CHIZURU_DOMESTIC", effectActionId: "ACT_CHIZURU_DOMESTIC_PS3_MARKER" },
    { unitId: "UNIT_STELLA_STATUE", effectActionId: "ACT_STELLA_STATUE_EX_MARKER" },
    { unitId: "UNIT_KARINA_DOWNER", effectActionId: "ACT_KARINA_DOWNER_PS1_MARK_ATTACKER" },
  ])(
    "IT-MARKER-PROD-001: $effectActionId ($unitId) applies via the real payload's stack policy",
    ({ unitId, effectActionId }) => {
      const snapshot = loadProductionSnapshot(CATALOG_DIR, [unitId]);

      const effectAction = effectActionFrom(snapshot, effectActionId);
      expect(effectAction.kind).toBe("APPLY_MARKER");
      if (effectAction.kind !== "APPLY_MARKER") {
        return;
      }

      const source = actorFor(unitId, "B_1:unit:1");
      const target = actorFor(unitId, "B_1:unit:2");
      const { recorder, context } = newContext();

      const first = applyMarker(
        context,
        [source, target],
        {
          markerId: effectAction.payload.markerId,
          sourceUnitId: source.battleUnitId,
          targetUnitId: target.battleUnitId,
          stackPolicy: effectAction.payload.stack.policy,
          stackMax: effectAction.payload.stack.max,
          durationDefinition: effectAction.payload.duration,
        },
        context.rootEventId,
      );
      expect(first.markerState.stackCount).toBe(1);
      expect(first.markerState.markerId).toBe(effectAction.payload.markerId);

      const second = applyMarker(
        context,
        first.units,
        {
          markerId: effectAction.payload.markerId,
          sourceUnitId: source.battleUnitId,
          targetUnitId: target.battleUnitId,
          stackPolicy: effectAction.payload.stack.policy,
          stackMax: effectAction.payload.stack.max,
          durationDefinition: effectAction.payload.duration,
        },
        first.lastEventId,
      );

      const expectedSecondStack = ((): number => {
        switch (effectAction.payload.stack.policy) {
          case "ADD":
            return effectAction.payload.stack.max === null
              ? 2
              : Math.min(2, effectAction.payload.stack.max);
          case "REFRESH":
          case "REPLACE":
          case "KEEP_EXISTING":
            return 1;
        }
      })();
      expect(second.markerState.stackCount).toBe(expectedSecondStack);

      const nextTarget = second.units.find((u) => u.battleUnitId === target.battleUnitId)!;
      expect(nextTarget.markerStates).toHaveLength(1);
      expect(recorder.getEvents().some((e) => e.eventType === "MarkerApplied")).toBe(true);
    },
  );

  it.each([
    {
      unitId: "UNIT_AOI_ELEGANT",
      applyEffectActionId: "ACT_AOI_ELEGANT_AS1_MARKER_UKIASHI",
      removeEffectActionId: "ACT_AOI_ELEGANT_AS1_CLEAR_UKIASHI",
    },
    {
      unitId: "UNIT_HARRIET_SAGE",
      applyEffectActionId: "ACT_HARRIET_SAGE_AS1_MARKER",
      removeEffectActionId: undefined,
    },
  ])(
    "IT-MARKER-PROD-002: $applyEffectActionId ($unitId) grants a Marker the real payload can later REMOVE_MARKER",
    ({ unitId, applyEffectActionId, removeEffectActionId }) => {
      const snapshot = loadProductionSnapshot(CATALOG_DIR, [unitId]);

      const applyEffectAction = effectActionFrom(snapshot, applyEffectActionId);
      expect(applyEffectAction.kind).toBe("APPLY_MARKER");
      if (applyEffectAction.kind !== "APPLY_MARKER") {
        return;
      }

      const source = actorFor(unitId, "B_1:unit:1");
      const target = actorFor(unitId, "B_1:unit:2");
      const { recorder, context } = newContext();

      const granted = applyMarker(
        context,
        [source, target],
        {
          markerId: applyEffectAction.payload.markerId,
          sourceUnitId: source.battleUnitId,
          targetUnitId: target.battleUnitId,
          stackPolicy: applyEffectAction.payload.stack.policy,
          stackMax: applyEffectAction.payload.stack.max,
          durationDefinition: applyEffectAction.payload.duration,
        },
        context.rootEventId,
      );

      if (removeEffectActionId === undefined) {
        return;
      }
      const removeEffectAction = effectActionFrom(snapshot, removeEffectActionId);
      expect(removeEffectAction.kind).toBe("REMOVE_MARKER");
      if (removeEffectAction.kind !== "REMOVE_MARKER") {
        return;
      }
      expect(removeEffectAction.payload.markerId).toBe(applyEffectAction.payload.markerId);

      const removed = removeMarkers(
        context,
        granted.units,
        [
          {
            battleUnitId: target.battleUnitId,
            markerInstanceId: granted.markerState.markerInstanceId,
            reason: "REMOVED",
          },
        ],
        snapshot.effectActions,
        granted.lastEventId,
      );
      const nextTarget = removed.units.find((u) => u.battleUnitId === target.battleUnitId)!;
      expect(nextTarget.markerStates).toHaveLength(0);
      expect(recorder.getEvents().some((e) => e.eventType === "MarkerRemoved")).toBe(true);
    },
  );
});
