import { describe, expect, it } from "vitest";
import { validateFormationInput, type FormationInput } from "./formation-input.js";
import { createMemoryDefinitionId, createUnitDefinitionId } from "../catalog/catalog-ids.js";
import { DomainValidationError } from "../shared/errors.js";

function slot(
  unitDefinitionId: string,
  column: "LEFT" | "CENTER" | "RIGHT",
  row: "FRONT" | "BACK",
) {
  return {
    unitDefinitionId: createUnitDefinitionId(unitDefinitionId),
    position: { column, row },
  };
}

function formation(slots: FormationInput["slots"], memoryCount = 0): FormationInput {
  return {
    slots,
    memoryDefinitionIds: Array.from({ length: memoryCount }, (_, i) =>
      createMemoryDefinitionId(`MEM_${String(i).padStart(3, "0")}`),
    ),
  };
}

describe("validateFormationInput — R-FRM-01 編成人数", () => {
  it("UT-R-FRM-01-001: rejects an empty formation (0 units)", () => {
    expect(() => validateFormationInput(formation([]), "allyFormation")).toThrow(
      DomainValidationError,
    );
  });

  it("UT-R-FRM-01-002: accepts the lower bound of 1 unit", () => {
    expect(() =>
      validateFormationInput(formation([slot("UNIT_001", "LEFT", "FRONT")]), "allyFormation"),
    ).not.toThrow();
  });

  it("UT-R-FRM-01-003: accepts the upper bound of 5 units", () => {
    const slots = [
      slot("UNIT_001", "LEFT", "FRONT"),
      slot("UNIT_002", "CENTER", "FRONT"),
      slot("UNIT_003", "RIGHT", "FRONT"),
      slot("UNIT_004", "LEFT", "BACK"),
      slot("UNIT_005", "CENTER", "BACK"),
    ];
    expect(() => validateFormationInput(formation(slots), "allyFormation")).not.toThrow();
  });

  it("UT-R-FRM-01-004: rejects 6 units", () => {
    const slots = [
      slot("UNIT_001", "LEFT", "FRONT"),
      slot("UNIT_002", "CENTER", "FRONT"),
      slot("UNIT_003", "RIGHT", "FRONT"),
      slot("UNIT_004", "LEFT", "BACK"),
      slot("UNIT_005", "CENTER", "BACK"),
      slot("UNIT_006", "RIGHT", "BACK"),
    ];
    expect(() => validateFormationInput(formation(slots), "allyFormation")).toThrow(
      DomainValidationError,
    );
  });
});

describe("validateFormationInput — R-FRM-02 配置", () => {
  it("UT-R-FRM-02-001: accepts distinct positions within the same formation", () => {
    const slots = [slot("UNIT_001", "LEFT", "FRONT"), slot("UNIT_002", "LEFT", "BACK")];
    expect(() => validateFormationInput(formation(slots), "allyFormation")).not.toThrow();
  });

  it("UT-R-FRM-02-002: rejects a duplicated column+row within the same formation", () => {
    const slots = [slot("UNIT_001", "LEFT", "FRONT"), slot("UNIT_002", "LEFT", "FRONT")];
    expect(() => validateFormationInput(formation(slots), "allyFormation")).toThrow(
      DomainValidationError,
    );
  });

  it("UT-R-FRM-02-003: result does not depend on input order", () => {
    const forward = [slot("UNIT_001", "LEFT", "FRONT"), slot("UNIT_002", "LEFT", "FRONT")];
    const reversed = [slot("UNIT_002", "LEFT", "FRONT"), slot("UNIT_001", "LEFT", "FRONT")];
    expect(() => validateFormationInput(formation(forward), "allyFormation")).toThrow(
      DomainValidationError,
    );
    expect(() => validateFormationInput(formation(reversed), "allyFormation")).toThrow(
      DomainValidationError,
    );
  });
});

describe("validateFormationInput — R-FRM-03 ユニット重複", () => {
  it("UT-R-FRM-03-001: allows the same UnitDefinitionId in two distinct positions", () => {
    const slots = [slot("UNIT_001", "LEFT", "FRONT"), slot("UNIT_001", "CENTER", "FRONT")];
    expect(() => validateFormationInput(formation(slots), "allyFormation")).not.toThrow();
  });
});

describe("validateFormationInput — R-FRM-04 メモリー指定", () => {
  const oneSlot = [slot("UNIT_001", "LEFT", "FRONT")];

  it("UT-R-FRM-04-001: accepts 0 memory IDs", () => {
    expect(() => validateFormationInput(formation(oneSlot, 0), "allyFormation")).not.toThrow();
  });

  it("UT-R-FRM-04-002: accepts the upper bound of 6 memory IDs", () => {
    expect(() => validateFormationInput(formation(oneSlot, 6), "allyFormation")).not.toThrow();
  });

  it("UT-R-FRM-04-003: rejects 7 memory IDs", () => {
    expect(() => validateFormationInput(formation(oneSlot, 7), "allyFormation")).toThrow(
      DomainValidationError,
    );
  });
});
