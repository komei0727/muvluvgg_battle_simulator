import { describe, expect, it } from "vitest";
import {
  buildGearEffects,
  gearEffectsFingerprint,
  type BattleSimulationGearEffect,
} from "./gear-effect-catalog.js";
import {
  calculateGearRatios,
  GEAR_GRADES,
  GEAR_STAT_APPLICATIONS,
  GEAR_TIERS,
} from "../../domain/battle/model/gear-customization-policy.js";
import { STAT_KINDS } from "../../domain/catalog/definitions/catalog-enums.js";

describe("buildGearEffects", () => {
  it("APP-CATALOG-GEAR-001 (R-ENH-04 #3/#5): publishes every stat × tier × grade, and each published value equals what the Domain actually applies for that gear", () => {
    const effects = buildGearEffects();

    expect(effects.map((effect) => effect.stat)).toEqual([...STAT_KINDS]);

    for (const effect of effects) {
      expect(effect.application).toBe(GEAR_STAT_APPLICATIONS[effect.stat]);
      expect(effect.values.map((value) => `${value.tier}-${value.grade}`)).toEqual(
        GEAR_TIERS.flatMap((tier) => GEAR_GRADES.map((grade) => `${tier}-${grade}`)),
      );

      for (const value of effect.values) {
        // 表を写し取るのではなく、そのギア1個を指定したときにDomainが算出する
        // 合計割合（内部表現）と突き合わせる。公開値がパーセントポイントの
        // ままであること（`/100`していないこと）もここで縛られる。
        const ratios = calculateGearRatios([
          { stat: effect.stat, tier: value.tier, grade: value.grade },
        ]);
        expect(value.percentagePoints / 100, `${effect.stat} ${value.tier}-${value.grade}`).toBe(
          ratios[effect.stat],
        );
      }
    }
  });
});

describe("gearEffectsFingerprint", () => {
  it("APP-CATALOG-GEAR-002 (ETag導出元): is stable for the same table, differs when any published value changes, and stays safe to embed in an ETag", () => {
    const effects = buildGearEffects();

    expect(gearEffectsFingerprint(effects)).toBe(gearEffectsFingerprint(buildGearEffects()));
    // RFC 9110 §8.8.3 etagc の範囲内（`toOpaqueEntityTag`のエスケープを経ずに
    // そのままETagへ入れられる）。
    expect(gearEffectsFingerprint(effects)).toMatch(/^[\x21\x23-\x7E]+$/);

    const first = effects[0] as BattleSimulationGearEffect;
    const firstValue = first.values[0]!;
    const changedValue: readonly BattleSimulationGearEffect[] = [
      {
        ...first,
        values: [{ ...firstValue, percentagePoints: firstValue.percentagePoints + 0.01 }].concat(
          first.values.slice(1),
        ),
      },
      ...effects.slice(1),
    ];
    expect(gearEffectsFingerprint(changedValue)).not.toBe(gearEffectsFingerprint(effects));

    const changedApplication: readonly BattleSimulationGearEffect[] = [
      { ...first, application: first.application === "RATIO" ? "POINT" : "RATIO" },
      ...effects.slice(1),
    ];
    expect(gearEffectsFingerprint(changedApplication)).not.toBe(gearEffectsFingerprint(effects));
  });
});
