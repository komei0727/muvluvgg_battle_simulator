import { describe, expect, it } from "vitest";
import { resolveTargets, resolveTargetsWithStealthConsumption } from "./target-selection-policy.js";
import { STEALTH_MARKER_ID } from "../model/marker-state.js";
import {
  createBattleUnit,
  type BattleUnit,
  type BattleUnitResourceLimits,
} from "../model/battle-unit.js";
import { buildInitialMarkerState, type MarkerState } from "../model/marker-state.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createMarkerInstanceId } from "../../shared/event-ids.js";
import {
  createMarkerId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
  type MarkerId,
  type UnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import type { TargetSelectorDefinition } from "../../catalog/definitions/target-selector-definition.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
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

function marker(markerId: MarkerId, stackCount = 1): MarkerState {
  return {
    ...buildInitialMarkerState(
      createMarkerInstanceId(`mi-${markerId}`),
      markerId,
      createBattleUnitId("SOURCE"),
      createBattleUnitId("TARGET"),
      null,
      { dispellable: true, linkedEffectGroupId: null, timeLimit: { unit: "BATTLE", count: 1 } },
      { turnNumber: 1 },
    ),
    stackCount,
  };
}

function unitDefinition(id: string, overrides: Partial<UnitDefinition> = {}): UnitDefinition {
  return {
    unitDefinitionId: createUnitDefinitionId(id),
    attribute: "AGGRESSIVE",
    unitType: "PHYSICAL",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT", "BACK"],
    baseStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
      actionSpeed: 10,
      maximumAp: 3,
      maximumPp: 3,
    },
    extraGaugeMaximum: 100,
    activeSkillDefinitionIds: [],
    passiveSkillDefinitionIds: [],
    extraSkillDefinitionId: createSkillDefinitionId("SKL_DUMMY_EX"),
    requiredCapabilities: [],
    metadata: {
      displayName: id,
      characterName: id,
      characterId: `CHAR_${id}`,
      affiliations: [],
      tags: [],
    },
    ...overrides,
  };
}

function unitDefinitions(...defs: UnitDefinition[]): ReadonlyMap<UnitDefinitionId, UnitDefinition> {
  return new Map(defs.map((d) => [d.unitDefinitionId, d]));
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

  it("UT-TARGET-SELECTION-POLICY-001: throws for an unsupported (unknown) order key", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });

    expect(() =>
      resolveTargets(
        selector({ side: "ENEMY", count: "ALL", order: ["BOGUS_ORDER_KEY" as never] }),
        actor,
        [actor],
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-TARGET-SELECTION-POLICY-002: applies a non-empty filters list (POSITION_ROW, TGT-002/CAP_TARGET_FILTER_ORDER)", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const front = unit("FRONT", "ENEMY", { column: "LEFT", row: "FRONT" });
    const back = unit("BACK", "ENEMY", { column: "LEFT", row: "BACK" });

    const targets = resolveTargets(
      selector({
        side: "ENEMY",
        count: "ALL",
        filters: [{ kind: "POSITION_ROW", row: "FRONT" }],
      }),
      actor,
      [actor, front, back],
    );

    expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("FRONT")]);
  });

  it("UT-TARGET-SELECTION-POLICY-003: throws when an area is set (area is M7 scope)", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });

    expect(() =>
      resolveTargets(selector({ side: "ENEMY", count: "ALL", area: { kind: "ALL" } }), actor, [
        actor,
      ]),
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

  it("UT-TARGET-SELECTION-POLICY-006: composes FRONT_ROW with NEAREST (both are supported order keys, TGT-002)", () => {
    const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
    const nearFront = unit("NEAR_FRONT", "ENEMY", { column: "CENTER", row: "FRONT" });
    const farFront = unit("FAR_FRONT", "ENEMY", { column: "LEFT", row: "FRONT" });
    const nearBack = unit("NEAR_BACK", "ENEMY", { column: "CENTER", row: "BACK" });

    const targets = resolveTargets(
      selector({ side: "ENEMY", count: "ALL", order: ["FRONT_ROW", "NEAREST"] }),
      actor,
      [actor, nearBack, farFront, nearFront],
    );

    expect(targets.map((t) => t.battleUnitId)).toEqual([
      createBattleUnitId("NEAR_FRONT"),
      createBattleUnitId("FAR_FRONT"),
      createBattleUnitId("NEAR_BACK"),
    ]);
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

  describe("R-TGT-09 #7/R-TGT-10: fallback evaluation (CAP_TARGET_BINDING_FALLBACK, TGT-003, Issue #168)", () => {
    it("UT-R-TGT-10-001: a primary selector that resolves to zero candidates evaluates its fallback selector instead", () => {
      const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
      const ally = unit("ALLY_1", "ALLY", { column: "RIGHT", row: "FRONT" });

      const targets = resolveTargets(
        selector({
          side: "ENEMY",
          count: "ALL",
          fallback: selector({ side: "ALLY", count: "ALL" }),
        }),
        actor,
        [actor, ally],
      );

      // fallback's side:"ALLY" is relative to the actor, so it also matches the actor itself
      // (UT-R-TGT-01-003 establishes the same relative-side semantics for SELECT).
      expect(targets.map((t) => t.battleUnitId).sort()).toEqual(
        [createBattleUnitId("ACTOR"), createBattleUnitId("ALLY_1")].sort(),
      );
    });

    it("UT-R-TGT-10-002: a primary selector with at least one candidate never evaluates its fallback", () => {
      const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
      const enemy = unit("ENEMY_1", "ENEMY", { column: "LEFT", row: "FRONT" });
      const ally = unit("ALLY_1", "ALLY", { column: "RIGHT", row: "FRONT" });

      const targets = resolveTargets(
        selector({
          side: "ENEMY",
          count: "ALL",
          fallback: selector({ side: "ALLY", count: "ALL" }),
        }),
        actor,
        [actor, enemy, ally],
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("ENEMY_1")]);
    });

    it("UT-R-TGT-10-003: the fallback selector is evaluated through the full pipeline (its own order and count apply)", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const near = unit("NEAR", "ENEMY", { column: "CENTER", row: "FRONT" });
      const far = unit("FAR", "ENEMY", { column: "LEFT", row: "BACK" });

      // The primary selector has no `side`/`kind` candidates of its own (BINDING_DERIVED base
      // SELF + DIRECTLY_AHEAD_OF_BASE resolves to zero when the actor is already FRONT row,
      // R-TGT-05), so this isolates the fallback's own order/count from any actor-inclusion
      // concern in the primary pool.
      const selectorDef: TargetSelectorDefinition = {
        kind: "BINDING_DERIVED",
        side: "ALLY",
        base: { kind: "SELF" },
        area: { kind: "DIRECTLY_AHEAD_OF_BASE" },
        filters: [],
        order: ["DEFAULT"],
        includeDefeated: false,
        fallback: selector({ side: "ENEMY", count: 1, order: ["DEFAULT"] }),
      };

      const targets = resolveTargets(selectorDef, actor, [actor, near, far]);

      expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("NEAR")]);
    });

    it("UT-R-TGT-10-004: a primary selector resolving to zero candidates because of includeDefeated:false still triggers fallback", () => {
      const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
      const defeatedEnemy = unit(
        "ENEMY_1",
        "ENEMY",
        { column: "LEFT", row: "FRONT" },
        { currentHp: 0 },
      );
      const ally = unit("ALLY_1", "ALLY", { column: "RIGHT", row: "FRONT" });

      const targets = resolveTargets(
        selector({
          side: "ENEMY",
          count: "ALL",
          fallback: selector({ side: "ALLY", count: "ALL" }),
        }),
        actor,
        [actor, defeatedEnemy, ally],
      );

      expect(targets.map((t) => t.battleUnitId).sort()).toEqual(
        [createBattleUnitId("ACTOR"), createBattleUnitId("ALLY_1")].sort(),
      );
    });

    it("UT-R-TGT-10-005: a BINDING_DERIVED selector whose area resolves to zero candidates evaluates its fallback", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "BACK" });
      const ally = unit("ALLY_1", "ALLY", { column: "RIGHT", row: "FRONT" });

      const selectorDef: TargetSelectorDefinition = {
        kind: "BINDING_DERIVED",
        side: "ALLY",
        base: { kind: "SELF" },
        area: { kind: "BEHIND_BASE" },
        filters: [],
        order: ["DEFAULT"],
        includeDefeated: false,
        fallback: selector({ side: "ALLY", count: "ALL" }),
      };

      const targets = resolveTargets(selectorDef, actor, [actor, ally]);

      expect(targets.map((t) => t.battleUnitId).sort()).toEqual(
        [createBattleUnitId("ACTOR"), createBattleUnitId("ALLY_1")].sort(),
      );
    });

    it("UT-R-TGT-10-006: chains through a fallback's own fallback when the first fallback also resolves to zero candidates", () => {
      const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
      const survivor = unit("SURVIVOR", "ALLY", { column: "RIGHT", row: "FRONT" });

      const targets = resolveTargets(
        selector({
          side: "ENEMY",
          count: "ALL",
          fallback: selector({
            side: "ENEMY",
            count: "ALL",
            includeDefeated: true,
            fallback: selector({ side: "ALLY", count: "ALL" }),
          }),
        }),
        actor,
        [actor, survivor],
      );

      expect(targets.map((t) => t.battleUnitId).sort()).toEqual(
        [createBattleUnitId("ACTOR"), createBattleUnitId("SURVIVOR")].sort(),
      );
    });

    it("UT-R-TGT-10-007: zero candidates with no fallback still resolves to an empty array (R-TGT-01/R-TGT-07, regression)", () => {
      const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });

      const targets = resolveTargets(selector({ side: "ENEMY", count: "ALL" }), actor, [actor]);

      expect(targets).toEqual([]);
    });

    it("UT-R-TGT-10-008: a non-empty filters list on the fallback selector is applied like any other selector (TGT-002/CAP_TARGET_FILTER_ORDER)", () => {
      const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
      const backAlly = unit("BACK_ALLY", "ALLY", { column: "RIGHT", row: "BACK" });

      const targets = resolveTargets(
        selector({
          side: "ENEMY",
          count: "ALL",
          fallback: selector({
            side: "ALLY",
            count: "ALL",
            filters: [{ kind: "POSITION_ROW", row: "BACK" }],
          }),
        }),
        actor,
        [actor, backAlly],
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("BACK_ALLY")]);
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
        { triggerTargetUnitIds: [triggerTarget.battleUnitId] },
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
        { triggerSourceUnitId: triggerSource.battleUnitId },
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
        { triggerTargetUnitIds: [enemyTarget.battleUnitId, allyTarget.battleUnitId] },
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
        triggerSourceUnitId: triggerSource.battleUnitId,
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

  describe("TGT-002: TargetFilterDefinition evaluation (CAP_TARGET_FILTER_ORDER, Issue #169)", () => {
    it("UT-TGT-002-001: HAS_MARKER filter matches only candidates holding the marker", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const markerId = createMarkerId("MARKER_TAG");
      const marked = unit(
        "MARKED",
        "ENEMY",
        { column: "LEFT", row: "FRONT" },
        {
          markerStates: [marker(markerId)],
        },
      );
      const unmarked = unit("UNMARKED", "ENEMY", { column: "RIGHT", row: "FRONT" });

      const targets = resolveTargets(
        selector({ side: "ENEMY", count: "ALL", filters: [{ kind: "HAS_MARKER", markerId }] }),
        actor,
        [actor, marked, unmarked],
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("MARKED")]);
    });

    it("UT-TGT-002-002: HAS_MARKER filter with countCondition compares stackCount (TARGET_FILTER_MARKER_COUNT_THRESHOLD)", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const markerId = createMarkerId("MARKER_TAG");
      const twoStacks = unit(
        "TWO",
        "ENEMY",
        { column: "LEFT", row: "FRONT" },
        {
          markerStates: [marker(markerId, 2)],
        },
      );
      const oneStack = unit(
        "ONE",
        "ENEMY",
        { column: "RIGHT", row: "FRONT" },
        {
          markerStates: [marker(markerId, 1)],
        },
      );

      const targets = resolveTargets(
        selector({
          side: "ENEMY",
          count: "ALL",
          filters: [{ kind: "HAS_MARKER", markerId, countCondition: { op: "GTE", value: 2 } }],
        }),
        actor,
        [actor, twoStacks, oneStack],
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("TWO")]);
    });

    it("UT-TGT-002-003: HP_RATIO filter compares currentHp/maximumHp", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const low = unit(
        "LOW",
        "ENEMY",
        { column: "LEFT", row: "FRONT" },
        { currentHp: 20, combatStats: { ...actor.combatStats, maximumHp: 100 } },
      );
      const high = unit(
        "HIGH",
        "ENEMY",
        { column: "RIGHT", row: "FRONT" },
        { currentHp: 90, combatStats: { ...actor.combatStats, maximumHp: 100 } },
      );

      const targets = resolveTargets(
        selector({
          side: "ENEMY",
          count: "ALL",
          filters: [{ kind: "HP_RATIO", op: "LTE", value: 0.3 }],
        }),
        actor,
        [actor, low, high],
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("LOW")]);
    });

    it("UT-TGT-002-004: AND/OR/NOT combinators evaluate recursively", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const leftFront = unit("LEFT_FRONT", "ENEMY", { column: "LEFT", row: "FRONT" });
      const rightFront = unit("RIGHT_FRONT", "ENEMY", { column: "RIGHT", row: "FRONT" });
      const leftBack = unit("LEFT_BACK", "ENEMY", { column: "LEFT", row: "BACK" });

      const targets = resolveTargets(
        selector({
          side: "ENEMY",
          count: "ALL",
          filters: [
            {
              kind: "AND",
              conditions: [
                { kind: "POSITION_ROW", row: "FRONT" },
                { kind: "NOT", condition: { kind: "POSITION_COLUMN", column: "RIGHT" } },
              ],
            },
          ],
        }),
        actor,
        [actor, leftFront, rightFront, leftBack],
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("LEFT_FRONT")]);
    });

    it("UT-TGT-002-005: EXCLUDE_RESOLVED_UNIT referencing SELF excludes the actor (自身を除く味方全体)", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const otherAlly = unit("OTHER_ALLY", "ALLY", { column: "LEFT", row: "FRONT" });

      const targets = resolveTargets(
        selector({
          side: "ALLY",
          count: "ALL",
          filters: [{ kind: "EXCLUDE_RESOLVED_UNIT", reference: { kind: "SELF" } }],
        }),
        actor,
        [actor, otherAlly],
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("OTHER_ALLY")]);
    });

    it("UT-TGT-002-006: EXCLUDE_RESOLVED_UNIT referencing a BINDING excludes an earlier binding's target (もう1体)", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const first = unit("FIRST", "ENEMY", { column: "LEFT", row: "FRONT" });
      const second = unit("SECOND", "ENEMY", { column: "RIGHT", row: "FRONT" });
      const resolvedBindings = new Map([[createTargetBindingId("TGT_FIRST"), [first]]]);

      const targets = resolveTargets(
        selector({
          side: "ENEMY",
          count: "ALL",
          filters: [
            {
              kind: "EXCLUDE_RESOLVED_UNIT",
              reference: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_FIRST") },
            },
          ],
        }),
        actor,
        [actor, first, second],
        resolvedBindings,
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("SECOND")]);
    });

    it("UT-TGT-002-007: EXCLUDE_RESOLVED_UNIT throws when the referenced BINDING was not resolved", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const enemy = unit("ENEMY", "ENEMY", { column: "LEFT", row: "FRONT" });

      expect(() =>
        resolveTargets(
          selector({
            side: "ENEMY",
            count: "ALL",
            filters: [
              {
                kind: "EXCLUDE_RESOLVED_UNIT",
                reference: {
                  kind: "BINDING",
                  targetBindingId: createTargetBindingId("TGT_MISSING"),
                },
              },
            ],
          }),
          actor,
          [actor, enemy],
        ),
      ).toThrow(DomainValidationError);
    });

    it("UT-TGT-002-008: EXCLUDE_RESOLVED_UNIT throws for an unsupported reference kind (only SELF/BINDING)", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const enemy = unit("ENEMY", "ENEMY", { column: "LEFT", row: "FRONT" });

      expect(() =>
        resolveTargets(
          selector({
            side: "ENEMY",
            count: "ALL",
            filters: [{ kind: "EXCLUDE_RESOLVED_UNIT", reference: { kind: "TRIGGER_SOURCE" } }],
          }),
          actor,
          [actor, enemy],
        ),
      ).toThrow(DomainValidationError);
    });

    it("UT-TGT-002-009: MARKER_IN_AREA matches a candidate whose own column contains a marked unit (TARGET_FILTER_MARKER_BY_AREA)", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const markerId = createMarkerId("MARKER_CLARA_SANTA_TAG");
      // LEFT column: front holds the tag, back does not hold it itself but shares the column.
      const leftFront = unit(
        "LEFT_FRONT",
        "ENEMY",
        { column: "LEFT", row: "FRONT" },
        {
          markerStates: [marker(markerId)],
        },
      );
      const leftBack = unit("LEFT_BACK", "ENEMY", { column: "LEFT", row: "BACK" });
      const rightFront = unit("RIGHT_FRONT", "ENEMY", { column: "RIGHT", row: "FRONT" });

      const targets = resolveTargets(
        selector({
          side: "ENEMY",
          count: "ALL",
          filters: [
            {
              kind: "MARKER_IN_AREA",
              area: { kind: "SAME_COLUMN_AS_BASE", includeBase: true },
              markerId,
            },
          ],
        }),
        actor,
        [actor, leftFront, leftBack, rightFront],
      );

      expect(targets.map((t) => t.battleUnitId).sort()).toEqual(
        [createBattleUnitId("LEFT_FRONT"), createBattleUnitId("LEFT_BACK")].sort(),
      );
    });

    it("UT-TGT-002-009B: MARKER_IN_AREA ignores a defeated marker holder (PR #233 review [P1])", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const markerId = createMarkerId("MARKER_CLARA_SANTA_TAG");
      // The only marked unit in the LEFT column is defeated, so the column
      // should no longer count as "having a marker holder" for MARKER_IN_AREA
      // — even though a living candidate (LEFT_FRONT) still shares the column.
      const defeatedTagged = unit(
        "DEFEATED_TAGGED",
        "ENEMY",
        { column: "LEFT", row: "BACK" },
        { currentHp: 0, markerStates: [marker(markerId)] },
      );
      const leftFront = unit("LEFT_FRONT", "ENEMY", { column: "LEFT", row: "FRONT" });
      const rightFront = unit("RIGHT_FRONT", "ENEMY", { column: "RIGHT", row: "FRONT" });

      const targets = resolveTargets(
        selector({
          side: "ENEMY",
          count: "ALL",
          filters: [
            {
              kind: "MARKER_IN_AREA",
              area: { kind: "SAME_COLUMN_AS_BASE", includeBase: true },
              markerId,
            },
          ],
        }),
        actor,
        [actor, defeatedTagged, leftFront, rightFront],
      );

      expect(targets).toEqual([]);
    });

    it("UT-TGT-002-010: UNIT_TYPE/ROLE/AFFILIATION/CHARACTER filters resolve via the unitDefinitions map", () => {
      const enDefId = createUnitDefinitionId("UNIT_EN");
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const enUnit = unit(
        "EN_UNIT",
        "ENEMY",
        { column: "LEFT", row: "FRONT" },
        { unitDefinitionId: enDefId },
      );
      const physicalUnit = unit("PHYSICAL_UNIT", "ENEMY", { column: "RIGHT", row: "FRONT" });
      const defs = unitDefinitions(
        unitDefinition("UNIT_EN", { unitType: "ENERGY", role: "EN_ATTACKER" }),
        unitDefinition("UNIT_001", { unitType: "PHYSICAL", role: "TANK" }),
      );

      const targets = resolveTargets(
        selector({
          side: "ENEMY",
          count: "ALL",
          filters: [{ kind: "UNIT_TYPE", unitType: "ENERGY" }],
        }),
        actor,
        [actor, enUnit, physicalUnit],
        undefined,
        undefined,
        defs,
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("EN_UNIT")]);
    });

    it("UT-TGT-002-011: UNIT_TYPE filter throws when the actual unitDefinitionId is absent from unitDefinitions", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const enemy = unit("ENEMY", "ENEMY", { column: "LEFT", row: "FRONT" });

      expect(() =>
        resolveTargets(
          selector({
            side: "ENEMY",
            count: "ALL",
            filters: [{ kind: "UNIT_TYPE", unitType: "ENERGY" }],
          }),
          actor,
          [actor, enemy],
        ),
      ).toThrow(DomainValidationError);
    });
  });

  describe("TGT-002: TargetOrderEntry evaluation (CAP_TARGET_FILTER_ORDER, Issue #169)", () => {
    it("UT-TGT-002-012: LOWEST_HP_RATIO/HIGHEST_HP_RATIO order by currentHp/maximumHp", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const low = unit("LOW", "ENEMY", { column: "LEFT", row: "FRONT" }, { currentHp: 10 });
      const high = unit("HIGH", "ENEMY", { column: "RIGHT", row: "FRONT" }, { currentHp: 90 });

      expect(
        resolveTargets(
          selector({ side: "ENEMY", count: "ALL", order: ["LOWEST_HP_RATIO"] }),
          actor,
          [actor, low, high],
        ).map((t) => t.battleUnitId),
      ).toEqual([createBattleUnitId("LOW"), createBattleUnitId("HIGH")]);

      expect(
        resolveTargets(
          selector({ side: "ENEMY", count: "ALL", order: ["HIGHEST_HP_RATIO"] }),
          actor,
          [actor, low, high],
        ).map((t) => t.battleUnitId),
      ).toEqual([createBattleUnitId("HIGH"), createBattleUnitId("LOW")]);
    });

    it("UT-TGT-002-013: HIGHEST_ATTACK orders by combatStats.attack descending", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const weak = unit(
        "WEAK",
        "ENEMY",
        { column: "LEFT", row: "FRONT" },
        { combatStats: { ...actor.combatStats, attack: 5 } },
      );
      const strong = unit(
        "STRONG",
        "ENEMY",
        { column: "RIGHT", row: "FRONT" },
        { combatStats: { ...actor.combatStats, attack: 50 } },
      );

      const targets = resolveTargets(
        selector({ side: "ENEMY", count: "ALL", order: ["HIGHEST_ATTACK"] }),
        actor,
        [actor, weak, strong],
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([
        createBattleUnitId("STRONG"),
        createBattleUnitId("WEAK"),
      ]);
    });

    it("UT-TGT-002-014: LOWEST_MAX_HP/HIGHEST_MAX_HP order by combatStats.maximumHp", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const small = unit(
        "SMALL",
        "ENEMY",
        { column: "LEFT", row: "FRONT" },
        { combatStats: { ...actor.combatStats, maximumHp: 50 } },
      );
      const large = unit(
        "LARGE",
        "ENEMY",
        { column: "RIGHT", row: "FRONT" },
        { combatStats: { ...actor.combatStats, maximumHp: 500 } },
      );

      expect(
        resolveTargets(selector({ side: "ENEMY", count: "ALL", order: ["LOWEST_MAX_HP"] }), actor, [
          actor,
          small,
          large,
        ]).map((t) => t.battleUnitId),
      ).toEqual([createBattleUnitId("SMALL"), createBattleUnitId("LARGE")]);

      expect(
        resolveTargets(
          selector({ side: "ENEMY", count: "ALL", order: ["HIGHEST_MAX_HP"] }),
          actor,
          [actor, small, large],
        ).map((t) => t.battleUnitId),
      ).toEqual([createBattleUnitId("LARGE"), createBattleUnitId("SMALL")]);
    });

    it("UT-TGT-002-015: HIGHEST_EX_GAUGE_RATIO orders by currentExtraGauge/maximumExtraGauge descending", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const low = unit("LOW", "ENEMY", { column: "LEFT", row: "FRONT" }, { currentExtraGauge: 10 });
      const high = unit(
        "HIGH",
        "ENEMY",
        { column: "RIGHT", row: "FRONT" },
        { currentExtraGauge: 90 },
      );

      const targets = resolveTargets(
        selector({ side: "ENEMY", count: "ALL", order: ["HIGHEST_EX_GAUGE_RATIO"] }),
        actor,
        [actor, low, high],
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([
        createBattleUnitId("HIGH"),
        createBattleUnitId("LOW"),
      ]);
    });

    it("UT-TGT-002-016: FASTEST orders by combatStats.actionSpeed descending (システマ・ヴラシェーニヤΩ)", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const slow = unit(
        "SLOW",
        "ENEMY",
        { column: "LEFT", row: "FRONT" },
        { combatStats: { ...actor.combatStats, actionSpeed: 5 } },
      );
      const fast = unit(
        "FAST",
        "ENEMY",
        { column: "RIGHT", row: "FRONT" },
        { combatStats: { ...actor.combatStats, actionSpeed: 50 } },
      );

      const targets = resolveTargets(
        selector({ side: "ENEMY", count: 1, order: ["FASTEST"] }),
        actor,
        [actor, slow, fast],
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("FAST")]);
    });

    it("UT-TGT-002-017: LEFT_TO_RIGHT orders by absolute column ascending", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const right = unit("RIGHT", "ENEMY", { column: "RIGHT", row: "FRONT" });
      const left = unit("LEFT", "ENEMY", { column: "LEFT", row: "FRONT" });

      const targets = resolveTargets(
        selector({ side: "ENEMY", count: "ALL", order: ["LEFT_TO_RIGHT"] }),
        actor,
        [actor, right, left],
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([
        createBattleUnitId("LEFT"),
        createBattleUnitId("RIGHT"),
      ]);
    });

    it("UT-TGT-002-018: SELF_LOWEST_PRIORITY ranks the actor last without excluding it (自身以外を優先)", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const otherAlly = unit("OTHER_ALLY", "ALLY", { column: "LEFT", row: "FRONT" });

      const withOther = resolveTargets(
        selector({ side: "ALLY", count: 1, order: ["SELF_LOWEST_PRIORITY"] }),
        actor,
        [actor, otherAlly],
      );
      expect(withOther.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("OTHER_ALLY")]);

      const onlySelf = resolveTargets(
        selector({ side: "ALLY", count: 1, order: ["SELF_LOWEST_PRIORITY"] }),
        actor,
        [actor],
      );
      expect(onlySelf.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("ACTOR")]);
    });

    it("UT-TGT-002-019: MARKER_COUNT order entry sorts ASC/DESC by stackCount, per markerId (TARGET_ORDER_MARKER_COUNT)", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const markerId = createMarkerId("MARKER_GRACE");
      const few = unit(
        "FEW",
        "ENEMY",
        { column: "LEFT", row: "FRONT" },
        {
          markerStates: [marker(markerId, 1)],
        },
      );
      const many = unit(
        "MANY",
        "ENEMY",
        { column: "RIGHT", row: "FRONT" },
        {
          markerStates: [marker(markerId, 5)],
        },
      );

      const ascending = resolveTargets(
        selector({
          side: "ENEMY",
          count: "ALL",
          order: [{ kind: "MARKER_COUNT", markerId, direction: "ASC" }],
        }),
        actor,
        [actor, many, few],
      );
      expect(ascending.map((t) => t.battleUnitId)).toEqual([
        createBattleUnitId("FEW"),
        createBattleUnitId("MANY"),
      ]);

      const descending = resolveTargets(
        selector({
          side: "ENEMY",
          count: "ALL",
          order: [{ kind: "MARKER_COUNT", markerId, direction: "DESC" }],
        }),
        actor,
        [actor, few, many],
      );
      expect(descending.map((t) => t.battleUnitId)).toEqual([
        createBattleUnitId("MANY"),
        createBattleUnitId("FEW"),
      ]);
    });

    it("UT-TGT-002-020: candidates without the marker are treated as stackCount 0 for MARKER_COUNT order", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const markerId = createMarkerId("MARKER_GRACE");
      const holder = unit(
        "HOLDER",
        "ENEMY",
        { column: "LEFT", row: "FRONT" },
        {
          markerStates: [marker(markerId, 1)],
        },
      );
      const bare = unit("BARE", "ENEMY", { column: "RIGHT", row: "FRONT" });

      const targets = resolveTargets(
        selector({
          side: "ENEMY",
          count: "ALL",
          order: [{ kind: "MARKER_COUNT", markerId, direction: "ASC" }],
        }),
        actor,
        [actor, holder, bare],
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([
        createBattleUnitId("BARE"),
        createBattleUnitId("HOLDER"),
      ]);
    });

    it("UT-TGT-002-021: UNIT_TYPE_PRIORITY order entry ranks the given unitType first (ENタイプを優先)", () => {
      const enDefId = createUnitDefinitionId("UNIT_EN");
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const enAlly = unit(
        "EN_ALLY",
        "ALLY",
        { column: "LEFT", row: "FRONT" },
        { unitDefinitionId: enDefId },
      );
      const physicalAlly = unit("PHYSICAL_ALLY", "ALLY", { column: "RIGHT", row: "FRONT" });
      const defs = unitDefinitions(
        unitDefinition("UNIT_EN", { unitType: "ENERGY" }),
        unitDefinition("UNIT_001", { unitType: "PHYSICAL" }),
      );

      const targets = resolveTargets(
        selector({
          side: "ALLY",
          count: 1,
          order: [{ kind: "UNIT_TYPE_PRIORITY", unitType: "ENERGY" }, "SELF_LOWEST_PRIORITY"],
        }),
        actor,
        [actor, physicalAlly, enAlly],
        undefined,
        undefined,
        defs,
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("EN_ALLY")]);
    });

    it("UT-TGT-002-022: order composition falls through to SELF_LOWEST_PRIORITY when no ally matches UNIT_TYPE_PRIORITY (幸運のデコイ)", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const otherAlly = unit("OTHER_ALLY", "ALLY", { column: "LEFT", row: "FRONT" });
      const defs = unitDefinitions(unitDefinition("UNIT_001", { unitType: "PHYSICAL" }));

      const targets = resolveTargets(
        selector({
          side: "ALLY",
          count: 1,
          order: [{ kind: "UNIT_TYPE_PRIORITY", unitType: "ENERGY" }, "SELF_LOWEST_PRIORITY"],
        }),
        actor,
        [actor, otherAlly],
        undefined,
        undefined,
        defs,
      );

      expect(targets.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("OTHER_ALLY")]);
    });
  });

  describe("R-TGT-08: Stealth redirect (TGT-004, Issue #167)", () => {
    it("UT-R-TGT-08-001: a first-priority target holding Stealth is moved to the end of candidate order, redirecting a count:1 selector to the next candidate", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const nearest = unit(
        "NEAREST",
        "ENEMY",
        { column: "CENTER", row: "FRONT" },
        { markerStates: [marker(STEALTH_MARKER_ID)] },
      );
      const farther = unit("FARTHER", "ENEMY", { column: "LEFT", row: "BACK" });

      const result = resolveTargetsWithStealthConsumption(
        selector({ side: "ENEMY", count: 1 }),
        actor,
        [actor, nearest, farther],
      );

      expect(result.units.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("FARTHER")]);
      expect(result.stealthConsumption).toEqual({
        battleUnitId: createBattleUnitId("NEAREST"),
        markerInstanceId: nearest.markerStates[0]!.markerInstanceId,
      });

      // `resolveTargets` (used by callers that don't need the consumption signal) reflects
      // the same redirected order.
      const plain = resolveTargets(selector({ side: "ENEMY", count: 1 }), actor, [
        actor,
        nearest,
        farther,
      ]);
      expect(plain.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("FARTHER")]);
    });

    it("UT-R-TGT-08-002: a Stealth holder who is not the first-priority target keeps their position and is not consumed", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const nearest = unit("NEAREST", "ENEMY", { column: "CENTER", row: "FRONT" });
      const farther = unit(
        "FARTHER",
        "ENEMY",
        { column: "LEFT", row: "BACK" },
        { markerStates: [marker(STEALTH_MARKER_ID)] },
      );

      const result = resolveTargetsWithStealthConsumption(
        selector({ side: "ENEMY", count: "ALL" }),
        actor,
        [actor, nearest, farther],
      );

      expect(result.units.map((t) => t.battleUnitId)).toEqual([
        createBattleUnitId("NEAREST"),
        createBattleUnitId("FARTHER"),
      ]);
      expect(result.stealthConsumption).toBeUndefined();
    });

    it("UT-R-TGT-08-003 (Q-TGT-05): when no alternative remains after the move (count requires the whole pool), Stealth is still consumed and the original target is still hit", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const nearest = unit(
        "NEAREST",
        "ENEMY",
        { column: "CENTER", row: "FRONT" },
        { markerStates: [marker(STEALTH_MARKER_ID)] },
      );
      const farther = unit("FARTHER", "ENEMY", { column: "LEFT", row: "BACK" });

      const result = resolveTargetsWithStealthConsumption(
        selector({ side: "ENEMY", count: "ALL" }),
        actor,
        [actor, nearest, farther],
      );

      expect(result.units.map((t) => t.battleUnitId).sort()).toEqual(
        [createBattleUnitId("NEAREST"), createBattleUnitId("FARTHER")].sort(),
      );
      expect(result.stealthConsumption).toEqual({
        battleUnitId: createBattleUnitId("NEAREST"),
        markerInstanceId: nearest.markerStates[0]!.markerInstanceId,
      });
    });

    it("UT-R-TGT-08-004 (R-TGT-08 #6): a SELF selector never redirects, even when the actor holds Stealth (self-cast self-target skill)", () => {
      const actor = unit(
        "ACTOR",
        "ALLY",
        { column: "CENTER", row: "FRONT" },
        { markerStates: [marker(STEALTH_MARKER_ID)] },
      );
      const ally = unit("ALLY_1", "ALLY", { column: "RIGHT", row: "FRONT" });

      const result = resolveTargetsWithStealthConsumption(
        { kind: "SELF", filters: [], order: ["DEFAULT"], includeDefeated: false },
        actor,
        [actor, ally],
      );

      expect(result.units.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("ACTOR")]);
      expect(result.stealthConsumption).toBeUndefined();
    });

    it("UT-R-TGT-08-005 (R-TGT-08 #7): a selector whose candidate pool is structurally limited to a single unit never redirects (『攻撃を受けた味方単体』例)", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const onlyCandidate = unit(
        "ONLY",
        "ENEMY",
        { column: "CENTER", row: "FRONT" },
        { markerStates: [marker(STEALTH_MARKER_ID)] },
      );

      const result = resolveTargetsWithStealthConsumption(
        selector({ side: "ENEMY", count: 1 }),
        actor,
        [actor, onlyCandidate],
      );

      expect(result.units.map((t) => t.battleUnitId)).toEqual([createBattleUnitId("ONLY")]);
      expect(result.stealthConsumption).toBeUndefined();
    });

    it("UT-R-TGT-08-006: Stealth redirect also applies inside a fallback selector's own evaluation", () => {
      const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
      const nearestEnemy = unit(
        "NEAREST_ENEMY",
        "ENEMY",
        { column: "CENTER", row: "FRONT" },
        { markerStates: [marker(STEALTH_MARKER_ID)] },
      );
      const fartherEnemy = unit("FARTHER_ENEMY", "ENEMY", { column: "LEFT", row: "BACK" });

      const result = resolveTargetsWithStealthConsumption(
        selector({
          side: "ALLY",
          count: 1,
          // actor's own HP_RATIO is always 1, never < 0: the primary selector (targeting
          // the actor's own side) always resolves to zero candidates, forcing fallback.
          filters: [{ kind: "HP_RATIO", op: "LT", value: 0 }],
          fallback: selector({ side: "ENEMY", count: 1 }),
        }),
        actor,
        [actor, nearestEnemy, fartherEnemy],
      );

      expect(result.units.map((t) => t.battleUnitId)).toEqual([
        createBattleUnitId("FARTHER_ENEMY"),
      ]);
      expect(result.stealthConsumption).toEqual({
        battleUnitId: createBattleUnitId("NEAREST_ENEMY"),
        markerInstanceId: nearestEnemy.markerStates[0]!.markerInstanceId,
      });
    });
  });
});
