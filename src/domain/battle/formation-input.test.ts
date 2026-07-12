import { describe, expect, it } from "vitest";
import { validateFormationInput, type FormationInput } from "./formation-input.js";
import {
  createMemoryDefinitionId,
  createUnitDefinitionId,
  type MemoryDefinitionId,
} from "../catalog/catalog-ids.js";
import { DomainValidationError } from "../shared/errors.js";

function slot(unitDefinitionId: string, column: string, row: string) {
  return {
    unitDefinitionId: createUnitDefinitionId(unitDefinitionId),
    position: { column, row },
  } as FormationInput["slots"][number];
}

function memoryIds(count: number): MemoryDefinitionId[] {
  return Array.from({ length: count }, (_, i) =>
    createMemoryDefinitionId(`MEM_${String(i).padStart(3, "0")}`),
  );
}

function formation(slots: FormationInput["slots"], memoryCount = 0): FormationInput {
  return {
    slots,
    memoryDefinitionIds: memoryIds(memoryCount),
  };
}

const NO_KNOWN_MEMORIES: ReadonlySet<MemoryDefinitionId> = new Set();

describe("validateFormationInput — R-FRM-01 編成人数", () => {
  it("UT-R-FRM-01-001: rejects an empty formation (0 units)", () => {
    expect(() => validateFormationInput(formation([]), NO_KNOWN_MEMORIES, "allyFormation")).toThrow(
      DomainValidationError,
    );
  });

  it("UT-R-FRM-01-002: accepts the lower bound of 1 unit", () => {
    expect(() =>
      validateFormationInput(
        formation([slot("UNIT_001", "LEFT", "FRONT")]),
        NO_KNOWN_MEMORIES,
        "allyFormation",
      ),
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
    expect(() =>
      validateFormationInput(formation(slots), NO_KNOWN_MEMORIES, "allyFormation"),
    ).not.toThrow();
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
    expect(() =>
      validateFormationInput(formation(slots), NO_KNOWN_MEMORIES, "allyFormation"),
    ).toThrow(DomainValidationError);
  });
});

describe("validateFormationInput — R-FRM-02 配置", () => {
  it("UT-R-FRM-02-001: accepts distinct positions within the same formation", () => {
    const slots = [slot("UNIT_001", "LEFT", "FRONT"), slot("UNIT_002", "LEFT", "BACK")];
    expect(() =>
      validateFormationInput(formation(slots), NO_KNOWN_MEMORIES, "allyFormation"),
    ).not.toThrow();
  });

  it("UT-R-FRM-02-002: rejects a duplicated column+row within the same formation", () => {
    const slots = [slot("UNIT_001", "LEFT", "FRONT"), slot("UNIT_002", "LEFT", "FRONT")];
    expect(() =>
      validateFormationInput(formation(slots), NO_KNOWN_MEMORIES, "allyFormation"),
    ).toThrow(DomainValidationError);
  });

  it("UT-R-FRM-02-003: result does not depend on input order", () => {
    const forward = [slot("UNIT_001", "LEFT", "FRONT"), slot("UNIT_002", "LEFT", "FRONT")];
    const reversed = [slot("UNIT_002", "LEFT", "FRONT"), slot("UNIT_001", "LEFT", "FRONT")];
    expect(() =>
      validateFormationInput(formation(forward), NO_KNOWN_MEMORIES, "allyFormation"),
    ).toThrow(DomainValidationError);
    expect(() =>
      validateFormationInput(formation(reversed), NO_KNOWN_MEMORIES, "allyFormation"),
    ).toThrow(DomainValidationError);
  });

  it("UT-R-FRM-02-004: rejects a column value outside LEFT/CENTER/RIGHT", () => {
    const slots = [slot("UNIT_001", "MIDDLE", "FRONT")];
    expect(() =>
      validateFormationInput(formation(slots), NO_KNOWN_MEMORIES, "allyFormation"),
    ).toThrow(DomainValidationError);
  });

  it("UT-R-FRM-02-005: rejects a row value outside FRONT/BACK", () => {
    const slots = [slot("UNIT_001", "LEFT", "SIDE")];
    expect(() =>
      validateFormationInput(formation(slots), NO_KNOWN_MEMORIES, "allyFormation"),
    ).toThrow(DomainValidationError);
  });
});

describe("validateFormationInput — R-FRM-03 ユニット重複", () => {
  it("UT-R-FRM-03-001: allows the same UnitDefinitionId in two distinct positions", () => {
    const slots = [slot("UNIT_001", "LEFT", "FRONT"), slot("UNIT_001", "CENTER", "FRONT")];
    expect(() =>
      validateFormationInput(formation(slots), NO_KNOWN_MEMORIES, "allyFormation"),
    ).not.toThrow();
  });
});

describe("validateFormationInput — R-FRM-04 メモリー指定", () => {
  const oneSlot = [slot("UNIT_001", "LEFT", "FRONT")];

  it("UT-R-FRM-04-001: accepts 0 memory IDs", () => {
    expect(() =>
      validateFormationInput(formation(oneSlot, 0), NO_KNOWN_MEMORIES, "allyFormation"),
    ).not.toThrow();
  });

  it("UT-R-FRM-04-002: accepts the upper bound of 6 memory IDs, all known", () => {
    const known = new Set(memoryIds(6));
    expect(() =>
      validateFormationInput(formation(oneSlot, 6), known, "allyFormation"),
    ).not.toThrow();
  });

  it("UT-R-FRM-04-003: rejects 7 memory IDs even when all are known", () => {
    const known = new Set(memoryIds(7));
    expect(() => validateFormationInput(formation(oneSlot, 7), known, "allyFormation")).toThrow(
      DomainValidationError,
    );
  });

  it("UT-R-FRM-04-004: rejects a memory ID absent from the known set", () => {
    expect(() =>
      validateFormationInput(formation(oneSlot, 1), NO_KNOWN_MEMORIES, "allyFormation"),
    ).toThrow(DomainValidationError);
  });

  it("UT-R-FRM-04-005: accepts a memory ID present in the known set", () => {
    const known = new Set(memoryIds(1));
    expect(() =>
      validateFormationInput(formation(oneSlot, 1), known, "allyFormation"),
    ).not.toThrow();
  });

  it("UT-R-FRM-04-006: rejects when only some memory IDs are known", () => {
    const known = new Set(memoryIds(1));
    expect(() => validateFormationInput(formation(oneSlot, 2), known, "allyFormation")).toThrow(
      DomainValidationError,
    );
  });
});
