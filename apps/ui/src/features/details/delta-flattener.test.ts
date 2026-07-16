import { describe, expect, it } from "vitest";
import { flattenDelta } from "./delta-flattener.js";

describe("flattenDelta", () => {
  it("returns nothing for a non-object delta", () => {
    expect(flattenDelta(undefined)).toEqual([]);
    expect(flattenDelta(null)).toEqual([]);
    expect(flattenDelta(42)).toEqual([]);
  });

  it("emits a before/after line for a ValueChange leaf", () => {
    expect(flattenDelta({ battleStatus: { before: "READY", after: "RUNNING" } })).toEqual([
      { path: "battleStatus", text: "READY → RUNNING" },
    ]);
  });

  it("recurses through nested objects, building a dotted path", () => {
    expect(flattenDelta({ units: { "ally:1": { hp: { before: 100, after: 80 } } } })).toEqual([
      { path: "units.ally:1.hp", text: "100 → 80" },
    ]);
  });

  it("summarizes an EntityCollectionDelta as add/update/remove counts", () => {
    expect(
      flattenDelta({
        effects: { added: [{ id: "e1" }], updated: [], removed: [{ id: "e2" }] },
      }),
    ).toEqual([{ path: "effects", text: "+1 / ~0 / -1" }]);
  });

  it("produces no lines for an empty delta object", () => {
    expect(flattenDelta({})).toEqual([]);
  });
});
