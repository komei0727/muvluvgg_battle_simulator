import { describe, expect, it } from "vitest";
import { mapServerViolationsToUiViolations } from "./violation-mapper.js";
import type { ViolationResponseBody } from "./api-contract.js";

const allySlotKeys = ["ally:FRONT:0", "ally:FRONT:2"];
const enemySlotKeys = ["enemy:FRONT:1"];
const allyMemorySlotKeys = ["ally:memory:0"];
const enemyMemorySlotKeys = ["enemy:memory:1"];

function map(violations: readonly ViolationResponseBody[]) {
  return mapServerViolationsToUiViolations(
    violations,
    allySlotKeys,
    enemySlotKeys,
    allyMemorySlotKeys,
    enemyMemorySlotKeys,
  );
}

describe("mapServerViolationsToUiViolations (UI-API-004)", () => {
  it("maps an ally unitDefinitionId violation back to its original slotKey", () => {
    const result = map([
      { path: "/allyFormation/units/1/unitDefinitionId", message: "Unknown definition." },
    ]);

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
    const result = map([
      { path: "/enemyFormation/units/0/position", message: "Duplicate position." },
    ]);

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
    const result = map([
      {
        path: "/allyFormation/units/0/unitDefinitionId",
        ruleId: "DEFINITION_NOT_FOUND",
        message: "Not found.",
      },
    ]);

    expect(result[0]?.code).toBe("DEFINITION_NOT_FOUND");
  });

  it("omits slotKey for a violation whose index has no corresponding slot", () => {
    const result = map([
      { path: "/allyFormation/units/5/unitDefinitionId", message: "Out of range." },
    ]);

    expect(result[0]?.slotKey).toBeUndefined();
  });

  it("omits slotKey for a violation path unrelated to a unit slot", () => {
    const result = map([{ path: "/turnLimit", message: "must be 1-99" }]);

    expect(result[0]?.slotKey).toBeUndefined();
    expect(result[0]?.path).toBe("/turnLimit");
  });

  it("omits slotKey when the violation has no path", () => {
    const result = map([{ message: "generic failure" }]);

    expect(result[0]?.slotKey).toBeUndefined();
    expect(result[0]?.path).toBe("");
  });

  it("maps multiple violations independently", () => {
    const result = map([
      { path: "/allyFormation/units/0/unitDefinitionId", message: "a" },
      { path: "/enemyFormation/units/0/unitDefinitionId", message: "b" },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]?.slotKey).toBe("ally:FRONT:0");
    expect(result[1]?.slotKey).toBe("enemy:FRONT:1");
  });

  it("maps an ally memoryDefinitionIds violation via the submission-time memory slot map (UI-CT-016)", () => {
    const result = map([
      { path: "/allyFormation/memoryDefinitionIds/0", message: "Unknown memory." },
    ]);

    expect(result[0]?.slotKey).toBe("ally:memory:0");
  });

  it("maps an enemy memoryDefinitionIds violation via the submission-time memory slot map (UI-CT-016)", () => {
    const result = map([
      { path: "/enemyFormation/memoryDefinitionIds/0", message: "Unknown memory." },
    ]);

    expect(result[0]?.slotKey).toBe("enemy:memory:1");
  });

  // P2 regression: request-mapper.ts compresses memoryDefinitionIds (empty
  // slots removed), so the API array index does not equal the UI memory slot
  // index. A sparse layout must resolve through the memory slot map, not
  // memorySlotKeyOf(side, apiIndex) directly.
  it("resolves a sparse memory layout through the memory slot map instead of the raw API index", () => {
    // UI memory slot 2 was the only one filled; the API sees it compressed
    // to memoryDefinitionIds[0], and the memory slot map records that.
    const sparseAllyMemorySlotKeys = ["ally:memory:2"];

    const result = mapServerViolationsToUiViolations(
      [{ path: "/allyFormation/memoryDefinitionIds/0", message: "Unknown memory." }],
      allySlotKeys,
      enemySlotKeys,
      sparseAllyMemorySlotKeys,
      enemyMemorySlotKeys,
    );

    expect(result[0]?.slotKey).toBe("ally:memory:2");
  });

  it("omits slotKey for a memoryDefinitionIds violation whose index has no corresponding entry", () => {
    const result = map([
      { path: "/allyFormation/memoryDefinitionIds/5", message: "Out of range." },
    ]);

    expect(result[0]?.slotKey).toBeUndefined();
  });

  it("passes through /options/logLevel without a slotKey", () => {
    const result = map([{ path: "/options/logLevel", message: "Unsupported log level." }]);

    expect(result[0]?.slotKey).toBeUndefined();
    expect(result[0]?.path).toBe("/options/logLevel");
  });
});
