import { describe, expect, it } from "vitest";
import { recomputeActiveEffects } from "./effect-duplicate-resolution.js";
import type { AppliedEffect, EffectKindKey } from "../model/applied-effect.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import { createBattleUnitId } from "../../shared/ids.js";

const TARGET = createBattleUnitId("ally:1");
const SOURCE = createBattleUnitId("enemy:1");
const KIND_A = "ACT_BUFF_ATTACK" as EffectKindKey;
const KIND_B = "ACT_DEBUFF_DEFENSE" as EffectKindKey;

function effect(overrides: {
  readonly id: string;
  readonly kindKey: EffectKindKey;
  readonly duplicate: boolean;
  readonly magnitude: number;
  readonly active?: boolean;
}): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(overrides.id),
    effectActionDefinitionId:
      overrides.kindKey as unknown as AppliedEffect["effectActionDefinitionId"],
    kindKey: overrides.kindKey,
    duplicate: overrides.duplicate,
    sourceId: SOURCE,
    targetId: TARGET,
    magnitude: overrides.magnitude,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    active: overrides.active ?? true,
  };
}

describe("recomputeActiveEffects (R-EFF-05 / R-STA-03)", () => {
  it("UT-EFF-DUP-001: keeps all duplicate-allowed effects active regardless of magnitude", () => {
    const effects = [
      effect({ id: "e1", kindKey: KIND_A, duplicate: true, magnitude: 10 }),
      effect({ id: "e2", kindKey: KIND_A, duplicate: true, magnitude: 5 }),
    ];

    const result = recomputeActiveEffects(effects);

    expect(result.map((e) => e.active)).toEqual([true, true]);
  });

  it("UT-EFF-DUP-002: activates only the strongest non-duplicate effect within a kindKey group", () => {
    const effects = [
      effect({ id: "e1", kindKey: KIND_A, duplicate: false, magnitude: 10 }),
      effect({ id: "e2", kindKey: KIND_A, duplicate: false, magnitude: 25 }),
      effect({ id: "e3", kindKey: KIND_A, duplicate: false, magnitude: 15 }),
    ];

    const result = recomputeActiveEffects(effects);

    expect(result.find((e) => e.effectInstanceId === "e2")?.active).toBe(true);
    expect(result.find((e) => e.effectInstanceId === "e1")?.active).toBe(false);
    expect(result.find((e) => e.effectInstanceId === "e3")?.active).toBe(false);
  });

  it("UT-EFF-DUP-003: compares debuffs by the size of the weakening amount (absolute value of a negative magnitude)", () => {
    const effects = [
      effect({ id: "e1", kindKey: KIND_B, duplicate: false, magnitude: -10 }),
      effect({ id: "e2", kindKey: KIND_B, duplicate: false, magnitude: -30 }),
    ];

    const result = recomputeActiveEffects(effects);

    expect(result.find((e) => e.effectInstanceId === "e2")?.active).toBe(true);
    expect(result.find((e) => e.effectInstanceId === "e1")?.active).toBe(false);
  });

  it("UT-EFF-DUP-004: keeps the earliest-granted (first in array order) effect active on a magnitude tie (R-STA-03 #3)", () => {
    const effects = [
      effect({ id: "e1", kindKey: KIND_A, duplicate: false, magnitude: 20 }),
      effect({ id: "e2", kindKey: KIND_A, duplicate: false, magnitude: 20 }),
    ];

    const result = recomputeActiveEffects(effects);

    expect(result.find((e) => e.effectInstanceId === "e1")?.active).toBe(true);
    expect(result.find((e) => e.effectInstanceId === "e2")?.active).toBe(false);
  });

  it("UT-EFF-DUP-005: promotes the next-strongest effect once the active one is removed from the array", () => {
    const afterGrant = recomputeActiveEffects([
      effect({ id: "e1", kindKey: KIND_A, duplicate: false, magnitude: 25 }),
      effect({ id: "e2", kindKey: KIND_A, duplicate: false, magnitude: 15 }),
    ]);
    expect(afterGrant.find((e) => e.effectInstanceId === "e1")?.active).toBe(true);

    const afterExpiry = recomputeActiveEffects(
      afterGrant.filter((e) => e.effectInstanceId !== "e1"),
    );

    expect(afterExpiry.find((e) => e.effectInstanceId === "e2")?.active).toBe(true);
  });

  it("UT-EFF-DUP-006: does not let different kindKey groups interfere with each other", () => {
    const effects = [
      effect({ id: "e1", kindKey: KIND_A, duplicate: false, magnitude: 10 }),
      effect({ id: "e2", kindKey: KIND_B, duplicate: false, magnitude: 5 }),
    ];

    const result = recomputeActiveEffects(effects);

    expect(result.find((e) => e.effectInstanceId === "e1")?.active).toBe(true);
    expect(result.find((e) => e.effectInstanceId === "e2")?.active).toBe(true);
  });
});
