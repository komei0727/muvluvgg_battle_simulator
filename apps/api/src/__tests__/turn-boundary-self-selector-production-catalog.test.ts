import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBattleUnit } from "../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../domain/battle/model/battle-party.js";
import { toGlobalCoordinate } from "../domain/battle/model/global-coordinate.js";
import { createBattleUnitId } from "../domain/shared/ids.js";
import { detectPassiveCandidates } from "../domain/battle/triggering/passive-trigger-matcher.js";
import { createEmptyPassiveActivationGuard } from "../domain/battle/triggering/passive-activation-guard.js";
import type { TriggerCandidateEvent } from "../domain/battle/triggering/trigger-event.js";
import { loadCatalogFromDirectory } from "../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * Review fix [P1] (Issue #144 follow-up, PR #152): `TurnStarted`/`TurnCompleting`
 * carry neither `sourceUnitId` nor `targetUnitIds` (they are global,
 * unit-less lifecycle events — `battle.ts` never sets these fields when
 * recording them). production Catalog authors 39 PS triggers
 * (`TurnStarted`: 27, `TurnCompleting`: 12) as `sourceSelector: "SELF"` /
 * `targetSelector: "SELF"` against these two eventTypes, matching
 * `08_ドメインイベント.md`'s own "自身がASを使う前 → sourceSelector = SELF"
 * convention. Before the matching `trigger-selector-evaluator.ts` fix, `SELF`
 * required an exact `sourceUnitId`/`targetUnitIds` match, which a unit-less
 * event can never provide — so all 39 rows silently never candidated,
 * regardless of this PR's `TurnCompleting` phase wiring.
 *
 * This exercises the REAL, unmodified `SKL_KARINA_DOWNER_PS2` trigger
 * (`sourceSelector`/`targetSelector: "SELF"` against `TurnCompleting`)
 * against a `TurnCompleting` event shaped exactly as `battle.ts` emits it,
 * proving `detectPassiveCandidates` now candidates it for its own owner.
 */

const CATALOG_DIR = fileURLToPath(new URL("../../catalog", import.meta.url));

const KARINA_UNIT_ID = "UNIT_KARINA_DOWNER";
const KARINA_PS2_ID = "SKL_KARINA_DOWNER_PS2";

function actorFor(
  unitDefinitionId: string,
  battleUnitId: string,
): ReturnType<typeof createBattleUnit> {
  const position = { column: "LEFT", row: "FRONT" } as const;
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(battleUnitId),
    unitDefinitionId: unitDefinitionId as never,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate("ALLY", position),
    combatStats: {
      maximumHp: 100,
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

describe("production Catalog TurnStarted/TurnCompleting SELF/SELF triggers (review fix [P1], Issue #144 follow-up)", () => {
  it("IT-CAT-PROD-013: SKL_KARINA_DOWNER_PS2's real TurnCompleting SELF/SELF trigger candidates its owner given the exact event shape battle.ts emits (no sourceUnitId/targetUnitIds)", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([KARINA_UNIT_ID as never], []);
    const karinaUnitDefinition = snapshot.units.get(KARINA_UNIT_ID as never);
    expect(karinaUnitDefinition).toBeDefined();
    expect(karinaUnitDefinition!.passiveSkillDefinitionIds).toContain(KARINA_PS2_ID);
    const trigger = snapshot.skills.get(KARINA_PS2_ID as never)!.triggers[0];
    expect(trigger).toMatchObject({
      eventType: "TurnCompleting",
      sourceSelector: "SELF",
      targetSelector: "SELF",
    });

    const owner = actorFor(KARINA_UNIT_ID, "ally:1");
    // Exactly what `advanceBattle` records for `TurnCompleting`
    // (`battle.ts`): no `sourceUnitId`/`targetUnitIds` at all.
    const turnCompleting: TriggerCandidateEvent = {
      eventType: "TurnCompleting",
      category: "TIMING",
      payload: { turnNumber: 1 },
    };

    const candidates = detectPassiveCandidates({
      event: turnCompleting,
      units: [owner],
      unitDefinitions: snapshot.units,
      skillDefinitions: snapshot.skills,
      activationGuard: createEmptyPassiveActivationGuard(),
    });

    const ps2Candidate = candidates.find(
      (candidate) => candidate.skillDefinition.skillDefinitionId === KARINA_PS2_ID,
    );
    expect(ps2Candidate).toBeDefined();
    expect(ps2Candidate!.unit.battleUnitId).toBe(owner.battleUnitId);
  });
});
