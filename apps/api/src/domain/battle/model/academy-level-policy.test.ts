import { describe, expect, it } from "vitest";
import {
  calculateAcademyLevelAddition,
  resolveAcademyLevelAddition,
} from "./academy-level-policy.js";
import { fc, PROPERTY_ASSERT_CONFIG } from "../../../testing/property/index.js";

describe("calculateAcademyLevelAddition — R-ENH-02 学園レベル加算", () => {
  it("UT-R-ENH-02-001: 物理タイプ学園レベル50 adds HP+2040 / attack+1440 / defense+800", () => {
    expect(calculateAcademyLevelAddition("UNIT_TYPE", 50)).toEqual({
      hp: 2040,
      attack: 1440,
      defense: 800,
    });
  });

  it("UT-R-ENH-02-002: 属性学園レベル50 adds HP+4080 / attack+2880 / defense+1600", () => {
    expect(calculateAcademyLevelAddition("ATTRIBUTE", 50)).toEqual({
      hp: 4080,
      attack: 2880,
      defense: 1600,
    });
  });

  it("UT-R-ENH-02-003: level 1 is the starting level and adds nothing", () => {
    expect(calculateAcademyLevelAddition("UNIT_TYPE", 1)).toEqual({ hp: 0, attack: 0, defense: 0 });
    expect(calculateAcademyLevelAddition("ATTRIBUTE", 1)).toEqual({ hp: 0, attack: 0, defense: 0 });
  });

  it("UT-R-ENH-02-004: boundary — levels 2/3/4 fill the HP→attack→defense rotation one step at a time", () => {
    expect(calculateAcademyLevelAddition("UNIT_TYPE", 2)).toEqual({
      hp: 120,
      attack: 0,
      defense: 0,
    });
    expect(calculateAcademyLevelAddition("UNIT_TYPE", 3)).toEqual({
      hp: 120,
      attack: 90,
      defense: 0,
    });
    expect(calculateAcademyLevelAddition("UNIT_TYPE", 4)).toEqual({
      hp: 120,
      attack: 90,
      defense: 50,
    });
  });

  it("UT-R-ENH-02-005: boundary — the rotation restarts at HP on the fifth level", () => {
    expect(calculateAcademyLevelAddition("ATTRIBUTE", 5)).toEqual({
      hp: 480,
      attack: 180,
      defense: 100,
    });
  });
});

describe("resolveAcademyLevelAddition — R-ENH-02 系統の選択", () => {
  it("UT-R-ENH-02-006: sums only the unit's own type system and own attribute system", () => {
    const addition = resolveAcademyLevelAddition(
      {
        unitTypes: { PHYSICAL: 50, ENERGY: 100 },
        attributes: { AGGRESSIVE: 50, CLEVER: 100 },
      },
      "PHYSICAL",
      "AGGRESSIVE",
    );
    expect(addition).toEqual({ hp: 2040 + 4080, attack: 1440 + 2880, defense: 800 + 1600 });
  });

  it("UT-R-ENH-02-007: treats an omitted system as level 1 (no addition)", () => {
    expect(resolveAcademyLevelAddition({ unitTypes: { PHYSICAL: 50 } }, "AGILE", "SHY")).toEqual({
      hp: 0,
      attack: 0,
      defense: 0,
    });
    expect(resolveAcademyLevelAddition(undefined, "PHYSICAL", "AGGRESSIVE")).toEqual({
      hp: 0,
      attack: 0,
      defense: 0,
    });
  });

  it("UT-R-ENH-02-008: has no upper level bound", () => {
    expect(resolveAcademyLevelAddition({ unitTypes: { AGILE: 3001 } }, "AGILE", "CUTE")).toEqual({
      hp: 1000 * 120,
      attack: 1000 * 90,
      defense: 1000 * 50,
    });
  });
});

/**
 * R-ENH-02のローテーション不変条件（`12_テスト戦略.md`「Property／Modelテスト」）:
 * 加算回数の合計は必ず `L − 1` に一致し、HP≧攻撃力≧防御力の順で1回以上離れない。
 */
describe("calculateAcademyLevelAddition properties (R-ENH-02)", () => {
  it("PROP-ENH-02-001: the three stats consume exactly L−1 rotation steps, HP first", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (level) => {
        const addition = calculateAcademyLevelAddition("UNIT_TYPE", level);
        const hpCount = addition.hp / 120;
        const attackCount = addition.attack / 90;
        const defenseCount = addition.defense / 50;
        return (
          hpCount + attackCount + defenseCount === level - 1 &&
          hpCount >= attackCount &&
          attackCount >= defenseCount &&
          hpCount - defenseCount <= 1
        );
      }),
      PROPERTY_ASSERT_CONFIG,
    );
  });

  it("PROP-ENH-02-002: the attribute system adds exactly twice the type system at every level", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (level) => {
        const type = calculateAcademyLevelAddition("UNIT_TYPE", level);
        const attribute = calculateAcademyLevelAddition("ATTRIBUTE", level);
        return (
          attribute.hp === type.hp * 2 &&
          attribute.attack === type.attack * 2 &&
          attribute.defense === type.defense * 2
        );
      }),
      PROPERTY_ASSERT_CONFIG,
    );
  });
});
