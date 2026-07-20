import { describe, expect, it } from "vitest";
import { decrementConsumption } from "./effect-consumption.js";
import type { AppliedEffect, EffectKindKey } from "../model/applied-effect.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import { createBattleUnitId } from "../../shared/ids.js";

const TARGET = createBattleUnitId("ally:1");
const SOURCE = createBattleUnitId("enemy:1");
const KIND = "ACT_EVASION" as EffectKindKey;

function consumableEffect(overrides: {
  readonly id: string;
  readonly kind:
    | "NEXT_OUTGOING_ATTACK"
    | "NEXT_INCOMING_ATTACK"
    | "OUTGOING_HIT"
    | "INCOMING_HIT"
    | "STATUS_BLOCKED"
    | "LETHAL_DAMAGE";
  readonly remaining: number;
}): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(overrides.id),
    effectActionDefinitionId: KIND as unknown as AppliedEffect["effectActionDefinitionId"],
    kindKey: KIND,
    duplicate: true,
    sourceId: SOURCE,
    targetId: TARGET,
    magnitude: 1,
    duration: {
      definition: {
        consumption: { kind: overrides.kind, maxCount: overrides.remaining },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      consumptionRemaining: overrides.remaining,
    },
    active: true,
  };
}

describe("decrementConsumption (R-EFF-07)", () => {
  it("UT-EFF-CONSUME-001: decrements the matching consumption kind's remaining count by 1", () => {
    const effects = [consumableEffect({ id: "e1", kind: "INCOMING_HIT", remaining: 2 })];

    const result = decrementConsumption(effects, "INCOMING_HIT");

    expect(result.changes).toEqual([{ effectInstanceId: "e1", before: 2, after: 1 }]);
    expect(result.effects[0]?.duration.consumptionRemaining).toBe(1);
  });

  it("UT-EFF-CONSUME-002: leaves effects with a different consumption kind untouched", () => {
    const effects = [consumableEffect({ id: "e1", kind: "OUTGOING_HIT", remaining: 2 })];

    const result = decrementConsumption(effects, "INCOMING_HIT");

    expect(result.changes).toEqual([]);
  });

  it("UT-EFF-CONSUME-003: leaves effects without a consumption definition untouched", () => {
    const noConsumption: AppliedEffect = {
      ...consumableEffect({ id: "e1", kind: "INCOMING_HIT", remaining: 2 }),
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    };

    const result = decrementConsumption([noConsumption], "INCOMING_HIT");

    expect(result.changes).toEqual([]);
  });

  it("UT-EFF-CONSUME-004: supports LETHAL_DAMAGE as a consumption kind (APPLY_DEATH_SURVIVAL)", () => {
    const effects = [consumableEffect({ id: "e1", kind: "LETHAL_DAMAGE", remaining: 1 })];

    const result = decrementConsumption(effects, "LETHAL_DAMAGE");

    expect(result.changes).toEqual([{ effectInstanceId: "e1", before: 1, after: 0 }]);
  });

  it("UT-EFF-CONSUME-005: does not decrement below 0", () => {
    const effects = [consumableEffect({ id: "e1", kind: "INCOMING_HIT", remaining: 0 })];

    const result = decrementConsumption(effects, "INCOMING_HIT");

    expect(result.changes).toEqual([]);
  });
});
