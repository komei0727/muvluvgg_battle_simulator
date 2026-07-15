import { describe, expect, it } from "vitest";
import { resolveTargets } from "./target-selection-policy.js";
import { createBattleUnit, type BattleUnit, type BattleUnitResourceLimits } from "./battle-unit.js";
import type { BattlePartyMember } from "./battle-party.js";
import { createBattleUnitId } from "../shared/ids.js";
import { createUnitDefinitionId } from "../catalog/catalog-ids.js";
import type { FormationPosition } from "./formation-input.js";
import { toGlobalCoordinate } from "./global-coordinate.js";
import type { Side } from "./side.js";
import type { TargetSelectorDefinition } from "../catalog/target-selector-definition.js";
import { DomainValidationError } from "../shared/errors.js";

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

  it("UT-TARGET-SELECTION-POLICY-005: throws for an unsupported selector kind (TRIGGER_SOURCE/TRIGGER_TARGET/BINDING_DERIVED are M6/M7 scope)", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });

    expect(() =>
      resolveTargets(
        { kind: "TRIGGER_SOURCE", filters: [], order: ["DEFAULT"], includeDefeated: false },
        actor,
        [actor],
      ),
    ).toThrow(DomainValidationError);
  });
});
