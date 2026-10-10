import { describe, expect, it } from "vitest";
import { createMarkerReference, referencedMarkerIds } from "./marker-reference.js";
import { DomainValidationError } from "../../shared/errors.js";

describe("MarkerReference", () => {
  it("UT-CAT-MRK-001: a single markerId is kept as-is and references exactly that marker", () => {
    const reference = createMarkerReference({ markerId: "MARKER_A" }, "formula");

    expect(reference).toEqual({ markerId: "MARKER_A" });
    expect(referencedMarkerIds(reference)).toEqual(["MARKER_A"]);
  });

  it("UT-CAT-MRK-002: markerIds references every listed marker in declaration order", () => {
    const reference = createMarkerReference({ markerIds: ["MARKER_A", "MARKER_B"] }, "formula");

    expect(reference).toEqual({ markerIds: ["MARKER_A", "MARKER_B"] });
    expect(referencedMarkerIds(reference)).toEqual(["MARKER_A", "MARKER_B"]);
  });

  it("UT-CAT-MRK-003: rejects declaring both markerId and markerIds, or neither", () => {
    expect(() =>
      createMarkerReference({ markerId: "MARKER_A", markerIds: ["MARKER_B"] }, "formula"),
    ).toThrow(DomainValidationError);
    expect(() => createMarkerReference({}, "formula")).toThrow(DomainValidationError);
  });

  it("UT-CAT-MRK-004: rejects an empty markerIds, a duplicated entry, and a non-string entry", () => {
    for (const markerIds of [[], ["MARKER_A", "MARKER_A"], ["MARKER_A", 1]]) {
      expect(() => createMarkerReference({ markerIds }, "formula")).toThrow(DomainValidationError);
    }
  });
});
