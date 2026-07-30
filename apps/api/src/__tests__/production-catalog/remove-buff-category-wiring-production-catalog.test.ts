import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { applyDamageAction } from "../../domain/battle/combat/damage-application-service.js";
import { PassiveActivationRuntime } from "../../domain/battle/lifecycle/passive-activation-service.js";
import { grantEffect } from "../../domain/battle/effects/effect-grant-service.js";
import { createBattleUnit, type BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";
import { createUnitDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import type { Side } from "../../domain/shared/side.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * M7-001C (Issue #244) re-review [P2]: `remove-effects-production-catalog.
 * test.ts`'s `IT-REMOVE-EFFECTS-PROD-004/005` exercise `removeEffects` (the
 * executor) directly against a hand-picked `battleUnitId`, so they never
 * prove the production `SkillDefinition`'s own target selection/binding is
 * wired correctly — a regression flipping Shouka EX/AS3's target from ENEMY
 * to SELF, or breaking Senka PS2's `TRIGGER_TARGET` binding, would still
 * pass. These tests instead resolve the REAL, unmodified production skills
 * through the REAL resolvers (`resolveSkillUse`/`PassiveActivationRuntime`)
 * and assert only the intended side loses its BUFF.
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 10 };

function member(
  battleUnitId: string,
  unitDefinitionId: string,
  side: Side,
  position: FormationPosition,
): BattlePartyMember {
  return {
    battleUnitId: createBattleUnitId(battleUnitId),
    unitDefinitionId: unitDefinitionId as never,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 1000,
      attack: 100,
      defense: 50,
      criticalRate: 0,
      actionSpeed: 100,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
}

function testUnitDefinition(id: string): UnitDefinition {
  return {
    unitDefinitionId: createUnitDefinitionId(id),
    attribute: "AGGRESSIVE",
    unitType: "PHYSICAL",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT", "BACK"],
    baseStats: {
      maximumHp: 1000,
      attack: 100,
      defense: 50,
      criticalRate: 0,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
      actionSpeed: 100,
      maximumAp: LIMITS.maximumAp,
      maximumPp: LIMITS.maximumPp,
    },
    extraGaugeMaximum: LIMITS.maximumExtraGauge,
    activeSkillDefinitionIds: [],
    passiveSkillDefinitionIds: [],
    extraSkillDefinitionId: undefined as never,
    requiredCapabilities: [],
    metadata: {
      displayName: id,
      characterName: id,
      characterId: `CHAR_${id}`,
      affiliations: [],
      tags: [],
    },
  };
}

const BUFF_DEF_ID = "ACT_TEST_WIRING_BUFF" as EffectActionDefinition["effectActionDefinitionId"];
const buffDefinition: EffectActionDefinition = {
  kind: "APPLY_STAT_MOD",
  effectActionDefinitionId: BUFF_DEF_ID,
  requiredCapabilities: [],
  metadata: { tags: [] },
  payload: {
    stat: "ATTACK",
    valueType: "RATIO",
    formula: { kind: "CONSTANT", value: 0.1 },
    stacking: { mode: "STACKABLE", max: null },
    duration: { dispellable: true, linkedEffectGroupId: null },
  },
};

/** Seeds a `TurnStarted` FACT event to obtain a valid `DomainEventId` for `grantBuff`'s `rootEventId`/`lastEventId`. */
function seedEvent(
  recorder: EventRecorder,
  resolutionScopeId: ReturnType<EventRecorder["nextResolutionScopeId"]>,
) {
  return recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId,
    payload: { turnNumber: 1 },
  });
}

/** Grants one BUFF-category (magnitude>=0 per R-EFF-05) instance of `BUFF_DEF_ID` onto `holder`. */
function grantBuff(
  recorder: EventRecorder,
  resolutionScopeId: ReturnType<EventRecorder["nextResolutionScopeId"]>,
  lastEventId: ReturnType<typeof seedEvent>["eventId"],
  units: readonly BattleUnit[],
  holder: BattleUnit,
): readonly BattleUnit[] {
  const result = grantEffect(
    { recorder, turnNumber: 1, cycleNumber: 1, resolutionScopeId, rootEventId: lastEventId },
    units,
    {
      definition: buffDefinition,
      sourceId: holder.battleUnitId,
      targetId: holder.battleUnitId,
      duplicate: true,
      magnitude: 0.1,
      durationDefinition: { dispellable: true, linkedEffectGroupId: null },
    },
    lastEventId,
  );
  return result.units;
}

describe("production Catalog SKL_SHOUKA_SCHEMER_EX/AS3 wiring (M7-001C, Issue #244 re-review)", () => {
  const ENEMY_UNIT_ID = "UNIT_TEST_SHOUKA_ENEMY";

  it.each([
    { skillId: "SKL_SHOUKA_SCHEMER_EX", effectiveActionType: "EX" as const },
    { skillId: "SKL_SHOUKA_SCHEMER_AS3", effectiveActionType: "AS" as const },
  ])(
    "IT-REMOVE-EFFECTS-PROD-006: $skillId removes the ENEMY target's BUFF and leaves the caster's own BUFF untouched",
    ({ skillId, effectiveActionType }) => {
      const catalog = loadCatalogFromDirectory(CATALOG_DIR);
      const snapshot = catalog.loadSnapshot(["UNIT_SHOUKA_SCHEMER" as never], []);
      const skill = snapshot.skills.get(skillId as never);
      expect(skill).toBeDefined();

      const shouka = {
        ...createBattleUnit(
          member("ally:shouka", "UNIT_SHOUKA_SCHEMER", "ALLY", { column: "CENTER", row: "FRONT" }),
          "ALLY",
          LIMITS,
        ),
        currentAp: LIMITS.maximumAp,
        currentExtraGauge: LIMITS.maximumExtraGauge,
      };
      const enemy = createBattleUnit(
        member("enemy:1", ENEMY_UNIT_ID, "ENEMY", { column: "CENTER", row: "FRONT" }),
        "ENEMY",
        LIMITS,
      );

      const unitDefinitions = new Map(snapshot.units);
      unitDefinitions.set(createUnitDefinitionId(ENEMY_UNIT_ID), testUnitDefinition(ENEMY_UNIT_ID));
      const effectActions = new Map(snapshot.effectActions);
      effectActions.set(BUFF_DEF_ID, buffDefinition);
      const definitions: BattleDefinitions = {
        activeSkillsByUnit: new Map(),
        exSkillByUnit: new Map(),
        effectActions,
        unitDefinitions,
        skillDefinitions: snapshot.skills,
      };

      const recorder = new EventRecorder(createBattleId("B_1"));
      const resolutionScopeId = recorder.nextResolutionScopeId();
      const seed = seedEvent(recorder, resolutionScopeId);
      const actionId = recorder.nextActionId();

      // Both the caster and the enemy hold their own BUFF before the skill
      // resolves; the caster's should survive regardless of which unit the
      // REMOVE_EFFECTS action actually targets.
      let units: readonly BattleUnit[] = [shouka, enemy];
      units = grantBuff(recorder, resolutionScopeId, seed.eventId, units, shouka);
      const shoukaWithBuff = units.find((u) => u.battleUnitId === shouka.battleUnitId)!;
      units = grantBuff(recorder, resolutionScopeId, seed.eventId, units, enemy);

      const result = resolveSkillUse(
        shoukaWithBuff,
        skill!,
        effectiveActionType,
        effectiveActionType,
        units,
        definitions,
        new SequenceRandomSource([0.99, 0.99, 0.99, 0.99, 0.99]),
        recorder,
        1,
        1,
        actionId,
        resolutionScopeId,
      );

      const finalShouka = result.units.find((u) => u.battleUnitId === shouka.battleUnitId)!;
      const finalEnemy = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;

      // The intended target (ENEMY) lost its BUFF...
      expect(finalEnemy.appliedEffects).toHaveLength(0);
      // ...but the caster's own BUFF was never touched — proving the
      // production skill's target binding still resolves to ENEMY, not SELF.
      // (Shouka EX's second step separately grants an ALLY-wide STATUS
      // immunity buff onto the caster too — that's the real, intended
      // ACT_SHOUKA_SCHEMER_EX_IMMUNITY side effect, not a regression, so we
      // only assert the synthetic BUFF instance specifically survives.)
      expect(
        finalShouka.appliedEffects.some(
          (effect) => effect.effectActionDefinitionId === BUFF_DEF_ID,
        ),
      ).toBe(true);

      const removed = recorder
        .getEvents()
        .find(
          (e) => e.eventType === "EffectRemoved" && e.targetUnitIds?.includes(enemy.battleUnitId),
        );
      expect(removed).toBeDefined();
    },
  );
});

describe("production Catalog SKL_SENKA_CHRISTMAS_PS2 wiring (M7-001C, Issue #244 re-review)", () => {
  const SENKA_UNIT_ID = "UNIT_SENKA_CHRISTMAS";
  const ATTACKED_ENEMY_ID = "UNIT_TEST_SENKA_ATTACKED_ENEMY";
  const OTHER_ENEMY_ID = "UNIT_TEST_SENKA_OTHER_ENEMY";
  const ATTACK_EFFECT_ID =
    "ACT_TEST_SENKA_ATTACK" as EffectActionDefinition["effectActionDefinitionId"];

  function attackEffectAction(): Extract<EffectActionDefinition, { kind: "DAMAGE" }> {
    return {
      kind: "DAMAGE",
      effectActionDefinitionId: ATTACK_EFFECT_ID,
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        damageType: "PHYSICAL",
        formula: { kind: "SKILL_POWER", power: 1 },
        hitCount: 1,
        // R-CRT-01 not exercised here: SKL_SENKA_CHRISTMAS_PS2's trigger
        // condition is unconditional TRUE on CriticalCheckResolved (see
        // catalog-src/units/UNIT_SENKA_CHRISTMAS/skills.json), so it fires
        // regardless of whether the hit actually crit.
        critical: { mode: "PREVENTED" },
        accuracy: { mode: "NORMAL" },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
        damageModifiers: [],
        link: { enabled: false },
      },
    };
  }

  it("IT-REMOVE-EFFECTS-PROD-007: SKL_SENKA_CHRISTMAS_PS2 activates from the REAL CriticalCheckResolved event applyDamageAction emits, and removes only the actually-attacked enemy's BUFF (TRIGGER_TARGET), leaving a bystander enemy and Senka herself untouched", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([SENKA_UNIT_ID as never], []);

    const senka = {
      ...createBattleUnit(
        member("ally:senka", SENKA_UNIT_ID, "ALLY", { column: "CENTER", row: "FRONT" }),
        "ALLY",
        LIMITS,
      ),
      currentPp: LIMITS.maximumPp,
    };
    const attackedEnemy = createBattleUnit(
      member("enemy:attacked", ATTACKED_ENEMY_ID, "ENEMY", { column: "CENTER", row: "FRONT" }),
      "ENEMY",
      LIMITS,
    );
    const otherEnemy = createBattleUnit(
      member("enemy:other", OTHER_ENEMY_ID, "ENEMY", { column: "LEFT", row: "FRONT" }),
      "ENEMY",
      LIMITS,
    );

    const unitDefinitions = new Map(snapshot.units);
    unitDefinitions.set(
      createUnitDefinitionId(ATTACKED_ENEMY_ID),
      testUnitDefinition(ATTACKED_ENEMY_ID),
    );
    unitDefinitions.set(createUnitDefinitionId(OTHER_ENEMY_ID), testUnitDefinition(OTHER_ENEMY_ID));
    const effectActions = new Map(snapshot.effectActions);
    effectActions.set(BUFF_DEF_ID, buffDefinition);
    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions,
      unitDefinitions,
      skillDefinitions: snapshot.skills,
    };

    const recorder = new EventRecorder(createBattleId("B_1"));
    const resolutionScopeId = recorder.nextResolutionScopeId();
    const seed = seedEvent(recorder, resolutionScopeId);
    const actionId = recorder.nextActionId();

    let units: readonly BattleUnit[] = [senka, attackedEnemy, otherEnemy];
    units = grantBuff(recorder, resolutionScopeId, seed.eventId, units, senka);
    units = grantBuff(recorder, resolutionScopeId, seed.eventId, units, attackedEnemy);
    units = grantBuff(recorder, resolutionScopeId, seed.eventId, units, otherEnemy);
    const senkaWithBuff = units.find((u) => u.battleUnitId === senka.battleUnitId)!;
    const attackedEnemyWithBuff = units.find((u) => u.battleUnitId === attackedEnemy.battleUnitId)!;

    const actionStarted = recorder.record({
      eventType: "ActionStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      actionId,
      resolutionScopeId,
      payload: {
        actorUnitId: senka.battleUnitId,
        reservedActionType: "AS",
        effectiveActionType: "AS",
        apBefore: 1,
        apAfter: 0,
        exBefore: 0,
        exAfter: 0,
      },
    });

    // Drive the REAL production Damage pipeline so `CriticalCheckResolved`
    // (Senka PS2's trigger, sourceSelector:SELF/targetSelector:ENEMY) is
    // byte-for-byte what a real Senka attack produces, with
    // targetUnitIds=[attackedEnemy] — proving `TGT_TRIGGER_TARGET` resolves
    // to the real attacked unit, not `otherEnemy` or Senka herself.
    const attack = attackEffectAction();
    const damageResult = applyDamageAction(
      senkaWithBuff,
      [
        {
          targetBattleUnitId: attackedEnemyWithBuff.battleUnitId,
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
        skillDefinitionId: "SKL_TEST_SENKA_ATTACKER" as never,
      },
    );

    const criticalCheckResolved = recorder
      .getEvents()
      .find((e) => e.eventType === "CriticalCheckResolved")!;
    expect(criticalCheckResolved.sourceUnitId).toBe(senka.battleUnitId);
    expect(criticalCheckResolved.targetUnitIds).toEqual([attackedEnemy.battleUnitId]);

    const runtime = new PassiveActivationRuntime(
      {
        definitions,
        random: new SequenceRandomSource([]),
        recorder,
        turnNumber: 1,
        cycleNumber: 1,
        resolutionScopeId,
        rootEventId: actionStarted.eventId,
        actionId,
      },
      damageResult.units,
    );

    const updatedUnits = runtime.onFactEvent(criticalCheckResolved, damageResult.units).units;

    const passiveActivated = recorder
      .getEvents()
      .find(
        (e) =>
          e.eventType === "PassiveActivated" &&
          (e.payload as { skillDefinitionId: string }).skillDefinitionId ===
            "SKL_SENKA_CHRISTMAS_PS2",
      );
    expect(passiveActivated).toBeDefined();

    const finalSenka = updatedUnits.find((u) => u.battleUnitId === senka.battleUnitId)!;
    const finalAttacked = updatedUnits.find((u) => u.battleUnitId === attackedEnemy.battleUnitId)!;
    const finalOther = updatedUnits.find((u) => u.battleUnitId === otherEnemy.battleUnitId)!;

    // Only the actually-attacked enemy lost its BUFF.
    expect(finalAttacked.appliedEffects).toHaveLength(0);
    // The bystander enemy and Senka herself were never touched.
    expect(finalOther.appliedEffects).toHaveLength(1);
    expect(finalSenka.appliedEffects).toHaveLength(1);
  });
});
