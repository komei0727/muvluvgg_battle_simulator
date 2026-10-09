import { describe, expect, it } from "vitest";
import { splitDisplayName } from "./display-name.js";

// 01_UI要求・画面設計.md §9
describe("splitDisplayName", () => {
  it("UI-UT-CAT-011: splits a bracketed epithet from the name", () => {
    expect(splitDisplayName("【おたすけさんぽ・イン・サマー】リディア・エルドリッジ")).toEqual({
      epithet: "【おたすけさんぽ・イン・サマー】",
      name: "リディア・エルドリッジ",
    });
  });

  it("keeps a name without brackets whole", () => {
    expect(splitDisplayName("Charming Smile")).toEqual({ name: "Charming Smile" });
  });

  it.each(["【abc", "【】x", "【abc】"])(
    "treats %s as a single name when the bracket pair is incomplete or empty",
    (displayName) => {
      expect(splitDisplayName(displayName)).toEqual({ name: displayName });
    },
  );

  it("trims surrounding whitespace before splitting", () => {
    expect(splitDisplayName("  【二つ名】 名前  ")).toEqual({
      epithet: "【二つ名】",
      name: "名前",
    });
    expect(splitDisplayName("  Alpha  ")).toEqual({ name: "Alpha" });
  });
});
