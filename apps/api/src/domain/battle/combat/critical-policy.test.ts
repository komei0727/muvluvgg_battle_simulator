import { describe, expect, it } from "vitest";
import {
  resolveCritical,
  resolveDeclaredCriticalMode,
  resolveEffectiveCriticalMode,
} from "./critical-policy.js";
import { createPercentage } from "../../shared/percentage.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import {
  createBattleUnit,
  type BattleUnit,
  type BattleUnitResourceLimits,
} from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { CriticalMode, StatusKind } from "../../catalog/definitions/catalog-enums.js";
import type { DamagePayload } from "../../catalog/definitions/effect-action-payload.js";
import type { FormulaDefinition } from "../../catalog/definitions/formula-definition.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { UNUSED_ENHANCED_BASE_STATS } from "../../../testing/fixtures/battle-actors.js";

const LIMITS: BattleUnitResourceLimits = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function unit(id: string): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    enhancedBaseStats: UNUSED_ENHANCED_BASE_STATS,
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_001"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate("ALLY", position),
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
  return createBattleUnit(member, "ALLY", LIMITS);
}

function statusEffect(id: string, holderId: string, statusKind: StatusKind): AppliedEffect {
  const definitionId = createEffectActionDefinitionId(`ACT_${statusKind}`);
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate: true,
    sourceUnitId: createBattleUnitId(holderId),
    targetUnitId: createBattleUnitId(holderId),
    magnitude: 0,
    categories: ["BUFF"],
    statusKind,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

function holderOf(...statusKinds: readonly StatusKind[]): BattleUnit {
  return {
    ...unit("ATTACKER"),
    appliedEffects: statusKinds.map((statusKind, index) =>
      statusEffect(`eff-${index + 1}`, "ATTACKER", statusKind),
    ),
  };
}

describe("resolveCritical", () => {
  it("UT-R-CRT-01-001: NORMAL mode with 0% criticalRate never crits, even with the lowest possible roll", () => {
    const random = new SequenceRandomSource([0]);

    const result = resolveCritical("NORMAL", createPercentage(0), 0.5, random);

    expect(result.isCritical).toBe(false);
    expect(result.multiplier).toBe(1);
    random.assertFullyConsumed();
  });

  it("UT-R-CRT-01-002: NORMAL mode with 100% criticalRate always crits, even with the highest possible roll", () => {
    const random = new SequenceRandomSource([0.999999]);

    const result = resolveCritical("NORMAL", createPercentage(1), 0.5, random);

    expect(result.isCritical).toBe(true);
    random.assertFullyConsumed();
  });

  it("UT-R-CRT-01-003: NORMAL mode clamps a criticalRate above 100% down to 100% (R-CRT-01)", () => {
    const random = new SequenceRandomSource([0.999999]);

    const result = resolveCritical("NORMAL", createPercentage(1.5), 0.5, random);

    expect(result.isCritical).toBe(true);
    random.assertFullyConsumed();
  });

  it("UT-R-CRT-01-004: NORMAL mode clamps a negative criticalRate up to 0% (R-CRT-01)", () => {
    const random = new SequenceRandomSource([0]);

    const result = resolveCritical("NORMAL", createPercentage(-0.5), 0.5, random);

    expect(result.isCritical).toBe(false);
    random.assertFullyConsumed();
  });

  it("UT-R-CRT-01-008 (会心・ダメージイベントの監査可能性): exposes both baseRate (元会心率) and effectiveRate (実効会心率, R-CRT-01のclamp後) on the result", () => {
    const random = new SequenceRandomSource([0.999999]);

    const result = resolveCritical("NORMAL", createPercentage(1.5), 0.5, random);

    expect(result.baseRate).toBe(1.5);
    expect(result.effectiveRate).toBe(1);
  });

  it("UT-R-CRT-01-009: effectiveRate clamps a negative baseRate up to 0", () => {
    const random = new SequenceRandomSource([0]);

    const result = resolveCritical("NORMAL", createPercentage(-0.5), 0.5, random);

    expect(result.baseRate).toBe(-0.5);
    expect(result.effectiveRate).toBe(0);
  });

  it("UT-R-CRT-01-010: GUARANTEED/PREVENTED modes still report baseRate/effectiveRate for auditability, even though the mode alone determines the outcome", () => {
    const random = new SequenceRandomSource([]);

    const guaranteed = resolveCritical("GUARANTEED", createPercentage(0.3), 0.5, random);
    const prevented = resolveCritical("PREVENTED", createPercentage(0.3), 0.5, random);

    expect(guaranteed.baseRate).toBe(0.3);
    expect(guaranteed.effectiveRate).toBe(0.3);
    expect(prevented.baseRate).toBe(0.3);
    expect(prevented.effectiveRate).toBe(0.3);
  });

  it("UT-R-CRT-01-005: NORMAL mode rolls against RandomSource for a mid-range criticalRate", () => {
    const belowRate = new SequenceRandomSource([0.29]);
    const atRate = new SequenceRandomSource([0.3]);

    expect(resolveCritical("NORMAL", createPercentage(0.3), 0.5, belowRate).isCritical).toBe(true);
    expect(resolveCritical("NORMAL", createPercentage(0.3), 0.5, atRate).isCritical).toBe(false);
  });

  it("UT-R-CRT-01-006: GUARANTEED mode always crits without consuming the RandomSource", () => {
    const random = new SequenceRandomSource([]);

    const result = resolveCritical("GUARANTEED", createPercentage(0), 0.5, random);

    expect(result.isCritical).toBe(true);
    random.assertFullyConsumed();
  });

  it("UT-R-CRT-01-007: PREVENTED mode never crits without consuming the RandomSource", () => {
    const random = new SequenceRandomSource([]);

    const result = resolveCritical("PREVENTED", createPercentage(1), 0.5, random);

    expect(result.isCritical).toBe(false);
    random.assertFullyConsumed();
  });

  it("UT-R-CRT-02-001: a critical hit multiplies by 100% plus the criticalDamageBonus", () => {
    const random = new SequenceRandomSource([]);

    const result = resolveCritical("GUARANTEED", createPercentage(0), 0.25, random);

    expect(result.multiplier).toBeCloseTo(1.25);
  });

  it("UT-R-CRT-02-002: a non-critical hit always multiplies by 100%, regardless of criticalDamageBonus", () => {
    const random = new SequenceRandomSource([]);

    const result = resolveCritical("PREVENTED", createPercentage(1), 0.9, random);

    expect(result.multiplier).toBe(1);
  });

  // `criticalDamageBonus`は既定値50%（Q-CAT-05）を含んだユニットステータスであり、
  // R-CRT-02の「150%」はその既定値込みの結果である。倍率式が150%を別途足すと既定値が
  // 二重に乗るため、既定値そのものを入力にした倍率をここで固定する。
  it("UT-R-CRT-02-003: the default 50% criticalDamageBonus yields exactly the 150% critical multiplier", () => {
    const random = new SequenceRandomSource([]);

    const result = resolveCritical("GUARANTEED", createPercentage(0), 0.5, random);

    expect(result.multiplier).toBeCloseTo(1.5);
  });

  it("UT-R-CRT-02-004: gear and buffs raise the multiplier by the same percentage points they add to the bonus", () => {
    const random = new SequenceRandomSource([]);

    const result = resolveCritical("GUARANTEED", createPercentage(0), 1.05, random);

    expect(result.multiplier).toBeCloseTo(2.05);
  });

  it("UT-R-CRT-02-005: a zero criticalDamageBonus leaves a critical hit at 100%", () => {
    const random = new SequenceRandomSource([]);

    const result = resolveCritical("GUARANTEED", createPercentage(0), 0, random);

    expect(result.multiplier).toBeCloseTo(1);
  });
});

describe("resolveEffectiveCriticalMode (R-CRT-03)", () => {
  it("UT-R-CRT-03-001 (R-CRT-03 #2, DMG-003A/Issue #295): an attacker holding CRITICAL_GUARANTEE turns a NORMAL declaration into GUARANTEED", () => {
    expect(resolveEffectiveCriticalMode(holderOf("CRITICAL_GUARANTEE"), "NORMAL")).toBe(
      "GUARANTEED",
    );
  });

  it("UT-R-CRT-03-002 (R-CRT-03 #1): an attacker holding CRITICAL_PREVENTION turns a NORMAL declaration into PREVENTED", () => {
    expect(resolveEffectiveCriticalMode(holderOf("CRITICAL_PREVENTION"), "NORMAL")).toBe(
      "PREVENTED",
    );
  });

  it("UT-R-CRT-03-003 (R-CRT-03 #3): an attacker holding neither status keeps the declared NORMAL mode", () => {
    expect(resolveEffectiveCriticalMode(holderOf(), "NORMAL")).toBe("NORMAL");
  });

  it("UT-R-CRT-03-004 (non-critical statusKind ignored): an unrelated status-kind AppliedEffect does not change the declared mode", () => {
    expect(resolveEffectiveCriticalMode(holderOf("STUN", "GUARANTEED_HIT"), "NORMAL")).toBe(
      "NORMAL",
    );
  });

  it("UT-R-CRT-03-005 (R-CRT-03 #1 precedence): holding both statuses resolves to PREVENTED — 会心不可 forbids the critical outright, 会心保証 only guarantees it", () => {
    expect(
      resolveEffectiveCriticalMode(holderOf("CRITICAL_GUARANTEE", "CRITICAL_PREVENTION"), "NORMAL"),
    ).toBe("PREVENTED");
    // 付与順に依存しない。
    expect(
      resolveEffectiveCriticalMode(holderOf("CRITICAL_PREVENTION", "CRITICAL_GUARANTEE"), "NORMAL"),
    ).toBe("PREVENTED");
  });

  it("UT-R-CRT-03-006 (R-CRT-03 #1 boundary): CRITICAL_PREVENTION overrides a definition that declares GUARANTEED", () => {
    expect(resolveEffectiveCriticalMode(holderOf("CRITICAL_PREVENTION"), "GUARANTEED")).toBe(
      "PREVENTED",
    );
  });

  it("UT-R-CRT-03-007 (R-CRT-03 #1 boundary / R-SUB-02): a definition declaring PREVENTED stays PREVENTED even for an attacker holding CRITICAL_GUARANTEE — sub-unit additional damage has no critical term", () => {
    expect(resolveEffectiveCriticalMode(holderOf("CRITICAL_GUARANTEE"), "PREVENTED")).toBe(
      "PREVENTED",
    );
  });

  it("UT-R-CRT-03-008: a declared GUARANTEED mode is unchanged when the attacker holds no critical status", () => {
    expect(resolveEffectiveCriticalMode(holderOf(), "GUARANTEED")).toBe("GUARANTEED");
    expect(resolveEffectiveCriticalMode(holderOf(), "PREVENTED")).toBe("PREVENTED");
  });

  it("UT-R-CRT-03-009 (R-CRT-03 boundary): the resolved mode drives resolveCritical without consuming the RandomSource", () => {
    const random = new SequenceRandomSource([]);

    const prevented = resolveCritical(
      resolveEffectiveCriticalMode(holderOf("CRITICAL_PREVENTION"), "NORMAL"),
      createPercentage(1),
      0.5,
      random,
    );
    const guaranteed = resolveCritical(
      resolveEffectiveCriticalMode(holderOf("CRITICAL_GUARANTEE"), "NORMAL"),
      createPercentage(0),
      0.5,
      random,
    );

    expect(prevented.isCritical).toBe(false);
    expect(guaranteed.isCritical).toBe(true);
    random.assertFullyConsumed();
  });
});

describe("resolveDeclaredCriticalMode (R-CRT-04)", () => {
  function damagePayload(
    formula: FormulaDefinition,
    criticalMode: CriticalMode = "NORMAL",
  ): DamagePayload {
    return {
      damageType: "PHYSICAL",
      formula,
      hitCount: 1,
      critical: { mode: criticalMode },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    };
  }

  const targetCurrentHp: FormulaDefinition = {
    kind: "CURRENT_HP_RATIO",
    source: { kind: "TARGET" },
    ratio: 0.125,
  };
  const attackCap: FormulaDefinition = {
    kind: "STAT_RATIO",
    source: { kind: "SKILL_SOURCE" },
    stat: "ATTACK",
    ratio: 0.5,
  };

  it("UT-R-CRT-04-001: a SKILL_POWER damage keeps its declared mode — the rule does not touch attack-based damage", () => {
    const formula: FormulaDefinition = { kind: "SKILL_POWER", power: 1.56 };
    expect(resolveDeclaredCriticalMode(damagePayload(formula))).toBe("NORMAL");
    expect(resolveDeclaredCriticalMode(damagePayload(formula, "GUARANTEED"))).toBe("GUARANTEED");
    expect(resolveDeclaredCriticalMode(damagePayload(formula, "PREVENTED"))).toBe("PREVENTED");
  });

  it("UT-R-CRT-04-002: a bare CURRENT_HP_RATIO on the target resolves to PREVENTED", () => {
    expect(resolveDeclaredCriticalMode(damagePayload(targetCurrentHp))).toBe("PREVENTED");
  });

  it("UT-R-CRT-04-003: the target HP term is found through a MIN cap — the production shape MIN[CURRENT_HP_RATIO(TARGET), STAT_RATIO(ATTACK)]", () => {
    const formula: FormulaDefinition = { kind: "MIN", formulas: [targetCurrentHp, attackCap] };
    expect(resolveDeclaredCriticalMode(damagePayload(formula))).toBe("PREVENTED");
  });

  it("UT-R-CRT-04-004: MISSING_HP_RATIO and LOST_HP_RATIO on the target resolve to PREVENTED — both evaluate as maximumHp - currentHp", () => {
    for (const kind of ["MISSING_HP_RATIO", "LOST_HP_RATIO"] as const) {
      const formula: FormulaDefinition = { kind, source: { kind: "TARGET" }, ratio: 0.5 };
      expect(resolveDeclaredCriticalMode(damagePayload(formula))).toBe("PREVENTED");
      expect(
        resolveDeclaredCriticalMode(damagePayload({ kind: "MIN", formulas: [formula, attackCap] })),
      ).toBe("PREVENTED");
    }
  });

  it("UT-R-CRT-04-005: the term is found through SUM / PRODUCT / MAX / CLAMP nesting as well", () => {
    const nested: readonly FormulaDefinition[] = [
      { kind: "SUM", formulas: [attackCap, targetCurrentHp] },
      { kind: "PRODUCT", formulas: [targetCurrentHp, { kind: "CONSTANT", value: 2 }] },
      { kind: "MAX", formulas: [attackCap, targetCurrentHp] },
      { kind: "CLAMP", formula: { kind: "MIN", formulas: [targetCurrentHp] }, min: 0, max: 999 },
    ];
    for (const formula of nested) {
      expect(resolveDeclaredCriticalMode(damagePayload(formula))).toBe("PREVENTED");
    }
  });

  it("UT-R-CRT-04-006: an HP ratio sourced from the skill user is not covered — 自身のHPを消費して撃つ攻撃は従来どおり会心判定を行う", () => {
    const selfHp: FormulaDefinition = {
      kind: "CURRENT_HP_RATIO",
      source: { kind: "SKILL_SOURCE" },
      ratio: 0.5625,
    };
    expect(resolveDeclaredCriticalMode(damagePayload(selfHp))).toBe("NORMAL");
    expect(
      resolveDeclaredCriticalMode(damagePayload({ kind: "MIN", formulas: [selfHp, attackCap] })),
    ).toBe("NORMAL");
  });

  it("UT-R-CRT-04-007: MAX_HP_RATIO and DAMAGE_RECEIVED_RATIO are not covered — 現在HPに依存しない量と反撃量は対象外", () => {
    const maxHpOnTarget: FormulaDefinition = {
      kind: "MAX_HP_RATIO",
      source: { kind: "TARGET" },
      ratio: 0.2,
    };
    const counter: FormulaDefinition = {
      kind: "DAMAGE_RECEIVED_RATIO",
      sourceResult: "LAST_DAMAGE_RECEIVED",
      ratio: 1,
    };
    expect(resolveDeclaredCriticalMode(damagePayload(maxHpOnTarget))).toBe("NORMAL");
    expect(resolveDeclaredCriticalMode(damagePayload(counter))).toBe("NORMAL");
    expect(resolveDeclaredCriticalMode(damagePayload(counter, "GUARANTEED"))).toBe("GUARANTEED");
  });

  it("UT-R-CRT-04-008 (R-CRT-03): the derived PREVENTED survives an attacker-held CRITICAL_GUARANTEE and consumes no RandomSource", () => {
    const random = new SequenceRandomSource([]);
    const declared = resolveDeclaredCriticalMode(
      damagePayload({ kind: "MIN", formulas: [targetCurrentHp, attackCap] }),
    );

    const effective = resolveEffectiveCriticalMode(holderOf("CRITICAL_GUARANTEE"), declared);
    const result = resolveCritical(effective, createPercentage(1), 0.5, random);

    expect(effective).toBe("PREVENTED");
    expect(result.isCritical).toBe(false);
    expect(result.multiplier).toBe(1);
    random.assertFullyConsumed();
  });
});
