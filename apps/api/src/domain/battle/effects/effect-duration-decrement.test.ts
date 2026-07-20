import { describe, expect, it } from "vitest";
import {
  decrementActionEffectDurations,
  decrementTurnEffectDurations,
} from "./effect-duration-decrement.js";
import type { AppliedEffect, EffectKindKey } from "../model/applied-effect.js";
import { createActionId, createEffectInstanceId } from "../../shared/event-ids.js";
import { createBattleUnitId } from "../../shared/ids.js";

const TARGET = createBattleUnitId("ally:1");
const SOURCE = createBattleUnitId("enemy:1");
const KIND = "ACT_BUFF_ATTACK" as EffectKindKey;
const ACTION_1 = createActionId("battle-1:action:1");
const ACTION_2 = createActionId("battle-1:action:2");

function actionEffect(overrides: {
  readonly id: string;
  readonly remaining: number;
  readonly grantedActionId?: ReturnType<typeof createActionId>;
}): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(overrides.id),
    effectActionDefinitionId: KIND as unknown as AppliedEffect["effectActionDefinitionId"],
    kindKey: KIND,
    duplicate: true,
    sourceId: SOURCE,
    targetId: TARGET,
    magnitude: 10,
    duration: {
      definition: {
        timeLimit: { unit: "ACTION", count: 3 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      timeLimitRemaining: overrides.remaining,
      ...(overrides.grantedActionId !== undefined
        ? { grantedActionId: overrides.grantedActionId }
        : {}),
    },
    active: true,
  };
}

function turnEffect(overrides: {
  readonly id: string;
  readonly remaining: number;
  readonly grantedTurnNumber?: number;
}): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(overrides.id),
    effectActionDefinitionId: KIND as unknown as AppliedEffect["effectActionDefinitionId"],
    kindKey: KIND,
    duplicate: true,
    sourceId: SOURCE,
    targetId: TARGET,
    magnitude: 10,
    duration: {
      definition: {
        timeLimit: { unit: "TURN", count: 2 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      timeLimitRemaining: overrides.remaining,
      ...(overrides.grantedTurnNumber !== undefined
        ? { grantedTurnNumber: overrides.grantedTurnNumber }
        : {}),
    },
    active: true,
  };
}

describe("decrementActionEffectDurations (R-EFF-04)", () => {
  it("UT-EFF-DUR-001: decrements the remaining count by 1 for an ACTION-unit effect not granted this action", () => {
    const effects = [actionEffect({ id: "e1", remaining: 3, grantedActionId: ACTION_1 })];

    const result = decrementActionEffectDurations(effects, ACTION_2);

    expect(result.changes).toEqual([{ effectInstanceId: "e1", before: 3, after: 2 }]);
    expect(result.effects[0]?.duration.timeLimitRemaining).toBe(2);
  });

  it("UT-EFF-DUR-002: does not decrement an effect granted during the current action (initial-decrement exclusion)", () => {
    const effects = [actionEffect({ id: "e1", remaining: 3, grantedActionId: ACTION_1 })];

    const result = decrementActionEffectDurations(effects, ACTION_1);

    expect(result.changes).toEqual([]);
    expect(result.effects[0]?.duration.timeLimitRemaining).toBe(3);
  });

  it("UT-EFF-DUR-003: ignores TURN-unit effects and effects without a remaining count", () => {
    const effects = [
      turnEffect({ id: "e-turn", remaining: 2, grantedTurnNumber: 1 }),
      {
        ...actionEffect({ id: "e-battle", remaining: 5 }),
        duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      },
    ];

    const result = decrementActionEffectDurations(effects, ACTION_2);

    expect(result.changes).toEqual([]);
  });

  it("UT-EFF-DUR-004: does not decrement an effect already at 0 remaining", () => {
    const effects = [actionEffect({ id: "e1", remaining: 0, grantedActionId: ACTION_1 })];

    const result = decrementActionEffectDurations(effects, ACTION_2);

    expect(result.changes).toEqual([]);
  });
});

describe("decrementTurnEffectDurations (R-EFF-06)", () => {
  it("UT-EFF-DUR-005: decrements the remaining count by 1 for a TURN-unit effect not granted this turn", () => {
    const effects = [turnEffect({ id: "e1", remaining: 2, grantedTurnNumber: 1 })];

    const result = decrementTurnEffectDurations(effects, 2);

    expect(result.changes).toEqual([{ effectInstanceId: "e1", before: 2, after: 1 }]);
  });

  it("UT-EFF-DUR-006: does not decrement an effect granted during the current turn (initial-decrement exclusion)", () => {
    const effects = [turnEffect({ id: "e1", remaining: 2, grantedTurnNumber: 3 })];

    const result = decrementTurnEffectDurations(effects, 3);

    expect(result.changes).toEqual([]);
  });
});
