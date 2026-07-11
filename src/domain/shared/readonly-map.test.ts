import { describe, expect, it } from "vitest";
import { toReadonlyMap } from "./readonly-map.js";

describe("toReadonlyMap", () => {
  it("UT-SHARED-ROMAP-001: exposes get/has/size for the wrapped entries", () => {
    const wrapped = toReadonlyMap(new Map([["a", 1]]));
    expect(wrapped.get("a")).toBe(1);
    expect(wrapped.has("a")).toBe(true);
    expect(wrapped.has("b")).toBe(false);
    expect(wrapped.size).toBe(1);
  });

  it("UT-SHARED-ROMAP-002: exposes keys/values/entries and default iteration", () => {
    const wrapped = toReadonlyMap(
      new Map([
        ["a", 1],
        ["b", 2],
      ]),
    );
    expect([...wrapped.keys()]).toEqual(["a", "b"]);
    expect([...wrapped.values()]).toEqual([1, 2]);
    expect([...wrapped.entries()]).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect([...wrapped]).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("UT-SHARED-ROMAP-003: forEach invokes the callback with (value, key, map)", () => {
    const wrapped = toReadonlyMap(new Map([["a", 1]]));
    const calls: unknown[] = [];
    wrapped.forEach((value, key, map) => calls.push([value, key, map === wrapped]));
    expect(calls).toEqual([[1, "a", true]]);
  });

  it("UT-SHARED-ROMAP-004: exposes no mutating methods even when cast to Map", () => {
    const wrapped: object = toReadonlyMap(new Map([["a", 1]]));
    expect("set" in wrapped).toBe(false);
    expect("delete" in wrapped).toBe(false);
    expect("clear" in wrapped).toBe(false);
  });

  it("UT-SHARED-ROMAP-005: is a defensive snapshot — mutating the source Map afterward does not leak through", () => {
    const source = new Map([["a", 1]]);
    const wrapped = toReadonlyMap(source);
    source.set("b", 2);
    source.delete("a");
    expect(wrapped.has("a")).toBe(true);
    expect(wrapped.has("b")).toBe(false);
  });
});
