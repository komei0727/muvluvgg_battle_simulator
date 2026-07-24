import { describe, expect, it } from "vitest";
import { resolveTargets } from "./target-selection-policy.js";
import {
  createBattleUnit,
  type BattleUnit,
  type BattleUnitResourceLimits,
} from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { createBattleUnitId } from "../../shared/ids.js";
import {
  createTargetBindingId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import type { TargetSelectorDefinition } from "../../catalog/definitions/target-selector-definition.js";
import { DomainValidationError } from "../../shared/errors.js";

const LIMITS: BattleUnitResourceLimits = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function unit(
  id: string,
  side: Side,
  position: FormationPosition,
  overrides: Partial<BattleUnit> = {},
): BattleUnit {
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_001"),
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

function selector(overrides: Partial<TargetSelectorDefinition> = {}): TargetSelectorDefinition {
  return {
    kind: "SELECT",
    side: "ENEMY",
    count: 1,
    filters: [],
    order: ["DEFAULT"],
    includeDefeated: false,
    ...overrides,
  };
}

describe("resolveTargets", () => {
  it("UT-R-TGT-01-001: SELF selector resolves only the actor, regardless of side", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const ally = unit("ALLY_2", "ALLY", { column: "RIGHT", row: "FRONT" });

    const targets = resolveTargets(
      { kind: "SELF", filters: [], order: ["DEFAULT"], includeDefeated: false },
      actor,
      [actor, ally],
    );

    expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("ACTOR")]);
  });

  it("UT-R-TGT-01-002: side ENEMY resolves only units on the opposite side of the actor", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const allyMate = unit("ALLY_2", "ALLY", { column: "RIGHT", row: "FRONT" });
    const enemy = unit("ENEMY_1", "ENEMY", { column: "LEFT", row: "FRONT" });

    const targets = resolveTargets(selector({ side: "ENEMY", count: "ALL" }), actor, [
      actor,
      allyMate,
      enemy,
    ]);

    expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("ENEMY_1")]);
  });

  it("UT-R-TGT-01-003: side ALLY is relative to the actor, so an ENEMY-side actor resolves its own side", () => {
    const actor = unit("ACTOR", "ENEMY", { column: "LEFT", row: "FRONT" });
    const enemyMate = unit("ENEMY_2", "ENEMY", { column: "RIGHT", row: "FRONT" });
    const ally = unit("ALLY_1", "ALLY", { column: "LEFT", row: "FRONT" });

    const targets = resolveTargets(selector({ side: "ALLY", count: "ALL" }), actor, [
      actor,
      enemyMate,
      ally,
    ]);

    expect(targets.map((t) => t.battleUnitId).sort()).toEqual(
      [createBattleUnitId("ACTOR"), createBattleUnitId("ENEMY_2")].sort(),
    );
  });

  it("UT-R-TGT-01-004: side ALL resolves units on both sides", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const enemy = unit("ENEMY_1", "ENEMY", { column: "LEFT", row: "FRONT" });

    const targets = resolveTargets(selector({ side: "ALL", count: "ALL" }), actor, [actor, enemy]);

    expect(targets.map((t) => t.battleUnitId).sort()).toEqual(
      [createBattleUnitId("ACTOR"), createBattleUnitId("ENEMY_1")].sort(),
    );
  });

  it("UT-R-TGT-01-005: excludes defeated units by default", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const defeatedEnemy = unit(
      "ENEMY_1",
      "ENEMY",
      { column: "LEFT", row: "FRONT" },
      {
        currentHp: 0,
      },
    );

    const targets = resolveTargets(selector({ side: "ENEMY", count: "ALL" }), actor, [
      actor,
      defeatedEnemy,
    ]);

    expect(targets).toEqual([]);
  });

  it("UT-R-TGT-01-006: includeDefeated keeps defeated units as candidates", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const defeatedEnemy = unit(
      "ENEMY_1",
      "ENEMY",
      { column: "LEFT", row: "FRONT" },
      {
        currentHp: 0,
      },
    );

    const targets = resolveTargets(
      selector({ side: "ENEMY", count: "ALL", includeDefeated: true }),
      actor,
      [actor, defeatedEnemy],
    );

    expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("ENEMY_1")]);
  });

  it("UT-R-TGT-01-007: zero matching candidates resolves to an empty array", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });

    const targets = resolveTargets(selector({ side: "ENEMY", count: "ALL" }), actor, [actor]);

    expect(targets).toEqual([]);
  });

  it("UT-R-TGT-02-001: orders candidates by ascending Manhattan distance from the actor", () => {
    const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
    const near = unit("NEAR", "ENEMY", { column: "CENTER", row: "FRONT" });
    const far = unit("FAR", "ENEMY", { column: "LEFT", row: "BACK" });

    const targets = resolveTargets(selector({ side: "ENEMY", count: "ALL" }), actor, [
      actor,
      far,
      near,
    ]);

    expect(targets.map((t) => t.battleUnitId)).toEqual([
      createBattleUnitId("NEAR"),
      createBattleUnitId("FAR"),
    ]);
  });

  it("UT-R-TGT-02-002: same distance breaks ties by FRONT before BACK", () => {
    const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
    const front = unit("FRONT_1", "ENEMY", { column: "CENTER", row: "FRONT" });
    const back = unit("BACK_1", "ENEMY", { column: "CENTER", row: "BACK" });

    const targets = resolveTargets(selector({ side: "ENEMY", count: "ALL" }), actor, [
      actor,
      back,
      front,
    ]);

    expect(targets.map((t) => t.battleUnitId)).toEqual([
      createBattleUnitId("FRONT_1"),
      createBattleUnitId("BACK_1"),
    ]);
  });

  it("UT-R-TGT-02-003: same distance and row breaks ties by absolute left-to-right column", () => {
    const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
    // Both candidates are equidistant (Manhattan distance 2) from the actor, so this only
    // passes if the column tie-break is actually applied rather than the distance ordering.
    const left = unit("LEFT_1", "ENEMY", { column: "LEFT", row: "FRONT" });
    const right = unit("RIGHT_1", "ENEMY", { column: "RIGHT", row: "FRONT" });

    const targets = resolveTargets(selector({ side: "ENEMY", count: "ALL" }), actor, [
      actor,
      right,
      left,
    ]);

    expect(targets.map((t) => t.battleUnitId)).toEqual([
      createBattleUnitId("LEFT_1"),
      createBattleUnitId("RIGHT_1"),
    ]);
  });

  it("UT-R-TGT-02-004: input order does not affect the resolved order (determinism)", () => {
    const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
    const candidates = [
      unit("E1", "ENEMY", { column: "LEFT", row: "FRONT" }),
      unit("E2", "ENEMY", { column: "RIGHT", row: "BACK" }),
      unit("E3", "ENEMY", { column: "CENTER", row: "BACK" }),
    ];

    const fromOriginal = resolveTargets(selector({ side: "ENEMY", count: "ALL" }), actor, [
      actor,
      ...candidates,
    ]).map((t) => t.battleUnitId);
    const fromShuffled = resolveTargets(selector({ side: "ENEMY", count: "ALL" }), actor, [
      candidates[2]!,
      actor,
      candidates[0]!,
      candidates[1]!,
    ]).map((t) => t.battleUnitId);

    expect(fromShuffled).toEqual(fromOriginal);
  });

  it("UT-R-TGT-07-001: fewer candidates than the requested count resolves to only the existing candidates", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const onlyEnemy = unit("ENEMY_1", "ENEMY", { column: "LEFT", row: "FRONT" });

    const targets = resolveTargets(selector({ side: "ENEMY", count: 3 }), actor, [
      actor,
      onlyEnemy,
    ]);

    expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("ENEMY_1")]);
  });

  it("UT-R-TGT-07-002: a numeric count trims candidates beyond the requested amount, in default order", () => {
    const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
    const near = unit("NEAR", "ENEMY", { column: "CENTER", row: "FRONT" });
    const far = unit("FAR", "ENEMY", { column: "LEFT", row: "BACK" });

    const targets = resolveTargets(selector({ side: "ENEMY", count: 1 }), actor, [
      actor,
      far,
      near,
    ]);

    expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("NEAR")]);
  });

  it("UT-TARGET-SELECTION-POLICY-001: throws for an unsupported order key (order beyond DEFAULT is M7 scope)", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });

    expect(() =>
      resolveTargets(selector({ side: "ENEMY", count: "ALL", order: ["NEAREST"] }), actor, [actor]),
    ).toThrow(DomainValidationError);
  });

  it("UT-TARGET-SELECTION-POLICY-002: throws for a non-empty filters list (filters are M7 scope)", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });

    expect(() =>
      resolveTargets(
        selector({
          side: "ENEMY",
          count: "ALL",
          filters: [{ kind: "POSITION_ROW", row: "FRONT" }],
        }),
        actor,
        [actor],
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-TARGET-SELECTION-POLICY-003: throws when an area is set (area is M7 scope)", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });

    expect(() =>
      resolveTargets(selector({ side: "ENEMY", count: "ALL", area: { kind: "ALL" } }), actor, [
        actor,
      ]),
    ).toThrow(DomainValidationError);
  });

  it("UT-TARGET-SELECTION-POLICY-004: throws when a fallback selector is set (fallback is M7 scope)", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });

    expect(() =>
      resolveTargets(
        selector({ side: "ENEMY", count: "ALL", fallback: selector({ side: "ALLY" }) }),
        actor,
        [actor],
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-TARGET-SELECTION-POLICY-005: throws for an unsupported selector kind (TRIGGER_SOURCE/TRIGGER_TARGET are M7 scope, see CAP_TRIGGER_CONTEXT/RES-005)", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });

    expect(() =>
      resolveTargets(
        { kind: "TRIGGER_SOURCE", filters: [], order: ["DEFAULT"], includeDefeated: false },
        actor,
        [actor],
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-TARGET-SELECTION-POLICY-006: throws when the order array mixes a supported key with an unsupported one (stat-based orders are TGT-002/CAP_TARGET_FILTER_ORDER scope)", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });

    expect(() =>
      resolveTargets(
        selector({ side: "ENEMY", count: "ALL", order: ["FRONT_ROW", "NEAREST"] }),
        actor,
        [actor],
      ),
    ).toThrow(DomainValidationError);
  });

  describe("R-TGT-03: FARTHEST order (reverses the full R-TGT-02 ordering)", () => {
    it("UT-R-TGT-03-001: reverses ascending distance to descending", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const near = unit("NEAR", "ENEMY", { column: "CENTER", row: "FRONT" });
      const far = unit("FAR", "ENEMY", { column: "LEFT", row: "BACK" });

      const targets = resolveTargets(
        selector({ side: "ENEMY", count: "ALL", order: ["FARTHEST"] }),
        actor,
        [actor, near, far],
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([
        createBattleUnitId("FAR"),
        createBattleUnitId("NEAR"),
      ]);
    });

    it("UT-R-TGT-03-002: same-distance ties break BACK before FRONT (row order reversed)", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const front = unit("FRONT_1", "ENEMY", { column: "CENTER", row: "FRONT" });
      const back = unit("BACK_1", "ENEMY", { column: "CENTER", row: "BACK" });

      const targets = resolveTargets(
        selector({ side: "ENEMY", count: "ALL", order: ["FARTHEST"] }),
        actor,
        [actor, front, back],
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([
        createBattleUnitId("BACK_1"),
        createBattleUnitId("FRONT_1"),
      ]);
    });

    it("UT-R-TGT-03-003: remaining ties break right-to-left column (column order reversed)", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const left = unit("LEFT_1", "ENEMY", { column: "LEFT", row: "FRONT" });
      const right = unit("RIGHT_1", "ENEMY", { column: "RIGHT", row: "FRONT" });

      const targets = resolveTargets(
        selector({ side: "ENEMY", count: "ALL", order: ["FARTHEST"] }),
        actor,
        [actor, right, left],
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([
        createBattleUnitId("RIGHT_1"),
        createBattleUnitId("LEFT_1"),
      ]);
    });
  });

  describe("R-TGT-06: row priority order (FRONT_ROW/BACK_ROW)", () => {
    it("UT-R-TGT-06-001: FRONT_ROW places front-row candidates before back-row even when farther", () => {
      const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
      const back = unit("BACK_1", "ENEMY", { column: "LEFT", row: "BACK" });
      const front = unit("FRONT_1", "ENEMY", { column: "RIGHT", row: "FRONT" });

      const targets = resolveTargets(
        selector({ side: "ENEMY", count: "ALL", order: ["FRONT_ROW", "DEFAULT"] }),
        actor,
        [actor, back, front],
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([
        createBattleUnitId("FRONT_1"),
        createBattleUnitId("BACK_1"),
      ]);
    });

    it("UT-R-TGT-06-002: BACK_ROW places back-row candidates before front-row even when farther", () => {
      const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
      const back = unit("BACK_1", "ENEMY", { column: "RIGHT", row: "BACK" });
      const front = unit("FRONT_1", "ENEMY", { column: "LEFT", row: "FRONT" });

      const targets = resolveTargets(
        selector({ side: "ENEMY", count: "ALL", order: ["BACK_ROW", "DEFAULT"] }),
        actor,
        [actor, back, front],
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([
        createBattleUnitId("BACK_1"),
        createBattleUnitId("FRONT_1"),
      ]);
    });

    it("UT-R-TGT-06-003: candidates tied on the specified key fall through to a deterministic tiebreak (R-TGT-02)", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const frontLeft = unit("FRONT_LEFT", "ENEMY", { column: "LEFT", row: "FRONT" });
      const frontRight = unit("FRONT_RIGHT", "ENEMY", { column: "RIGHT", row: "FRONT" });

      const targets = resolveTargets(
        selector({ side: "ENEMY", count: "ALL", order: ["FRONT_ROW"] }),
        actor,
        [actor, frontRight, frontLeft],
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([
        createBattleUnitId("FRONT_LEFT"),
        createBattleUnitId("FRONT_RIGHT"),
      ]);
    });
  });

  describe("R-TGT-04: ADJACENT_ORTHOGONAL area", () => {
    it("UT-R-TGT-04-001: resolves the orthogonal neighbors of the base, excluding diagonals", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const up = unit("UP", "ALLY", { column: "CENTER", row: "BACK" });
      const left = unit("LEFT", "ALLY", { column: "LEFT", row: "FRONT" });
      const right = unit("RIGHT", "ALLY", { column: "RIGHT", row: "FRONT" });
      const diagonal = unit("DIAG", "ALLY", { column: "LEFT", row: "BACK" });

      const selectorDef: TargetSelectorDefinition = {
        kind: "BINDING_DERIVED",
        side: "ALLY",
        base: { kind: "SELF" },
        area: { kind: "ADJACENT_ORTHOGONAL" },
        filters: [],
        order: ["DEFAULT"],
        includeDefeated: false,
      };

      const targets = resolveTargets(selectorDef, actor, [actor, up, left, right, diagonal]);

      expect(targets.map((t) => t.battleUnitId).sort()).toEqual(
        [createBattleUnitId("UP"), createBattleUnitId("LEFT"), createBattleUnitId("RIGHT")].sort(),
      );
    });

    it("UT-R-TGT-04-002: does not cross the side boundary even when an enemy occupies the geometrically adjacent square", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const enemyAcrossBoundary = unit("ENEMY_ADJ", "ENEMY", { column: "CENTER", row: "FRONT" });

      const selectorDef: TargetSelectorDefinition = {
        kind: "BINDING_DERIVED",
        side: "ALL",
        base: { kind: "SELF" },
        area: { kind: "ADJACENT_ORTHOGONAL" },
        filters: [],
        order: ["DEFAULT"],
        includeDefeated: false,
      };

      const targets = resolveTargets(selectorDef, actor, [actor, enemyAcrossBoundary]);

      expect(targets).toEqual([]);
    });
  });

  describe("R-TGT-05: DIRECTLY_AHEAD_OF_BASE area", () => {
    it("UT-R-TGT-05-001: resolves the single square directly in front of a BACK-row base", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "BACK" });
      const ahead = unit("AHEAD", "ALLY", { column: "CENTER", row: "FRONT" });

      const selectorDef: TargetSelectorDefinition = {
        kind: "BINDING_DERIVED",
        side: "ALLY",
        base: { kind: "SELF" },
        area: { kind: "DIRECTLY_AHEAD_OF_BASE" },
        filters: [],
        order: ["DEFAULT"],
        includeDefeated: false,
      };

      const targets = resolveTargets(selectorDef, actor, [actor, ahead]);

      expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("AHEAD")]);
    });

    it("UT-R-TGT-05-002: resolves zero candidates when the base is already FRONT row (skill becomes unusable)", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const enemyFront = unit("ENEMY_FRONT", "ENEMY", { column: "CENTER", row: "FRONT" });

      const selectorDef: TargetSelectorDefinition = {
        kind: "BINDING_DERIVED",
        side: "ALL",
        base: { kind: "SELF" },
        area: { kind: "DIRECTLY_AHEAD_OF_BASE" },
        filters: [],
        order: ["DEFAULT"],
        includeDefeated: false,
      };

      const targets = resolveTargets(selectorDef, actor, [actor, enemyFront]);

      expect(targets).toEqual([]);
    });
  });

  describe("R-TGT-09: TargetSelector evaluation order (kind/base/area wiring)", () => {
    it("UT-R-TGT-09-001: BINDING_DERIVED resolves base from a previously-resolved targetBinding", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const mainTarget = unit("MAIN", "ENEMY", { column: "CENTER", row: "FRONT" });
      const adjacent = unit("ADJ", "ENEMY", { column: "LEFT", row: "FRONT" });
      const resolvedBindings = new Map([[createTargetBindingId("TGT_MAIN"), [mainTarget]]]);

      const selectorDef: TargetSelectorDefinition = {
        kind: "BINDING_DERIVED",
        side: "ENEMY",
        base: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_MAIN") },
        area: { kind: "ADJACENT_ORTHOGONAL" },
        filters: [],
        order: ["DEFAULT"],
        includeDefeated: false,
      };

      const targets = resolveTargets(
        selectorDef,
        actor,
        [actor, mainTarget, adjacent],
        resolvedBindings,
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("ADJ")]);
    });

    it("UT-R-TGT-09-002: resolves zero candidates (not a throw) when the referenced binding resolved to zero units", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const adjacent = unit("ADJ", "ENEMY", { column: "LEFT", row: "FRONT" });
      const resolvedBindings = new Map<ReturnType<typeof createTargetBindingId>, BattleUnit[]>([
        [createTargetBindingId("TGT_MAIN"), []],
      ]);

      const selectorDef: TargetSelectorDefinition = {
        kind: "BINDING_DERIVED",
        side: "ENEMY",
        base: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_MAIN") },
        area: { kind: "ADJACENT_ORTHOGONAL" },
        filters: [],
        order: ["DEFAULT"],
        includeDefeated: false,
      };

      const targets = resolveTargets(selectorDef, actor, [actor, adjacent], resolvedBindings);

      expect(targets).toEqual([]);
    });

    it("UT-R-TGT-09-003: throws when the referenced targetBindingId was never resolved", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });

      const selectorDef: TargetSelectorDefinition = {
        kind: "BINDING_DERIVED",
        side: "ENEMY",
        base: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_MISSING") },
        area: { kind: "ADJACENT_ORTHOGONAL" },
        filters: [],
        order: ["DEFAULT"],
        includeDefeated: false,
      };

      expect(() => resolveTargets(selectorDef, actor, [actor])).toThrow(DomainValidationError);
    });

    it("UT-R-TGT-09-004: SAME_COLUMN_AS_BASE with includeBase:true includes both the base and its column-mate", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const baseUnit = unit("BASE", "ENEMY", { column: "LEFT", row: "FRONT" });
      const columnMate = unit("MATE", "ENEMY", { column: "LEFT", row: "BACK" });
      const other = unit("OTHER", "ENEMY", { column: "RIGHT", row: "FRONT" });
      const resolvedBindings = new Map([[createTargetBindingId("TGT_BASE"), [baseUnit]]]);

      const selectorDef: TargetSelectorDefinition = {
        kind: "BINDING_DERIVED",
        side: "ENEMY",
        base: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_BASE") },
        area: { kind: "SAME_COLUMN_AS_BASE", includeBase: true },
        filters: [],
        order: ["DEFAULT"],
        includeDefeated: false,
      };

      const targets = resolveTargets(
        selectorDef,
        actor,
        [actor, baseUnit, columnMate, other],
        resolvedBindings,
      );

      expect(targets.map((t) => t.battleUnitId).sort()).toEqual(
        [createBattleUnitId("BASE"), createBattleUnitId("MATE")].sort(),
      );
    });

    it("UT-R-TGT-09-005: SAME_ROW_AS_BASE with includeBase:false excludes the base itself", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const baseUnit = unit("BASE", "ENEMY", { column: "LEFT", row: "FRONT" });
      const rowMate = unit("MATE", "ENEMY", { column: "RIGHT", row: "FRONT" });
      const resolvedBindings = new Map([[createTargetBindingId("TGT_BASE"), [baseUnit]]]);

      const selectorDef: TargetSelectorDefinition = {
        kind: "BINDING_DERIVED",
        side: "ENEMY",
        base: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_BASE") },
        area: { kind: "SAME_ROW_AS_BASE", includeBase: false },
        filters: [],
        order: ["DEFAULT"],
        includeDefeated: false,
      };

      const targets = resolveTargets(
        selectorDef,
        actor,
        [actor, baseUnit, rowMate],
        resolvedBindings,
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("MATE")]);
    });

    it("UT-R-TGT-09-006: BEHIND_BASE resolves the single square behind the base", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const behindAlly = unit("BEHIND", "ALLY", { column: "CENTER", row: "BACK" });

      const selectorDef: TargetSelectorDefinition = {
        kind: "BINDING_DERIVED",
        side: "ALLY",
        base: { kind: "SELF" },
        area: { kind: "BEHIND_BASE" },
        filters: [],
        order: ["DEFAULT"],
        includeDefeated: false,
      };

      const targets = resolveTargets(selectorDef, actor, [actor, behindAlly]);

      expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("BEHIND")]);
    });

    it("UT-R-TGT-09-007: BEHIND_BASE resolves zero candidates at the board edge", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "BACK" });

      const selectorDef: TargetSelectorDefinition = {
        kind: "BINDING_DERIVED",
        side: "ALLY",
        base: { kind: "SELF" },
        area: { kind: "BEHIND_BASE" },
        filters: [],
        order: ["DEFAULT"],
        includeDefeated: false,
      };

      const targets = resolveTargets(selectorDef, actor, [actor]);

      expect(targets).toEqual([]);
    });

    it("UT-R-TGT-09-008: excludes defeated units from area-derived candidates unless includeDefeated is set", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const defeatedAdjacent = unit(
        "DEFEATED",
        "ALLY",
        { column: "LEFT", row: "FRONT" },
        { currentHp: 0 },
      );

      const selectorDef: TargetSelectorDefinition = {
        kind: "BINDING_DERIVED",
        side: "ALLY",
        base: { kind: "SELF" },
        area: { kind: "ADJACENT_ORTHOGONAL" },
        filters: [],
        order: ["DEFAULT"],
        includeDefeated: false,
      };

      const targets = resolveTargets(selectorDef, actor, [actor, defeatedAdjacent]);

      expect(targets).toEqual([]);
    });

    it("UT-R-TGT-09-009: throws for a base TargetReference kind requiring a triggerContext (TRIGGER_TARGET) when none is given (CAP_TRIGGER_CONTEXT/RES-005)", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });

      const selectorDef: TargetSelectorDefinition = {
        kind: "BINDING_DERIVED",
        side: "ENEMY",
        base: { kind: "TRIGGER_TARGET" },
        area: { kind: "SAME_ROW_AS_BASE", includeBase: true },
        filters: [],
        order: ["DEFAULT"],
        includeDefeated: false,
      };

      expect(() => resolveTargets(selectorDef, actor, [actor])).toThrow(DomainValidationError);
    });
  });

  describe("TRIGGER_SOURCE/TRIGGER_TARGET (CAP_TRIGGER_CONTEXT, RES-005, Issue #172)", () => {
    it("UT-CAP-TRIGGER-CONTEXT-004: BINDING_DERIVED resolves base from triggerContext.triggerTargetUnits (SKL_SIENA_DIVA_PS1's TGT_ROW binding)", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const triggerTarget = unit("TRIGGER_TARGET_UNIT", "ENEMY", { column: "LEFT", row: "FRONT" });
      const rowMate = unit("ROW_MATE", "ENEMY", { column: "RIGHT", row: "FRONT" });
      const other = unit("OTHER", "ENEMY", { column: "LEFT", row: "BACK" });

      const selectorDef: TargetSelectorDefinition = {
        kind: "BINDING_DERIVED",
        side: "ENEMY",
        base: { kind: "TRIGGER_TARGET" },
        area: { kind: "SAME_ROW_AS_BASE", includeBase: true },
        filters: [],
        order: ["DEFAULT"],
        includeDefeated: false,
      };

      const targets = resolveTargets(
        selectorDef,
        actor,
        [actor, triggerTarget, rowMate, other],
        undefined,
        { triggerTargetUnits: [triggerTarget] },
      );

      expect(targets.map((t) => t.battleUnitId).sort()).toEqual(
        [createBattleUnitId("TRIGGER_TARGET_UNIT"), createBattleUnitId("ROW_MATE")].sort(),
      );
    });

    it("UT-CAP-TRIGGER-CONTEXT-005: BINDING_DERIVED resolves base from triggerContext.triggerSourceUnit", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const triggerSource = unit("TRIGGER_SOURCE_UNIT", "ENEMY", { column: "LEFT", row: "FRONT" });
      const adjacent = unit("ADJ", "ENEMY", { column: "CENTER", row: "FRONT" });

      const selectorDef: TargetSelectorDefinition = {
        kind: "BINDING_DERIVED",
        side: "ENEMY",
        base: { kind: "TRIGGER_SOURCE" },
        area: { kind: "ADJACENT_ORTHOGONAL" },
        filters: [],
        order: ["DEFAULT"],
        includeDefeated: false,
      };

      const targets = resolveTargets(
        selectorDef,
        actor,
        [actor, triggerSource, adjacent],
        undefined,
        { triggerSourceUnit: triggerSource },
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("ADJ")]);
    });

    it("UT-CAP-TRIGGER-CONTEXT-006: a selector.kind of TRIGGER_TARGET resolves directly to the triggerContext's target units, filtered by side", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const enemyTarget = unit("ENEMY_TARGET", "ENEMY", { column: "LEFT", row: "FRONT" });
      const allyTarget = unit("ALLY_TARGET", "ALLY", { column: "RIGHT", row: "FRONT" });

      const selectorDef: TargetSelectorDefinition = {
        kind: "TRIGGER_TARGET",
        side: "ENEMY",
        filters: [],
        order: ["DEFAULT"],
        includeDefeated: false,
      };

      const targets = resolveTargets(
        selectorDef,
        actor,
        [actor, enemyTarget, allyTarget],
        undefined,
        { triggerTargetUnits: [enemyTarget, allyTarget] },
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("ENEMY_TARGET")]);
    });

    it("UT-CAP-TRIGGER-CONTEXT-007: a selector.kind of TRIGGER_SOURCE resolves directly to the triggerContext's source unit", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const triggerSource = unit("TRIGGER_SOURCE_UNIT", "ENEMY", { column: "LEFT", row: "FRONT" });

      const selectorDef: TargetSelectorDefinition = {
        kind: "TRIGGER_SOURCE",
        filters: [],
        order: ["DEFAULT"],
        includeDefeated: false,
      };

      const targets = resolveTargets(selectorDef, actor, [actor, triggerSource], undefined, {
        triggerSourceUnit: triggerSource,
      });

      expect(targets.map((t) => t.battleUnitId)).toEqual([
        createBattleUnitId("TRIGGER_SOURCE_UNIT"),
      ]);
    });

    it("UT-CAP-TRIGGER-CONTEXT-008: throws for selector.kind TRIGGER_SOURCE/TRIGGER_TARGET without a matching triggerContext", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });

      for (const kind of ["TRIGGER_SOURCE", "TRIGGER_TARGET"] as const) {
        const selectorDef: TargetSelectorDefinition = {
          kind,
          filters: [],
          order: ["DEFAULT"],
          includeDefeated: false,
        };

        expect(() => resolveTargets(selectorDef, actor, [actor])).toThrow(DomainValidationError);
      }
    });
  });
});
