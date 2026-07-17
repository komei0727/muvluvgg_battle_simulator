import { describe, expect, it } from "vitest";
import {
  createEmptyPassiveActivationGuard,
  hasActivated,
  recordActivation,
} from "./passive-activation-guard.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createSkillDefinitionId } from "../../catalog/definitions/catalog-ids.js";

describe("PassiveActivationGuard", () => {
  const unitA = createBattleUnitId("UNIT_A");
  const unitB = createBattleUnitId("UNIT_B");
  const skillX = createSkillDefinitionId("SKL_X");
  const skillY = createSkillDefinitionId("SKL_Y");

  it("UT-R-PS-07-001: a fresh guard has not activated anything", () => {
    const guard = createEmptyPassiveActivationGuard();
    expect(hasActivated(guard, unitA, skillX)).toBe(false);
  });

  it("UT-R-PS-07-002: recording an activation makes it visible for the same unit+skill pair only", () => {
    const guard = recordActivation(createEmptyPassiveActivationGuard(), unitA, skillX);
    expect(hasActivated(guard, unitA, skillX)).toBe(true);
    expect(hasActivated(guard, unitA, skillY)).toBe(false);
    expect(hasActivated(guard, unitB, skillX)).toBe(false);
  });

  it("UT-R-PS-07-003: recordActivation does not mutate the original guard (immutable)", () => {
    const original = createEmptyPassiveActivationGuard();
    const updated = recordActivation(original, unitA, skillX);
    expect(hasActivated(original, unitA, skillX)).toBe(false);
    expect(hasActivated(updated, unitA, skillX)).toBe(true);
  });

  it("UT-R-PS-07-004: recording twice for the same pair is idempotent", () => {
    const once = recordActivation(createEmptyPassiveActivationGuard(), unitA, skillX);
    const twice = recordActivation(once, unitA, skillX);
    expect(hasActivated(twice, unitA, skillX)).toBe(true);
  });
});
