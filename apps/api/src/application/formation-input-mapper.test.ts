import { describe, expect, it } from "vitest";
import { toDomainFormationInput, toDomainFormationPosition } from "./formation-input-mapper.js";
import { createMemoryDefinitionId, createUnitDefinitionId } from "../domain/catalog/catalog-ids.js";

describe("toDomainFormationPosition", () => {
  it.each([
    [0, "LEFT"],
    [1, "CENTER"],
    [2, "RIGHT"],
  ] as const)(
    "UT-FORMATION-MAPPER-001: maps column %i to %s (10_API設計.md: 俯瞰時の絶対左から0,1,2)",
    (column, expectedColumn) => {
      expect(toDomainFormationPosition({ column, row: "FRONT" }).column).toBe(expectedColumn);
    },
  );

  it("UT-FORMATION-MAPPER-002: maps row FRONT to Domain FRONT", () => {
    expect(toDomainFormationPosition({ column: 0, row: "FRONT" }).row).toBe("FRONT");
  });

  it("UT-FORMATION-MAPPER-003: maps row REAR to Domain BACK (10_API設計.md: 各陣営から敵へ近い側がFRONT / formation-input.ts POSITION_ROWS=[FRONT,BACK])", () => {
    expect(toDomainFormationPosition({ column: 0, row: "REAR" }).row).toBe("BACK");
  });
});

describe("toDomainFormationInput", () => {
  it("UT-FORMATION-MAPPER-004: maps every slot's position and passes memoryDefinitionIds through unchanged", () => {
    const result = toDomainFormationInput({
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: 0, row: "FRONT" },
        },
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_002"),
          position: { column: 2, row: "REAR" },
        },
      ],
      memoryDefinitionIds: [createMemoryDefinitionId("MEM_001")],
    });

    expect(result).toEqual({
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "FRONT" },
        },
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_002"),
          position: { column: "RIGHT", row: "BACK" },
        },
      ],
      memoryDefinitionIds: [createMemoryDefinitionId("MEM_001")],
    });
  });
});
