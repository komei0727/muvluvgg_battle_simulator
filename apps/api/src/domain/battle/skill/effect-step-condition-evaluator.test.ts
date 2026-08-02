import { describe, expect, it } from "vitest";
import {
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
import { createEffectInstanceId, createMarkerInstanceId } from "../../shared/event-ids.js";
import type { TargetReference } from "../../catalog/definitions/references.js";
import type {
  ContinuousDamageKind,
  EffectImmunityCategory,
} from "../../catalog/definitions/catalog-enums.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import { effectCategoriesOf } from "../effects/effect-category-classifier.js";
import { createEffectActionDefinition } from "../../catalog/definitions/effect-action-definition-factory.js";

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

/**
 * M7-001E（Issue #248）: `TARGET_HAS_EFFECT`/`HAS_STATUS`が読む最小の`AppliedEffect`。
 * `categories`は`grantEffect`が`effectCategoriesOf`から焼き込む値と同じ形で渡す。
 */
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
    targetId: createBattleUnitId("t1"),
    magnitude,
    categories,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}
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
      criticalHitCount: 0,
    };

    it("UT-R-SKL-08-021 (POST_DAMAGE_CRITICAL_BRANCH, DMG-003/Issue #196): compares criticalHitCount, which is 0 when the preceding ACTION step produced no critical hit", () => {
      const anyCritical: ConditionDefinition = {
        kind: "LAST_RESULT",
        field: "criticalHitCount",
        op: "GTE",
        value: 1,
      };
      expect(evaluateEffectStepCondition(anyCritical, damageResult)).toBe(false);
      expect(
        evaluateEffectStepCondition(anyCritical, { ...damageResult, criticalHitCount: 1 }),
      ).toBe(true);
      expect(
        evaluateEffectStepCondition(anyCritical, { ...damageResult, criticalHitCount: 3 }),
      ).toBe(true);
    });

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

  // UT-R-SKL-06-013/014/015（Issue #171）は`conditionReferencesStepTarget`
  // （`targetCondition`が自身のtargetを参照するかどうかを実行時に動的判定する
  // 分類器）を直接検証していたが、Issue #230でACTIONの`targetCondition`は
  // 常に自身の`target`だけを参照するとCatalogロード時点で保証されるように
  // なり、この動的判定自体が不要になったため関数ごと削除した。同等の不変
  // 条件は`effect-sequence.test.ts`の`UT-CAT-SEQ-034`/`038`（Catalog構築時に
  // 検証）が引き継ぐ。

  describe("conditionReferencesTargetSetCount (CAP_EFFECT_STEP_SET_CONDITION, Issue #227 RES-004集合条件)", () => {
    it("UT-R-SKL-06-032: detects a top-level TARGET_SET_COUNT and recurses through AND/OR/NOT", () => {
      const direct: ConditionDefinition = {
        kind: "TARGET_SET_COUNT",
        countOf: "ALIVE",
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
            { sourceId: createBattleUnitId("actor") },
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
              { sourceId: createBattleUnitId("actor") },
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
            { sourceId: createBattleUnitId("actor") },
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

  describe("BRANCH step-wide TARGET_STATE/TARGET_HAS_MARKER via resolveTargetSet, no EffectStepTargetContext (CAP_EFFECT_STEP_CONDITION_SCOPE, Issue #230 PRレビュー[P1])", () => {
    const physicalDefinitionId = createUnitDefinitionId("UNIT_PHYSICAL");
    const unitDefinitions = new Map<typeof physicalDefinitionId, UnitDefinition>([
      [
        physicalDefinitionId,
        { unitDefinitionId: physicalDefinitionId, unitType: "PHYSICAL" } as UnitDefinition,
      ],
    ]);

    it("UT-R-SKL-06-044: TARGET_STATE evaluates the single unit resolveTargetSet resolves, when no EffectStepTargetContext is given (BRANCH scope)", () => {
      const enemy = unit("enemy", "UNIT_PHYSICAL");
      const condition: ConditionDefinition = {
        kind: "TARGET_STATE",
        target: STEP_TARGET,
        field: "UNIT_TYPE",
        op: "EQ",
        value: "PHYSICAL",
      };
      expect(
        evaluateEffectStepCondition(
          condition,
          undefined,
          undefined,
          () => [enemy],
          unitDefinitions,
        ),
      ).toBe(true);
      expect(
        evaluateEffectStepCondition(
          { ...condition, value: "ENERGY" },
          undefined,
          undefined,
          () => [enemy],
          unitDefinitions,
        ),
      ).toBe(false);
    });

    it("UT-R-SKL-06-045: TARGET_STATE is false when resolveTargetSet resolves zero units (BRANCH scope)", () => {
      const condition: ConditionDefinition = {
        kind: "TARGET_STATE",
        target: STEP_TARGET,
        field: "IS_ALIVE",
        op: "EQ",
        value: true,
      };
      expect(evaluateEffectStepCondition(condition, undefined, undefined, () => [])).toBe(false);
    });

    it("UT-R-SKL-06-046: TARGET_STATE throws when resolveTargetSet resolves more than one unit (BRANCH has no per-target context to quantify over multiple units; Catalog preflight should already guarantee at most one)", () => {
      const enemyA = unit("enemy-a", "UNIT_PHYSICAL");
      const enemyB = unit("enemy-b", "UNIT_PHYSICAL");
      const condition: ConditionDefinition = {
        kind: "TARGET_STATE",
        target: STEP_TARGET,
        field: "IS_ALIVE",
        op: "EQ",
        value: true,
      };
      expect(() =>
        evaluateEffectStepCondition(condition, undefined, undefined, () => [enemyA, enemyB]),
      ).toThrow(DomainValidationError);
    });

    it("UT-R-SKL-06-047: TARGET_HAS_MARKER evaluates the single unit resolveTargetSet resolves, including countCondition, when no EffectStepTargetContext is given (BRANCH scope)", () => {
      const markerId = createMarkerId("MARKER_CURSE");
      const marked = unit("enemy", "UNIT_PHYSICAL", {
        markerStates: [
          {
            ...buildInitialMarkerState(
              createMarkerInstanceId("mi-1"),
              markerId,
              { sourceId: createBattleUnitId("actor") },
              createBattleUnitId("enemy"),
              null,
              {
                dispellable: true,
                linkedEffectGroupId: null,
                timeLimit: { unit: "BATTLE", count: 1 },
              },
              { turnNumber: 1 },
            ),
            stackCount: 4,
          },
        ],
      });
      const condition: ConditionDefinition = {
        kind: "TARGET_HAS_MARKER",
        target: STEP_TARGET,
        markerId,
        countCondition: { op: "GTE", value: 4 },
      };
      expect(evaluateEffectStepCondition(condition, undefined, undefined, () => [marked])).toBe(
        true,
      );
      expect(
        evaluateEffectStepCondition(
          { ...condition, countCondition: { op: "GTE", value: 5 } },
          undefined,
          undefined,
          () => [marked],
        ),
      ).toBe(false);
      const unmarked = unit("enemy-2", "UNIT_PHYSICAL");
      expect(evaluateEffectStepCondition(condition, undefined, undefined, () => [unmarked])).toBe(
        false,
      );
    });

    it("UT-R-SKL-06-048: TARGET_HAS_MARKER throws when resolveTargetSet resolves more than one unit (BRANCH scope)", () => {
      const enemyA = unit("enemy-a", "UNIT_PHYSICAL");
      const enemyB = unit("enemy-b", "UNIT_PHYSICAL");
      const condition: ConditionDefinition = {
        kind: "TARGET_HAS_MARKER",
        target: STEP_TARGET,
        markerId: createMarkerId("MARKER_CURSE"),
      };
      expect(() =>
        evaluateEffectStepCondition(condition, undefined, undefined, () => [enemyA, enemyB]),
      ).toThrow(DomainValidationError);
    });
  });

  describe("TARGET_SET_COUNT（CAP_EFFECT_STEP_SET_CONDITION、Issue #227 RES-004集合条件）", () => {
    it("UT-R-SKL-06-025: without a resolveTargetSet resolver throws", () => {
      const condition: ConditionDefinition = {
        kind: "TARGET_SET_COUNT",
        countOf: "ALIVE",
        target: OTHER_BINDING,
        op: "GTE",
        value: 1,
      };
      expect(() => evaluateEffectStepCondition(condition)).toThrow(DomainValidationError);
    });

    it("UT-R-SKL-06-026: EXISTS-style (op GTE, value 1) is false when the resolved set is empty", () => {
      const condition: ConditionDefinition = {
        kind: "TARGET_SET_COUNT",
        countOf: "ALIVE",
        target: OTHER_BINDING,
        op: "GTE",
        value: 1,
      };
      expect(evaluateEffectStepCondition(condition, undefined, undefined, () => [])).toBe(false);
    });

    it("UT-R-SKL-06-027: NONE-style (op LT, value 1) is true when the resolved set is empty", () => {
      const condition: ConditionDefinition = {
        kind: "TARGET_SET_COUNT",
        countOf: "ALIVE",
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
        countOf: "ALIVE",
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
        countOf: "ALIVE",
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

    it("UT-R-SKL-06-069 (POST_DAMAGE_SURVIVAL_BRANCH, DMG-003/Issue #196): countOf DEFEATED counts the defeated members instead of the surviving ones", () => {
      const alive = unit("ENEMY_A", "UNIT_A");
      const defeated = unit("ENEMY_B", "UNIT_A", { currentHp: 0 });
      const anyDefeated: ConditionDefinition = {
        kind: "TARGET_SET_COUNT",
        target: OTHER_BINDING,
        countOf: "DEFEATED",
        op: "GTE",
        value: 1,
      };
      // 全員生存 → 0件、1体でも撃破 → 成立（「この攻撃で敵を倒した場合」）。
      expect(evaluateEffectStepCondition(anyDefeated, undefined, undefined, () => [alive])).toBe(
        false,
      );
      expect(
        evaluateEffectStepCondition(anyDefeated, undefined, undefined, () => [alive, defeated]),
      ).toBe(true);
      // 空集合はどちらの数え方でも0件。
      expect(evaluateEffectStepCondition(anyDefeated, undefined, undefined, () => [])).toBe(false);
    });

    it("UT-R-SKL-06-070 (DMG-003/Issue #196): countOf ALIVE is the default and keeps the pre-existing surviving-member semantics", () => {
      const alive = unit("ENEMY_A", "UNIT_A");
      const defeated = unit("ENEMY_B", "UNIT_A", { currentHp: 0 });
      const explicitAlive: ConditionDefinition = {
        kind: "TARGET_SET_COUNT",
        target: OTHER_BINDING,
        countOf: "ALIVE",
        op: "GTE",
        value: 1,
      };
      expect(
        evaluateEffectStepCondition(explicitAlive, undefined, undefined, () => [defeated]),
      ).toBe(false);
      expect(
        evaluateEffectStepCondition(explicitAlive, undefined, undefined, () => [alive, defeated]),
      ).toBe(true);
    });

    it("UT-R-SKL-06-030: recurses through AND/OR/NOT and passes the resolveTargetSet resolver down", () => {
      const enemyA = unit("ENEMY_A", "UNIT_A");
      const condition: ConditionDefinition = {
        kind: "AND",
        conditions: [
          {
            kind: "TARGET_SET_COUNT",
            target: OTHER_BINDING,
            countOf: "ALIVE",
            op: "GTE",
            value: 1,
          },
          {
            kind: "NOT",
            condition: {
              kind: "TARGET_SET_COUNT",
              target: OTHER_BINDING,
              countOf: "ALIVE",
              op: "GTE",
              value: 2,
            },
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
          {
            kind: "TARGET_SET_COUNT",
            target: OTHER_BINDING,
            countOf: "ALIVE",
            op: "GTE",
            value: 1,
          },
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

  describe("EVENT_PAYLOAD (CAP_TRIGGER_PAYLOAD_IN_RESOLUTION, Issue #247 M7-001D)", () => {
    it("UT-R-SKL-06-052: compares a field of the triggering event's payload passed by the caller", () => {
      const condition: ConditionDefinition = {
        kind: "EVENT_PAYLOAD",
        field: "calculatedDamage",
        op: "LTE",
        value: 10,
      };
      expect(
        evaluateEffectStepCondition(condition, undefined, undefined, undefined, undefined, {
          calculatedDamage: 10,
        }),
      ).toBe(true);
      expect(
        evaluateEffectStepCondition(condition, undefined, undefined, undefined, undefined, {
          calculatedDamage: 11,
        }),
      ).toBe(false);
    });

    it("UT-R-SKL-06-053: without a triggerEventPayload throws (Catalog-authoring error: no triggering event in this scope, e.g. an AS/EX active skill)", () => {
      const condition: ConditionDefinition = {
        kind: "EVENT_PAYLOAD",
        field: "calculatedDamage",
        op: "LTE",
        value: 10,
      };
      expect(() => evaluateEffectStepCondition(condition)).toThrow(DomainValidationError);
    });

    it("UT-R-SKL-06-054: recurses through AND/OR/NOT and threads triggerEventPayload down", () => {
      const condition: ConditionDefinition = {
        kind: "AND",
        conditions: [
          { kind: "EVENT_PAYLOAD", field: "calculatedDamage", op: "LTE", value: 10 },
          {
            kind: "NOT",
            condition: { kind: "EVENT_PAYLOAD", field: "calculatedDamage", op: "GT", value: 20 },
          },
        ],
      };
      expect(
        evaluateEffectStepCondition(condition, undefined, undefined, undefined, undefined, {
          calculatedDamage: 5,
        }),
      ).toBe(true);
    });

    it("UT-R-SKL-06-055 (PRレビュー[P2], Issue #249): evaluates inside a per-target EffectStepTargetContext too (targetCondition scope) — the same triggerEventPayload applies uniformly to every candidate, combined with a per-target TARGET_STATE via AND", () => {
      const enemyAlive = unit("ENEMY_A", "UNIT_A");
      const enemyDead = unit("ENEMY_B", "UNIT_B", { currentHp: 0 });
      const condition: ConditionDefinition = {
        kind: "AND",
        conditions: [
          { kind: "TARGET_STATE", target: STEP_TARGET, field: "IS_ALIVE", op: "EQ", value: true },
          { kind: "EVENT_PAYLOAD", field: "calculatedDamage", op: "LTE", value: 10 },
        ],
      };
      const ctxFor = (current: BattleUnit): EffectStepTargetContext => ({
        stepTarget: STEP_TARGET,
        current,
        resolveOtherReference: () => [],
        unitDefinitions: new Map(),
      });

      expect(
        evaluateEffectStepCondition(
          condition,
          undefined,
          ctxFor(enemyAlive),
          undefined,
          undefined,
          { calculatedDamage: 5 },
        ),
      ).toBe(true);
      // Same alive target, but the triggering event's damage exceeds the threshold.
      expect(
        evaluateEffectStepCondition(
          condition,
          undefined,
          ctxFor(enemyAlive),
          undefined,
          undefined,
          { calculatedDamage: 11 },
        ),
      ).toBe(false);
      // Damage within threshold, but this particular target is already dead.
      expect(
        evaluateEffectStepCondition(condition, undefined, ctxFor(enemyDead), undefined, undefined, {
          calculatedDamage: 5,
        }),
      ).toBe(false);
    });
  });

  /**
   * M7-001E（Issue #248、`TARGET_STATE_QUERY_BUFF_DEBUFF`、`CAP_TARGET_EFFECT_QUERY`）:
   * 「対象が何らかのバフ／デバフ／状態異常を保持しているか」「対象が毒／炎上か」
   * 「対象の攻撃力にデバフがかかっているか」を、評価時点の最新`BattleUnit`が持つ
   * `AppliedEffect.categories`（付与時に`effectCategoriesOf`が確定した分類）から判定する。
   */
  describe("TARGET_HAS_EFFECT (CAP_TARGET_EFFECT_QUERY, Issue #248 M7-001E)", () => {
    function contextFor(current: BattleUnit): EffectStepTargetContext {
      return {
        stepTarget: STEP_TARGET,
        current,
        resolveOtherReference: () => [],
        unitDefinitions: new Map(),
      };
    }

    const HAS_DEBUFF: ConditionDefinition = {
      kind: "TARGET_HAS_EFFECT",
      target: STEP_TARGET,
      categories: ["DEBUFF"],
    };

    it("UT-R-SKL-06-056: matches a target holding an effect classified in one of the queried categories, and not one holding only other categories", () => {
      const debuffed = unit("t1", "UNIT_A", { appliedEffects: [effect("e1", ["DEBUFF"])] });
      const buffed = unit("t2", "UNIT_A", { appliedEffects: [effect("e2", ["BUFF"])] });
      const clean = unit("t3", "UNIT_A");

      expect(evaluateEffectStepCondition(HAS_DEBUFF, undefined, contextFor(debuffed))).toBe(true);
      expect(evaluateEffectStepCondition(HAS_DEBUFF, undefined, contextFor(buffed))).toBe(false);
      expect(evaluateEffectStepCondition(HAS_DEBUFF, undefined, contextFor(clean))).toBe(false);
    });

    it("UT-R-SKL-06-057 (R-STS-01): a status ailment matches both a STATUS query and a DEBUFF query, because effectCategoriesOf classifies it as both", () => {
      const stunned = unit("t1", "UNIT_A", {
        appliedEffects: [{ ...effect("e1", ["DEBUFF", "STATUS"]), statusKind: "STUN" }],
      });
      const hasStatus: ConditionDefinition = {
        kind: "TARGET_HAS_EFFECT",
        target: STEP_TARGET,
        categories: ["STATUS"],
      };

      expect(evaluateEffectStepCondition(hasStatus, undefined, contextFor(stunned))).toBe(true);
      expect(evaluateEffectStepCondition(HAS_DEBUFF, undefined, contextFor(stunned))).toBe(true);
    });

    it("UT-R-SKL-06-058: continuousDamageKinds narrows a DEBUFF query to poison, so a burning (but not poisoned) target does not match", () => {
      const poisonQuery: ConditionDefinition = {
        kind: "TARGET_HAS_EFFECT",
        target: STEP_TARGET,
        categories: ["DEBUFF"],
        continuousDamageKinds: ["POISON"],
      };
      const poisoned = unit("t1", "UNIT_A", {
        appliedEffects: [
          {
            ...effect("e1", ["DEBUFF"]),
            continuousDamage: { continuousDamageKind: "POISON", damageType: "PHYSICAL" },
          },
        ],
      });
      const burning = unit("t2", "UNIT_A", {
        appliedEffects: [
          {
            ...effect("e2", ["DEBUFF"]),
            continuousDamage: { continuousDamageKind: "BURN", damageType: "PHYSICAL" },
          },
        ],
      });
      // 継続ダメージでない一般のデバフも、絞り込みがある限り一致しない。
      const statDebuffed = unit("t3", "UNIT_A", { appliedEffects: [effect("e3", ["DEBUFF"])] });

      expect(evaluateEffectStepCondition(poisonQuery, undefined, contextFor(poisoned))).toBe(true);
      expect(evaluateEffectStepCondition(poisonQuery, undefined, contextFor(burning))).toBe(false);
      expect(evaluateEffectStepCondition(poisonQuery, undefined, contextFor(statDebuffed))).toBe(
        false,
      );
    });

    it("UT-R-SKL-06-059: statKinds narrows a DEBUFF query to the attack stat, so a defense-only debuff does not match", () => {
      const attackDebuffQuery: ConditionDefinition = {
        kind: "TARGET_HAS_EFFECT",
        target: STEP_TARGET,
        categories: ["DEBUFF"],
        statKinds: ["ATTACK"],
      };
      const attackDown = unit("t1", "UNIT_A", {
        appliedEffects: [{ ...effect("e1", ["DEBUFF"]), statModStat: "ATTACK" }],
      });
      const defenseDown = unit("t2", "UNIT_A", {
        appliedEffects: [{ ...effect("e2", ["DEBUFF"]), statModStat: "DEFENSE" }],
      });
      // 攻撃力**バフ**は`categories`が一致しないため、statだけ合っても一致しない。
      const attackUp = unit("t3", "UNIT_A", {
        appliedEffects: [{ ...effect("e3", ["BUFF"], 0.2), statModStat: "ATTACK" }],
      });

      expect(
        evaluateEffectStepCondition(attackDebuffQuery, undefined, contextFor(attackDown)),
      ).toBe(true);
      expect(
        evaluateEffectStepCondition(attackDebuffQuery, undefined, contextFor(defenseDown)),
      ).toBe(false);
      expect(evaluateEffectStepCondition(attackDebuffQuery, undefined, contextFor(attackUp))).toBe(
        false,
      );
    });

    it("UT-R-SKL-06-060: evaluates per target, so a mixed target set yields a different verdict for each candidate", () => {
      const debuffed = unit("t1", "UNIT_A", { appliedEffects: [effect("e1", ["DEBUFF"])] });
      const clean = unit("t2", "UNIT_A");

      expect(
        [debuffed, clean].map((current) =>
          evaluateEffectStepCondition(HAS_DEBUFF, undefined, contextFor(current)),
        ),
      ).toEqual([true, false]);
    });

    it("UT-R-SKL-06-061: reads the latest state, so an effect removed since planning no longer matches", () => {
      const debuffed = unit("t1", "UNIT_A", { appliedEffects: [effect("e1", ["DEBUFF"])] });
      const cleansed = { ...debuffed, appliedEffects: [] };

      expect(evaluateEffectStepCondition(HAS_DEBUFF, undefined, contextFor(debuffed))).toBe(true);
      expect(evaluateEffectStepCondition(HAS_DEBUFF, undefined, contextFor(cleansed))).toBe(false);
    });

    it("UT-R-SKL-06-062: in step-wide (BRANCH) scope resolves 0..1 units via the TargetSetResolver, and throws beyond one", () => {
      const debuffed = unit("t1", "UNIT_A", { appliedEffects: [effect("e1", ["DEBUFF"])] });
      const clean = unit("t2", "UNIT_A");

      expect(evaluateEffectStepCondition(HAS_DEBUFF, undefined, undefined, () => [])).toBe(false);
      expect(evaluateEffectStepCondition(HAS_DEBUFF, undefined, undefined, () => [debuffed])).toBe(
        true,
      );
      expect(evaluateEffectStepCondition(HAS_DEBUFF, undefined, undefined, () => [clean])).toBe(
        false,
      );
      expect(() =>
        evaluateEffectStepCondition(HAS_DEBUFF, undefined, undefined, () => [debuffed, clean]),
      ).toThrow(DomainValidationError);
    });

    it("UT-R-SKL-06-063: without either an EffectStepTargetContext or a TargetSetResolver throws instead of silently returning false", () => {
      expect(() => evaluateEffectStepCondition(HAS_DEBUFF)).toThrow(DomainValidationError);
    });

    /**
     * RES-004-STATUS-CONDITION（Issue #224）: 「対象が状態異常にある場合」
     * （`SKL_CHIYURU_MAZE_EX`）をAOEの対象ごとに評価する。分類は手書きせず
     * `effectCategoriesOf`（唯一の分類元）に通した値をそのまま`AppliedEffect`へ
     * 載せることで、Catalog定義kind→分類→照会の経路全体を固定する。
     */
    it("UT-R-SKL-06-067 (RES-004-STATUS-CONDITION, Issue #224): a STATUS query matches poison and burn holders as well as APPLY_STATUS ailments, across a mixed AOE target set", () => {
      const hasStatusAilment: ConditionDefinition = {
        kind: "TARGET_HAS_EFFECT",
        target: STEP_TARGET,
        categories: ["STATUS"],
      };
      const continuousDamageEffect = (id: string, kind: ContinuousDamageKind): AppliedEffect => ({
        ...effect(id, [
          ...effectCategoriesOf(
            { magnitude: 100 },
            createEffectActionDefinition(
              {
                effectActionDefinitionId: `ACT_${id.toUpperCase()}`,
                kind: "APPLY_CONTINUOUS_DAMAGE",
                payload: {
                  continuousDamageKind: kind,
                  damageType: "PHYSICAL",
                  formula: { kind: "CONSTANT", value: 100 },
                  timing: { eventType: "ActionStarted", targetSelector: "EFFECT_OWNER" },
                  duration: { timeLimit: { unit: "ACTION", count: 3 } },
                },
                requiredCapabilities: ["CAP_CONTINUOUS_DAMAGE"],
              },
              "effectAction",
            ),
          ),
        ]),
        continuousDamage: { continuousDamageKind: kind, damageType: "PHYSICAL" },
      });

      const poisoned = unit("t1", "UNIT_A", {
        appliedEffects: [continuousDamageEffect("e1", "POISON")],
      });
      const burning = unit("t2", "UNIT_A", {
        appliedEffects: [continuousDamageEffect("e2", "BURN")],
      });
      const stunned = unit("t3", "UNIT_A", {
        appliedEffects: [{ ...effect("e3", ["DEBUFF", "STATUS"]), statusKind: "STUN" }],
      });
      // 固定継続ダメージは名前付きの状態異常ではないため一致しない（分類は`DEBUFF`のみ）。
      const fixedDot = unit("t4", "UNIT_A", {
        appliedEffects: [continuousDamageEffect("e4", "FIXED")],
      });
      // 通常のstatデバフだけを持つ対象も、状態異常ではないため一致しない。
      const statDebuffed = unit("t5", "UNIT_A", { appliedEffects: [effect("e5", ["DEBUFF"])] });
      const clean = unit("t6", "UNIT_A");

      expect(
        [poisoned, burning, stunned, fixedDot, statDebuffed, clean].map((current) =>
          evaluateEffectStepCondition(hasStatusAilment, undefined, contextFor(current)),
        ),
      ).toEqual([true, true, true, false, false, false]);
    });

    it("UT-R-SKL-06-068 (RES-004-STATUS-CONDITION, Issue #224): a STATUS query reads the latest state, so a poison cleansed since planning no longer matches", () => {
      const hasStatusAilment: ConditionDefinition = {
        kind: "TARGET_HAS_EFFECT",
        target: STEP_TARGET,
        categories: ["STATUS"],
      };
      const poisoned = unit("t1", "UNIT_A", {
        appliedEffects: [
          {
            ...effect("e1", ["DEBUFF", "STATUS"], 100),
            continuousDamage: { continuousDamageKind: "POISON", damageType: "PHYSICAL" },
          },
        ],
      });
      const cleansed = { ...poisoned, appliedEffects: [] };

      expect(evaluateEffectStepCondition(hasStatusAilment, undefined, contextFor(poisoned))).toBe(
        true,
      );
      expect(evaluateEffectStepCondition(hasStatusAilment, undefined, contextFor(cleansed))).toBe(
        false,
      );
    });
  });

  /**
   * M7-001E（Issue #248、`CAP_TARGET_STATE_EXTENDED_FIELD`）: `TARGET_STATE`の
   * `HAS_STATUS`（`UNIT_MERU_FLATSPIN`/`UNIT_NANAE_COMMANDER`のBRANCH条件）と
   * `ROLE`を評価できるようにする。
   */
  describe("TARGET_STATE HAS_STATUS/ROLE (CAP_TARGET_STATE_EXTENDED_FIELD, Issue #248 M7-001E)", () => {
    const stunCondition: ConditionDefinition = {
      kind: "TARGET_STATE",
      target: STEP_TARGET,
      field: "HAS_STATUS",
      op: "EQ",
      value: "STUN",
    };

    function contextFor(current: BattleUnit): EffectStepTargetContext {
      return {
        stepTarget: STEP_TARGET,
        current,
        resolveOtherReference: () => [],
        unitDefinitions: new Map(),
      };
    }

    it("UT-R-SKL-06-064: HAS_STATUS is true exactly when the target holds an AppliedEffect of that statusKind", () => {
      const stunned = unit("t1", "UNIT_A", {
        appliedEffects: [{ ...effect("e1", ["DEBUFF", "STATUS"]), statusKind: "STUN" }],
      });
      const frozen = unit("t2", "UNIT_A", {
        appliedEffects: [{ ...effect("e2", ["DEBUFF", "STATUS"]), statusKind: "FREEZE" }],
      });
      const statDebuffed = unit("t3", "UNIT_A", { appliedEffects: [effect("e3", ["DEBUFF"])] });

      expect(evaluateEffectStepCondition(stunCondition, undefined, contextFor(stunned))).toBe(true);
      expect(evaluateEffectStepCondition(stunCondition, undefined, contextFor(frozen))).toBe(false);
      expect(evaluateEffectStepCondition(stunCondition, undefined, contextFor(statDebuffed))).toBe(
        false,
      );
    });

    // RES-004-STATUS-CONDITION（Issue #224）: このORは「対象が状態異常か」という
    // 総称の表現としては使わなくなった（炎上・毒を取りこぼすため、production定義は
    // `TARGET_HAS_EFFECT.categories: ["STATUS"]`へ移した）。`HAS_STATUS`自体は
    // R-EFF-02の照会粒度#2「個別の状態異常種別を保持しているか」を担い続けるため、
    // step-wideスコープでの評価規約をここで固定する。
    it("UT-R-SKL-06-065: HAS_STATUS in step-wide (BRANCH) scope reads the resolved unit, quantifying over the statuses it holds", () => {
      const blinded = unit("t1", "UNIT_A", {
        appliedEffects: [{ ...effect("e1", ["DEBUFF", "STATUS"]), statusKind: "BLIND" }],
      });
      const anyAilment: ConditionDefinition = {
        kind: "OR",
        conditions: (["STUN", "FREEZE", "BLIND"] as const).map((value) => ({
          kind: "TARGET_STATE",
          target: STEP_TARGET,
          field: "HAS_STATUS",
          op: "EQ",
          value,
        })),
      };

      expect(evaluateEffectStepCondition(anyAilment, undefined, undefined, () => [blinded])).toBe(
        true,
      );
      expect(
        evaluateEffectStepCondition(anyAilment, undefined, undefined, () => [unit("t2", "UNIT_A")]),
      ).toBe(false);
    });

    it("UT-R-SKL-06-066: ROLE resolves from the target's UnitDefinition, and still throws when that definition is missing", () => {
      const unitDefinitionId = createUnitDefinitionId("UNIT_TANK");
      const unitDefinitions = new Map<typeof unitDefinitionId, UnitDefinition>([
        [
          unitDefinitionId,
          { unitDefinitionId, unitType: "PHYSICAL", role: "TANK" } as UnitDefinition,
        ],
      ]);
      const condition: ConditionDefinition = {
        kind: "TARGET_STATE",
        target: STEP_TARGET,
        field: "ROLE",
        op: "EQ",
        value: "TANK",
      };
      const tank = unit("t1", "UNIT_TANK");

      expect(
        evaluateEffectStepCondition(condition, undefined, {
          stepTarget: STEP_TARGET,
          current: tank,
          resolveOtherReference: () => [],
          unitDefinitions,
        }),
      ).toBe(true);
      expect(() =>
        evaluateEffectStepCondition(condition, undefined, {
          stepTarget: STEP_TARGET,
          current: unit("t2", "UNIT_UNKNOWN"),
          resolveOtherReference: () => [],
          unitDefinitions,
        }),
      ).toThrow(DomainValidationError);
    });
  });
});
