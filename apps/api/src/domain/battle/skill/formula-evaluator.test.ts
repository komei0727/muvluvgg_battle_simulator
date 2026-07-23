import { describe, expect, it } from "vitest";
import { evaluateFormula, type FormulaEvaluationContext } from "./formula-evaluator.js";
import type { FormulaDefinition } from "../../catalog/definitions/formula-definition.js";
import { DomainValidationError } from "../../shared/errors.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createMarkerInstanceId } from "../../shared/event-ids.js";
import {
  createMarkerId,
  createTargetBindingId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import { createHitPoint } from "../model/resource-gauge.js";
import type { Side } from "../../shared/side.js";
import type { MarkerState } from "../model/marker-state.js";

function unitAt(id: string, side: Side, overrides: Partial<BattleUnit> = {}): BattleUnit {
  const position = { row: "FRONT" as const, column: "LEFT" as const };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 50,
      defense: 20,
      criticalRate: 0.1,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
  return {
    ...createBattleUnit(member, side, { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 }),
    ...overrides,
  };
}

function withCurrentHp(unit: BattleUnit, currentHp: number): BattleUnit {
  return { ...unit, currentHp: createHitPoint(currentHp, unit.combatStats.maximumHp) };
}

function marker(unit: BattleUnit, markerIdValue: string, stackCount: number): MarkerState {
  return {
    markerInstanceId: createMarkerInstanceId("MARKER_INSTANCE_1"),
    markerId: createMarkerId(markerIdValue),
    sourceId: unit.battleUnitId,
    targetId: unit.battleUnitId,
    stackCount,
    stackMax: null,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
  };
}

function context(overrides: Partial<FormulaEvaluationContext> = {}): FormulaEvaluationContext {
  const skillSource = unitAt("U_SOURCE", "ALLY");
  const target = unitAt("U_TARGET", "ENEMY");
  return {
    skillSource,
    target,
    allUnits: [skillSource, target],
    ...overrides,
  };
}

describe("evaluateFormula", () => {
  it("UT-R-NUM-04-001: CONSTANT returns its value unchanged", () => {
    const formula: FormulaDefinition = { kind: "CONSTANT", value: 0.42 };
    expect(evaluateFormula(formula, context())).toBe(0.42);
  });

  it("UT-R-NUM-04-002: SKILL_POWER returns its power unchanged", () => {
    const formula: FormulaDefinition = { kind: "SKILL_POWER", power: 1.75 };
    expect(evaluateFormula(formula, context())).toBe(1.75);
  });

  it("UT-R-NUM-04-003: STAT_RATIO resolves SKILL_SOURCE and multiplies the stat by ratio", () => {
    const formula: FormulaDefinition = {
      kind: "STAT_RATIO",
      source: { kind: "SKILL_SOURCE" },
      stat: "ATTACK",
      ratio: 1.5,
    };
    // skillSource.combatStats.attack = 50
    expect(evaluateFormula(formula, context())).toBe(75);
  });

  it("UT-R-NUM-04-004: STAT_RATIO resolves TARGET to the current action target", () => {
    const formula: FormulaDefinition = {
      kind: "STAT_RATIO",
      source: { kind: "TARGET" },
      stat: "DEFENSE",
      ratio: 2,
    };
    // target.combatStats.defense = 20
    expect(evaluateFormula(formula, context())).toBe(40);
  });

  it("UT-R-NUM-04-005: MAX_HP_RATIO multiplies maximum HP by ratio", () => {
    const formula: FormulaDefinition = {
      kind: "MAX_HP_RATIO",
      source: { kind: "TARGET" },
      ratio: 0.3,
    };
    expect(evaluateFormula(formula, context())).toBeCloseTo(30);
  });

  it("UT-R-NUM-04-006: CURRENT_HP_RATIO multiplies current HP by ratio", () => {
    const ctx = context({ target: withCurrentHp(unitAt("U_TARGET", "ENEMY"), 40) });
    const formula: FormulaDefinition = {
      kind: "CURRENT_HP_RATIO",
      source: { kind: "TARGET" },
      ratio: 0.9,
    };
    expect(evaluateFormula(formula, ctx)).toBeCloseTo(36);
  });

  it("UT-R-NUM-04-007: MISSING_HP_RATIO multiplies (max - current) HP by ratio", () => {
    const ctx = context({ target: withCurrentHp(unitAt("U_TARGET", "ENEMY"), 40) });
    const formula: FormulaDefinition = {
      kind: "MISSING_HP_RATIO",
      source: { kind: "TARGET" },
      ratio: 0.5,
    };
    // missing = 100 - 40 = 60; 60 * 0.5 = 30
    expect(evaluateFormula(formula, ctx)).toBeCloseTo(30);
  });

  it("UT-R-NUM-04-008: LOST_HP_RATIO multiplies (max - current) HP by ratio, same as MISSING_HP_RATIO", () => {
    const ctx = context({ target: withCurrentHp(unitAt("U_TARGET", "ENEMY"), 40) });
    const formula: FormulaDefinition = {
      kind: "LOST_HP_RATIO",
      source: { kind: "TARGET" },
      ratio: 0.5,
    };
    expect(evaluateFormula(formula, ctx)).toBeCloseTo(30);
  });

  it("UT-R-NUM-04-009: MARKER_COUNT_SCALE reads the target's MarkerState.stackCount at evaluation time", () => {
    const skillSource = unitAt("U_SOURCE", "ALLY", {
      markerStates: [marker(unitAt("U_SOURCE", "ALLY"), "MARKER_MOCHI", 3)],
    });
    const ctx = context({ skillSource, allUnits: [skillSource] });
    const formula: FormulaDefinition = {
      kind: "MARKER_COUNT_SCALE",
      target: { kind: "SKILL_SOURCE" },
      markerId: createMarkerId("MARKER_MOCHI"),
      perStack: 0.03,
      max: 0.18,
    };
    expect(evaluateFormula(formula, ctx)).toBeCloseTo(0.09);
  });

  it("UT-R-NUM-04-010: MARKER_COUNT_SCALE treats an absent marker as stackCount 0", () => {
    const formula: FormulaDefinition = {
      kind: "MARKER_COUNT_SCALE",
      target: { kind: "SKILL_SOURCE" },
      markerId: createMarkerId("MARKER_MOCHI"),
      perStack: 0.03,
      max: 0.18,
    };
    expect(evaluateFormula(formula, context())).toBe(0);
  });

  it("UT-R-NUM-04-011: MARKER_COUNT_SCALE caps the result at max even when stackCount*perStack exceeds it", () => {
    const skillSource = unitAt("U_SOURCE", "ALLY");
    const withMarker = {
      ...skillSource,
      markerStates: [marker(skillSource, "MARKER_MOCHI", 20)],
    };
    const ctx = context({ skillSource: withMarker, allUnits: [withMarker] });
    const formula: FormulaDefinition = {
      kind: "MARKER_COUNT_SCALE",
      target: { kind: "SKILL_SOURCE" },
      markerId: createMarkerId("MARKER_MOCHI"),
      perStack: 0.03,
      max: 0.18,
    };
    // 20 * 0.03 = 0.6, capped at 0.18
    expect(evaluateFormula(formula, ctx)).toBeCloseTo(0.18);
  });

  it("UT-R-NUM-04-012: ALIVE_UNIT_COUNT_SCALE counts alive allies relative to the skill source's side", () => {
    const skillSource = unitAt("U_SOURCE", "ALLY");
    const ally1 = unitAt("U_ALLY_1", "ALLY");
    const ally2 = unitAt("U_ALLY_2", "ALLY");
    const enemy = unitAt("U_ENEMY", "ENEMY");
    const ctx = context({ skillSource, allUnits: [skillSource, ally1, ally2, enemy] });
    const formula: FormulaDefinition = {
      kind: "ALIVE_UNIT_COUNT_SCALE",
      side: "ALLY",
      perUnit: 0.0175,
      max: 0.07,
    };
    // 3 allies alive (self + ally1 + ally2) * 0.0175 = 0.0525
    expect(evaluateFormula(formula, ctx)).toBeCloseTo(0.0525);
  });

  it("UT-R-NUM-04-013: ALIVE_UNIT_COUNT_SCALE excludes defeated units and caps at max", () => {
    const skillSource = unitAt("U_SOURCE", "ALLY");
    const ally1 = unitAt("U_ALLY_1", "ALLY");
    const defeatedAlly = withCurrentHp(unitAt("U_ALLY_2", "ALLY"), 0);
    const ctx = context({ skillSource, allUnits: [skillSource, ally1, defeatedAlly] });
    const formula: FormulaDefinition = {
      kind: "ALIVE_UNIT_COUNT_SCALE",
      side: "ALLY",
      perUnit: 0.05,
      max: 0.07,
    };
    // 2 alive allies * 0.05 = 0.1, capped at 0.07
    expect(evaluateFormula(formula, ctx)).toBeCloseTo(0.07);
  });

  it("UT-R-NUM-04-014: DAMAGE_DEALT_RATIO/DAMAGE_RECEIVED_RATIO read the provided last-result value", () => {
    const ctx = context({
      lastResults: { LAST_DAMAGE_DEALT: 200, SUM_DAMAGE_RECEIVED: 80 },
    });
    expect(
      evaluateFormula(
        { kind: "DAMAGE_DEALT_RATIO", sourceResult: "LAST_DAMAGE_DEALT", ratio: 0.6 },
        ctx,
      ),
    ).toBeCloseTo(120);
    expect(
      evaluateFormula(
        { kind: "DAMAGE_RECEIVED_RATIO", sourceResult: "SUM_DAMAGE_RECEIVED", ratio: 0.5 },
        ctx,
      ),
    ).toBeCloseTo(40);
  });

  it("UT-R-NUM-04-015: DAMAGE_DEALT_RATIO throws when the evaluation context has no recorded value for that sourceResult", () => {
    const formula: FormulaDefinition = {
      kind: "DAMAGE_DEALT_RATIO",
      sourceResult: "SUM_DAMAGE_DEALT",
      ratio: 0.6,
    };
    expect(() => evaluateFormula(formula, context())).toThrow(DomainValidationError);
  });

  it("UT-R-NUM-04-016: a source referencing TRIGGER_SOURCE throws when the context has no triggerSource", () => {
    const formula: FormulaDefinition = {
      kind: "STAT_RATIO",
      source: { kind: "TRIGGER_SOURCE" },
      stat: "ATTACK",
      ratio: 1,
    };
    expect(() => evaluateFormula(formula, context())).toThrow(DomainValidationError);
  });

  it("UT-R-NUM-04-017: a source referencing TRIGGER_SOURCE resolves when the context provides one", () => {
    const triggerSource = unitAt("U_TRIGGER_SOURCE", "ALLY", {
      combatStats: {
        maximumHp: 100,
        attack: 999,
        defense: 20,
        criticalRate: 0.1,
        actionSpeed: 10,
        criticalDamageBonus: 0.5,
        affinityBonus: 0.25,
      },
    });
    const ctx = context({ triggerSource });
    const formula: FormulaDefinition = {
      kind: "STAT_RATIO",
      source: { kind: "TRIGGER_SOURCE" },
      stat: "ATTACK",
      ratio: 1,
    };
    expect(evaluateFormula(formula, ctx)).toBe(999);
  });

  it("UT-R-NUM-04-018: a source referencing TRIGGER_TARGET throws when the context has no triggerTarget", () => {
    const formula: FormulaDefinition = {
      kind: "MAX_HP_RATIO",
      source: { kind: "TRIGGER_TARGET" },
      ratio: 1,
    };
    expect(() => evaluateFormula(formula, context())).toThrow(DomainValidationError);
  });

  it("UT-R-NUM-04-019: a source referencing BINDING resolves through the bindings map", () => {
    const bindingId = createTargetBindingId("TGT_PRIMARY");
    const bound = unitAt("U_BOUND", "ENEMY");
    const ctx = context({ bindings: new Map([[bindingId, bound]]) });
    const formula: FormulaDefinition = {
      kind: "MAX_HP_RATIO",
      source: { kind: "BINDING", targetBindingId: bindingId },
      ratio: 0.5,
    };
    expect(evaluateFormula(formula, ctx)).toBeCloseTo(50);
  });

  it("UT-R-NUM-04-020: a source referencing BINDING throws when the binding is not resolved in the context", () => {
    const bindingId = createTargetBindingId("TGT_PRIMARY");
    const formula: FormulaDefinition = {
      kind: "MAX_HP_RATIO",
      source: { kind: "BINDING", targetBindingId: bindingId },
      ratio: 0.5,
    };
    expect(() => evaluateFormula(formula, context())).toThrow(DomainValidationError);
  });

  it("UT-R-NUM-04-021: SUBUNIT_ADDITIONAL_DAMAGE throws (SubUnit runtime state is not implemented yet)", () => {
    const formula: FormulaDefinition = {
      kind: "SUBUNIT_ADDITIONAL_DAMAGE",
      ownerAttack: "CURRENT_ATTACK",
      providerAttack: "SOURCE_SNAPSHOT_ATTACK",
      skillMultiplier: 1,
      targetDefense: "TARGET_CURRENT_DEFENSE",
    };
    expect(() => evaluateFormula(formula, context())).toThrow(DomainValidationError);
  });

  it("UT-R-NUM-04-022: SUM composes child Formula results without any intermediate rounding", () => {
    const formula: FormulaDefinition = {
      kind: "SUM",
      formulas: [
        { kind: "CONSTANT", value: 0.1 },
        { kind: "CONSTANT", value: 0.2 },
      ],
    };
    // 0.1 + 0.2 in IEEE754 is 0.30000000000000004, not 0.3 — this would only
    // pass with `toBe` if the evaluator performs plain float addition and
    // never rounds/truncates the child results before combining them.
    expect(evaluateFormula(formula, context())).toBe(0.1 + 0.2);
  });

  it("UT-R-NUM-04-023: MIN picks the smaller of two child Formula results (doc example: HP ratio vs. attack ratio)", () => {
    const ctx = context({ target: withCurrentHp(unitAt("U_TARGET", "ENEMY"), 40) });
    const formula: FormulaDefinition = {
      kind: "MIN",
      formulas: [
        { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.9 },
        { kind: "STAT_RATIO", source: { kind: "SKILL_SOURCE" }, stat: "ATTACK", ratio: 1.5 },
      ],
    };
    // CURRENT_HP_RATIO = 40 * 0.9 = 36; STAT_RATIO = 50 * 1.5 = 75; MIN = 36
    expect(evaluateFormula(formula, ctx)).toBeCloseTo(36);
  });

  it("UT-R-NUM-04-024: MAX picks the larger of two child Formula results", () => {
    const formula: FormulaDefinition = {
      kind: "MAX",
      formulas: [
        { kind: "CONSTANT", value: 10 },
        { kind: "CONSTANT", value: 25 },
      ],
    };
    expect(evaluateFormula(formula, context())).toBe(25);
  });

  it("UT-R-NUM-04-025: CLAMP restricts a child Formula result to [min, max]", () => {
    expect(
      evaluateFormula(
        { kind: "CLAMP", formula: { kind: "CONSTANT", value: 150 }, min: 0, max: 100 },
        context(),
      ),
    ).toBe(100);
    expect(
      evaluateFormula(
        { kind: "CLAMP", formula: { kind: "CONSTANT", value: -10 }, min: 0, max: 100 },
        context(),
      ),
    ).toBe(0);
    expect(
      evaluateFormula(
        { kind: "CLAMP", formula: { kind: "CONSTANT", value: 42 }, min: 0, max: 100 },
        context(),
      ),
    ).toBe(42);
  });

  it("UT-R-NUM-04-026: nested SUM/CLAMP/MARKER_COUNT_SCALE composition never rounds an intermediate value", () => {
    const skillSource = unitAt("U_SOURCE", "ALLY");
    const withMarker = { ...skillSource, markerStates: [marker(skillSource, "MARKER_MOCHI", 7)] };
    const ctx = context({ skillSource: withMarker, allUnits: [withMarker] });
    const formula: FormulaDefinition = {
      kind: "SUM",
      formulas: [
        { kind: "CONSTANT", value: 0.001 },
        {
          kind: "CLAMP",
          formula: {
            kind: "MARKER_COUNT_SCALE",
            target: { kind: "SKILL_SOURCE" },
            markerId: createMarkerId("MARKER_MOCHI"),
            perStack: 0.03,
            max: 10,
          },
          min: 0,
          max: 10,
        },
      ],
    };
    // MARKER_COUNT_SCALE = min(7 * 0.03, 10) = 0.21 (7*0.03 is not exactly
    // 0.21 in IEEE754); CLAMP passes it through unchanged; SUM adds 0.001.
    expect(evaluateFormula(formula, ctx)).toBe(0.001 + Math.min(7 * 0.03, 10));
  });
});
