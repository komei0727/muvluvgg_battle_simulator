import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { applyDamageAction } from "../../domain/battle/combat/damage-application-service.js";
import { PassiveActivationRuntime } from "../../domain/battle/lifecycle/passive-activation-service.js";
import { grantEffect } from "../../domain/battle/effects/effect-grant-service.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import type { DomainEventId, ResolutionScopeId } from "../../domain/shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import {
  definitionsWith,
  loadProductionSnapshot,
  seedRecorder,
  skillFrom,
  testBattleUnit,
  testUnitDefinition,
} from "../../testing/fixtures/index.js";

/**
 * M7-001C (Issue #244): `remove-effects-production-catalog.
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
const COMBAT_STATS = {
  maximumHp: 1000,
  attack: 100,
  defense: 50,
  actionSpeed: 100,
  affinityBonus: 0.25,
};
const POSITION = { column: "CENTER", row: "FRONT" } as const;

function enemyDefinition(id: string): UnitDefinition {
  return testUnitDefinition(id, {
    baseStats: { ...COMBAT_STATS, maximumAp: LIMITS.maximumAp, maximumPp: LIMITS.maximumPp },
    extraGaugeMaximum: LIMITS.maximumExtraGauge,
  });
}

const BUFF_DEF_ID = createEffectActionDefinitionId("ACT_TEST_WIRING_BUFF");
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

/** Grants one BUFF-category (magnitude>=0 per R-EFF-05) instance of `BUFF_DEF_ID` onto `holder`. */
function grantBuff(
  recorder: EventRecorder,
  resolutionScopeId: ResolutionScopeId,
  lastEventId: DomainEventId,
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
      const snapshot = loadProductionSnapshot(CATALOG_DIR, ["UNIT_SHOUKA_SCHEMER"]);
      const skill = skillFrom(snapshot, skillId);
      expect(skill).toBeDefined();

      const shouka = testBattleUnit({
        battleUnitId: "ally:shouka",
        unitDefinitionId: "UNIT_SHOUKA_SCHEMER",
        position: POSITION,
        combatStats: COMBAT_STATS,
        limits: LIMITS,
        overrides: {
          currentAp: LIMITS.maximumAp,
          currentExtraGauge: LIMITS.maximumExtraGauge,
        },
      });
      const enemy = testBattleUnit({
        battleUnitId: "enemy:1",
        unitDefinitionId: ENEMY_UNIT_ID,
        side: "ENEMY",
        position: POSITION,
        combatStats: COMBAT_STATS,
        limits: LIMITS,
      });

      const effectActions = new Map(snapshot.effectActions);
      effectActions.set(BUFF_DEF_ID, buffDefinition);
      const definitions = definitionsWith(snapshot, {
        units: [enemyDefinition(ENEMY_UNIT_ID)],
        overrides: { effectActions },
      });

      const { recorder, resolutionScopeId, rootEventId } = seedRecorder("B_1");
      const actionId = recorder.nextActionId();

      // Both the caster and the enemy hold their own BUFF before the skill
      // resolves; the caster's should survive regardless of which unit the
      // REMOVE_EFFECTS action actually targets.
      let units: readonly BattleUnit[] = [shouka, enemy];
      units = grantBuff(recorder, resolutionScopeId, rootEventId, units, shouka);
      const shoukaWithBuff = units.find((u) => u.battleUnitId === shouka.battleUnitId)!;
      units = grantBuff(recorder, resolutionScopeId, rootEventId, units, enemy);

      const result = resolveSkillUse(
        shoukaWithBuff,
        skill,
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
  const ATTACK_EFFECT_ID = createEffectActionDefinitionId("ACT_TEST_SENKA_ATTACK");

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
    const snapshot = loadProductionSnapshot(CATALOG_DIR, [SENKA_UNIT_ID]);

    const senka = testBattleUnit({
      battleUnitId: "ally:senka",
      unitDefinitionId: SENKA_UNIT_ID,
      position: POSITION,
      combatStats: COMBAT_STATS,
      limits: LIMITS,
      overrides: { currentPp: LIMITS.maximumPp },
    });
    const attackedEnemy = testBattleUnit({
      battleUnitId: "enemy:attacked",
      unitDefinitionId: ATTACKED_ENEMY_ID,
      side: "ENEMY",
      position: POSITION,
      combatStats: COMBAT_STATS,
      limits: LIMITS,
    });
    const otherEnemy = testBattleUnit({
      battleUnitId: "enemy:other",
      unitDefinitionId: OTHER_ENEMY_ID,
      side: "ENEMY",
      position: { column: "LEFT", row: "FRONT" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
    });

    const effectActions = new Map(snapshot.effectActions);
    effectActions.set(BUFF_DEF_ID, buffDefinition);
    const definitions = definitionsWith(snapshot, {
      units: [enemyDefinition(ATTACKED_ENEMY_ID), enemyDefinition(OTHER_ENEMY_ID)],
      overrides: { effectActions },
    });

    const { recorder, resolutionScopeId, rootEventId } = seedRecorder("B_1");
    const actionId = recorder.nextActionId();

    let units: readonly BattleUnit[] = [senka, attackedEnemy, otherEnemy];
    units = grantBuff(recorder, resolutionScopeId, rootEventId, units, senka);
    units = grantBuff(recorder, resolutionScopeId, rootEventId, units, attackedEnemy);
    units = grantBuff(recorder, resolutionScopeId, rootEventId, units, otherEnemy);
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
        skillDefinitionId: createSkillDefinitionId("SKL_TEST_SENKA_ATTACKER"),
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
