import { describe, expect, it } from "vitest";
import {
  conditionReferencesStepTarget,
  conditionReferencesTargetSetCount,
  evaluateEffectStepCondition,
  type EffectStepTargetContext,
} from "./effect-step-condition-evaluator.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { ConditionDefinition } from "../../catalog/definitions/condition-definition.js";
import type { LastEffectActionResult } from "./last-effect-action-result.js";
import { createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createMarkerId,
  createTargetBindingId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import {
  createBattleUnit,
  type BattleUnit,
  type BattleUnitResourceLimits,
} from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import { buildInitialMarkerState } from "../model/marker-state.js";
import { createMarkerInstanceId } from "../../shared/event-ids.js";
import type { TargetReference } from "../../catalog/definitions/references.js";

const LIMITS: BattleUnitResourceLimits = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function unit(
  id: string,
  unitDefinitionId: string,
  overrides: Partial<BattleUnit> = {},
): BattleUnit {
  const side = "ENEMY" as const;
  const position = { row: "FRONT", column: "CENTER" } as const;
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId(unitDefinitionId),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
  return { ...createBattleUnit(member, side, LIMITS), ...overrides };
}

const STEP_TARGET: TargetReference = {
  kind: "BINDING",
  targetBindingId: createTargetBindingId("TGT_COLUMN"),
};
const OTHER_BINDING: TargetReference = {
  kind: "BINDING",
  targetBindingId: createTargetBindingId("TGT_OTHER"),
};

describe("evaluateEffectStepCondition", () => {
  it("UT-R-SKL-06-001: TRUE evaluates to true", () => {
    expect(evaluateEffectStepCondition({ kind: "TRUE" })).toBe(true);
  });

  it("UT-R-SKL-06-002: NOT(TRUE) evaluates to false", () => {
    const condition: ConditionDefinition = { kind: "NOT", condition: { kind: "TRUE" } };
    expect(evaluateEffectStepCondition(condition)).toBe(false);
  });

  it("UT-R-SKL-06-003: AND is true only when every condition is true", () => {
    const allTrue: ConditionDefinition = {
      kind: "AND",
      conditions: [{ kind: "TRUE" }, { kind: "TRUE" }],
    };
    const oneFalse: ConditionDefinition = {
      kind: "AND",
      conditions: [{ kind: "TRUE" }, { kind: "NOT", condition: { kind: "TRUE" } }],
    };
    expect(evaluateEffectStepCondition(allTrue)).toBe(true);
    expect(evaluateEffectStepCondition(oneFalse)).toBe(false);
  });

  it("UT-R-SKL-06-004: OR is true when at least one condition is true", () => {
    const condition: ConditionDefinition = {
      kind: "OR",
      conditions: [{ kind: "NOT", condition: { kind: "TRUE" } }, { kind: "TRUE" }],
    };
    expect(evaluateEffectStepCondition(condition)).toBe(true);
  });

  it("UT-R-SKL-06-005: TARGET_STATE without an EffectStepTargetContext throws (CAP_EFFECT_STEP_CONDITION only evaluates it per-target)", () => {
    const condition: ConditionDefinition = {
      kind: "TARGET_STATE",
      target: { kind: "SELF" },
      field: "IS_ALIVE",
      op: "EQ",
      value: true,
    };
    expect(() => evaluateEffectStepCondition(condition)).toThrow(DomainValidationError);
  });

  describe("R-SKL-08: LAST_RESULT (RES-003, Issue #173/#217)", () => {
    const damageResult: LastEffectActionResult = {
      resultKind: "APPLIED",
      effectActionKind: "DAMAGE",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_DAMAGE"),
      targetUnitIds: [createBattleUnitId("enemy-1"), createBattleUnitId("enemy-2")],
    };

    it("UT-R-SKL-08-001: compares resultKind against the supplied last result", () => {
      const condition: ConditionDefinition = {
        kind: "LAST_RESULT",
        field: "resultKind",
        op: "EQ",
        value: "APPLIED",
      };
      expect(evaluateEffectStepCondition(condition, damageResult)).toBe(true);
      expect(evaluateEffectStepCondition({ ...condition, value: "MISSED" }, damageResult)).toBe(
        false,
      );
    });

    it("UT-R-SKL-08-002: compares effectActionKind against the supplied last result", () => {
      const condition: ConditionDefinition = {
        kind: "LAST_RESULT",
        field: "effectActionKind",
        op: "EQ",
        value: "DAMAGE",
      };
      expect(evaluateEffectStepCondition(condition, damageResult)).toBe(true);
    });

    it("UT-R-SKL-08-003: compares effectActionDefinitionId against the supplied last result", () => {
      const condition: ConditionDefinition = {
        kind: "LAST_RESULT",
        field: "effectActionDefinitionId",
        op: "EQ",
        value: "ACT_DAMAGE",
      };
      expect(evaluateEffectStepCondition(condition, damageResult)).toBe(true);
    });

    it("UT-R-SKL-08-004: CONTAINS checks targetUnitIds membership", () => {
      const condition: ConditionDefinition = {
        kind: "LAST_RESULT",
        field: "targetUnitIds",
        op: "CONTAINS",
        value: "enemy-2",
      };
      expect(evaluateEffectStepCondition(condition, damageResult)).toBe(true);
      expect(evaluateEffectStepCondition({ ...condition, value: "enemy-9" }, damageResult)).toBe(
        false,
      );
    });

    it("UT-R-SKL-08-005: throws a Catalog-authoring error when no last result is available", () => {
      const condition: ConditionDefinition = {
        kind: "LAST_RESULT",
        field: "resultKind",
        op: "EQ",
        value: "APPLIED",
      };
      expect(() => evaluateEffectStepCondition(condition, undefined)).toThrow(
        DomainValidationError,
      );
      expect(() => evaluateEffectStepCondition(condition)).toThrow(DomainValidationError);
    });

    it("UT-R-SKL-08-006: composes with AND/OR/NOT", () => {
      const condition: ConditionDefinition = {
        kind: "AND",
        conditions: [
          { kind: "LAST_RESULT", field: "resultKind", op: "EQ", value: "APPLIED" },
          {
            kind: "NOT",
            condition: { kind: "LAST_RESULT", field: "resultKind", op: "EQ", value: "MISSED" },
          },
        ],
      };
      expect(evaluateEffectStepCondition(condition, damageResult)).toBe(true);
    });
  });

  describe("conditionReferencesStepTarget (CAP_EFFECT_STEP_CONDITION, Issue #171 RES-004後半)", () => {
    it("UT-R-SKL-06-013: detects TARGET_STATE/TARGET_HAS_MARKER referencing the step's own target", () => {
      const targetState: ConditionDefinition = {
        kind: "TARGET_STATE",
        target: STEP_TARGET,
        field: "IS_ALIVE",
        op: "EQ",
        value: true,
      };
      const targetHasMarker: ConditionDefinition = {
        kind: "TARGET_HAS_MARKER",
        target: STEP_TARGET,
        markerId: createMarkerId("MARKER_TEST"),
      };
      expect(conditionReferencesStepTarget(targetState, STEP_TARGET)).toBe(true);
      expect(conditionReferencesStepTarget(targetHasMarker, STEP_TARGET)).toBe(true);
    });

    it("UT-R-SKL-06-014: is false when TARGET_STATE/TARGET_HAS_MARKER reference a different TargetReference", () => {
      const condition: ConditionDefinition = {
        kind: "TARGET_STATE",
        target: OTHER_BINDING,
        field: "IS_ALIVE",
        op: "EQ",
        value: true,
      };
      const selfCondition: ConditionDefinition = {
        kind: "TARGET_STATE",
        target: { kind: "SELF" },
        field: "IS_ALIVE",
        op: "EQ",
        value: true,
      };
      expect(conditionReferencesStepTarget(condition, STEP_TARGET)).toBe(false);
      expect(conditionReferencesStepTarget(selfCondition, STEP_TARGET)).toBe(false);
    });

    it("UT-R-SKL-06-015: recurses through AND/OR/NOT", () => {
      const nested: ConditionDefinition = {
        kind: "AND",
        conditions: [
          { kind: "TRUE" },
          {
            kind: "OR",
            conditions: [
              {
                kind: "NOT",
                condition: {
                  kind: "TARGET_STATE",
                  target: STEP_TARGET,
                  field: "UNIT_TYPE",
                  op: "EQ",
                  value: "PHYSICAL",
                },
              },
            ],
          },
        ],
      };
      expect(conditionReferencesStepTarget(nested, STEP_TARGET)).toBe(true);
      expect(conditionReferencesStepTarget({ kind: "TRUE" }, STEP_TARGET)).toBe(false);
    });
  });

  describe("conditionReferencesTargetSetCount (CAP_EFFECT_STEP_SET_CONDITION, Issue #227 RES-004集合条件)", () => {
    it("UT-R-SKL-06-032: detects a top-level TARGET_SET_COUNT and recurses through AND/OR/NOT", () => {
      const direct: ConditionDefinition = {
        kind: "TARGET_SET_COUNT",
        target: OTHER_BINDING,
        op: "GTE",
        value: 1,
      };
      const nested: ConditionDefinition = {
        kind: "AND",
        conditions: [
          { kind: "TRUE" },
          { kind: "OR", conditions: [{ kind: "NOT", condition: direct }] },
        ],
      };
      expect(conditionReferencesTargetSetCount(direct)).toBe(true);
      expect(conditionReferencesTargetSetCount(nested)).toBe(true);
    });

    it("UT-R-SKL-06-033: is false when no TARGET_SET_COUNT is present", () => {
      const condition: ConditionDefinition = {
        kind: "TARGET_STATE",
        target: STEP_TARGET,
        field: "IS_ALIVE",
        op: "EQ",
        value: true,
      };
      expect(conditionReferencesTargetSetCount(condition)).toBe(false);
      expect(conditionReferencesTargetSetCount({ kind: "TRUE" })).toBe(false);
    });
  });

  describe("TARGET_STATE/TARGET_HAS_MARKER per-target evaluation (CAP_EFFECT_STEP_CONDITION, Issue #171 RES-004後半)", () => {
    const physicalUnitDefinitionId = createUnitDefinitionId("UNIT_PHYSICAL");
    const agileUnitDefinitionId = createUnitDefinitionId("UNIT_AGILE");
    const unitDefinitions = new Map<typeof physicalUnitDefinitionId, UnitDefinition>([
      [
        physicalUnitDefinitionId,
        { unitDefinitionId: physicalUnitDefinitionId, unitType: "PHYSICAL" } as UnitDefinition,
      ],
      [
        agileUnitDefinitionId,
        { unitDefinitionId: agileUnitDefinitionId, unitType: "AGILE" } as UnitDefinition,
      ],
    ]);

    function contextFor(current: BattleUnit, actor: BattleUnit): EffectStepTargetContext {
      return {
        stepTarget: STEP_TARGET,
        current,
        resolveOtherReference: (reference) => {
          if (reference.kind === "SELF") {
            return [actor];
          }
          return [];
        },
        unitDefinitions,
      };
    }

    it("UT-R-SKL-06-016: TARGET_STATE evaluates the field of `current` (the individually-iterated target), not a fixed representative", () => {
      const physical = unit("t1", "UNIT_PHYSICAL");
      const agile = unit("t2", "UNIT_AGILE");
      const actor = unit("actor", "UNIT_PHYSICAL");
      const condition: ConditionDefinition = {
        kind: "OR",
        conditions: [
          {
            kind: "TARGET_STATE",
            target: STEP_TARGET,
            field: "UNIT_TYPE",
            op: "EQ",
            value: "PHYSICAL",
          },
          {
            kind: "TARGET_STATE",
            target: STEP_TARGET,
            field: "UNIT_TYPE",
            op: "EQ",
            value: "AGILE",
          },
        ],
      };
      expect(evaluateEffectStepCondition(condition, undefined, contextFor(physical, actor))).toBe(
        true,
      );
      expect(evaluateEffectStepCondition(condition, undefined, contextFor(agile, actor))).toBe(
        true,
      );
    });

    it("UT-R-SKL-06-017: TARGET_STATE UNIT_TYPE throws when the target's UnitDefinition is not in unitDefinitions", () => {
      const unknown = unit("t3", "UNIT_UNKNOWN");
      const actor = unit("actor", "UNIT_PHYSICAL");
      const condition: ConditionDefinition = {
        kind: "TARGET_STATE",
        target: STEP_TARGET,
        field: "UNIT_TYPE",
        op: "EQ",
        value: "PHYSICAL",
      };
      expect(() =>
        evaluateEffectStepCondition(condition, undefined, contextFor(unknown, actor)),
      ).toThrow(DomainValidationError);
    });

    it("UT-R-SKL-06-018: a TARGET_STATE referencing a different TargetReference (e.g. SELF) resolves via resolveOtherReference, constant across targets", () => {
      const physical = unit("t1", "UNIT_PHYSICAL");
      const agile = unit("t2", "UNIT_AGILE");
      const actor = unit("actor", "UNIT_PHYSICAL");
      const condition: ConditionDefinition = {
        kind: "TARGET_STATE",
        target: { kind: "SELF" },
        field: "UNIT_TYPE",
        op: "EQ",
        value: "PHYSICAL",
      };
      expect(evaluateEffectStepCondition(condition, undefined, contextFor(physical, actor))).toBe(
        true,
      );
      expect(evaluateEffectStepCondition(condition, undefined, contextFor(agile, actor))).toBe(
        true,
      );
    });

    it("UT-R-SKL-06-019: TARGET_HAS_MARKER checks `current`'s own markerStates", () => {
      const markerId = createMarkerId("MARKER_UKIASHI");
      const withMarker = unit("t1", "UNIT_PHYSICAL", {
        markerStates: [
          buildInitialMarkerState(
            createMarkerInstanceId("mi-1"),
            markerId,
            createBattleUnitId("actor"),
            createBattleUnitId("t1"),
            null,
            {
              dispellable: true,
              linkedEffectGroupId: null,
              timeLimit: { unit: "BATTLE", count: 1 },
            },
            { turnNumber: 1 },
          ),
        ],
      });
      const withoutMarker = unit("t2", "UNIT_PHYSICAL");
      const actor = unit("actor", "UNIT_PHYSICAL");
      const condition: ConditionDefinition = {
        kind: "TARGET_HAS_MARKER",
        target: STEP_TARGET,
        markerId,
      };
      expect(evaluateEffectStepCondition(condition, undefined, contextFor(withMarker, actor))).toBe(
        true,
      );
      expect(
        evaluateEffectStepCondition(condition, undefined, contextFor(withoutMarker, actor)),
      ).toBe(false);
    });

    it("UT-R-SKL-06-020: TARGET_HAS_MARKER countCondition compares stackCount", () => {
      const markerId = createMarkerId("MARKER_OMEN");
      const actor = unit("actor", "UNIT_PHYSICAL");
      const twoStacks = unit("t1", "UNIT_PHYSICAL", {
        markerStates: [
          {
            ...buildInitialMarkerState(
              createMarkerInstanceId("mi-1"),
              markerId,
              createBattleUnitId("actor"),
              createBattleUnitId("t1"),
              null,
              {
                dispellable: true,
                linkedEffectGroupId: null,
                timeLimit: { unit: "BATTLE", count: 1 },
              },
              { turnNumber: 1 },
            ),
            stackCount: 2,
          },
        ],
      });
      const oneStack = unit("t2", "UNIT_PHYSICAL", {
        markerStates: [
          buildInitialMarkerState(
            createMarkerInstanceId("mi-2"),
            markerId,
            createBattleUnitId("actor"),
            createBattleUnitId("t2"),
            null,
            {
              dispellable: true,
              linkedEffectGroupId: null,
              timeLimit: { unit: "BATTLE", count: 1 },
            },
            { turnNumber: 1 },
          ),
        ],
      });
      const condition: ConditionDefinition = {
        kind: "TARGET_HAS_MARKER",
        target: STEP_TARGET,
        markerId,
        countCondition: { op: "GTE", value: 2 },
      };
      expect(evaluateEffectStepCondition(condition, undefined, contextFor(twoStacks, actor))).toBe(
        true,
      );
      expect(evaluateEffectStepCondition(condition, undefined, contextFor(oneStack, actor))).toBe(
        false,
      );
    });

    it("UT-R-SKL-06-021: TARGET_HAS_MARKER without an EffectStepTargetContext throws", () => {
      const condition: ConditionDefinition = {
        kind: "TARGET_HAS_MARKER",
        target: STEP_TARGET,
        markerId: createMarkerId("MARKER_UKIASHI"),
      };
      expect(() => evaluateEffectStepCondition(condition)).toThrow(DomainValidationError);
    });
  });

  describe("TARGET_SET_COUNT（CAP_EFFECT_STEP_SET_CONDITION、Issue #227 RES-004集合条件）", () => {
    it("UT-R-SKL-06-025: without a resolveTargetSet resolver throws", () => {
      const condition: ConditionDefinition = {
        kind: "TARGET_SET_COUNT",
        target: OTHER_BINDING,
        op: "GTE",
        value: 1,
      };
      expect(() => evaluateEffectStepCondition(condition)).toThrow(DomainValidationError);
    });

    it("UT-R-SKL-06-026: EXISTS-style (op GTE, value 1) is false when the resolved set is empty", () => {
      const condition: ConditionDefinition = {
        kind: "TARGET_SET_COUNT",
        target: OTHER_BINDING,
        op: "GTE",
        value: 1,
      };
      expect(evaluateEffectStepCondition(condition, undefined, undefined, () => [])).toBe(false);
    });

    it("UT-R-SKL-06-027: NONE-style (op LT, value 1) is true when the resolved set is empty", () => {
      const condition: ConditionDefinition = {
        kind: "TARGET_SET_COUNT",
        target: OTHER_BINDING,
        op: "LT",
        value: 1,
      };
      expect(evaluateEffectStepCondition(condition, undefined, undefined, () => [])).toBe(true);
    });

    it("UT-R-SKL-06-028: COUNT threshold compares the resolved set size (boundary and multiple members)", () => {
      const enemyA = unit("ENEMY_A", "UNIT_A");
      const enemyB = unit("ENEMY_B", "UNIT_A");
      const condition: ConditionDefinition = {
        kind: "TARGET_SET_COUNT",
        target: OTHER_BINDING,
        op: "GTE",
        value: 2,
      };
      expect(evaluateEffectStepCondition(condition, undefined, undefined, () => [enemyA])).toBe(
        false,
      );
      expect(
        evaluateEffectStepCondition(condition, undefined, undefined, () => [enemyA, enemyB]),
      ).toBe(true);
    });

    it("UT-R-SKL-06-029: excludes defeated units from the count, reflecting the latest state the resolver returns", () => {
      const alive = unit("ENEMY_A", "UNIT_A");
      const defeated = unit("ENEMY_B", "UNIT_A", { currentHp: 0 });
      const condition: ConditionDefinition = {
        kind: "TARGET_SET_COUNT",
        target: OTHER_BINDING,
        op: "GTE",
        value: 1,
      };
      expect(evaluateEffectStepCondition(condition, undefined, undefined, () => [defeated])).toBe(
        false,
      );
      expect(
        evaluateEffectStepCondition(condition, undefined, undefined, () => [alive, defeated]),
      ).toBe(true);
    });

    it("UT-R-SKL-06-030: recurses through AND/OR/NOT and passes the resolveTargetSet resolver down", () => {
      const enemyA = unit("ENEMY_A", "UNIT_A");
      const condition: ConditionDefinition = {
        kind: "AND",
        conditions: [
          { kind: "TARGET_SET_COUNT", target: OTHER_BINDING, op: "GTE", value: 1 },
          {
            kind: "NOT",
            condition: { kind: "TARGET_SET_COUNT", target: OTHER_BINDING, op: "GTE", value: 2 },
          },
        ],
      };
      expect(evaluateEffectStepCondition(condition, undefined, undefined, () => [enemyA])).toBe(
        true,
      );
    });

    it("UT-R-SKL-06-031: resolves via the EffectStepTargetContext's resolveOtherReference when a per-target context is also present (combined with TARGET_STATE self-condition)", () => {
      const enemyA = unit("ENEMY_A", "UNIT_A");
      const condition: ConditionDefinition = {
        kind: "AND",
        conditions: [
          { kind: "TARGET_STATE", target: STEP_TARGET, field: "IS_ALIVE", op: "EQ", value: true },
          { kind: "TARGET_SET_COUNT", target: OTHER_BINDING, op: "GTE", value: 1 },
        ],
      };
      const ctx: EffectStepTargetContext = {
        stepTarget: STEP_TARGET,
        current: enemyA,
        resolveOtherReference: () => [enemyA],
        unitDefinitions: new Map(),
      };
      expect(
        evaluateEffectStepCondition(condition, undefined, ctx, ctx.resolveOtherReference),
      ).toBe(true);
    });
  });
});
