import { describe, expect, it } from "vitest";
import { evaluateTriggerCondition } from "./trigger-condition-evaluator.js";
import type { ConditionDefinition } from "../../catalog/definitions/condition-definition.js";
import { DomainValidationError } from "../../shared/errors.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import type { MarkerState } from "../model/marker-state.js";
import { createBattleUnitId, type BattleUnitId } from "../../shared/ids.js";
import { createEffectInstanceId, createMarkerInstanceId } from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createMarkerId,
  createRuntimeCounterId,
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import type {
  EffectImmunityCategory,
  PositionColumn,
  PositionRow,
} from "../../catalog/definitions/catalog-enums.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";

const SKILL_ID = createSkillDefinitionId("SKL_PS1");
const COUNTER_ID = createRuntimeCounterId("RUNTIME_COUNTER_CRIT");

function ownerWithCounter(value?: number): BattleUnit {
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId("U1"),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position: { row: "FRONT", column: "LEFT" },
    globalCoordinate: toGlobalCoordinate("ALLY", { row: "FRONT", column: "LEFT" }),
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
  const unit = createBattleUnit(member, "ALLY", {
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 100,
  });
  if (value === undefined) {
    return unit;
  }
  return {
    ...unit,
    skillCounters: { [SKILL_ID]: { [COUNTER_ID]: { value, carry: 0 } } },
  };
}

function unitAt(
  id: string,
  side: Side,
  row: PositionRow,
  column: PositionColumn,
  overrides: Partial<BattleUnit> = {},
): BattleUnit {
  const position = { row, column };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
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
  return {
    ...createBattleUnit(member, side, { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 }),
    ...overrides,
  };
}

/** M7-001E（Issue #248）: `TARGET_HAS_EFFECT`/`HAS_STATUS`が読む最小の`AppliedEffect`。 */
function effect(
  id: string,
  categories: readonly EffectImmunityCategory[],
  magnitude = -0.2,
): AppliedEffect {
  const effectActionDefinitionId = createEffectActionDefinitionId(`ACT_${id.toUpperCase()}`);
  return {
    effectInstanceId: createEffectInstanceId(`battle-1:effect:${id}`),
    effectActionDefinitionId,
    kindKey: effectKindKeyFromDefinitionId(effectActionDefinitionId),
    duplicate: true,
    targetId: createBattleUnitId("OWNER"),
    magnitude,
    categories,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
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

describe("evaluateTriggerCondition", () => {
  it("UT-R-PS-01-001: TRUE always matches", () => {
    expect(evaluateTriggerCondition({ kind: "TRUE" }, { payload: {} })).toBe(true);
  });

  it("UT-R-PS-01-002: EVENT_PAYLOAD compares a payload field with the operator", () => {
    const condition: ConditionDefinition = {
      kind: "EVENT_PAYLOAD",
      field: "hpDamage",
      op: "GT",
      value: 0,
    };
    expect(evaluateTriggerCondition(condition, { payload: { hpDamage: 5 } })).toBe(true);
    expect(evaluateTriggerCondition(condition, { payload: { hpDamage: 0 } })).toBe(false);
  });

  it("UT-R-PS-01-003: EVENT_PAYLOAD supports EQ/NEQ/IN/CONTAINS against string and array payload fields", () => {
    expect(
      evaluateTriggerCondition(
        { kind: "EVENT_PAYLOAD", field: "status", op: "EQ", value: "FREEZE" },
        { payload: { status: "FREEZE" } },
      ),
    ).toBe(true);
    expect(
      evaluateTriggerCondition(
        { kind: "EVENT_PAYLOAD", field: "status", op: "NEQ", value: "FREEZE" },
        { payload: { status: "STUN" } },
      ),
    ).toBe(true);
    expect(
      evaluateTriggerCondition(
        { kind: "EVENT_PAYLOAD", field: "status", op: "IN", value: ["FREEZE", "STUN"] as never },
        { payload: { status: "STUN" } },
      ),
    ).toBe(true);
  });

  it("UT-R-PS-01-004: EVENT_PAYLOAD returns false when the field is missing from payload", () => {
    const condition: ConditionDefinition = {
      kind: "EVENT_PAYLOAD",
      field: "missingField",
      op: "EQ",
      value: 1,
    };
    expect(evaluateTriggerCondition(condition, { payload: {} })).toBe(false);
  });

  it("UT-R-PS-01-005: AND requires every sub-condition to hold", () => {
    const condition: ConditionDefinition = {
      kind: "AND",
      conditions: [
        { kind: "EVENT_PAYLOAD", field: "a", op: "EQ", value: 1 },
        { kind: "EVENT_PAYLOAD", field: "b", op: "EQ", value: 2 },
      ],
    };
    expect(evaluateTriggerCondition(condition, { payload: { a: 1, b: 2 } })).toBe(true);
    expect(evaluateTriggerCondition(condition, { payload: { a: 1, b: 3 } })).toBe(false);
  });

  it("UT-R-PS-01-006: OR requires at least one sub-condition to hold", () => {
    const condition: ConditionDefinition = {
      kind: "OR",
      conditions: [
        { kind: "EVENT_PAYLOAD", field: "a", op: "EQ", value: 1 },
        { kind: "EVENT_PAYLOAD", field: "b", op: "EQ", value: 2 },
      ],
    };
    expect(evaluateTriggerCondition(condition, { payload: { a: 0, b: 2 } })).toBe(true);
    expect(evaluateTriggerCondition(condition, { payload: { a: 0, b: 0 } })).toBe(false);
  });

  it("UT-R-PS-01-007: NOT inverts the inner condition", () => {
    const condition: ConditionDefinition = {
      kind: "NOT",
      condition: { kind: "EVENT_PAYLOAD", field: "a", op: "EQ", value: 1 },
    };
    expect(evaluateTriggerCondition(condition, { payload: { a: 1 } })).toBe(false);
    expect(evaluateTriggerCondition(condition, { payload: { a: 2 } })).toBe(true);
  });

  it("UT-R-PS-01-008: an unsupported condition kind throws a clear DomainValidationError (LAST_RESULT is EffectStep-scoped, not a trigger/activationCondition concern)", () => {
    const condition: ConditionDefinition = {
      kind: "LAST_RESULT",
      field: "resultKind",
      op: "EQ",
      value: "HIT",
    };
    expect(() => evaluateTriggerCondition(condition, { payload: {} })).toThrow(
      DomainValidationError,
    );
  });

  describe("RUNTIME_COUNTER (Issue #143)", () => {
    const condition: Extract<ConditionDefinition, { kind: "RUNTIME_COUNTER" }> = {
      kind: "RUNTIME_COUNTER",
      counter: COUNTER_ID,
      op: "GTE",
      value: 1,
    };

    it("UT-R-PS-01-009: throws when no RuntimeCounterLookupContext is supplied", () => {
      expect(() => evaluateTriggerCondition(condition, { payload: {} })).toThrow(
        DomainValidationError,
      );
    });

    it("UT-R-PS-01-010: an absent counter defaults to value 0", () => {
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner: ownerWithCounter(), skillDefinitionId: SKILL_ID },
        ),
      ).toBe(false);
    });

    it("UT-R-PS-01-011: compares the owning skill's current counter value with op/value", () => {
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner: ownerWithCounter(1), skillDefinitionId: SKILL_ID },
        ),
      ).toBe(true);
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner: ownerWithCounter(0), skillDefinitionId: SKILL_ID },
        ),
      ).toBe(false);
    });

    it("UT-R-PS-01-012 (RUNTIME_COUNTER_MODULO): modulo adds 'value mod modulo == 0' as an extra condition (every 3rd)", () => {
      const everyThird: ConditionDefinition = { ...condition, modulo: 3 };
      expect(
        evaluateTriggerCondition(
          everyThird,
          { payload: {} },
          { owner: ownerWithCounter(3), skillDefinitionId: SKILL_ID },
        ),
      ).toBe(true);
      expect(
        evaluateTriggerCondition(
          everyThird,
          { payload: {} },
          { owner: ownerWithCounter(4), skillDefinitionId: SKILL_ID },
        ),
      ).toBe(false);
      expect(
        evaluateTriggerCondition(
          everyThird,
          { payload: {} },
          { owner: ownerWithCounter(6), skillDefinitionId: SKILL_ID },
        ),
      ).toBe(true);
    });

    it("UT-R-PS-01-013: a counter belonging to a different SkillDefinitionId is not visible (SKILL_RUNTIME scope isolation)", () => {
      const owner = ownerWithCounter(5);
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          {
            owner,
            skillDefinitionId: createSkillDefinitionId("SKL_OTHER"),
          },
        ),
      ).toBe(false);
    });

    describe("APPLIED_EFFECT scope (EFF-005, Issue #162)", () => {
      it("UT-R-EFF-11-007: reads the counter from context.effectCounters when supplied, without requiring skillDefinitionId", () => {
        expect(
          evaluateTriggerCondition(
            condition,
            { payload: {} },
            { owner: ownerWithCounter(), effectCounters: { [COUNTER_ID]: { value: 2, carry: 0 } } },
          ),
        ).toBe(true);
      });

      it("UT-R-EFF-11-008: an absent counter in effectCounters defaults to value 0", () => {
        expect(
          evaluateTriggerCondition(
            condition,
            { payload: {} },
            { owner: ownerWithCounter(), effectCounters: {} },
          ),
        ).toBe(false);
      });

      it("UT-R-EFF-11-009: effectCounters is isolated from the owner's skillCounters (AppliedEffect scope has no visibility into SkillRuntime scope)", () => {
        const owner = ownerWithCounter(5);
        expect(
          evaluateTriggerCondition(condition, { payload: {} }, { owner, effectCounters: {} }),
        ).toBe(false);
      });

      it("UT-R-EFF-11-010: effectCounters takes precedence over skillDefinitionId when both are supplied", () => {
        expect(
          evaluateTriggerCondition(
            condition,
            { payload: {} },
            {
              owner: ownerWithCounter(0),
              skillDefinitionId: SKILL_ID,
              effectCounters: { [COUNTER_ID]: { value: 1, carry: 0 } },
            },
          ),
        ).toBe(true);
      });
    });
  });

  describe("POSITION_RELATION (Issue #144, TRIGGER_POSITION_RELATION)", () => {
    const inFrontOfTriggerTarget: ConditionDefinition = {
      kind: "POSITION_RELATION",
      target: { kind: "TRIGGER_TARGET" },
      relation: "IN_FRONT_OF",
    };

    it.each([
      {
        side: "ALLY",
        ownerRow: "BACK",
        ownerCol: "LEFT",
        targetRow: "FRONT",
        targetCol: "LEFT",
        expected: true,
      },
      {
        side: "ALLY",
        ownerRow: "BACK",
        ownerCol: "CENTER",
        targetRow: "FRONT",
        targetCol: "CENTER",
        expected: true,
      },
      {
        side: "ALLY",
        ownerRow: "BACK",
        ownerCol: "RIGHT",
        targetRow: "FRONT",
        targetCol: "RIGHT",
        expected: true,
      },
      {
        side: "ALLY",
        ownerRow: "BACK",
        ownerCol: "LEFT",
        targetRow: "FRONT",
        targetCol: "CENTER",
        expected: false,
      },
      {
        side: "ALLY",
        ownerRow: "FRONT",
        ownerCol: "LEFT",
        targetRow: "BACK",
        targetCol: "LEFT",
        expected: false,
      },
      {
        side: "ENEMY",
        ownerRow: "BACK",
        ownerCol: "LEFT",
        targetRow: "FRONT",
        targetCol: "LEFT",
        expected: true,
      },
      {
        side: "ENEMY",
        ownerRow: "FRONT",
        ownerCol: "LEFT",
        targetRow: "BACK",
        targetCol: "LEFT",
        expected: false,
      },
    ] as const)(
      "UT-R-PS-01-014: $side owner at $ownerRow/$ownerCol vs target at $targetRow/$targetCol -> $expected",
      ({ side, ownerRow, ownerCol, targetRow, targetCol, expected }) => {
        const owner = unitAt("OWNER", side, ownerRow, ownerCol);
        const target = unitAt("TARGET", side, targetRow, targetCol);
        const getUnit = (id: BattleUnitId): BattleUnit | undefined =>
          [owner, target].find((u) => u.battleUnitId === id);
        expect(
          evaluateTriggerCondition(
            inFrontOfTriggerTarget,
            { payload: {}, targetUnitIds: [target.battleUnitId] },
            { owner, skillDefinitionId: SKILL_ID, getUnit },
          ),
        ).toBe(expected);
      },
    );

    it("UT-R-PS-01-015: resolves the target via TRIGGER_SOURCE", () => {
      const owner = unitAt("OWNER", "ALLY", "BACK", "LEFT");
      const source = unitAt("SOURCE", "ALLY", "FRONT", "LEFT");
      const getUnit = (id: BattleUnitId): BattleUnit | undefined =>
        [owner, source].find((u) => u.battleUnitId === id);
      const condition: ConditionDefinition = {
        kind: "POSITION_RELATION",
        target: { kind: "TRIGGER_SOURCE" },
        relation: "IN_FRONT_OF",
      };
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {}, sourceUnitId: source.battleUnitId },
          { owner, skillDefinitionId: SKILL_ID, getUnit },
        ),
      ).toBe(true);
    });

    it("UT-R-PS-01-016: no target in the event (absent target) does not match", () => {
      const owner = unitAt("OWNER", "ALLY", "BACK", "LEFT");
      expect(
        evaluateTriggerCondition(
          inFrontOfTriggerTarget,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, getUnit: () => undefined },
        ),
      ).toBe(false);
    });

    it("UT-R-PS-01-017: a defeated target does not match, even at the correct coordinate", () => {
      const owner = unitAt("OWNER", "ALLY", "BACK", "LEFT");
      const defeatedTarget = unitAt("TARGET", "ALLY", "FRONT", "LEFT", { currentHp: 0 });
      const getUnit = (id: BattleUnitId): BattleUnit | undefined =>
        [owner, defeatedTarget].find((u) => u.battleUnitId === id);
      expect(
        evaluateTriggerCondition(
          inFrontOfTriggerTarget,
          { payload: {}, targetUnitIds: [defeatedTarget.battleUnitId] },
          { owner, skillDefinitionId: SKILL_ID, getUnit },
        ),
      ).toBe(false);
    });

    it("UT-R-PS-01-018: a targetUnitId that no longer resolves to a unit does not match", () => {
      const owner = unitAt("OWNER", "ALLY", "BACK", "LEFT");
      expect(
        evaluateTriggerCondition(
          inFrontOfTriggerTarget,
          { payload: {}, targetUnitIds: [createBattleUnitId("GONE")] },
          { owner, skillDefinitionId: SKILL_ID, getUnit: () => undefined },
        ),
      ).toBe(false);
    });

    it("UT-R-PS-01-019: matches if any of multiple targetUnitIds satisfies the relation", () => {
      const owner = unitAt("OWNER", "ALLY", "BACK", "LEFT");
      const wrongColumn = unitAt("WRONG", "ALLY", "FRONT", "CENTER");
      const inFront = unitAt("RIGHT_ONE", "ALLY", "FRONT", "LEFT");
      const getUnit = (id: BattleUnitId): BattleUnit | undefined =>
        [owner, wrongColumn, inFront].find((u) => u.battleUnitId === id);
      expect(
        evaluateTriggerCondition(
          inFrontOfTriggerTarget,
          { payload: {}, targetUnitIds: [wrongColumn.battleUnitId, inFront.battleUnitId] },
          { owner, skillDefinitionId: SKILL_ID, getUnit },
        ),
      ).toBe(true);
    });

    it("UT-R-PS-01-020: throws when no getUnit lookup is supplied in context", () => {
      const owner = unitAt("OWNER", "ALLY", "BACK", "LEFT");
      expect(() =>
        evaluateTriggerCondition(
          inFrontOfTriggerTarget,
          { payload: {}, targetUnitIds: [createBattleUnitId("TARGET")] },
          { owner, skillDefinitionId: SKILL_ID },
        ),
      ).toThrow(DomainValidationError);
    });

    it("UT-R-PS-01-021: throws when context itself is missing", () => {
      expect(() =>
        evaluateTriggerCondition(inFrontOfTriggerTarget, {
          payload: {},
          targetUnitIds: [createBattleUnitId("TARGET")],
        }),
      ).toThrow(DomainValidationError);
    });
  });

  describe("RESOLUTION_PHASE (Issue #144, TRIGGER_EXCLUSION_TIMING)", () => {
    const owner = ownerWithCounter();

    it("UT-R-PS-01-022: matches (negate: false) when resolutionPhase equals the declared phase", () => {
      const condition: ConditionDefinition = {
        kind: "RESOLUTION_PHASE",
        phase: "TURN_START",
        negate: false,
      };
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, resolutionPhase: "TURN_START" },
        ),
      ).toBe(true);
    });

    it("UT-R-PS-01-023: does not match (negate: false) when resolutionPhase differs from the declared phase", () => {
      const condition: ConditionDefinition = {
        kind: "RESOLUTION_PHASE",
        phase: "TURN_START",
        negate: false,
      };
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, resolutionPhase: "TURN_END" },
        ),
      ).toBe(false);
    });

    it.each(["BATTLE_START", "TURN_START", "TURN_END"] as const)(
      "UT-R-PS-01-024: negate: true excludes the %s phase (TRIGGER_EXCLUSION_TIMING)",
      (phase) => {
        const condition: ConditionDefinition = { kind: "RESOLUTION_PHASE", phase, negate: true };
        expect(
          evaluateTriggerCondition(
            condition,
            { payload: {} },
            { owner, skillDefinitionId: SKILL_ID, resolutionPhase: phase },
          ),
        ).toBe(false);
      },
    );

    it("UT-R-PS-01-025: an AND of three negated RESOLUTION_PHASE conditions matches during normal action resolution (resolutionPhase undefined)", () => {
      const condition: ConditionDefinition = {
        kind: "AND",
        conditions: (["BATTLE_START", "TURN_START", "TURN_END"] as const).map((phase) => ({
          kind: "RESOLUTION_PHASE" as const,
          phase,
          negate: true,
        })),
      };
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID },
        ),
      ).toBe(true);
    });

    it("UT-R-PS-01-026: an AND of three negated RESOLUTION_PHASE conditions is excluded when resolutionPhase is one of them", () => {
      const condition: ConditionDefinition = {
        kind: "AND",
        conditions: (["BATTLE_START", "TURN_START", "TURN_END"] as const).map((phase) => ({
          kind: "RESOLUTION_PHASE" as const,
          phase,
          negate: true,
        })),
      };
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, resolutionPhase: "TURN_END" },
        ),
      ).toBe(false);
    });

    it("UT-R-PS-01-027: does not throw when context is entirely missing (defaults to normal/undefined phase)", () => {
      const condition: ConditionDefinition = {
        kind: "RESOLUTION_PHASE",
        phase: "BATTLE_START",
        negate: true,
      };
      expect(evaluateTriggerCondition(condition, { payload: {} })).toBe(true);
    });
  });

  describe("TARGET_STATE (レビュー修正 PR #209、EFF-003: production Catalogの ACT_HARRIET_SAGE_PS1_CONTINUOUS_HEAL が TARGET_STATE/SELF/IS_ALIVE を使用)", () => {
    it("UT-R-PS-01-028: IS_ALIVE/SELF matches the owner's own alive state", () => {
      const owner = unitAt("OWNER", "ALLY", "FRONT", "LEFT");
      const condition: ConditionDefinition = {
        kind: "TARGET_STATE",
        target: { kind: "SELF" },
        field: "IS_ALIVE",
        op: "EQ",
        value: true,
      };
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, getUnit: () => owner },
        ),
      ).toBe(true);
    });

    it("UT-R-PS-01-029: IS_ALIVE/SELF reflects a defeated owner", () => {
      const owner = unitAt("OWNER", "ALLY", "FRONT", "LEFT", { currentHp: 0 });
      const condition: ConditionDefinition = {
        kind: "TARGET_STATE",
        target: { kind: "SELF" },
        field: "IS_ALIVE",
        op: "EQ",
        value: false,
      };
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, getUnit: () => owner },
        ),
      ).toBe(true);
    });

    it("UT-R-PS-01-030: HP_RATIO/TRIGGER_TARGET compares the resolved target's current/maximum HP ratio", () => {
      const owner = unitAt("OWNER", "ALLY", "FRONT", "LEFT");
      const target = unitAt("TARGET", "ENEMY", "FRONT", "LEFT", { currentHp: 30 });
      const condition: ConditionDefinition = {
        kind: "TARGET_STATE",
        target: { kind: "TRIGGER_TARGET" },
        field: "HP_RATIO",
        op: "LTE",
        value: 0.3,
      };
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {}, targetUnitIds: [target.battleUnitId] },
          {
            owner,
            skillDefinitionId: SKILL_ID,
            getUnit: (id) => (id === target.battleUnitId ? target : undefined),
          },
        ),
      ).toBe(true);
    });

    it("UT-R-PS-01-031: ATTRIBUTE/POSITION_ROW/POSITION_COLUMN/RESOURCE_* resolve from the target's own BattleUnit fields", () => {
      const owner = unitAt("OWNER", "ALLY", "BACK", "RIGHT", {
        attribute: "SHY",
        currentAp: 2,
        currentPp: 1,
        currentExtraGauge: 40,
      });
      const context = { owner, skillDefinitionId: SKILL_ID, getUnit: () => owner };
      const check = (
        field:
          | "ATTRIBUTE"
          | "POSITION_ROW"
          | "POSITION_COLUMN"
          | "RESOURCE_AP"
          | "RESOURCE_PP"
          | "RESOURCE_EX_GAUGE",
        value: string | number,
      ): boolean =>
        evaluateTriggerCondition(
          { kind: "TARGET_STATE", target: { kind: "SELF" }, field, op: "EQ", value },
          { payload: {} },
          context,
        );

      expect(check("ATTRIBUTE", "SHY")).toBe(true);
      expect(check("POSITION_ROW", "BACK")).toBe(true);
      expect(check("POSITION_COLUMN", "RIGHT")).toBe(true);
      expect(check("RESOURCE_AP", 2)).toBe(true);
      expect(check("RESOURCE_PP", 1)).toBe(true);
      expect(check("RESOURCE_EX_GAUGE", 40)).toBe(true);
    });

    it("UT-R-PS-01-032: throws when no context with getUnit is supplied", () => {
      const condition: ConditionDefinition = {
        kind: "TARGET_STATE",
        target: { kind: "SELF" },
        field: "IS_ALIVE",
        op: "EQ",
        value: true,
      };
      expect(() => evaluateTriggerCondition(condition, { payload: {} })).toThrow(
        DomainValidationError,
      );
    });

    it("UT-R-PS-01-033: resolving to an unknown/absent target does not match", () => {
      const owner = unitAt("OWNER", "ALLY", "FRONT", "LEFT");
      const condition: ConditionDefinition = {
        kind: "TARGET_STATE",
        target: { kind: "TRIGGER_TARGET" },
        field: "IS_ALIVE",
        op: "EQ",
        value: true,
      };
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, getUnit: () => undefined },
        ),
      ).toBe(false);
    });

    it("UT-R-PS-01-059 (M7-001E、Issue #248): HAS_STATUS matches the statuses the resolved target currently holds, without needing a UnitDefinition lookup", () => {
      const stunned = unitAt("OWNER", "ALLY", "FRONT", "LEFT", {
        appliedEffects: [{ ...effect("e1", ["DEBUFF", "STATUS"]), statusKind: "STUN" }],
      });
      const clean = unitAt("OWNER", "ALLY", "FRONT", "LEFT");
      const condition: ConditionDefinition = {
        kind: "TARGET_STATE",
        target: { kind: "SELF" },
        field: "HAS_STATUS",
        op: "EQ",
        value: "STUN",
      };
      const check = (owner: BattleUnit): boolean =>
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, getUnit: () => owner },
        );

      expect(check(stunned)).toBe(true);
      expect(check(clean)).toBe(false);
    });

    it("UT-R-PS-01-055 (M7-001E、Issue #248、CAP_TARGET_STATE_EXTENDED_FIELD): UNIT_TYPE and ROLE resolve from the unitDefinitions the caller threads through, and throw without them", () => {
      const unitDefinitionId = createUnitDefinitionId("UNIT_A");
      const unitDefinitions = new Map<typeof unitDefinitionId, UnitDefinition>([
        [
          unitDefinitionId,
          { unitDefinitionId, unitType: "AGILE", role: "CONTROL" } as UnitDefinition,
        ],
      ]);
      const owner = unitAt("OWNER", "ALLY", "FRONT", "LEFT");
      const conditionFor = (field: "UNIT_TYPE" | "ROLE", value: string): ConditionDefinition => ({
        kind: "TARGET_STATE",
        target: { kind: "SELF" },
        field,
        op: "EQ",
        value,
      });
      const base = { owner, skillDefinitionId: SKILL_ID, getUnit: () => owner };

      expect(
        evaluateTriggerCondition(
          conditionFor("UNIT_TYPE", "AGILE"),
          { payload: {} },
          {
            ...base,
            unitDefinitions,
          },
        ),
      ).toBe(true);
      expect(
        evaluateTriggerCondition(
          conditionFor("UNIT_TYPE", "PHYSICAL"),
          { payload: {} },
          {
            ...base,
            unitDefinitions,
          },
        ),
      ).toBe(false);
      expect(
        evaluateTriggerCondition(
          conditionFor("ROLE", "CONTROL"),
          { payload: {} },
          {
            ...base,
            unitDefinitions,
          },
        ),
      ).toBe(true);
      // 呼び出し側が`unitDefinitions`を渡さない場合は、黙ってfalseにせず例外で隔離する。
      expect(() =>
        evaluateTriggerCondition(conditionFor("UNIT_TYPE", "AGILE"), { payload: {} }, base),
      ).toThrow(DomainValidationError);
    });
  });

  /**
   * M7-001E（Issue #248、`CAP_TARGET_EFFECT_QUERY`）: PS trigger／AS・PSの
   * `activationCondition`／R-EFF-08の`expiration.conditions`も、ACTION step条件と
   * 同じ`TARGET_HAS_EFFECT`契約で対象の保持効果を照会できる。
   */
  describe("TARGET_HAS_EFFECT (CAP_TARGET_EFFECT_QUERY, Issue #248 M7-001E)", () => {
    const hasBuff: ConditionDefinition = {
      kind: "TARGET_HAS_EFFECT",
      target: { kind: "TRIGGER_TARGET" },
      categories: ["BUFF"],
    };

    it("UT-R-PS-01-056: matches when the resolved trigger target holds an effect of the queried category", () => {
      const buffed = unitAt("TARGET", "ENEMY", "FRONT", "LEFT", {
        appliedEffects: [effect("e1", ["BUFF"], 0.2)],
      });
      const debuffed = unitAt("TARGET", "ENEMY", "FRONT", "LEFT", {
        appliedEffects: [effect("e2", ["DEBUFF"])],
      });
      const check = (target: BattleUnit): boolean =>
        evaluateTriggerCondition(
          hasBuff,
          { payload: {}, targetUnitIds: [target.battleUnitId] },
          { owner: target, skillDefinitionId: SKILL_ID, getUnit: () => target },
        );

      expect(check(buffed)).toBe(true);
      expect(check(debuffed)).toBe(false);
    });

    it("UT-R-PS-01-057: resolving to no unit does not match, and no getUnit lookup throws (same isolation as TARGET_STATE)", () => {
      const owner = unitAt("OWNER", "ALLY", "FRONT", "LEFT");
      expect(
        evaluateTriggerCondition(
          hasBuff,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, getUnit: () => undefined },
        ),
      ).toBe(false);
      expect(() => evaluateTriggerCondition(hasBuff, { payload: {} })).toThrow(
        DomainValidationError,
      );
    });

    it("UT-R-LNK-03-020 (DMG-007, Issue #187): narrows by effectActionDefinitionIds and grantedBy: SELF, matching only the link this owner granted (SKL_DOROTHEA_PIONEER_PS2)", () => {
      const ownLink: ConditionDefinition = {
        kind: "TARGET_HAS_EFFECT",
        target: { kind: "TRIGGER_TARGET" },
        categories: ["DEBUFF"],
        effectActionDefinitionIds: [createEffectActionDefinitionId("ACT_LINK")],
        grantedBy: "SELF",
      };
      const owner = unitAt("OWNER", "ALLY", "FRONT", "LEFT");
      const linkFrom = (
        sourceId: string | undefined,
        definitionId = "ACT_LINK",
      ): AppliedEffect => ({
        ...effect("link", ["DEBUFF"]),
        effectActionDefinitionId: createEffectActionDefinitionId(definitionId),
        ...(sourceId === undefined ? {} : { sourceId: createBattleUnitId(sourceId) }),
        damageLink: { linkToUnitId: createBattleUnitId("PEER"), linkRate: 0.35 },
      });
      const check = (held: AppliedEffect): boolean => {
        const target = unitAt("TARGET", "ENEMY", "FRONT", "LEFT", { appliedEffects: [held] });
        return evaluateTriggerCondition(
          ownLink,
          { payload: {}, targetUnitIds: [target.battleUnitId] },
          { owner, skillDefinitionId: SKILL_ID, getUnit: () => target },
        );
      };

      expect(check(linkFrom("OWNER"))).toBe(true);
      // 別のユニットが付与した同じ定義のリンクは「自身が付与した」に当たらない。
      expect(check(linkFrom("SOMEONE_ELSE"))).toBe(false);
      // 自身が付与していても別定義のリンクは一致しない。
      expect(check(linkFrom("OWNER", "ACT_OTHER_LINK"))).toBe(false);
      // 付与者を持たない付与（Memory由来など）も一致しない。
      expect(check(linkFrom(undefined))).toBe(false);
    });

    it("UT-R-PS-01-058: narrows a DEBUFF query to burn, so a poisoned (but not burning) target does not match", () => {
      const burnQuery: ConditionDefinition = {
        kind: "TARGET_HAS_EFFECT",
        target: { kind: "SELF" },
        categories: ["DEBUFF"],
        continuousDamageKinds: ["BURN"],
      };
      const burning = unitAt("OWNER", "ALLY", "FRONT", "LEFT", {
        appliedEffects: [
          {
            ...effect("e1", ["DEBUFF"]),
            continuousDamage: { continuousDamageKind: "BURN", damageType: "PHYSICAL" },
          },
        ],
      });
      const poisoned = unitAt("OWNER", "ALLY", "FRONT", "LEFT", {
        appliedEffects: [
          {
            ...effect("e2", ["DEBUFF"]),
            continuousDamage: { continuousDamageKind: "POISON", damageType: "PHYSICAL" },
          },
        ],
      });
      const check = (owner: BattleUnit): boolean =>
        evaluateTriggerCondition(
          burnQuery,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, getUnit: () => owner },
        );

      expect(check(burning)).toBe(true);
      expect(check(poisoned)).toBe(false);
    });
  });

  describe("TARGET_HAS_MARKER (RES-004, Issue #171: CAP_PASSIVE_ACTIVATION_CONDITION)", () => {
    it("UT-R-PS-01-039: matches when the resolved target has any stack of the marker", () => {
      const owner = unitAt("OWNER", "ALLY", "FRONT", "LEFT", {
        markerStates: [marker(unitAt("OWNER", "ALLY", "FRONT", "LEFT"), "MARKER_STOIC", 1)],
      });
      const condition: ConditionDefinition = {
        kind: "TARGET_HAS_MARKER",
        target: { kind: "SELF" },
        markerId: createMarkerId("MARKER_STOIC"),
      };
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, getUnit: () => owner },
        ),
      ).toBe(true);
    });

    it("UT-R-PS-01-040: does not match when the resolved target lacks the marker entirely", () => {
      const owner = unitAt("OWNER", "ALLY", "FRONT", "LEFT", { markerStates: [] });
      const condition: ConditionDefinition = {
        kind: "TARGET_HAS_MARKER",
        target: { kind: "SELF" },
        markerId: createMarkerId("MARKER_STOIC"),
      };
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, getUnit: () => owner },
        ),
      ).toBe(false);
    });

    it("UT-R-PS-01-041: does not match a different markerId held by the same target", () => {
      const self = unitAt("OWNER", "ALLY", "FRONT", "LEFT");
      const owner = { ...self, markerStates: [marker(self, "MARKER_OTHER", 1)] };
      const condition: ConditionDefinition = {
        kind: "TARGET_HAS_MARKER",
        target: { kind: "SELF" },
        markerId: createMarkerId("MARKER_STOIC"),
      };
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, getUnit: () => owner },
        ),
      ).toBe(false);
    });

    it("UT-R-PS-01-042: countCondition compares the marker's stackCount instead of only checking presence", () => {
      const self = unitAt("OWNER", "ALLY", "FRONT", "LEFT");
      const owner = { ...self, markerStates: [marker(self, "MARKER_KYOCHO", 2)] };
      const condition: ConditionDefinition = {
        kind: "TARGET_HAS_MARKER",
        target: { kind: "SELF" },
        markerId: createMarkerId("MARKER_KYOCHO"),
        countCondition: { op: "GTE", value: 2 },
      };
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, getUnit: () => owner },
        ),
      ).toBe(true);
      const belowThreshold = {
        ...self,
        markerStates: [marker(self, "MARKER_KYOCHO", 1)],
      };
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner: belowThreshold, skillDefinitionId: SKILL_ID, getUnit: () => belowThreshold },
        ),
      ).toBe(false);
    });

    it("UT-R-PS-01-043: an absent marker is false with countCondition regardless of op/value (presence gates first)", () => {
      const owner = unitAt("OWNER", "ALLY", "FRONT", "LEFT", { markerStates: [] });
      const gteOne: ConditionDefinition = {
        kind: "TARGET_HAS_MARKER",
        target: { kind: "SELF" },
        markerId: createMarkerId("MARKER_KYOCHO"),
        countCondition: { op: "GTE", value: 1 },
      };
      expect(
        evaluateTriggerCondition(
          gteOne,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, getUnit: () => owner },
        ),
      ).toBe(false);
    });

    it("UT-R-PS-01-043b (review [P2]): an absent marker stays false even for countCondition operators that a stackCount of 0 would satisfy (EQ 0, LTE 1)", () => {
      const owner = unitAt("OWNER", "ALLY", "FRONT", "LEFT", { markerStates: [] });
      const eqZero: ConditionDefinition = {
        kind: "TARGET_HAS_MARKER",
        target: { kind: "SELF" },
        markerId: createMarkerId("MARKER_KYOCHO"),
        countCondition: { op: "EQ", value: 0 },
      };
      const lteOne: ConditionDefinition = {
        kind: "TARGET_HAS_MARKER",
        target: { kind: "SELF" },
        markerId: createMarkerId("MARKER_KYOCHO"),
        countCondition: { op: "LTE", value: 1 },
      };
      expect(
        evaluateTriggerCondition(
          eqZero,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, getUnit: () => owner },
        ),
      ).toBe(false);
      expect(
        evaluateTriggerCondition(
          lteOne,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, getUnit: () => owner },
        ),
      ).toBe(false);
    });

    it("UT-R-PS-01-044: throws when no context with getUnit is supplied", () => {
      const condition: ConditionDefinition = {
        kind: "TARGET_HAS_MARKER",
        target: { kind: "SELF" },
        markerId: createMarkerId("MARKER_STOIC"),
      };
      expect(() => evaluateTriggerCondition(condition, { payload: {} })).toThrow(
        DomainValidationError,
      );
    });
  });

  describe("ALIVE_UNIT_COUNT (RES-004, Issue #171, G-03/Issue #44)", () => {
    it("UT-R-PS-01-045: counts alive units on the owner's relative ALLY side, excludeSelf true", () => {
      const owner = unitAt("OWNER", "ALLY", "FRONT", "LEFT");
      const ally = unitAt("ALLY_1", "ALLY", "FRONT", "CENTER");
      const enemy = unitAt("ENEMY_1", "ENEMY", "FRONT", "LEFT");
      const condition: ConditionDefinition = {
        kind: "ALIVE_UNIT_COUNT",
        side: "ALLY",
        excludeSelf: true,
        op: "GT",
        value: 0,
      };
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, units: [owner, ally, enemy] },
        ),
      ).toBe(true);
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, units: [owner, enemy] },
        ),
      ).toBe(false);
    });

    it("UT-R-PS-01-046: excludeSelf false counts the owner itself among ALLY", () => {
      const owner = unitAt("OWNER", "ALLY", "FRONT", "LEFT");
      const condition: ConditionDefinition = {
        kind: "ALIVE_UNIT_COUNT",
        side: "ALLY",
        excludeSelf: false,
        op: "GT",
        value: 0,
      };
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, units: [owner] },
        ),
      ).toBe(true);
    });

    it("UT-R-PS-01-047: excludes defeated units from the count", () => {
      const owner = unitAt("OWNER", "ALLY", "FRONT", "LEFT");
      const defeatedAlly = unitAt("ALLY_1", "ALLY", "FRONT", "CENTER", { currentHp: 0 });
      const condition: ConditionDefinition = {
        kind: "ALIVE_UNIT_COUNT",
        side: "ALLY",
        excludeSelf: true,
        op: "GT",
        value: 0,
      };
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, units: [owner, defeatedAlly] },
        ),
      ).toBe(false);
    });

    it("UT-R-PS-01-048: side is relative to the owner (ENEMY counts the opposite side of the owner)", () => {
      const owner = unitAt("OWNER", "ALLY", "FRONT", "LEFT");
      const enemy = unitAt("ENEMY_1", "ENEMY", "FRONT", "LEFT");
      const condition: ConditionDefinition = {
        kind: "ALIVE_UNIT_COUNT",
        side: "ENEMY",
        excludeSelf: false,
        op: "EQ",
        value: 1,
      };
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, units: [owner, enemy] },
        ),
      ).toBe(true);
    });

    it("UT-R-PS-01-049: throws when no context with units is supplied", () => {
      const owner = unitAt("OWNER", "ALLY", "FRONT", "LEFT");
      const condition: ConditionDefinition = {
        kind: "ALIVE_UNIT_COUNT",
        side: "ALLY",
        excludeSelf: false,
        op: "GT",
        value: 0,
      };
      expect(() =>
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID },
        ),
      ).toThrow(DomainValidationError);
    });
  });

  describe("TURN_NUMBER (RES-004, Issue #171)", () => {
    it("UT-R-PS-01-050: compares context.turnNumber with op/value", () => {
      const owner = ownerWithCounter();
      const condition: ConditionDefinition = { kind: "TURN_NUMBER", op: "NEQ", value: 1 };
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, turnNumber: 1 },
        ),
      ).toBe(false);
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, turnNumber: 2 },
        ),
      ).toBe(true);
    });

    it("UT-R-PS-01-051: modulo compares (turnNumber mod modulo) against op/value (every 2nd turn)", () => {
      const owner = ownerWithCounter();
      const condition: ConditionDefinition = {
        kind: "TURN_NUMBER",
        op: "EQ",
        value: 0,
        modulo: 2,
      };
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, turnNumber: 2 },
        ),
      ).toBe(true);
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, turnNumber: 3 },
        ),
      ).toBe(false);
      expect(
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID, turnNumber: 4 },
        ),
      ).toBe(true);
    });

    it("UT-R-PS-01-052: throws when no context with turnNumber is supplied", () => {
      const owner = ownerWithCounter();
      const condition: ConditionDefinition = { kind: "TURN_NUMBER", op: "EQ", value: 1 };
      expect(() =>
        evaluateTriggerCondition(
          condition,
          { payload: {} },
          { owner, skillDefinitionId: SKILL_ID },
        ),
      ).toThrow(DomainValidationError);
    });
  });
});
