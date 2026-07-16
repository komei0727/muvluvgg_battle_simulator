import { describe, expect, it } from "vitest";
import {
  decrementActionCooldowns,
  decrementTurnCooldowns,
  startCooldown,
  type CooldownMap,
} from "./cooldown-state.js";
import { createActionId } from "./events/event-ids.js";
import { createSkillDefinitionId } from "../catalog/catalog-ids.js";

const SKL_A = createSkillDefinitionId("SKL_A");
const SKL_B = createSkillDefinitionId("SKL_B");
const ACTION_1 = createActionId("B_1:action:1");
const ACTION_2 = createActionId("B_1:action:2");

describe("startCooldown", () => {
  it("UT-COOLDOWN-001 (R-SKL-04): sets an ACTION-unit cooldown with the skill's declared count, scoped to the setting actionId", () => {
    const result = startCooldown({}, SKL_A, { unit: "ACTION", count: 2 }, { actionId: ACTION_1 });

    expect(result.before).toBe(0);
    expect(result.cooldowns[SKL_A]).toEqual({
      unit: "ACTION",
      remaining: 2,
      setActionId: ACTION_1,
    });
  });

  it("UT-COOLDOWN-002 (R-SKL-04): sets a TURN-unit cooldown scoped to the setting turnNumber", () => {
    const result = startCooldown({}, SKL_A, { unit: "TURN", count: 3 }, { turnNumber: 1 });

    expect(result.cooldowns[SKL_A]).toEqual({ unit: "TURN", remaining: 3, setTurnNumber: 1 });
  });

  it("UT-COOLDOWN-003: a cooldown.count of 0 records no entry (never enters COOLING)", () => {
    const result = startCooldown({}, SKL_A, { unit: "ACTION", count: 0 }, { actionId: ACTION_1 });

    expect(result.cooldowns).toEqual({});
    expect(result.before).toBe(0);
  });

  it("UT-COOLDOWN-004: re-using a skill after its cooldown completed reports the prior remaining (0) as `before` and resets scope", () => {
    const first = startCooldown({}, SKL_A, { unit: "ACTION", count: 1 }, { actionId: ACTION_1 });
    const { cooldowns: afterDecrement } = decrementActionCooldowns(first.cooldowns, ACTION_2);

    const second = startCooldown(
      afterDecrement,
      SKL_A,
      { unit: "ACTION", count: 1 },
      {
        actionId: ACTION_2,
      },
    );

    expect(second.before).toBe(0);
    expect(second.cooldowns[SKL_A]).toEqual({
      unit: "ACTION",
      remaining: 1,
      setActionId: ACTION_2,
    });
  });

  it("UT-COOLDOWN-005: leaves other skills' cooldowns untouched", () => {
    const withA = startCooldown(
      {},
      SKL_A,
      { unit: "ACTION", count: 2 },
      { actionId: ACTION_1 },
    ).cooldowns;
    const withBoth = startCooldown(
      withA,
      SKL_B,
      { unit: "TURN", count: 1 },
      { turnNumber: 1 },
    ).cooldowns;

    expect(withBoth[SKL_A]).toEqual({ unit: "ACTION", remaining: 2, setActionId: ACTION_1 });
    expect(withBoth[SKL_B]).toEqual({ unit: "TURN", remaining: 1, setTurnNumber: 1 });
  });
});

describe("decrementActionCooldowns", () => {
  it("UT-COOLDOWN-006 (R-SKL-04): does not decrement a cooldown set in the same action", () => {
    const cooldowns = startCooldown(
      {},
      SKL_A,
      { unit: "ACTION", count: 2 },
      {
        actionId: ACTION_1,
      },
    ).cooldowns;

    const result = decrementActionCooldowns(cooldowns, ACTION_1);

    expect(result.cooldowns[SKL_A]!.remaining).toBe(2);
    expect(result.changes).toEqual([]);
  });

  it("UT-COOLDOWN-007 (R-SKL-04): decrements by 1 on a subsequent action, reporting the change", () => {
    const cooldowns = startCooldown(
      {},
      SKL_A,
      { unit: "ACTION", count: 2 },
      {
        actionId: ACTION_1,
      },
    ).cooldowns;

    const result = decrementActionCooldowns(cooldowns, ACTION_2);

    expect(result.cooldowns[SKL_A]!.remaining).toBe(1);
    expect(result.changes).toEqual([
      { skillDefinitionId: SKL_A, unit: "ACTION", before: 2, after: 1 },
    ]);
  });

  it("UT-COOLDOWN-008: reaching 0 is reported once and further decrements are skipped (already READY)", () => {
    let cooldowns = startCooldown(
      {},
      SKL_A,
      { unit: "ACTION", count: 1 },
      {
        actionId: ACTION_1,
      },
    ).cooldowns;

    const first = decrementActionCooldowns(cooldowns, ACTION_2);
    cooldowns = first.cooldowns;
    expect(first.changes).toEqual([
      { skillDefinitionId: SKL_A, unit: "ACTION", before: 1, after: 0 },
    ]);

    const second = decrementActionCooldowns(cooldowns, createActionId("B_1:action:3"));
    expect(second.changes).toEqual([]);
    expect(second.cooldowns[SKL_A]!.remaining).toBe(0);
  });

  it("UT-COOLDOWN-009: ignores TURN-unit cooldowns entirely", () => {
    const cooldowns = startCooldown(
      {},
      SKL_A,
      { unit: "TURN", count: 2 },
      { turnNumber: 1 },
    ).cooldowns;

    const result = decrementActionCooldowns(cooldowns, ACTION_1);

    expect(result.changes).toEqual([]);
    expect(result.cooldowns[SKL_A]!.remaining).toBe(2);
  });
});

describe("decrementTurnCooldowns", () => {
  it("UT-COOLDOWN-010 (R-SKL-04): does not decrement a cooldown set in the same turn", () => {
    const cooldowns = startCooldown(
      {},
      SKL_A,
      { unit: "TURN", count: 2 },
      { turnNumber: 1 },
    ).cooldowns;

    const result = decrementTurnCooldowns(cooldowns, 1);

    expect(result.cooldowns[SKL_A]!.remaining).toBe(2);
    expect(result.changes).toEqual([]);
  });

  it("UT-COOLDOWN-011 (R-SKL-04): decrements by 1 at a subsequent turn end", () => {
    const cooldowns = startCooldown(
      {},
      SKL_A,
      { unit: "TURN", count: 2 },
      { turnNumber: 1 },
    ).cooldowns;

    const result = decrementTurnCooldowns(cooldowns, 2);

    expect(result.cooldowns[SKL_A]!.remaining).toBe(1);
    expect(result.changes).toEqual([
      { skillDefinitionId: SKL_A, unit: "TURN", before: 2, after: 1 },
    ]);
  });

  it("UT-COOLDOWN-012: ignores ACTION-unit cooldowns entirely", () => {
    const cooldowns = startCooldown(
      {},
      SKL_A,
      { unit: "ACTION", count: 2 },
      {
        actionId: ACTION_1,
      },
    ).cooldowns;

    const result = decrementTurnCooldowns(cooldowns, 5);

    expect(result.changes).toEqual([]);
    expect(result.cooldowns[SKL_A]!.remaining).toBe(2);
  });

  it("UT-COOLDOWN-013: an empty cooldown map decrements to itself with no changes", () => {
    const empty: CooldownMap = {};
    const result = decrementTurnCooldowns(empty, 1);

    expect(result.cooldowns).toEqual({});
    expect(result.changes).toEqual([]);
  });
});
