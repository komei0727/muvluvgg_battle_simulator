import { describe, expect, it } from "vitest";
import { isLinkedGroupParent, linkedGroupChildren } from "./linked-effect-group.js";
import type { LinkedGroupMember } from "./linked-effect-group.js";

function member(key: string, linkedEffectGroupId: string | null): LinkedGroupMember {
  return { key, linkedEffectGroupId };
}

describe("linked-effect-group (R-EFF-09)", () => {
  it("UT-EFF-LINK-001: the earliest-granted member of a group is its parent", () => {
    const group = [member("e1", "GROUP_A"), member("e2", "GROUP_A"), member("e3", "GROUP_A")];

    expect(isLinkedGroupParent(group[0]!, group)).toBe(true);
    expect(isLinkedGroupParent(group[1]!, group)).toBe(false);
    expect(isLinkedGroupParent(group[2]!, group)).toBe(false);
  });

  it("UT-EFF-LINK-002: a member without a linkedEffectGroupId is never a parent", () => {
    const solo = member("e1", null);

    expect(isLinkedGroupParent(solo, [solo])).toBe(false);
  });

  it("UT-EFF-LINK-003: linkedGroupChildren returns every other member sharing the same group id", () => {
    const group = [member("e1", "GROUP_A"), member("e2", "GROUP_A"), member("e3", "GROUP_A")];

    expect(linkedGroupChildren(group[0]!, group).map((m) => m.key)).toEqual(["e2", "e3"]);
  });

  it("UT-EFF-LINK-004: linkedGroupChildren ignores members from a different group", () => {
    const groupA1 = member("e1", "GROUP_A");
    const groupB = member("e2", "GROUP_B");
    const groupA2 = member("e3", "GROUP_A");

    expect(linkedGroupChildren(groupA1, [groupA1, groupB, groupA2]).map((m) => m.key)).toEqual([
      "e3",
    ]);
  });

  it("UT-EFF-LINK-005: a child expiring does not report itself as a parent, so callers know not to cascade (子効果だけが消費条件で失効した場合、親効果は維持する)", () => {
    const group = [member("e1", "GROUP_A"), member("e2", "GROUP_A")];

    expect(isLinkedGroupParent(group[1]!, group)).toBe(false);
  });
});
