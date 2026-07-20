import { describe, expect, it } from "vitest";
import { findEffectsWithSatisfiedExpiration } from "./effect-special-expiration.js";
import type { AppliedEffect, EffectKindKey } from "../model/applied-effect.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import { createBattleUnitId } from "../../shared/ids.js";
import type { ConditionDefinition } from "../../catalog/definitions/condition-definition.js";

const TARGET = createBattleUnitId("ally:1");
const SOURCE = createBattleUnitId("enemy:1");
const KIND = "ACT_TAUNT" as EffectKindKey;

function effectWithExpiration(
  id: string,
  conditions: readonly ConditionDefinition[],
): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: KIND as unknown as AppliedEffect["effectActionDefinitionId"],
    kindKey: KIND,
    duplicate: true,
    sourceId: SOURCE,
    targetId: TARGET,
    magnitude: 1,
    duration: {
      definition: { expiration: { conditions }, dispellable: true, linkedEffectGroupId: null },
    },
    active: true,
  };
}

describe("findEffectsWithSatisfiedExpiration (R-EFF-08)", () => {
  it("UT-EFF-EXPIRE-001: returns an effect whose expiration condition is satisfied by the causing event", () => {
    const effect = effectWithExpiration("e1", [
      { kind: "EVENT_PAYLOAD", field: "defeated", op: "EQ", value: true },
    ]);

    const result = findEffectsWithSatisfiedExpiration([effect], { payload: { defeated: true } });

    expect(result.map((e) => e.effectInstanceId)).toEqual(["e1"]);
  });

  it("UT-EFF-EXPIRE-002: does not return an effect whose expiration condition is not satisfied", () => {
    const effect = effectWithExpiration("e1", [
      { kind: "EVENT_PAYLOAD", field: "defeated", op: "EQ", value: true },
    ]);

    const result = findEffectsWithSatisfiedExpiration([effect], { payload: { defeated: false } });

    expect(result).toEqual([]);
  });

  it("UT-EFF-EXPIRE-003: treats multiple conditions as OR (any one satisfied expires the effect)", () => {
    const effect = effectWithExpiration("e1", [
      { kind: "EVENT_PAYLOAD", field: "a", op: "EQ", value: true },
      { kind: "EVENT_PAYLOAD", field: "b", op: "EQ", value: true },
    ]);

    const result = findEffectsWithSatisfiedExpiration([effect], { payload: { a: false, b: true } });

    expect(result.map((e) => e.effectInstanceId)).toEqual(["e1"]);
  });

  it("UT-EFF-EXPIRE-004: ignores effects without an expiration definition", () => {
    const noExpiration: AppliedEffect = {
      ...effectWithExpiration("e1", []),
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    };

    const result = findEffectsWithSatisfiedExpiration([noExpiration], { payload: {} });

    expect(result).toEqual([]);
  });
});
