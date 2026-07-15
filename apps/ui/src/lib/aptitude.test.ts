import { describe, expect, it } from "vitest";
import { aptitudeMatches } from "./aptitude.js";

describe("aptitudeMatches", () => {
  // docs/ui-design/03_API・データ連携設計.md §4: Catalogの`BACK`をUI`REAR`と対応させる。
  it("matches FRONT aptitude against a Catalog FRONT entry", () => {
    expect(aptitudeMatches("FRONT", ["FRONT"])).toBe(true);
  });

  it("does not match FRONT aptitude against a Catalog BACK-only entry", () => {
    expect(aptitudeMatches("FRONT", ["BACK"])).toBe(false);
  });

  it("matches REAR aptitude against a Catalog BACK entry", () => {
    expect(aptitudeMatches("REAR", ["BACK"])).toBe(true);
  });

  it("does not match REAR aptitude against a Catalog FRONT-only entry", () => {
    expect(aptitudeMatches("REAR", ["FRONT"])).toBe(false);
  });

  it("matches when the Catalog entry lists both aptitudes", () => {
    expect(aptitudeMatches("REAR", ["FRONT", "BACK"])).toBe(true);
  });
});
