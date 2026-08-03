import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyDamageAction,
  type DamageEventContext,
} from "../../domain/battle/combat/damage-application-service.js";
import {
  evaluateFormula,
  type DamageResultRegistry,
} from "../../domain/battle/skill/formula-evaluator.js";
import { grantEffect } from "../../domain/battle/effects/effect-grant-service.js";
import { recalculateCombatStats } from "../../domain/battle/effects/combat-stat-recalculation-service.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { ResolvedEffectApplication } from "../../domain/battle/skill/skill-resolution-service.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import {
  effectActionFrom,
  loadProductionSnapshot,
  seedRecorder,
  testBattleUnit,
} from "../../testing/fixtures/index.js";

/**
 * RES-001 (Issue #175, R-NUM-04): exercises the REAL production `catalog/`
 * `DAMAGE`/`APPLY_STAT_MOD` `EffectActionDefinition` payloads that require
 * `CAP_FORMULA` through the REAL domain executors (`applyDamageAction`,
 * `grantEffect`/`recalculateCombatStats`), proving the general
 * `FormulaEvaluator` is correctly wired into the real lifecycle (not just
 * unit-tested in isolation). Mirrors `stat-mod-production-catalog.test.ts`/
 * `cooldown-manipulation-production-catalog.test.ts` (calls the mid-level
 * application service directly, not the full generator-based
 * `applyEffectActionGroups`).
 *
 * Reviewer findings addressed here (PR #214 review):
 * - [P1] a DAMAGE formula kind other than SKILL_POWER must bypass
 *   attack/defense entirely, not be multiplied by the attacker's attack
 *   stat (`ACT_FLUTE_VAMPIRE_AS1_HP_COST`).
 * - [P1] DAMAGE_RECEIVED_RATIO(LAST_DAMAGE_RECEIVED) must read the actor's
 *   own most recently received DAMAGE result from the real lifecycle
 *   (`ACT_AOI_GUARDIAN_PS2_COUNTER`, `ACT_STELLA_STATUE_PS2_COUNTER`).
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

/** このファイルの計算検証はHP1000・攻撃100・防御50を基準値に組み立てている。 */
const BASE_COMBAT_STATS = {
  maximumHp: 1000,
  attack: 100,
  defense: 50,
  actionSpeed: 100,
};

function unitFor(
  id: string,
  unitDefinitionId: string,
  overrides: {
    readonly attack?: number;
    readonly defense?: number;
    readonly maximumHp?: number;
    readonly criticalRate?: number;
  } = {},
): BattleUnit {
  return testBattleUnit({
    battleUnitId: id,
    unitDefinitionId,
    combatStats: { ...BASE_COMBAT_STATS, ...overrides },
  });
}

function enemyFor(
  id: string,
  overrides: {
    readonly attack?: number;
    readonly defense?: number;
    readonly maximumHp?: number;
  } = {},
): BattleUnit {
  return testBattleUnit({
    battleUnitId: id,
    unitDefinitionId: "UNIT_ENEMY",
    side: "ENEMY",
    combatStats: { ...BASE_COMBAT_STATS, ...overrides },
  });
}

function eventContext(): DamageEventContext {
  const recorder = new EventRecorder(createBattleId("B_1"));
  const actionId = recorder.nextActionId();
  const resolutionScopeId = recorder.nextResolutionScopeId();
  const actionStarted = recorder.record({
    eventType: "ActionStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    resolutionScopeId,
    payload: {
      actorUnitId: createBattleUnitId("ACTOR"),
      reservedActionType: "AS",
      effectiveActionType: "AS",
      apBefore: 1,
      apAfter: 0,
      exBefore: 0,
      exAfter: 0,
    },
  });
  return {
    recorder,
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    skillUseId: recorder.nextSkillUseId(),
    resolutionScopeId,
    rootEventId: actionStarted.eventId,
    parentEventId: actionStarted.eventId,
    // `applyDamageAction`はskillDefinitionIdをイベントpayloadへ載せるだけで
    // 定義解決には使わないため、この層のテストでは任意のIDでよい。
    skillDefinitionId: createSkillDefinitionId("SKL_TEST"),
  };
}

function singleHit(targetId: string, effectActionDefinitionId: string): ResolvedEffectApplication {
  return {
    targetBattleUnitId: createBattleUnitId(targetId),
    effectActionDefinitionId: createEffectActionDefinitionId(effectActionDefinitionId),
    hitIndex: 1,
  };
}

describe("production Catalog DAMAGE with a non-SKILL_POWER formula (RES-001, R-NUM-04)", () => {
  it("IT-CAP-FORMULA-PROD-001: ACT_FLUTE_VAMPIRE_AS1_HP_COST (CURRENT_HP_RATIO) computes the target's current HP × 0.25 unaffected by the attacker's attack stat", () => {
    const snapshot = loadProductionSnapshot(CATALOG_DIR, ["UNIT_FLUTE_VAMPIRE"]);
    const effectAction = effectActionFrom(snapshot, "ACT_FLUTE_VAMPIRE_AS1_HP_COST");
    expect(effectAction.kind).toBe("DAMAGE");
    if (effectAction.kind !== "DAMAGE") {
      return;
    }
    expect(effectAction.requiredCapabilities).toContain("CAP_FORMULA");
    expect(effectAction.payload.formula.kind).toBe("CURRENT_HP_RATIO");

    const target = unitFor("TARGET", "UNIT_A", { maximumHp: 1000 });
    for (const attackerAttack of [1, 999]) {
      const attacker = unitFor("ATTACKER", "UNIT_FLUTE_VAMPIRE", { attack: attackerAttack });
      const result = applyDamageAction(
        attacker,
        [singleHit("TARGET", effectAction.effectActionDefinitionId)],
        effectAction,
        [attacker, target],
        new SequenceRandomSource([]),
        eventContext(),
      );
      // target.currentHp(1000) * 0.25 = 250, regardless of attacker.attack.
      expect(result.hits[0]!.damage).toBe(250);
    }
  });
});

describe("production Catalog DAMAGE_RECEIVED_RATIO counters (RES-001, R-NUM-04)", () => {
  it.each([
    { unitId: "UNIT_AOI_GUARDIAN", effectActionId: "ACT_AOI_GUARDIAN_PS2_COUNTER", ratio: 1 },
    { unitId: "UNIT_STELLA_STATUE", effectActionId: "ACT_STELLA_STATUE_PS2_COUNTER", ratio: 0.5 },
  ])(
    "IT-CAP-FORMULA-PROD-002: $effectActionId reflects the counter-user's own lastDamageReceived × $ratio",
    ({ unitId, effectActionId, ratio }) => {
      const snapshot = loadProductionSnapshot(CATALOG_DIR, [unitId]);
      const effectAction = effectActionFrom(snapshot, effectActionId);
      expect(effectAction.kind).toBe("DAMAGE");
      if (effectAction.kind !== "DAMAGE") {
        return;
      }
      expect(effectAction.requiredCapabilities).toContain("CAP_FORMULA");
      expect(effectAction.payload.formula).toEqual({
        kind: "DAMAGE_RECEIVED_RATIO",
        sourceResult: "LAST_DAMAGE_RECEIVED",
        ratio,
      });

      const counterUser = unitFor("COUNTER_USER", unitId, { defense: 50 });
      const originalAttacker = enemyFor("ORIGINAL_ATTACKER", { attack: 130 });
      // One registry instance shared across both calls, standing in for the
      // single resolution scope (one action) that both the triggering hit
      // and the counter it provokes belong to (R-SKL-08; `PassiveActivationRuntime`
      // threads the same instance through nested PS chains in production).
      const damageResults: DamageResultRegistry = new Map();

      // Step 1: a plain hit lands on the counter-user (130 - 50 = 80 damage),
      // establishing its lastDamageReceived in the shared registry.
      const triggeringDamageAction = {
        kind: "DAMAGE" as const,
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_TEST_TRIGGER"),
        requiredCapabilities: [],
        metadata: { tags: [] },
        payload: {
          damageType: "PHYSICAL" as const,
          formula: { kind: "SKILL_POWER" as const, power: 1 },
          hitCount: 1,
          critical: { mode: "PREVENTED" as const },
          accuracy: { mode: "NORMAL" as const },
          piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
          damageModifiers: [],
          link: { enabled: false },
        },
      };
      const triggerResult = applyDamageAction(
        originalAttacker,
        [singleHit("COUNTER_USER", "ACT_TEST_TRIGGER")],
        triggeringDamageAction,
        [originalAttacker, counterUser],
        new SequenceRandomSource([]),
        { ...eventContext(), damageResults },
      );
      expect(triggerResult.hits[0]!.damage).toBe(80);
      const counterUserAfterHit = triggerResult.units.find(
        (u) => u.battleUnitId === counterUser.battleUnitId,
      )!;
      expect(damageResults.get(counterUser.battleUnitId)?.lastDamageReceived).toBe(80);

      // Step 2: the counter-user counters with the REAL production
      // DAMAGE_RECEIVED_RATIO EffectAction, targeting the original attacker.
      // The definition doesn't override critical.mode (defaults to NORMAL),
      // so a random draw is consumed; counterUser.criticalRate is 0, so any
      // draw >= 0 resolves as a non-critical hit deterministically.
      const counterResult = applyDamageAction(
        counterUserAfterHit,
        [singleHit("ORIGINAL_ATTACKER", effectAction.effectActionDefinitionId)],
        effectAction,
        triggerResult.units,
        new SequenceRandomSource([0]),
        { ...eventContext(), damageResults },
      );
      expect(counterResult.hits[0]!.damage).toBe(Math.floor(80 * ratio));
    },
  );
});

describe("production Catalog DAMAGE with MIN composition (RES-001, R-NUM-04)", () => {
  it("IT-CAP-FORMULA-PROD-003: ACT_AOI_ELEGANT_AS2_BONUS_DAMAGE (MIN of CURRENT_HP_RATIO and STAT_RATIO) picks whichever branch is smaller, matching the 14_Catalog定義スキーマ.md canonical example", () => {
    const snapshot = loadProductionSnapshot(CATALOG_DIR, ["UNIT_AOI_ELEGANT"]);
    const effectAction = effectActionFrom(snapshot, "ACT_AOI_ELEGANT_AS2_BONUS_DAMAGE");
    expect(effectAction.kind).toBe("DAMAGE");
    if (effectAction.kind !== "DAMAGE") {
      return;
    }
    expect(effectAction.payload.formula).toEqual({
      kind: "MIN",
      formulas: [
        { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.2 },
        { kind: "STAT_RATIO", source: { kind: "SKILL_SOURCE" }, stat: "ATTACK", ratio: 0.5 },
      ],
    });

    // HP branch is smaller: target currentHp(1000)*0.2=200 < attacker.attack(1000)*0.5=500.
    const target = unitFor("TARGET", "UNIT_A", { maximumHp: 1000 });
    const strongAttacker = unitFor("ATTACKER", "UNIT_AOI_ELEGANT", { attack: 1000 });
    const hpBranchResult = applyDamageAction(
      strongAttacker,
      [singleHit("TARGET", effectAction.effectActionDefinitionId)],
      effectAction,
      [strongAttacker, target],
      new SequenceRandomSource([0]),
      eventContext(),
    );
    expect(hpBranchResult.hits[0]!.damage).toBe(200);

    // ATTACK branch is smaller: attacker.attack(100)*0.5=50 < target currentHp(1000)*0.2=200.
    const weakAttacker = unitFor("ATTACKER", "UNIT_AOI_ELEGANT", { attack: 100 });
    const statBranchResult = applyDamageAction(
      weakAttacker,
      [singleHit("TARGET", effectAction.effectActionDefinitionId)],
      effectAction,
      [weakAttacker, target],
      new SequenceRandomSource([0]),
      eventContext(),
    );
    expect(statBranchResult.hits[0]!.damage).toBe(50);
  });
});

describe("production Catalog APPLY_STAT_MOD with ALIVE_UNIT_COUNT_SCALE (RES-001, R-NUM-04)", () => {
  it("IT-CAP-FORMULA-PROD-004: ACT_LAURA_MOUNTAIN_PS1_ATK_BUFF scales with alive ally count, capped at 0.07 (perUnit 0.0175)", () => {
    const snapshot = loadProductionSnapshot(CATALOG_DIR, ["UNIT_LAURA_MOUNTAIN"]);
    const effectAction = effectActionFrom(snapshot, "ACT_LAURA_MOUNTAIN_PS1_ATK_BUFF");
    expect(effectAction.kind).toBe("APPLY_STAT_MOD");
    if (effectAction.kind !== "APPLY_STAT_MOD") {
      return;
    }
    expect(effectAction.requiredCapabilities).toContain("CAP_FORMULA");
    expect(effectAction.payload.formula).toEqual({
      kind: "ALIVE_UNIT_COUNT_SCALE",
      side: "ALLY",
      perUnit: 0.0175,
      max: 0.07,
    });

    const laura = unitFor("LAURA", "UNIT_LAURA_MOUNTAIN", { attack: 100 });
    const threeAllies = [laura, unitFor("ALLY_1", "UNIT_A"), unitFor("ALLY_2", "UNIT_A")];
    const magnitudeBelowCap = evaluateFormula(effectAction.payload.formula, {
      skillSource: laura,
      target: laura,
      allUnits: threeAllies,
    });
    expect(magnitudeBelowCap).toBeCloseTo(0.0525);

    const fiveAllies = [
      laura,
      unitFor("ALLY_1", "UNIT_A"),
      unitFor("ALLY_2", "UNIT_A"),
      unitFor("ALLY_3", "UNIT_A"),
      unitFor("ALLY_4", "UNIT_A"),
    ];
    const magnitudeAtCap = evaluateFormula(effectAction.payload.formula, {
      skillSource: laura,
      target: laura,
      allUnits: fiveAllies,
    });
    expect(magnitudeAtCap).toBeCloseTo(0.07);

    // Full lifecycle: grantEffect + recalculateCombatStats applies the capped
    // magnitude as a RATIO ATTACK buff, mirroring stat-mod-production-catalog.test.ts.
    const { recorder, seed } = seedRecorder("B_1");
    const grantContext = {
      recorder,
      turnNumber: 1,
      cycleNumber: 1,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      rootEventId: seed.eventId,
    };
    const grantResult = grantEffect(
      grantContext,
      fiveAllies,
      {
        definition: effectAction,
        sourceId: laura.battleUnitId,
        targetId: laura.battleUnitId,
        duplicate: true,
        magnitude: magnitudeAtCap,
        durationDefinition: effectAction.payload.duration,
      },
      seed.eventId,
    );
    const recalculation = recalculateCombatStats(
      grantContext,
      fiveAllies,
      grantResult.units,
      laura.battleUnitId,
      snapshot.effectActions,
      grantResult.lastEventId,
      "EFFECT_APPLIED",
    );
    const updatedLaura = recalculation.units.find((u) => u.battleUnitId === laura.battleUnitId)!;
    expect(updatedLaura.combatStats.attack).toBeCloseTo(100 * (1 + 0.07));
  });
});
