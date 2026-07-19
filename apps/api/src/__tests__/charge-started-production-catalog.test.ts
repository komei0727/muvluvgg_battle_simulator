import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBattleUnit } from "../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../domain/battle/model/battle-party.js";
import { toGlobalCoordinate } from "../domain/battle/model/global-coordinate.js";
import { createBattleUnitId } from "../domain/shared/ids.js";
import { detectPassiveCandidates } from "../domain/battle/triggering/passive-trigger-matcher.js";
import { createEmptyPassiveActivationGuard } from "../domain/battle/triggering/passive-activation-guard.js";
import type { TriggerCandidateEvent } from "../domain/battle/triggering/trigger-event.js";
import type { UnitDefinition } from "../domain/catalog/definitions/unit-definition.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../domain/catalog/definitions/catalog-ids.js";
import type { Side } from "../domain/shared/side.js";
import { loadCatalogFromDirectory } from "../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * Issue #143 review re-fix [P2]: `ChargeStarted` previously carried no
 * `targetUnitIds`, so no `targetSelector` other than `ANY` could ever match
 * it — the production Harriet Sage PS2 (`sourceSelector: ALLY`,
 * `targetSelector: ALLY`) would never become a PS candidate even once
 * `resolveChargeStart` started routing `ChargeStarted` through
 * `PassiveActivationRuntime.onFactEvent`. `resolveChargeStart` now sets
 * `targetUnitIds: [actorId]` (the charging unit observes itself as the
 * event's subject), which this test verifies against the REAL, unmodified
 * production Catalog trigger.
 */

const CATALOG_DIR = fileURLToPath(new URL("../../catalog", import.meta.url));

function actorFor(
  unitDefinitionId: string,
  side: Side,
  battleUnitId: string,
): ReturnType<typeof createBattleUnit> {
  const position = { column: "LEFT", row: "FRONT" } as const;
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(battleUnitId),
    unitDefinitionId: unitDefinitionId as never,
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
  return createBattleUnit(member, side, { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 10 });
}

function noPassiveUnitDefinition(id: ReturnType<typeof createUnitDefinitionId>): UnitDefinition {
  return {
    unitDefinitionId: id,
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
      maximumAp: 3,
      maximumPp: 3,
    },
    extraGaugeMaximum: 10,
    activeSkillDefinitionIds: [],
    passiveSkillDefinitionIds: [],
    extraSkillDefinitionId: createSkillDefinitionId("SKL_EX_DEFAULT"),
    requiredCapabilities: [],
    metadata: {
      displayName: "Other",
      characterName: "Other",
      characterId: "CHAR_OTHER",
      affiliations: [],
      tags: [],
    },
  };
}

describe("production Catalog ChargeStarted targetUnitIds wiring (Issue #143 review re-fix [P2])", () => {
  it("IT-CAT-PROD-011: Harriet Sage's real PS2 trigger (ChargeStarted, sourceSelector/targetSelector: ALLY) becomes a PS candidate when another ally starts a charge, but not when an enemy does", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const harrietDefId = createUnitDefinitionId("UNIT_HARRIET_SAGE");
    const snapshot = catalog.loadSnapshot([harrietDefId], []);
    const harrietSkillId = createSkillDefinitionId("SKL_HARRIET_SAGE_PS2");
    const harrietSkill = snapshot.skills.get(harrietSkillId);
    expect(harrietSkill).toBeDefined();
    const trigger = harrietSkill!.triggers.find((t) => t.eventType === "ChargeStarted");
    expect(trigger).toBeDefined();
    expect(trigger?.sourceSelector).toBe("ALLY");
    expect(trigger?.targetSelector).toBe("ALLY");

    const chargingAllyDefId = createUnitDefinitionId("UNIT_CHARGE_ALLY_TEST");
    const chargingEnemyDefId = createUnitDefinitionId("UNIT_CHARGE_ENEMY_TEST");
    const unitDefinitions = new Map([
      ...snapshot.units,
      [chargingAllyDefId, noPassiveUnitDefinition(chargingAllyDefId)],
      [chargingEnemyDefId, noPassiveUnitDefinition(chargingEnemyDefId)],
    ]);

    const harriet = actorFor(harrietDefId, "ALLY", "B_1:unit:harriet");
    const chargingAlly = actorFor(chargingAllyDefId, "ALLY", "B_1:unit:ally-charger");
    const chargingEnemy = actorFor(chargingEnemyDefId, "ENEMY", "B_1:unit:enemy-charger");

    const chargeStartedFromAlly: TriggerCandidateEvent = {
      eventType: "ChargeStarted",
      category: "FACT",
      sourceUnitId: chargingAlly.battleUnitId,
      targetUnitIds: [chargingAlly.battleUnitId],
      payload: {
        actorUnitId: chargingAlly.battleUnitId,
        skillDefinitionId: "SKL_SOME_CHARGE",
        startedActionId: "B_1:action:1",
      },
    };
    const candidatesFromAlly = detectPassiveCandidates({
      event: chargeStartedFromAlly,
      units: [harriet, chargingAlly],
      unitDefinitions,
      skillDefinitions: snapshot.skills,
      activationGuard: createEmptyPassiveActivationGuard(),
    });
    expect(
      candidatesFromAlly.some((c) => c.skillDefinition.skillDefinitionId === harrietSkillId),
    ).toBe(true);

    const chargeStartedFromEnemy: TriggerCandidateEvent = {
      ...chargeStartedFromAlly,
      sourceUnitId: chargingEnemy.battleUnitId,
      targetUnitIds: [chargingEnemy.battleUnitId],
    };
    const candidatesFromEnemy = detectPassiveCandidates({
      event: chargeStartedFromEnemy,
      units: [harriet, chargingEnemy],
      unitDefinitions,
      skillDefinitions: snapshot.skills,
      activationGuard: createEmptyPassiveActivationGuard(),
    });
    expect(
      candidatesFromEnemy.some((c) => c.skillDefinition.skillDefinitionId === harrietSkillId),
    ).toBe(false);
  });
});
