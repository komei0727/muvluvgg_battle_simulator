import { describe, expect, it } from "vitest";
import {
  calculateEnhancedBaseStats,
  DEFAULT_UNIT_LEVEL,
  type EnhancementTarget,
  type UnitEnhancement,
} from "./enhanced-base-stats-calculator.js";
import {
  GEAR_EFFECT_PERCENTAGE_POINTS,
  GEAR_STAT_APPLICATIONS,
} from "./gear-customization-policy.js";
import { STAT_KINDS, type StatKind } from "../../catalog/definitions/catalog-enums.js";
import type {
  BaseStats,
  LevelGrowth,
  RankGrowth,
} from "../../catalog/definitions/unit-definition.js";
import { fc, PROPERTY_ASSERT_CONFIG } from "../../../testing/property/index.js";

const BASE_STATS: BaseStats = {
  maximumHp: 28375,
  attack: 23221,
  defense: 11781,
  criticalRate: 0.25,
  criticalDamageBonus: 0.5,
  affinityBonus: 0.25,
  actionSpeed: 780,
  maximumAp: 4,
  maximumPp: 4,
};

const LEVEL_GROWTH: LevelGrowth = { hp: 255, attack: 209, defense: 106, actionSpeed: 2 };
const RANK_GROWTH: RankGrowth = { hp: 1200, attack: 900, defense: 500, criticalRate: 0.01 };

function target(overrides: Partial<EnhancementTarget> = {}): EnhancementTarget {
  return {
    attribute: "AGGRESSIVE",
    unitType: "PHYSICAL",
    baseStats: BASE_STATS,
    ...overrides,
  };
}

/** 物理タイプ・アグレッシブ属性の学園レベル50（R-ENH-02の設計書実例）。 */
const ACADEMY_LEVEL_50: UnitEnhancement = {
  academyLevels: { unitTypes: { PHYSICAL: 50 }, attributes: { AGGRESSIVE: 50 } },
};

describe("calculateEnhancedBaseStats — R-ENH-03 タイプ装備・モジュール", () => {
  it("UT-R-ENH-03-001: applies type equipment and module to a unit with no other enhancement", () => {
    const stats = calculateEnhancedBaseStats(target(), {});
    // (28375 + 21600 + 3628) × 1.09 など、固定加算のあとに9%の割合補正が掛かる。
    expect(stats.maximumHp).toBeCloseTo(58427.27, 6);
    expect(stats.attack).toBeCloseTo(45738.58, 6);
    expect(stats.defense).toBeCloseTo(24215.44, 6);
  });

  it("UT-R-ENH-03-002: the 9% module ratio never reaches action speed or the three bonus stats", () => {
    const stats = calculateEnhancedBaseStats(target(), {});
    expect(stats.actionSpeed).toBe(780);
    expect(stats.criticalRate).toBe(0.25);
    expect(stats.criticalDamageBonus).toBe(0.5);
    expect(stats.affinityBonus).toBe(0.25);
  });

  it("UT-R-ENH-03-003 [R-ENH-08]: overriding only module.hp.fixed leaves attack/defense at the default module values", () => {
    const stats = calculateEnhancedBaseStats(target(), { module: { hp: { fixed: 5000 } } });
    // (28375 + 21600 + 5000) × 1.09 = 59922.75
    expect(stats.maximumHp).toBeCloseTo(59922.75, 6);
    expect(stats.attack).toBeCloseTo(45738.58, 6);
    expect(stats.defense).toBeCloseTo(24215.44, 6);
  });

  it("UT-R-ENH-03-004 [R-ENH-08]: overriding only module.attack.ratio leaves hp/defense at the default module values", () => {
    const stats = calculateEnhancedBaseStats(target(), { module: { attack: { ratio: 0.05 } } });
    // (23221 + 16020 + 2721) × 1.05 = 44060.1 — module.attack.fixed stays at the default (2721).
    expect(stats.attack).toBeCloseTo(44060.1, 6);
    expect(stats.maximumHp).toBeCloseTo(58427.27, 6);
    expect(stats.defense).toBeCloseTo(24215.44, 6);
  });
});

describe("calculateEnhancedBaseStats — R-ENH-08 モジュール補正のリクエスト上書き", () => {
  it("UT-R-ENH-08-001: overriding fixed and ratio independently for HP/attack/defense reaches all three with the given values", () => {
    const stats = calculateEnhancedBaseStats(target(), {
      module: {
        hp: { fixed: 5000, ratio: 0.1 },
        attack: { fixed: 3000, ratio: 0.05 },
        defense: { fixed: 2000, ratio: 0.2 },
      },
    });
    // (28375 + 21600 + 5000) × 1.10 = 60472.5
    expect(stats.maximumHp).toBeCloseTo(60472.5, 6);
    // (23221 + 16020 + 3000) × 1.05 = 44353.05
    expect(stats.attack).toBeCloseTo(44353.05, 6);
    // (11781 + 8920 + 2000) × 1.20 = 27241.2
    expect(stats.defense).toBeCloseTo(27241.2, 6);
  });

  it("UT-R-ENH-08-002: omitting module, or passing an empty module object, matches the pre-existing default values exactly — no regression", () => {
    const withoutModule = calculateEnhancedBaseStats(target(), {});
    const withEmptyModule = calculateEnhancedBaseStats(target(), { module: {} });
    expect(withoutModule.maximumHp).toBeCloseTo(58427.27, 6);
    expect(withoutModule.attack).toBeCloseTo(45738.58, 6);
    expect(withoutModule.defense).toBeCloseTo(24215.44, 6);
    expect(withEmptyModule).toEqual(withoutModule);
  });

  it("UT-R-ENH-08-003 (boundary): overriding only the ratio to 0 keeps the default fixed addition but drops the multiplier to 1", () => {
    const stats = calculateEnhancedBaseStats(target(), { module: { hp: { ratio: 0 } } });
    // (28375 + 21600 + 3628) × (1 + 0) = 53603 — module.hp.fixed stays at the default (3628).
    expect(stats.maximumHp).toBeCloseTo(53603, 6);
  });

  it("UT-R-ENH-08-004 (boundary): a large negative module fixed/ratio override still clamps to R-ENH-06's floor (maximum HP 1, attack/defense 0)", () => {
    // R-ENH-08はfixed/ratioの符号を制限しない設計であり、この安全弁（R-ENH-06の
    // クランプ）が実際に負値の経路でも効くことを直接検証する——validateModuleStatOverride
    // が符号を拒否しない根拠がこのクランプであるため。
    const stats = calculateEnhancedBaseStats(target(), {
      module: {
        hp: { fixed: -1_000_000 },
        attack: { fixed: -1_000_000 },
        defense: { ratio: -100 },
      },
    });
    expect(stats.maximumHp).toBe(1);
    expect(stats.attack).toBe(0);
    expect(stats.defense).toBe(0);
  });
});

describe("calculateEnhancedBaseStats — R-ENH-05 レベル増加", () => {
  it("UT-R-ENH-05-001: level 300 adds 100 × levelGrowth to HP/attack/defense/action speed", () => {
    const stats = calculateEnhancedBaseStats(target({ levelGrowth: LEVEL_GROWTH }), { level: 300 });
    expect(stats.maximumHp).toBeCloseTo(86222.27, 6);
    expect(stats.attack).toBeCloseTo(68519.58, 6);
    expect(stats.defense).toBeCloseTo(35769.44, 6);
    expect(stats.actionSpeed).toBe(980);
  });

  it("UT-R-ENH-05-002: level 100 subtracts with the same formula (negative direction)", () => {
    const stats = calculateEnhancedBaseStats(target({ levelGrowth: LEVEL_GROWTH }), { level: 100 });
    expect(stats.maximumHp).toBeCloseTo(30632.27, 6);
    expect(stats.actionSpeed).toBe(580);
  });

  it("UT-R-ENH-05-003: level 200 is the neutral point and never reads levelGrowth", () => {
    const withGrowth = calculateEnhancedBaseStats(target({ levelGrowth: LEVEL_GROWTH }), {
      level: DEFAULT_UNIT_LEVEL,
    });
    const withoutGrowth = calculateEnhancedBaseStats(target(), { level: DEFAULT_UNIT_LEVEL });
    expect(withGrowth).toEqual(withoutGrowth);
    expect(withoutGrowth).toEqual(calculateEnhancedBaseStats(target(), {}));
  });
});

describe("calculateEnhancedBaseStats — R-ENH-07 ユニットランク", () => {
  it("UT-R-ENH-07-001: rank 0 (LR) subtracts 5 × rankGrowth from HP/attack/defense/critical rate", () => {
    const stats = calculateEnhancedBaseStats(target({ rankGrowth: RANK_GROWTH }), { rank: 0 });
    // (28375 + 21600 + 3628 − 5×1200) × 1.09 など、ランク減算は固定加算の内側に入る。
    expect(stats.maximumHp).toBeCloseTo(51887.27, 6);
    expect(stats.attack).toBeCloseTo(40833.58, 6);
    expect(stats.defense).toBeCloseTo(21490.44, 6);
    expect(stats.criticalRate).toBeCloseTo(0.2, 12);
  });

  it("UT-R-ENH-07-002: rank 5 is the neutral point and never reads rankGrowth", () => {
    const withGrowth = calculateEnhancedBaseStats(target({ rankGrowth: RANK_GROWTH }), { rank: 5 });
    const withoutGrowth = calculateEnhancedBaseStats(target(), { rank: 5 });
    expect(withGrowth).toEqual(withoutGrowth);
    expect(withoutGrowth).toEqual(calculateEnhancedBaseStats(target(), {}));
  });

  it("UT-R-ENH-07-003: a unit without rankGrowth treats the growth amount as zero", () => {
    const withRank = calculateEnhancedBaseStats(target(), { rank: 0 });
    const withoutRank = calculateEnhancedBaseStats(target(), {});
    expect(withRank).toEqual(withoutRank);
  });

  it("UT-R-ENH-07-004: rank's addition sits inside the module ratio and gear ratio", () => {
    const gearRatio = GEAR_EFFECT_PERCENTAGE_POINTS.MAXIMUM_HP.III.S / 100;
    const rankContribution = (gears: UnitEnhancement["gears"]): number =>
      calculateEnhancedBaseStats(target({ rankGrowth: RANK_GROWTH }), { rank: 0, gears })
        .maximumHp -
      calculateEnhancedBaseStats(target({ rankGrowth: RANK_GROWTH }), { rank: 5, gears }).maximumHp;

    const withoutGear = rankContribution([]);
    const withGear = rankContribution([{ stat: "MAXIMUM_HP", tier: "III", grade: "S" }]);

    // 割合の内側にあるなら、寄与量は(1+0.09)から(1+0.09+gearRatio)へ比例して増える。
    expect(withGear).toBeCloseTo((withoutGear * (1 + 0.09 + gearRatio)) / (1 + 0.09), 6);
    expect(withGear).not.toBeCloseTo(withoutGear, 6);
  });

  it("UT-R-ENH-07-005: critical rate combines the rank contribution as a plain addition, same term as the gear ratio", () => {
    const delta = (baseStats: BaseStats): number =>
      calculateEnhancedBaseStats(target({ baseStats, rankGrowth: RANK_GROWTH }), { rank: 0 })
        .criticalRate -
      calculateEnhancedBaseStats(target({ baseStats, rankGrowth: RANK_GROWTH }), {}).criticalRate;

    expect(delta(BASE_STATS)).toBeCloseTo(-5 * RANK_GROWTH.criticalRate, 12);
    expect(delta({ ...BASE_STATS, criticalRate: BASE_STATS.criticalRate * 2 })).toBeCloseTo(
      delta(BASE_STATS),
      12,
    );
  });
});

describe("calculateEnhancedBaseStats — R-ENH-06 強化後基本ステータスの算出", () => {
  it("UT-R-ENH-06-001: composes academy levels, type equipment and module for HP/attack/defense", () => {
    const stats = calculateEnhancedBaseStats(target(), ACADEMY_LEVEL_50);
    expect(stats.maximumHp).toBeCloseTo(65098.07, 6);
    expect(stats.attack).toBeCloseTo(50447.38, 6);
    expect(stats.defense).toBeCloseTo(26831.44, 6);
  });

  it("UT-R-ENH-06-002: gear ratios join the module ratio for HP/attack/defense", () => {
    const stats = calculateEnhancedBaseStats(target(), {
      gears: [
        { stat: "MAXIMUM_HP", tier: "III", grade: "S" },
        { stat: "MAXIMUM_HP", tier: "III", grade: "S" },
      ],
    });
    expect(stats.maximumHp).toBeCloseTo(53603 * (1 + 0.09 + 0.0666), 6);
  });

  it("UT-R-ENH-06-003: action speed takes gear ratios without the module ratio", () => {
    const stats = calculateEnhancedBaseStats(target(), {
      gears: [{ stat: "ACTION_SPEED", tier: "III", grade: "A" }],
    });
    expect(stats.actionSpeed).toBeCloseTo(780 * 1.06, 6);
  });

  it("UT-R-ENH-06-004: critical rate, critical damage and affinity take the gear ratio as a plain addition", () => {
    const stats = calculateEnhancedBaseStats(target(), {
      gears: [
        { stat: "CRITICAL_RATE", tier: "II", grade: "S" },
        { stat: "CRITICAL_DAMAGE_BONUS", tier: "III", grade: "C" },
        { stat: "AFFINITY_BONUS", tier: "III", grade: "S" },
      ],
    });
    expect(stats.criticalRate).toBeCloseTo(0.25 + 0.0525, 12);
    expect(stats.criticalDamageBonus).toBeCloseTo(0.5 + 0.085, 12);
    expect(stats.affinityBonus).toBeCloseTo(0.25 + 0.085, 12);
  });

  it("UT-R-ENH-06-005: keeps full precision — the result is not rounded to an integer", () => {
    const stats = calculateEnhancedBaseStats(target(), ACADEMY_LEVEL_50);
    expect(Number.isInteger(stats.maximumHp)).toBe(false);
    expect(Number.isInteger(stats.attack)).toBe(false);
  });

  /**
   * `GEAR_STAT_APPLICATIONS`はギア効果の意味（割合補正かポイント加算か）を外部へ
   * 公開するための分類であり、算出式そのものではない。分類と式が別々に動くと
   * 表示だけが静かにずれるため、「割合補正なら上昇量が基本値に依存し、ポイント
   * 加算なら基本値に依存せず表のパーセント値そのもの」という観測可能な差で
   * 機械検証する。
   */
  it("UT-R-ENH-06-009: every stat's declared gear application matches how the formula actually applies the gear", () => {
    const STAT_FIELDS: Readonly<Record<StatKind, keyof BaseStats>> = {
      MAXIMUM_HP: "maximumHp",
      ATTACK: "attack",
      DEFENSE: "defense",
      ACTION_SPEED: "actionSpeed",
      CRITICAL_RATE: "criticalRate",
      CRITICAL_DAMAGE_BONUS: "criticalDamageBonus",
      AFFINITY_BONUS: "affinityBonus",
    };

    for (const stat of STAT_KINDS) {
      const field = STAT_FIELDS[stat];
      const gears = [{ stat, tier: "III", grade: "S" }] as const;
      const doubled: BaseStats = {
        ...BASE_STATS,
        maximumHp: BASE_STATS.maximumHp * 2,
        attack: BASE_STATS.attack * 2,
        defense: BASE_STATS.defense * 2,
        actionSpeed: BASE_STATS.actionSpeed * 2,
        criticalRate: BASE_STATS.criticalRate * 2,
        criticalDamageBonus: BASE_STATS.criticalDamageBonus * 2,
        affinityBonus: BASE_STATS.affinityBonus * 2,
      };
      const delta = (baseStats: BaseStats): number =>
        calculateEnhancedBaseStats(target({ baseStats }), { gears })[field] -
        calculateEnhancedBaseStats(target({ baseStats }), {})[field];

      const points = GEAR_EFFECT_PERCENTAGE_POINTS[stat].III.S;
      if (GEAR_STAT_APPLICATIONS[stat] === "POINT") {
        expect(delta(BASE_STATS), `${stat} must add the table value itself`).toBeCloseTo(
          points / 100,
          12,
        );
        expect(delta(doubled), `${stat} must not depend on the base value`).toBeCloseTo(
          delta(BASE_STATS),
          12,
        );
      } else {
        expect(delta(doubled), `${stat} must scale with the base value`).not.toBeCloseTo(
          delta(BASE_STATS),
          6,
        );
      }
    }
  });

  it("UT-R-ENH-06-006: boundary — clamps every stat at 0 and maximum HP at 1", () => {
    const stats = calculateEnhancedBaseStats(
      target({
        baseStats: { ...BASE_STATS, maximumHp: 100, attack: 10, defense: 10, actionSpeed: 5 },
        levelGrowth: { hp: 1000, attack: 1000, defense: 1000, actionSpeed: 100 },
      }),
      { level: 1 },
    );
    expect(stats.maximumHp).toBe(1);
    expect(stats.attack).toBe(0);
    expect(stats.defense).toBe(0);
    expect(stats.actionSpeed).toBe(0);
  });
});

describe("calculateEnhancedBaseStats — R-ENH-01 強化対象ステータス", () => {
  it("UT-R-ENH-01-001: AP and PP maximums are copied through unenhanced", () => {
    const stats = calculateEnhancedBaseStats(target({ levelGrowth: LEVEL_GROWTH }), {
      ...ACADEMY_LEVEL_50,
      level: 300,
      gears: [{ stat: "MAXIMUM_HP", tier: "III", grade: "S" }],
    });
    expect(stats.maximumAp).toBe(BASE_STATS.maximumAp);
    expect(stats.maximumPp).toBe(BASE_STATS.maximumPp);
  });
});

/**
 * R-ENH-01 #4・R-ENH-06の不変条件（`12_テスト戦略.md`「Property／Modelテスト」）。
 * 既定値の明示指定が無指定と同値であること、レベルに対する単調性、クランプ下限を
 * 個別の実例ではなく入力空間全体で確認する。
 */
describe("calculateEnhancedBaseStats properties (R-ENH-05/06)", () => {
  const levelArb = fc.integer({ min: 1, max: 1000 });
  const growthArb = fc.record({
    hp: fc.integer({ min: 0, max: 500 }),
    attack: fc.integer({ min: 0, max: 500 }),
    defense: fc.integer({ min: 0, max: 500 }),
    actionSpeed: fc.integer({ min: 0, max: 10 }),
  });

  it("PROP-ENH-06-001 [R-ENH-06]: spelling out the defaults yields the same result as omitting them", () => {
    fc.assert(
      fc.property(growthArb, (levelGrowth) => {
        const unit = target({ levelGrowth });
        const explicit = calculateEnhancedBaseStats(unit, {
          academyLevels: {
            unitTypes: { PHYSICAL: 1, ENERGY: 1, AGILE: 1 },
            attributes: {
              AGGRESSIVE: 1,
              SHY: 1,
              CUTE: 1,
              SMART: 1,
              COMICAL: 1,
              CLEVER: 1,
            },
          },
          level: DEFAULT_UNIT_LEVEL,
          gears: [],
        });
        expect(explicit).toEqual(calculateEnhancedBaseStats(unit, {}));
      }),
      PROPERTY_ASSERT_CONFIG,
    );
  });

  it("PROP-ENH-06-002 [R-ENH-06]: no stat drops below 0 and maximum HP never drops below 1", () => {
    fc.assert(
      fc.property(levelArb, growthArb, (level, levelGrowth) => {
        const stats = calculateEnhancedBaseStats(target({ levelGrowth }), { level });
        return (
          stats.maximumHp >= 1 &&
          stats.attack >= 0 &&
          stats.defense >= 0 &&
          stats.actionSpeed >= 0 &&
          stats.criticalRate >= 0
        );
      }),
      PROPERTY_ASSERT_CONFIG,
    );
  });

  it("PROP-ENH-05-001 [R-ENH-05]: a higher level never lowers a stat (growth values are non-negative)", () => {
    fc.assert(
      fc.property(levelArb, levelArb, growthArb, (a, b, levelGrowth) => {
        const lower = Math.min(a, b);
        const higher = Math.max(a, b);
        const unit = target({ levelGrowth });
        const lowerStats = calculateEnhancedBaseStats(unit, { level: lower });
        const higherStats = calculateEnhancedBaseStats(unit, { level: higher });
        return (
          higherStats.maximumHp >= lowerStats.maximumHp &&
          higherStats.attack >= lowerStats.attack &&
          higherStats.defense >= lowerStats.defense &&
          higherStats.actionSpeed >= lowerStats.actionSpeed
        );
      }),
      PROPERTY_ASSERT_CONFIG,
    );
  });

  const rankArb = fc.integer({ min: 0, max: 5 });
  const rankGrowthArb = fc.record({
    hp: fc.integer({ min: 0, max: 2000 }),
    attack: fc.integer({ min: 0, max: 2000 }),
    defense: fc.integer({ min: 0, max: 2000 }),
    criticalRate: fc.double({ min: 0, max: 0.1, noNaN: true }),
  });

  it("PROP-ENH-07-001 [R-ENH-07]: a higher rank never lowers a stat (rankGrowth values are non-negative)", () => {
    fc.assert(
      fc.property(rankArb, rankArb, rankGrowthArb, (a, b, rankGrowth) => {
        const lower = Math.min(a, b);
        const higher = Math.max(a, b);
        const unit = target({ rankGrowth });
        const lowerStats = calculateEnhancedBaseStats(unit, { rank: lower });
        const higherStats = calculateEnhancedBaseStats(unit, { rank: higher });
        return (
          higherStats.maximumHp >= lowerStats.maximumHp &&
          higherStats.attack >= lowerStats.attack &&
          higherStats.defense >= lowerStats.defense &&
          higherStats.criticalRate >= lowerStats.criticalRate
        );
      }),
      PROPERTY_ASSERT_CONFIG,
    );
  });
});
