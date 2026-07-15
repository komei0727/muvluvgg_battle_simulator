import { describe, expect, it } from "vitest";
import { mapServerViolationsToUiViolations } from "./violation-mapper.js";
import type { ViolationResponseBody } from "./api-contract.js";

const allySlotKeys = ["ally:FRONT:0", "ally:FRONT:2"];
const enemySlotKeys = ["enemy:FRONT:1"];

describe("mapServerViolationsToUiViolations (UI-API-004)", () => {
  it("maps an ally unitDefinitionId violation back to its original slotKey", () => {
    const violations: readonly ViolationResponseBody[] = [
      { path: "/allyFormation/units/1/unitDefinitionId", message: "Unknown definition." },
    ];

    const result = mapServerViolationsToUiViolations(violations, allySlotKeys, enemySlotKeys);

    expect(result).toEqual([
      {
        path: "/allyFormation/units/1/unitDefinitionId",
        slotKey: "ally:FRONT:2",
        code: "SERVER_VIOLATION",
        message: "Unknown definition.",
        severity: "error",
      },
    ]);
  });

  it("maps an enemy position violation back to its original slotKey", () => {
    const violations: readonly ViolationResponseBody[] = [
      { path: "/enemyFormation/units/0/position", message: "Duplicate position." },
    ];

    const result = mapServerViolationsToUiViolations(violations, allySlotKeys, enemySlotKeys);

    expect(result).toEqual([
      {
        path: "/enemyFormation/units/0/position",
        slotKey: "enemy:FRONT:1",
        code: "SERVER_VIOLATION",
        message: "Duplicate position.",
        severity: "error",
      },
    ]);
  });

  it("uses the violation's ruleId as the code when present", () => {
    const violations: readonly ViolationResponseBody[] = [
      {
        path: "/allyFormation/units/0/unitDefinitionId",
        ruleId: "DEFINITION_NOT_FOUND",
        message: "Not found.",
      },
    ];

    const result = mapServerViolationsToUiViolations(violations, allySlotKeys, enemySlotKeys);

    expect(result[0]?.code).toBe("DEFINITION_NOT_FOUND");
  });

  it("omits slotKey for a violation whose index has no corresponding slot", () => {
    const violations: readonly ViolationResponseBody[] = [
      { path: "/allyFormation/units/5/unitDefinitionId", message: "Out of range." },
    ];

    const result = mapServerViolationsToUiViolations(violations, allySlotKeys, enemySlotKeys);

    expect(result[0]?.slotKey).toBeUndefined();
  });

  it("omits slotKey for a violation path unrelated to a unit slot", () => {
    const violations: readonly ViolationResponseBody[] = [
      { path: "/turnLimit", message: "must be 1-99" },
    ];

    const result = mapServerViolationsToUiViolations(violations, allySlotKeys, enemySlotKeys);

    expect(result[0]?.slotKey).toBeUndefined();
    expect(result[0]?.path).toBe("/turnLimit");
  });

  it("omits slotKey when the violation has no path", () => {
    const violations: readonly ViolationResponseBody[] = [{ message: "generic failure" }];

    const result = mapServerViolationsToUiViolations(violations, allySlotKeys, enemySlotKeys);

    expect(result[0]?.slotKey).toBeUndefined();
    expect(result[0]?.path).toBe("");
  });

  it("maps multiple violations independently", () => {
    const violations: readonly ViolationResponseBody[] = [
      { path: "/allyFormation/units/0/unitDefinitionId", message: "a" },
      { path: "/enemyFormation/units/0/unitDefinitionId", message: "b" },
    ];

    const result = mapServerViolationsToUiViolations(violations, allySlotKeys, enemySlotKeys);

    expect(result).toHaveLength(2);
    expect(result[0]?.slotKey).toBe("ally:FRONT:0");
    expect(result[1]?.slotKey).toBe("enemy:FRONT:1");
  });

  it("maps an ally memoryDefinitionIds violation to its memory slotKey (UI-CT-016)", () => {
    const violations: readonly ViolationResponseBody[] = [
      { path: "/allyFormation/memoryDefinitionIds/2", message: "Unknown memory." },
    ];

    const result = mapServerViolationsToUiViolations(violations, allySlotKeys, enemySlotKeys);

    expect(result[0]?.slotKey).toBe("ally:memory:2");
  });

  it("maps an enemy memoryDefinitionIds violation to its memory slotKey (UI-CT-016)", () => {
    const violations: readonly ViolationResponseBody[] = [
      { path: "/enemyFormation/memoryDefinitionIds/0", message: "Unknown memory." },
    ];

    const result = mapServerViolationsToUiViolations(violations, allySlotKeys, enemySlotKeys);

    expect(result[0]?.slotKey).toBe("enemy:memory:0");
  });

  it("passes through /options/logLevel without a slotKey", () => {
    const violations: readonly ViolationResponseBody[] = [
      { path: "/options/logLevel", message: "Unsupported log level." },
    ];

    const result = mapServerViolationsToUiViolations(violations, allySlotKeys, enemySlotKeys);

    expect(result[0]?.slotKey).toBeUndefined();
    expect(result[0]?.path).toBe("/options/logLevel");
  });
});
