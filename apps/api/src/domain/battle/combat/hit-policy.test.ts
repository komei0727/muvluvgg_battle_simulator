import { describe, expect, it } from "vitest";
import { resolveDarkness, resolveEffectiveAccuracyMode, resolveEvasion } from "./hit-policy.js";
import {
  createBattleUnit,
  type BattleUnit,
  type BattleUnitResourceLimits,
} from "../model/battle-unit.js";
import {
  effectKindKeyFromDefinitionId,
  type AppliedEffect,
  type StatusEffectDetails,
} from "../model/applied-effect.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import { UNUSED_ENHANCED_BASE_STATS } from "../../../testing/fixtures/battle-actors.js";

const LIMITS: BattleUnitResourceLimits = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };
const EVASION_DEFINITION_ID = createEffectActionDefinitionId("ACT_EVASION");
const BLIND_DEFINITION_ID = createEffectActionDefinitionId("ACT_BLIND");
const HIT_EVASION_DEFINITION_ID = createEffectActionDefinitionId("ACT_HIT_EVASION");
const GUARANTEED_HIT_DEFINITION_ID = createEffectActionDefinitionId("ACT_GUARANTEED_HIT");

function unit(id: string): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    enhancedBaseStats: UNUSED_ENHANCED_BASE_STATS,
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_001"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate("ENEMY", position),
    combatStats: {
      maximumHp: 100,
      attack: 30,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  return createBattleUnit(member, "ENEMY", LIMITS);
}

function evasionEffect(
  id: string,
  targetUnitId: string,
  details: StatusEffectDetails = {},
): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: EVASION_DEFINITION_ID,
    kindKey: effectKindKeyFromDefinitionId(EVASION_DEFINITION_ID),
    duplicate: true,
    sourceUnitId: createBattleUnitId(targetUnitId),
    targetUnitId: createBattleUnitId(targetUnitId),
    magnitude: 0,
    categories: ["BUFF"],
    statusKind: "EVASION",
    statusDetails: details,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

function hitEvasionEffect(
  id: string,
  targetUnitId: string,
  details: StatusEffectDetails = {},
): AppliedEffect {
  return {
    ...evasionEffect(id, targetUnitId, details),
    effectActionDefinitionId: HIT_EVASION_DEFINITION_ID,
    kindKey: effectKindKeyFromDefinitionId(HIT_EVASION_DEFINITION_ID),
    statusKind: "HIT_EVASION",
  };
}

function guaranteedHitEffect(id: string, attackerId: string): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: GUARANTEED_HIT_DEFINITION_ID,
    kindKey: effectKindKeyFromDefinitionId(GUARANTEED_HIT_DEFINITION_ID),
    duplicate: true,
    sourceUnitId: createBattleUnitId(attackerId),
    targetUnitId: createBattleUnitId(attackerId),
    magnitude: 0,
    categories: ["BUFF"],
    statusKind: "GUARANTEED_HIT",
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

function darknessEffect(
  id: string,
  attackerId: string,
  details: StatusEffectDetails = {},
): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: BLIND_DEFINITION_ID,
    kindKey: effectKindKeyFromDefinitionId(BLIND_DEFINITION_ID),
    duplicate: true,
    sourceUnitId: createBattleUnitId(attackerId),
    targetUnitId: createBattleUnitId(attackerId),
    magnitude: 0,
    categories: ["DEBUFF", "STATUS"],
    statusKind: "BLIND",
    statusDetails: details,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

describe("resolveEvasion (R-HIT-01/R-HIT-02)", () => {
  it("UT-R-HIT-01-001: hits when the target has no EVASION effect (no evasion/darkness system => always hits)", () => {
    const target = unit("TARGET");
    const random = new SequenceRandomSource([]);

    const result = resolveEvasion(target, "NORMAL", random);

    expect(result).toEqual({ evaded: false });
    random.assertFullyConsumed();
  });

  it("UT-R-HIT-01-002: still hits when called repeatedly with no EVASION effects (no hidden state or RNG consumption)", () => {
    const target = unit("TARGET");
    const random = new SequenceRandomSource([]);

    expect(resolveEvasion(target, "NORMAL", random)).toEqual({ evaded: false });
    expect(resolveEvasion(target, "NORMAL", random)).toEqual({ evaded: false });
    random.assertFullyConsumed();
  });

  it("UT-R-HIT-02-001: a 100%-probability EVASION effect always evades a DAMAGE attack", () => {
    const effect = evasionEffect("eff-1", "TARGET", { probability: 1 });
    const target = { ...unit("TARGET"), appliedEffects: [effect] };
    const random = new SequenceRandomSource([0.999]);

    const result = resolveEvasion(target, "NORMAL", random);

    expect(result).toEqual({
      evaded: true,
      evadedByEffectInstanceId: effect.effectInstanceId,
      evadedByEffectActionDefinitionId: effect.effectActionDefinitionId,
    });
  });

  it("UT-R-HIT-02-002: a probability roll that fails does not evade (hit lands)", () => {
    const effect = evasionEffect("eff-1", "TARGET", { probability: 0.5 });
    const target = { ...unit("TARGET"), appliedEffects: [effect] };
    const random = new SequenceRandomSource([0.5]);

    const result = resolveEvasion(target, "NORMAL", random);

    expect(result).toEqual({ evaded: false });
  });

  it("UT-R-HIT-02-003 (missing probability defaults to certain evasion): an EVASION effect without an explicit probability always evades without consuming RandomSource", () => {
    const effect = evasionEffect("eff-1", "TARGET", {});
    const target = { ...unit("TARGET"), appliedEffects: [effect] };
    const random = new SequenceRandomSource([]);

    const result = resolveEvasion(target, "NORMAL", random);

    expect(result).toEqual({
      evaded: true,
      evadedByEffectInstanceId: effect.effectInstanceId,
      evadedByEffectActionDefinitionId: effect.effectActionDefinitionId,
    });
    random.assertFullyConsumed();
  });

  it("UT-R-HIT-02-004 (R-HIT-02 #2): a GUARANTEED-hit attack never triggers the evasion effect, even at 100% probability", () => {
    const effect = evasionEffect("eff-1", "TARGET", { probability: 1 });
    const target = { ...unit("TARGET"), appliedEffects: [effect] };
    const random = new SequenceRandomSource([]);

    const result = resolveEvasion(target, "GUARANTEED", random);

    expect(result).toEqual({ evaded: false });
    random.assertFullyConsumed();
  });

  it("UT-R-HIT-02-005 (R-HIT-02 #3): a charging target never triggers its own evasion effect", () => {
    const effect = evasionEffect("eff-1", "TARGET", { probability: 1 });
    const target = {
      ...unit("TARGET"),
      appliedEffects: [effect],
      charge: { skill: {}, startedActionId: {} } as unknown as NonNullable<BattleUnit["charge"]>,
    };
    const random = new SequenceRandomSource([]);

    const result = resolveEvasion(target, "NORMAL", random);

    expect(result).toEqual({ evaded: false });
    random.assertFullyConsumed();
  });

  it("UT-R-HIT-02-006 (appliesTo gate): an EVASION effect scoped to a different incoming action kind does not evade a DAMAGE attack", () => {
    const effect = evasionEffect("eff-1", "TARGET", {
      probability: 1,
      appliesTo: { incomingActionKinds: ["DEBUFF"] },
    });
    const target = { ...unit("TARGET"), appliedEffects: [effect] };
    const random = new SequenceRandomSource([]);

    const result = resolveEvasion(target, "NORMAL", random);

    expect(result).toEqual({ evaded: false });
    random.assertFullyConsumed();
  });

  it("UT-R-HIT-02-007 (multiple EVASION effects, independent rolls in application order): the first eligible effect that succeeds evades, consuming RandomSource in order", () => {
    const first = evasionEffect("eff-1", "TARGET", { probability: 0.3 });
    const second = evasionEffect("eff-2", "TARGET", { probability: 0.6 });
    const target = { ...unit("TARGET"), appliedEffects: [first, second] };
    // First roll fails (0.3 <= 0.5), second roll succeeds (0.1 < 0.6).
    const random = new SequenceRandomSource([0.5, 0.1]);

    const result = resolveEvasion(target, "NORMAL", random);

    expect(result).toEqual({
      evaded: true,
      evadedByEffectInstanceId: second.effectInstanceId,
      evadedByEffectActionDefinitionId: second.effectActionDefinitionId,
    });
    random.assertFullyConsumed();
  });

  it("UT-R-HIT-02-008 (non-EVASION statusKind ignored): an unrelated status-kind AppliedEffect does not affect hit resolution", () => {
    const notEvasion: AppliedEffect = {
      ...evasionEffect("eff-1", "TARGET", { probability: 1 }),
      statusKind: "STUN",
    };
    const target = { ...unit("TARGET"), appliedEffects: [notEvasion] };
    const random = new SequenceRandomSource([]);

    const result = resolveEvasion(target, "NORMAL", random);

    expect(result).toEqual({ evaded: false });
    random.assertFullyConsumed();
  });

  it('UT-R-HIT-04-001 (R-HIT-04, M7-018/Issue #272): a HIT_EVASION effect evades a DAMAGE hit exactly like status: "EVASION"', () => {
    const effect = hitEvasionEffect("eff-1", "TARGET", { probability: 1 });
    const target = { ...unit("TARGET"), appliedEffects: [effect] };
    const random = new SequenceRandomSource([]);

    const result = resolveEvasion(target, "NORMAL", random);

    expect(result).toEqual({
      evaded: true,
      evadedByEffectInstanceId: effect.effectInstanceId,
      evadedByEffectActionDefinitionId: effect.effectActionDefinitionId,
    });
    random.assertFullyConsumed();
  });

  it("UT-R-HIT-04-002 (R-HIT-04 -> R-HIT-02 #2): a GUARANTEED-hit attack never triggers a HIT_EVASION effect", () => {
    const effect = hitEvasionEffect("eff-1", "TARGET", { probability: 1 });
    const target = { ...unit("TARGET"), appliedEffects: [effect] };
    const random = new SequenceRandomSource([]);

    const result = resolveEvasion(target, "GUARANTEED", random);

    expect(result).toEqual({ evaded: false });
    random.assertFullyConsumed();
  });

  it("UT-R-HIT-04-003 (R-HIT-04 -> R-HIT-02 #3): a charging target never triggers its own HIT_EVASION effect", () => {
    const effect = hitEvasionEffect("eff-1", "TARGET", { probability: 1 });
    const target = {
      ...unit("TARGET"),
      appliedEffects: [effect],
      charge: { skill: {}, startedActionId: {} } as unknown as NonNullable<BattleUnit["charge"]>,
    };
    const random = new SequenceRandomSource([]);

    const result = resolveEvasion(target, "NORMAL", random);

    expect(result).toEqual({ evaded: false });
    random.assertFullyConsumed();
  });

  it("UT-R-HIT-04-004 (R-HIT-04: one ordered judgement sequence): HIT_EVASION and EVASION are judged together in application order, and the first effect that succeeds evades", () => {
    const first = hitEvasionEffect("eff-1", "TARGET", { probability: 0.3 });
    const second = evasionEffect("eff-2", "TARGET", { probability: 0.6 });
    const target = { ...unit("TARGET"), appliedEffects: [first, second] };
    // First roll fails (0.3 <= 0.5), second roll succeeds (0.1 < 0.6).
    const random = new SequenceRandomSource([0.5, 0.1]);

    const result = resolveEvasion(target, "NORMAL", random);

    expect(result).toEqual({
      evaded: true,
      evadedByEffectInstanceId: second.effectInstanceId,
      evadedByEffectActionDefinitionId: second.effectActionDefinitionId,
    });
    random.assertFullyConsumed();
  });

  it("UT-R-HIT-04-005 (R-HIT-04 -> R-HIT-02 appliesTo gate): a HIT_EVASION effect scoped to a different incoming action kind does not evade a DAMAGE attack", () => {
    const effect = hitEvasionEffect("eff-1", "TARGET", {
      probability: 1,
      appliesTo: { incomingActionKinds: ["DEBUFF"] },
    });
    const target = { ...unit("TARGET"), appliedEffects: [effect] };
    const random = new SequenceRandomSource([]);

    const result = resolveEvasion(target, "NORMAL", random);

    expect(result).toEqual({ evaded: false });
    random.assertFullyConsumed();
  });
});

describe("resolveEffectiveAccuracyMode (R-HIT-05)", () => {
  it("UT-R-HIT-05-001 (R-HIT-05 #1, M7-018/Issue #272): an attacker holding a GUARANTEED_HIT effect turns a NORMAL attack into a guaranteed hit", () => {
    const attacker = {
      ...unit("ATTACKER"),
      appliedEffects: [guaranteedHitEffect("eff-1", "ATTACKER")],
    };

    expect(resolveEffectiveAccuracyMode(attacker, "NORMAL")).toBe("GUARANTEED");
  });

  it("UT-R-HIT-05-002: an attacker without a GUARANTEED_HIT effect keeps the declared NORMAL accuracy", () => {
    expect(resolveEffectiveAccuracyMode(unit("ATTACKER"), "NORMAL")).toBe("NORMAL");
  });

  it("UT-R-HIT-05-003: an attack already declared GUARANTEED stays guaranteed regardless of the attacker's effects", () => {
    expect(resolveEffectiveAccuracyMode(unit("ATTACKER"), "GUARANTEED")).toBe("GUARANTEED");
  });

  it("UT-R-HIT-05-004 (non-GUARANTEED_HIT statusKind ignored): an unrelated status-kind AppliedEffect does not make the attacker's attacks guaranteed", () => {
    const attacker = {
      ...unit("ATTACKER"),
      appliedEffects: [
        { ...guaranteedHitEffect("eff-1", "ATTACKER"), statusKind: "STUN" as const },
      ],
    };

    expect(resolveEffectiveAccuracyMode(attacker, "NORMAL")).toBe("NORMAL");
  });

  it("UT-R-HIT-05-005 (R-HIT-05 #3 / R-HIT-03 #6): a GUARANTEED_HIT attacker is still subject to darkness MISS judgement", () => {
    const blind = darknessEffect("eff-2", "ATTACKER", { probability: 1 });
    const attacker = {
      ...unit("ATTACKER"),
      appliedEffects: [guaranteedHitEffect("eff-1", "ATTACKER"), blind],
    };
    const random = new SequenceRandomSource([]);

    expect(resolveEffectiveAccuracyMode(attacker, "NORMAL")).toBe("GUARANTEED");
    expect(resolveDarkness(attacker, random).missed).toBe(true);
    random.assertFullyConsumed();
  });
});

describe("resolveDarkness (R-HIT-03/R-STS-04)", () => {
  it("UT-R-HIT-03-001: no BLIND effects never misses and does not consume RandomSource", () => {
    const attacker = unit("ATTACKER");
    const random = new SequenceRandomSource([]);

    const result = resolveDarkness(attacker, random);

    expect(result).toEqual({ missed: false, checks: [] });
    random.assertFullyConsumed();
  });

  it("UT-R-HIT-03-002: a single BLIND effect that rolls MISS makes the whole check missed", () => {
    const blind = darknessEffect("eff-1", "ATTACKER", { probability: 0.55 });
    const attacker = { ...unit("ATTACKER"), appliedEffects: [blind] };
    const random = new SequenceRandomSource([0.1]);

    const result = resolveDarkness(attacker, random);

    expect(result).toEqual({
      missed: true,
      checks: [
        {
          effectInstanceId: blind.effectInstanceId,
          effectActionDefinitionId: blind.effectActionDefinitionId,
          probability: 0.55,
          missed: true,
        },
      ],
    });
  });

  it("UT-R-HIT-03-003: a single BLIND effect whose roll fails does not miss", () => {
    const blind = darknessEffect("eff-1", "ATTACKER", { probability: 0.55 });
    const attacker = { ...unit("ATTACKER"), appliedEffects: [blind] };
    const random = new SequenceRandomSource([0.9]);

    const result = resolveDarkness(attacker, random);

    expect(result).toEqual({
      missed: false,
      checks: [
        {
          effectInstanceId: blind.effectInstanceId,
          effectActionDefinitionId: blind.effectActionDefinitionId,
          probability: 0.55,
          missed: false,
        },
      ],
    });
  });

  it("UT-R-HIT-03-004 (R-HIT-03 #3/#5: independent per-effect rolls, probabilities not combined): two BLIND effects are each judged with their own roll, and any single MISS makes the whole check missed even if the other roll fails", () => {
    const first = darknessEffect("eff-1", "ATTACKER", { probability: 0.3 });
    const second = darknessEffect("eff-2", "ATTACKER", { probability: 0.3 });
    const attacker = { ...unit("ATTACKER"), appliedEffects: [first, second] };
    // First roll fails (0.3 <= 0.5), second roll succeeds (0.1 < 0.3) — proves
    // the two are NOT combined into a single combined probability (0.3+0.3=0.6
    // would also pass at 0.5, but a truly independent per-effect roll is what
    // is asserted by checking both individual outcomes below).
    const random = new SequenceRandomSource([0.5, 0.1]);

    const result = resolveDarkness(attacker, random);

    expect(result.missed).toBe(true);
    expect(result.checks).toEqual([
      {
        effectInstanceId: first.effectInstanceId,
        effectActionDefinitionId: first.effectActionDefinitionId,
        probability: 0.3,
        missed: false,
      },
      {
        effectInstanceId: second.effectInstanceId,
        effectActionDefinitionId: second.effectActionDefinitionId,
        probability: 0.3,
        missed: true,
      },
    ]);
    random.assertFullyConsumed();
  });

  it("UT-R-HIT-03-005 (R-HIT-03 #4: does not short-circuit on the first MISS — all checks are recorded for audit): both BLIND effects roll MISS and both are recorded", () => {
    const first = darknessEffect("eff-1", "ATTACKER", { probability: 1 });
    const second = darknessEffect("eff-2", "ATTACKER", { probability: 0.5 });
    const attacker = { ...unit("ATTACKER"), appliedEffects: [first, second] };
    const random = new SequenceRandomSource([0.1]);

    const result = resolveDarkness(attacker, random);

    expect(result.missed).toBe(true);
    expect(result.checks).toEqual([
      {
        effectInstanceId: first.effectInstanceId,
        effectActionDefinitionId: first.effectActionDefinitionId,
        probability: 1,
        missed: true,
      },
      {
        effectInstanceId: second.effectInstanceId,
        effectActionDefinitionId: second.effectActionDefinitionId,
        probability: 0.5,
        missed: true,
      },
    ]);
    random.assertFullyConsumed();
  });

  it("UT-R-HIT-03-006 (missing probability defaults to certain MISS without consuming RandomSource): a BLIND effect without an explicit probability always misses", () => {
    const blind = darknessEffect("eff-1", "ATTACKER", {});
    const attacker = { ...unit("ATTACKER"), appliedEffects: [blind] };
    const random = new SequenceRandomSource([]);

    const result = resolveDarkness(attacker, random);

    expect(result).toEqual({
      missed: true,
      checks: [
        {
          effectInstanceId: blind.effectInstanceId,
          effectActionDefinitionId: blind.effectActionDefinitionId,
          probability: 1,
          missed: true,
        },
      ],
    });
    random.assertFullyConsumed();
  });

  it("UT-R-HIT-03-007 (non-BLIND statusKind ignored): an unrelated status-kind AppliedEffect does not affect darkness resolution", () => {
    const notBlind: AppliedEffect = { ...darknessEffect("eff-1", "ATTACKER"), statusKind: "STUN" };
    const attacker = { ...unit("ATTACKER"), appliedEffects: [notBlind] };
    const random = new SequenceRandomSource([]);

    const result = resolveDarkness(attacker, random);

    expect(result).toEqual({ missed: false, checks: [] });
    random.assertFullyConsumed();
  });
});
