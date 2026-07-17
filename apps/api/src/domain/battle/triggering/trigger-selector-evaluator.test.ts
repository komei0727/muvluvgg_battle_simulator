import { describe, expect, it } from "vitest";
import { evaluateSourceSelector, evaluateTargetSelector } from "./trigger-selector-evaluator.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { createBattleUnitId, type BattleUnitId } from "../../shared/ids.js";
import { createUnitDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import { DomainValidationError } from "../../shared/errors.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function unit(id: string, side: Side): BattleUnit {
  const position = { column: "LEFT", row: "FRONT" } as const;
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
  return createBattleUnit(member, side, LIMITS);
}

function eventFrom(sourceUnitId: BattleUnitId | undefined, sourceSide: Side | undefined) {
  const event: TriggerCandidateEvent = {
    eventType: "DamageApplied",
    category: "FACT",
    payload: {},
    ...(sourceUnitId !== undefined ? { sourceUnitId } : {}),
    ...(sourceSide !== undefined ? { sourceSide } : {}),
  };
  return event;
}

describe("evaluateSourceSelector", () => {
  const owner = unit("OWNER", "ALLY");

  it("UT-R-PS-01-010: ANY matches regardless of source", () => {
    expect(evaluateSourceSelector("ANY", owner, eventFrom(undefined, undefined))).toBe(true);
  });

  it("UT-R-PS-01-011: SELF matches only when the source is the owner itself", () => {
    expect(evaluateSourceSelector("SELF", owner, eventFrom(owner.battleUnitId, "ALLY"))).toBe(true);
    expect(
      evaluateSourceSelector("SELF", owner, eventFrom(createBattleUnitId("OTHER"), "ALLY")),
    ).toBe(false);
  });

  it("UT-R-PS-01-012: ALLY matches when the source side equals the owner side", () => {
    expect(
      evaluateSourceSelector("ALLY", owner, eventFrom(createBattleUnitId("OTHER"), "ALLY")),
    ).toBe(true);
    expect(
      evaluateSourceSelector("ALLY", owner, eventFrom(createBattleUnitId("OTHER"), "ENEMY")),
    ).toBe(false);
  });

  it("UT-R-PS-01-013: ENEMY matches when the source side is the opposite of the owner side", () => {
    expect(
      evaluateSourceSelector("ENEMY", owner, eventFrom(createBattleUnitId("OTHER"), "ENEMY")),
    ).toBe(true);
    expect(
      evaluateSourceSelector("ENEMY", owner, eventFrom(createBattleUnitId("OTHER"), "ALLY")),
    ).toBe(false);
    expect(evaluateSourceSelector("ENEMY", owner, eventFrom(undefined, undefined))).toBe(false);
  });

  it("UT-R-PS-01-014: EFFECT_OWNER throws (M7 scope, requires AppliedEffect ownership)", () => {
    expect(() =>
      evaluateSourceSelector("EFFECT_OWNER", owner, eventFrom(undefined, undefined)),
    ).toThrow(DomainValidationError);
  });
});

describe("evaluateTargetSelector", () => {
  const owner = unit("OWNER", "ALLY");
  const ally = unit("ALLY_1", "ALLY");
  const enemy = unit("ENEMY_1", "ENEMY");
  const unitsById = new Map([
    [owner.battleUnitId, owner],
    [ally.battleUnitId, ally],
    [enemy.battleUnitId, enemy],
  ]);

  function eventWithTargets(targetUnitIds: readonly BattleUnitId[] | undefined) {
    const event: TriggerCandidateEvent = {
      eventType: "DamageApplied",
      category: "FACT",
      payload: {},
      ...(targetUnitIds !== undefined ? { targetUnitIds } : {}),
    };
    return event;
  }

  it("UT-R-PS-01-015: ANY matches even without targets", () => {
    expect(evaluateTargetSelector("ANY", owner, eventWithTargets(undefined), unitsById)).toBe(true);
  });

  it("UT-R-PS-01-016: SELF matches when the owner itself is among the targets", () => {
    expect(
      evaluateTargetSelector(
        "SELF",
        owner,
        eventWithTargets([enemy.battleUnitId, owner.battleUnitId]),
        unitsById,
      ),
    ).toBe(true);
    expect(
      evaluateTargetSelector("SELF", owner, eventWithTargets([enemy.battleUnitId]), unitsById),
    ).toBe(false);
  });

  it("UT-R-PS-01-017: ALLY matches when at least one target shares the owner side", () => {
    expect(
      evaluateTargetSelector(
        "ALLY",
        owner,
        eventWithTargets([enemy.battleUnitId, ally.battleUnitId]),
        unitsById,
      ),
    ).toBe(true);
    expect(
      evaluateTargetSelector("ALLY", owner, eventWithTargets([enemy.battleUnitId]), unitsById),
    ).toBe(false);
  });

  it("UT-R-PS-01-018: ENEMY matches when at least one target is on the opposite side", () => {
    expect(
      evaluateTargetSelector("ENEMY", owner, eventWithTargets([enemy.battleUnitId]), unitsById),
    ).toBe(true);
    expect(
      evaluateTargetSelector("ENEMY", owner, eventWithTargets([ally.battleUnitId]), unitsById),
    ).toBe(false);
  });

  it("UT-R-PS-01-019: a non-ANY selector never matches when there are no targets", () => {
    expect(evaluateTargetSelector("ALLY", owner, eventWithTargets(undefined), unitsById)).toBe(
      false,
    );
    expect(evaluateTargetSelector("ALLY", owner, eventWithTargets([]), unitsById)).toBe(false);
  });
});
