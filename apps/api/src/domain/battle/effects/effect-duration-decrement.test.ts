import { describe, expect, it } from "vitest";
import {
  decrementActionEffectDurations,
  decrementTurnEffectDurations,
} from "./effect-duration-decrement.js";
import type { AppliedEffect, EffectKindKey } from "../model/applied-effect.js";
import { createActionId, createEffectInstanceId } from "../../shared/event-ids.js";
import { createBattleUnitId } from "../../shared/ids.js";
import type { DurationOwner } from "../../catalog/definitions/catalog-enums.js";

const KIND = "ACT_BUFF_ATTACK" as EffectKindKey;
const ACTION_1 = createActionId("battle-1:action:1");
const ACTION_2 = createActionId("battle-1:action:2");
const HOLDER = createBattleUnitId("ally:1");
const SOURCE = createBattleUnitId("enemy:1");
const OTHER = createBattleUnitId("enemy:2");

function actionEffect(overrides: {
  readonly id: string;
  readonly remaining: number;
  readonly sourceId?: ReturnType<typeof createBattleUnitId>;
  readonly targetId?: ReturnType<typeof createBattleUnitId>;
  readonly owner?: DurationOwner;
  readonly grantedActionId?: ReturnType<typeof createActionId>;
}): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(overrides.id),
    effectActionDefinitionId: KIND as unknown as AppliedEffect["effectActionDefinitionId"],
    kindKey: KIND,
    duplicate: true,
    sourceId: overrides.sourceId ?? SOURCE,
    targetId: overrides.targetId ?? HOLDER,
    magnitude: 10,
    duration: {
      definition: {
        timeLimit: {
          unit: "ACTION",
          count: 3,
          ...(overrides.owner !== undefined ? { owner: overrides.owner } : {}),
        },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      timeLimitRemaining: overrides.remaining,
      ...(overrides.grantedActionId !== undefined
        ? { grantedActionId: overrides.grantedActionId }
        : {}),
    },
    active: true,
    appliedTurnNumber: 1,
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
    targetId: HOLDER,
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
    appliedTurnNumber: 1,
  };
}

describe("decrementActionEffectDurations (R-EFF-04)", () => {
  it("UT-EFF-DUR-001: decrements a default-owner (EFFECT_TARGET) effect when its holder acts", () => {
    const effects = [actionEffect({ id: "e1", remaining: 3, grantedActionId: ACTION_1 })];

    const result = decrementActionEffectDurations(effects, ACTION_2, HOLDER);

    expect(result.changes).toEqual([{ effectInstanceId: "e1", before: 3, after: 2 }]);
  });

  it("UT-EFF-DUR-002: does not decrement an effect granted during the current action (initial-decrement exclusion)", () => {
    const effects = [actionEffect({ id: "e1", remaining: 3, grantedActionId: ACTION_1 })];

    const result = decrementActionEffectDurations(effects, ACTION_1, HOLDER);

    expect(result.changes).toEqual([]);
  });

  it("PR #155 re-review [P1]: an EFFECT_TARGET-owner effect does NOT decrement when a different unit acts", () => {
    const effects = [actionEffect({ id: "e1", remaining: 3, grantedActionId: ACTION_1 })];

    const result = decrementActionEffectDurations(effects, ACTION_2, OTHER);

    expect(result.changes).toEqual([]);
  });

  it("PR #155 re-review [P1]: an EFFECT_SOURCE-owner effect decrements when the SOURCE (not the holder) acts", () => {
    const effects = [
      actionEffect({
        id: "e1",
        remaining: 3,
        owner: "EFFECT_SOURCE",
        sourceId: SOURCE,
        targetId: HOLDER,
        grantedActionId: ACTION_1,
      }),
    ];

    const decrementedBySource = decrementActionEffectDurations(effects, ACTION_2, SOURCE);
    expect(decrementedBySource.changes).toEqual([{ effectInstanceId: "e1", before: 3, after: 2 }]);

    const notDecrementedByHolder = decrementActionEffectDurations(effects, ACTION_2, HOLDER);
    expect(notDecrementedByHolder.changes).toEqual([]);
  });

  it("PR #155 re-review [P1]: a BATTLE-owner effect decrements when ANY unit acts, regardless of holder/source", () => {
    const effects = [
      actionEffect({
        id: "e1",
        remaining: 1,
        owner: "BATTLE",
        sourceId: SOURCE,
        targetId: HOLDER,
        grantedActionId: ACTION_1,
      }),
    ];

    const result = decrementActionEffectDurations(effects, ACTION_2, OTHER);

    expect(result.changes).toEqual([{ effectInstanceId: "e1", before: 1, after: 0 }]);
  });

  it("UT-EFF-DUR-003: ignores TURN-unit effects and effects without a remaining count", () => {
    const effects = [
      turnEffect({ id: "e-turn", remaining: 2, grantedTurnNumber: 1 }),
      {
        ...actionEffect({ id: "e-battle", remaining: 5 }),
        duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      },
    ];

    const result = decrementActionEffectDurations(effects, ACTION_2, HOLDER);

    expect(result.changes).toEqual([]);
  });

  it("UT-EFF-DUR-004: does not decrement an effect already at 0 remaining", () => {
    const effects = [actionEffect({ id: "e1", remaining: 0, grantedActionId: ACTION_1 })];

    const result = decrementActionEffectDurations(effects, ACTION_2, HOLDER);

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
