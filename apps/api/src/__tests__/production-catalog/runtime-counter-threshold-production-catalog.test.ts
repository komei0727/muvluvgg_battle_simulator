import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { PassiveActivationRuntime } from "../../domain/battle/lifecycle/passive-activation-service.js";
import { createBattleId, type BattleUnitId } from "../../domain/shared/ids.js";
import {
  createEffectActionDefinitionId,
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import { detectRuntimeCounterUpdates } from "../../domain/battle/triggering/runtime-counter-matcher.js";
import { evaluateTriggerCondition } from "../../domain/battle/triggering/trigger-condition-evaluator.js";
import type { TriggerCandidateEvent } from "../../domain/battle/triggering/trigger-event.js";
import type { Side } from "../../domain/shared/side.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import {
  definitionsWith,
  initialSnapshotFor,
  loadProductionSnapshot,
  reconstruct,
  skillFrom,
  testBattleUnit,
  unitFrom,
} from "../../testing/fixtures/index.js";

/**
 * Issue #143: the 3 `CUMULATIVE_DAMAGE_THRESHOLD_TRIGGER`
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

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

const COMBAT_STATS = {
  attack: 100,
  defense: 50,
  criticalRate: 0.1,
  actionSpeed: 100,
  criticalDamageBonus: 0.5,
  affinityBonus: 0.25,
};

function actorFor(
  unitDefinitionId: string,
  side: Side,
  battleUnitId: string,
  maximumHp: number,
): BattleUnit {
  return testBattleUnit({
    battleUnitId,
    unitDefinitionId,
    side,
    combatStats: { ...COMBAT_STATS, maximumHp },
  });
}

function damageEvent(
  sourceUnitId: BattleUnitId,
  targetUnitId: BattleUnitId,
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

function passiveActivatedEvent(
  ownerUnitId: BattleUnitId,
  skillDefinitionId: string,
): TriggerCandidateEvent {
  return {
    eventType: "PassiveActivated",
    category: "FACT",
    sourceUnitId: ownerUnitId,
    targetUnitIds: [ownerUnitId],
    payload: { skillDefinitionId },
  };
}

function lifecycleDefinitions(
  snapshot: BattleCatalogSnapshot,
  unitId: string,
  skillId: string,
): BattleDefinitions {
  const unit = unitFrom(snapshot, unitId);
  const skill = skillFrom(snapshot, skillId);
  return definitionsWith(snapshot, {
    overrides: {
      unitDefinitions: new Map([
        [
          unit.unitDefinitionId,
          {
            ...unit,
            activeSkillDefinitionIds: [],
            passiveSkillDefinitionIds: [skill.skillDefinitionId],
          },
        ],
      ]),
      skillDefinitions: new Map([[skill.skillDefinitionId, skill]]),
    },
  });
}

describe("production Catalog CUMULATIVE_DAMAGE_THRESHOLD_TRIGGER gating on valueChanged (Issue #143)", () => {
  it.each([
    { unitId: "UNIT_CHIYURU_NEWYEAR", skillId: "SKL_CHIYURU_NEWYEAR_PS2", maxHpRatio: 0.4 },
    { unitId: "UNIT_CHIZURU_DOMESTIC", skillId: "SKL_CHIZURU_DOMESTIC_PS3", maxHpRatio: 0.85 },
    { unitId: "UNIT_MIKOTO_SURVIVOR", skillId: "SKL_MIKOTO_SURVIVOR_PS1", maxHpRatio: 0.1 },
    { unitId: "UNIT_TATIANA_SAGE", skillId: "SKL_TATIANA_SAGE_PS1", maxHpRatio: 0.2 },
    { unitId: "UNIT_YUI_HEIR", skillId: "SKL_YUI_HEIR_PS2", maxHpRatio: 0.3 },
  ])(
    "IT-CAP-SKILL-RUNTIME-001: $skillId's ($unitId) real RuntimeCounterChanged trigger condition rejects a sub-threshold (carry-only) hit and accepts a threshold-crossing hit",
    ({ unitId, skillId, maxHpRatio }) => {
      const snapshot = loadProductionSnapshot(CATALOG_DIR, [unitId]);
      const unitDefinition = unitFrom(snapshot, unitId);
      expect(unitDefinition).toBeDefined();
      const skill = skillFrom(snapshot, skillId);
      expect(skill).toBeDefined();
      expect(skill.requiredCapabilities).toContain("CAP_SKILL_RUNTIME_COUNTER");
      const trigger = skill.triggers[0];
      expect(trigger?.eventType).toBe("RuntimeCounterChanged");

      const maximumHp = unitDefinition.baseStats.maximumHp;
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
          { owner, skillDefinitionId: skill.skillDefinitionId },
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
          { owner, skillDefinitionId: skill.skillDefinitionId },
        ),
      ).toBe(true);
    },
  );

  it.each([
    ["UNIT_CHIZURU_DOMESTIC", "SKL_CHIZURU_DOMESTIC_PS1"],
    ["UNIT_CHIZURU_DOMESTIC", "SKL_CHIZURU_DOMESTIC_PS2"],
    ["UNIT_DOROTHEA_PIONEER", "SKL_DOROTHEA_PIONEER_PS1"],
    ["UNIT_DOROTHEA_PIONEER", "SKL_DOROTHEA_PIONEER_PS2"],
    ["UNIT_EVIE_ECO", "SKL_EVIE_ECO_PS2"],
    ["UNIT_FEE_ACTOR", "SKL_FEE_ACTOR_PS2"],
    ["UNIT_FLUTE_VAMPIRE", "SKL_FLUTE_VAMPIRE_PS1"],
    ["UNIT_FLUTE_VAMPIRE", "SKL_FLUTE_VAMPIRE_PS3"],
    ["UNIT_HIIRO_LONEWOLF", "SKL_HIIRO_LONEWOLF_PS1"],
    ["UNIT_KEI_JACKKNIFE", "SKL_KEI_JACKKNIFE_PS1"],
    ["UNIT_KOTOHA_REBEL", "SKL_KOTOHA_REBEL_PS2"],
    ["UNIT_LAYLA_ENTREPRENEUR", "SKL_LAYLA_ENTREPRENEUR_PS1"],
    ["UNIT_LYDIA_GENIUS", "SKL_LYDIA_GENIUS_PS2"],
    ["UNIT_OLGA_VETERAN", "SKL_OLGA_VETERAN_PS2"],
    ["UNIT_RAMI_UNYIELDING", "SKL_RAMI_UNYIELDING_PS1"],
    ["UNIT_YURIA_YUKATA", "SKL_YURIA_YUKATA_PS2"],
  ])(
    "IT-CAP-SKILL-RUNTIME-002: %s %s increments only its own activation counter from the production PassiveActivated payload",
    (unitId, skillId) => {
      const snapshot = loadProductionSnapshot(CATALOG_DIR, [unitId]);
      const unitDefinition = unitFrom(snapshot, unitId);
      const skill = skillFrom(snapshot, skillId);
      expect(unitDefinition).toBeDefined();
      expect(skill).toBeDefined();
      expect(skill.requiredCapabilities).toContain("CAP_SKILL_RUNTIME_COUNTER");
      expect(skill.counterUpdates).toHaveLength(1);
      expect(skill.counterUpdates[0]).toMatchObject({
        kind: "INCREMENT",
        scope: "SKILL_RUNTIME",
        amount: 1,
      });

      const owner = actorFor(unitId, "ALLY", "B_1:unit:1", unitDefinition.baseStats.maximumHp);
      const unrelated = detectRuntimeCounterUpdates({
        event: passiveActivatedEvent(owner.battleUnitId, "SKL_OTHER"),
        units: [owner],
        unitDefinitions: snapshot.units,
        skillDefinitions: snapshot.skills,
      });
      expect(unrelated.changes).toEqual([]);

      const activated = detectRuntimeCounterUpdates({
        event: passiveActivatedEvent(owner.battleUnitId, skillId),
        units: [owner],
        unitDefinitions: snapshot.units,
        skillDefinitions: snapshot.skills,
      });
      expect(activated.changes).toHaveLength(1);
      expect(activated.changes[0]).toMatchObject({
        skillDefinitionId: skill.skillDefinitionId,
        counter: `${skillId}_ACTIVATIONS`,
        before: 0,
        after: 1,
        valueChanged: true,
      });
    },
  );

  it("IT-CAP-SKILL-RUNTIME-003: an executable production PS traverses TurnStarted through PassiveActivated, RuntimeCounterChanged, StateDelta replay, and next-activation blocking", () => {
    const unitId = "UNIT_CI_SMOKE_TEST";
    const skillId = createSkillDefinitionId("SKL_CI_SMOKE_TEST_PS1");
    const counterId = createRuntimeCounterId(`${skillId}_ACTIVATIONS`);
    const snapshot = loadProductionSnapshot(CATALOG_DIR, [unitId]);
    const unitDefinition = unitFrom(snapshot, unitId);
    const owner = {
      ...actorFor(unitId, "ALLY", "B_CAP_RUNTIME:unit:1", unitDefinition.baseStats.maximumHp),
      currentPp: 4,
    };
    const enemy = actorFor(
      unitId,
      "ENEMY",
      "B_CAP_RUNTIME:unit:2",
      unitDefinition.baseStats.maximumHp,
    );
    const initial = initialSnapshotFor([owner, enemy]);
    const definitions = lifecycleDefinitions(snapshot, unitId, skillId);
    const recorder = new EventRecorder(createBattleId("B_CAP_RUNTIME"));
    const turnStarted = recorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { turnNumber: 1 },
    });
    const runtime = new PassiveActivationRuntime(
      {
        definitions,
        random: new SequenceRandomSource([0.5]),
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: turnStarted.resolutionScopeId,
        rootEventId: turnStarted.eventId,
      },
      [owner, enemy],
    );

    const afterFirstActivation = runtime.onFactEvent(turnStarted, [owner, enemy]).units;
    const updatedOwner = afterFirstActivation.find(
      (unit) => unit.battleUnitId === owner.battleUnitId,
    )!;
    const updatedEnemy = afterFirstActivation.find(
      (unit) => unit.battleUnitId === enemy.battleUnitId,
    )!;
    const passiveActivated = recorder
      .getEvents()
      .find((event) => event.eventType === "PassiveActivated");
    const counterChanged = recorder
      .getEvents()
      .find((event) => event.eventType === "RuntimeCounterChanged");

    expect(passiveActivated?.payload).toMatchObject({
      actorUnitId: owner.battleUnitId,
      skillDefinitionId: skillId,
      ppBefore: 4,
      ppAfter: 3,
      exBefore: 0,
      exAfter: 1,
    });
    expect(counterChanged?.parentEventId).toBe(passiveActivated?.eventId);
    expect(counterChanged?.payload).toMatchObject({
      skillDefinitionId: skillId,
      counter: counterId,
      before: 0,
      after: 1,
      valueChanged: true,
    });
    expect(updatedOwner.skillCounters?.[skillId]?.[counterId]).toEqual({
      value: 1,
      carry: 0,
    });
    expect(updatedOwner.currentPp).toBe(3);
    expect(updatedOwner.currentExtraGauge).toBe(1);
    expect(updatedEnemy.currentHp).toBeLessThan(enemy.currentHp);

    const reconstructed = reconstruct(initial, recorder);
    expect(reconstructed.units[owner.battleUnitId]).toMatchObject({
      pp: updatedOwner.currentPp,
      extraGauge: updatedOwner.currentExtraGauge,
      maximumAp: updatedOwner.maximumAp,
      maximumPp: updatedOwner.maximumPp,
      maximumExtraGauge: updatedOwner.maximumExtraGauge,
      skillCounters: { [skillId]: { [counterId]: 1 } },
    });
    expect(reconstructed.units[enemy.battleUnitId]?.hp).toBe(updatedEnemy.currentHp);

    const secondRecorder = new EventRecorder(createBattleId("B_CAP_RUNTIME_SECOND"));
    const secondTurnStarted = secondRecorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 2,
      cycleNumber: 0,
      resolutionScopeId: secondRecorder.nextResolutionScopeId(),
      payload: { turnNumber: 2 },
    });
    const secondRuntime = new PassiveActivationRuntime(
      {
        definitions,
        random: new SequenceRandomSource([]),
        recorder: secondRecorder,
        turnNumber: 2,
        cycleNumber: 0,
        resolutionScopeId: secondTurnStarted.resolutionScopeId,
        rootEventId: secondTurnStarted.eventId,
      },
      afterFirstActivation,
    );
    secondRuntime.onFactEvent(secondTurnStarted, afterFirstActivation);
    expect(
      secondRecorder.getEvents().filter((event) => event.eventType === "PassiveActivated"),
    ).toHaveLength(0);
  });

  it("IT-CAP-SKILL-RUNTIME-004: a production cumulative counter emits replayable carry and threshold-crossing StateDelta through PassiveActivationRuntime", () => {
    const unitId = "UNIT_MIKOTO_SURVIVOR";
    const skillId = createSkillDefinitionId("SKL_MIKOTO_SURVIVOR_PS1");
    const counterId = createRuntimeCounterId("SKL_MIKOTO_SURVIVOR_PS1_CUMULATIVE_DAMAGE_RATIO");
    const snapshot = loadProductionSnapshot(CATALOG_DIR, [unitId]);
    const unitDefinition = unitFrom(snapshot, unitId);
    const owner = {
      ...actorFor(unitId, "ALLY", "B_CAP_CUMULATIVE:unit:1", unitDefinition.baseStats.maximumHp),
      currentPp: 0,
    };
    const initial = initialSnapshotFor([owner]);
    const definitions = lifecycleDefinitions(snapshot, unitId, skillId);
    const recorder = new EventRecorder(createBattleId("B_CAP_CUMULATIVE"));
    const scopeId = recorder.nextResolutionScopeId();

    function recordDamageApplied(hitPointDamage: number, hpBefore: number) {
      return recorder.record({
        eventType: "DamageApplied",
        category: "FACT",
        turnNumber: 1,
        cycleNumber: 1,
        resolutionScopeId: scopeId,
        sourceUnitId: owner.battleUnitId,
        targetUnitIds: [owner.battleUnitId],
        payload: {
          effectActionDefinitionId: createEffectActionDefinitionId("ACT_CAP_RUNTIME_TEST"),
          hitIndex: 1,
          targetUnitId: owner.battleUnitId,
          calculatedDamage: hitPointDamage,
          // DMG-004（Issue #194、R-SHD-02/03）: シールド未所持の対象なので全量がHPへ向かう。
          hpDirectDamage: 0,
          typedShieldAbsorbed: 0,
          untypedShieldAbsorbed: 0,
          subUnitAbsorbed: 0,
          discardedDamage: 0,
          hitPointDamage,
          hpBefore,
          hpAfter: hpBefore - hitPointDamage,
          defeated: false,
        },
        stateDelta: {
          units: {
            [owner.battleUnitId]: {
              hp: { before: hpBefore, after: hpBefore - hitPointDamage },
            },
          },
        },
      });
    }

    const hitPointDamage = unitDefinition.baseStats.maximumHp * 0.05;
    const firstDamage = recordDamageApplied(hitPointDamage, owner.currentHp);
    const afterFirstDamage = [{ ...owner, currentHp: owner.currentHp - hitPointDamage }];
    const runtime = new PassiveActivationRuntime(
      {
        definitions,
        random: new SequenceRandomSource([]),
        recorder,
        turnNumber: 1,
        cycleNumber: 1,
        resolutionScopeId: scopeId,
        rootEventId: firstDamage.eventId,
      },
      afterFirstDamage,
    );
    runtime.onFactEvent(firstDamage, afterFirstDamage);
    const hpBeforeSecondDamage = runtime.currentUnits[0]!.currentHp;
    const secondDamage = recordDamageApplied(hitPointDamage, hpBeforeSecondDamage);
    const afterSecondDamage = runtime.currentUnits.map((unit) => ({
      ...unit,
      currentHp: unit.currentHp - hitPointDamage,
    }));
    const finalUnits = runtime.onFactEvent(secondDamage, afterSecondDamage).units;

    const changes = recorder
      .getEvents()
      .filter((event) => event.eventType === "RuntimeCounterChanged");
    expect(changes.map((event) => event.payload)).toMatchObject([
      { counter: counterId, before: 0, after: 0, valueChanged: false },
      { counter: counterId, before: 0, after: 1, valueChanged: true },
    ]);
    expect(finalUnits[0]?.skillCounters?.[skillId]?.[counterId]).toEqual({
      value: 1,
      carry: 0,
    });

    const reconstructed = reconstruct(initial, recorder);
    expect(reconstructed.units[owner.battleUnitId]).toMatchObject({
      hp: finalUnits[0]!.currentHp,
      skillCounters: { [skillId]: { [counterId]: 1 } },
    });
    expect(reconstructed.units[owner.battleUnitId]?.skillCounterCarry).toBeUndefined();
  });
});
