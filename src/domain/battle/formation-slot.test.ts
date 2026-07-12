import { describe, expect, it } from "vitest";
import { createFormationSlot } from "./formation-slot.js";
import { createUnitDefinitionId } from "../catalog/catalog-ids.js";
import type { FormationPosition } from "./formation-input.js";

describe("createFormationSlot — R-POS-01 共通座標への変換", () => {
  it("UT-R-POS-01-020: derives the ALLY common coordinate for the slot's local position", () => {
    const position: FormationPosition = { column: "LEFT", row: "FRONT" };
    const slot = createFormationSlot(createUnitDefinitionId("UNIT_001"), "ALLY", position);

    expect(slot).toEqual({
      unitDefinitionId: createUnitDefinitionId("UNIT_001"),
      side: "ALLY",
      position,
      globalCoordinate: { x: 0, y: 2 },
    });
  });

  it("UT-R-POS-01-021: derives the ENEMY common coordinate for the slot's local position", () => {
    const position: FormationPosition = { column: "RIGHT", row: "BACK" };
    const slot = createFormationSlot(createUnitDefinitionId("UNIT_002"), "ENEMY", position);

    expect(slot.globalCoordinate).toEqual({ x: 2, y: 0 });
  });

  it("UT-R-POS-01-022: the derived common coordinate does not depend on the order slots are built in", () => {
    const positions: FormationPosition[] = [
      { column: "LEFT", row: "FRONT" },
      { column: "CENTER", row: "BACK" },
    ];
    const unitIds = [createUnitDefinitionId("UNIT_001"), createUnitDefinitionId("UNIT_002")];

    const forward = unitIds.map((id, i) => createFormationSlot(id, "ALLY", positions[i]!));
    const reversed = [...unitIds]
      .reverse()
      .map((id, i) => createFormationSlot(id, "ALLY", [...positions].reverse()[i]!));

    const coordinatesOf = (slots: typeof forward) =>
      new Set(slots.map((s) => `${s.globalCoordinate.x}:${s.globalCoordinate.y}`));

    expect(coordinatesOf(forward)).toEqual(coordinatesOf(reversed));
  });
});
