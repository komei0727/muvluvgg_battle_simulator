import { describe, expect, it } from "vitest";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import { loadProductionSnapshot } from "../../testing/fixtures/index.js";
import { observeContinuousDamage } from "../../testing/production-unit/continuous-damage.js";
import {
  observeLifecycleDamageProbe,
  type DamageProbeObservation,
} from "../../testing/production-unit/damage-probe.js";
import {
  PRODUCTION_CATALOG_DIR,
  applyPrecedingActions,
  productionBoard,
} from "../../testing/production-unit/skill-behaviour.js";

/**
 * R-DMG-02 #2: 有効なダメージ無効が成立したヒットは0ダメージとし、#3の最低1より優先する。
 * 無効の期間・消費単位（1ヒット・1攻撃・行動・閾値つき）は各定義のまま変えない。
 * 実`catalog/`の定義で確かめる。
 *
 * 被攻撃側は保持者（`ally:subject`）へ実定義を前提アクションで付け、`enemy:front`から
 * 合成の1攻撃を撃つ。盤面は攻撃力1000・防御力500のため威力0.132で1ヒット66になり、
 * 評価シートの「66×13ヒット」の例をそのまま再現できる。
 */

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  "UNIT_LAYLA_ENTREPRENEUR",
  "UNIT_JULIE_SNOW",
  "UNIT_HARRIET_SAGE",
  "UNIT_CHIZURU_DOMESTIC",
  "UNIT_LUCIE_COMPANION",
  "UNIT_LILY_SINGER",
  "UNIT_NINA_ZINA_FRONTRUNNER",
]);

const HOLDER = "ally:subject";
/** 1ヒット66（(1000 - 500) × 0.132）。 */
const POWER_66 = 0.132;

interface Holder {
  readonly units: readonly BattleUnit[];
  readonly definitions: ReturnType<typeof productionBoard>["definitions"];
}

function holderWith(
  unitDefinitionId: string,
  effectActionDefinitionIds: readonly string[],
): Holder {
  const production = productionBoard(snapshot, unitDefinitionId);
  return {
    definitions: production.definitions,
    units: applyPrecedingActions(
      production,
      effectActionDefinitionIds.map((effectActionDefinitionId) => ({
        effectActionDefinitionId,
        target: "SELF" as const,
      })),
    ),
  };
}

/** 保持者へ1回の攻撃を撃ち、次の攻撃へ引き継ぐ盤面と観測を返す。 */
function strike(
  holder: Holder,
  options: { readonly hitCount?: number; readonly power?: number } = {},
): DamageProbeObservation & Holder {
  const observation = observeLifecycleDamageProbe({
    definitions: holder.definitions,
    units: holder.units,
    attackerUnitId: "enemy:front",
    targetUnitId: HOLDER,
    power: options.power ?? POWER_66,
    hitCount: options.hitCount ?? 13,
    damageType: "PHYSICAL",
    accuracy: "GUARANTEED",
  });
  return { ...observation, definitions: holder.definitions };
}

function hpLossOf(observation: DamageProbeObservation): number {
  return 0 - (observation.hpDeltas[HOLDER] ?? 0);
}

function hitDamagesOf(observation: DamageProbeObservation): number[] {
  return observation.distributions.map((distribution) => distribution.calculatedDamage);
}

function remainingOf(units: readonly BattleUnit[], effectActionDefinitionId: string) {
  return units
    .find((unit) => unit.battleUnitId === HOLDER)!
    .appliedEffects.filter((effect) => effect.effectActionDefinitionId === effectActionDefinitionId)
    .map((effect) => effect.duration.consumptionRemaining ?? "UNLIMITED");
}

describe("ダメージ無効は0ダメージ（R-DMG-02 #2）", () => {
  it("IT-CAT-IMMUNITY-001 [R-DMG-02, R-EFF-07] SR-171: レイラEXの無効は最初の攻撃の13ヒットをすべて0にしてその攻撃で消え、次の攻撃へ持ち越さない", () => {
    const holder = holderWith("UNIT_LAYLA_ENTREPRENEUR", ["ACT_LAYLA_ENTREPRENEUR_EX_IMMUNITY"]);
    const first = strike(holder);
    expect(hitDamagesOf(first)).toEqual(new Array<number>(13).fill(0));
    expect(hpLossOf(first)).toBe(0);
    expect(remainingOf(first.units, "ACT_LAYLA_ENTREPRENEUR_EX_IMMUNITY")).toEqual([]);

    const second = strike(first);
    expect(hpLossOf(second)).toBe(66 * 13);
  });

  it("IT-CAT-IMMUNITY-002 [R-DMG-02, R-EFF-07] SR-319・SR-413: ジュリーEX・ニーナPS1の無効は1ヒットだけ0にし、残りのヒットへ持ち越さない", () => {
    const julie = strike(holderWith("UNIT_JULIE_SNOW", ["ACT_JULIE_SNOW_EX_IMMUNITY"]));
    expect(hitDamagesOf(julie)).toEqual([0, ...new Array<number>(12).fill(66)]);
    expect(hpLossOf(julie)).toBe(792);

    const nina = strike(
      holderWith("UNIT_NINA_ZINA_FRONTRUNNER", ["ACT_NINA_ZINA_FRONTRUNNER_PS1_DAMAGE_IMMUNITY"]),
    );
    expect(hitDamagesOf(nina)).toEqual([0, ...new Array<number>(12).fill(66)]);
  });

  it("IT-CAT-IMMUNITY-003 [R-DMG-02, R-EFF-07] SR-190: ハリエットAS2の無効は現在HP35%を厳密に超えるヒットだけ0にし、閾値以下のヒットも残数2を消費する", () => {
    // 現在HP5000の35%＝1750。ちょうど1750のヒットは超えないため通常ダメージになる。
    const atThreshold = strike(holderWith("UNIT_HARRIET_SAGE", ["ACT_HARRIET_SAGE_AS2_IMMUNITY"]), {
      hitCount: 1,
      power: 3.5,
    });
    expect(hitDamagesOf(atThreshold)).toEqual([1750]);
    expect(remainingOf(atThreshold.units, "ACT_HARRIET_SAGE_AS2_IMMUNITY")).toEqual([1]);

    // 閾値以下の弱いヒット66は通り、残数を1つ使う。続く2000は現在HP4934の35%（1726.9）を
    // 超えるため0になり、2ヒット目で無効が消える。
    const holder = holderWith("UNIT_HARRIET_SAGE", ["ACT_HARRIET_SAGE_AS2_IMMUNITY"]);
    const weak = strike(holder, { hitCount: 1 });
    expect(hitDamagesOf(weak)).toEqual([66]);
    expect(remainingOf(weak.units, "ACT_HARRIET_SAGE_AS2_IMMUNITY")).toEqual([1]);
    const strong = strike(weak, { hitCount: 1, power: 4 });
    expect(hitDamagesOf(strong)).toEqual([0]);
    expect(hpLossOf(strong)).toBe(0);
    expect(remainingOf(strong.units, "ACT_HARRIET_SAGE_AS2_IMMUNITY")).toEqual([]);
  });

  it("IT-CAT-IMMUNITY-004 [R-DMG-02, R-EFF-11] SR-296・SR-173: 千鶴PS3・リリーEXの行動期間の無効は複数の攻撃の全ヒットを0にし、攻撃では消費しない。実HP減少0なので被ダメージ累計の素材も0になる", () => {
    for (const [unitDefinitionId, effectActionDefinitionId] of [
      ["UNIT_CHIZURU_DOMESTIC", "ACT_CHIZURU_DOMESTIC_PS3_IMMUNITY"],
      ["UNIT_LILY_SINGER", "ACT_LILY_SINGER_EX_IMMUNITY"],
    ] as const) {
      const first = strike(holderWith(unitDefinitionId, [effectActionDefinitionId]));
      const second = strike(first);
      for (const observed of [first, second]) {
        expect(hitDamagesOf(observed)).toEqual(new Array<number>(13).fill(0));
        // 千鶴PS3の累計counter（CUMULATIVE_DAMAGE_THRESHOLD）は`DamageApplied.hitPointDamage`を
        // 素材にする（IT-UNIT-CHIZURU-DOMESTIC-005）。
        expect(observed.distributions.every((d) => d.hitPointDamage === 0)).toBe(true);
      }
      expect(remainingOf(second.units, effectActionDefinitionId)).toEqual(["UNLIMITED"]);
    }
  });

  it("IT-CAT-IMMUNITY-005 [R-DMG-02, R-DOT-04] SR-196: リュシーEXの無効中も攻撃のヒットは0だが、継続ダメージ（毒）は防がない", () => {
    const holder = holderWith("UNIT_LUCIE_COMPANION", [
      "ACT_LUCIE_COMPANION_EX_DAMAGE_IMMUNITY",
      "ACT_LUCIE_COMPANION_EX_POISON",
    ]);
    expect(hpLossOf(strike(holder))).toBe(0);

    const poison = observeContinuousDamage({
      units: holder.units,
      definitions: holder.definitions,
      actors: [HOLDER],
      battleId: "B_LUCIE_IMMUNITY_POISON",
    });
    // 現在HP5000の20%＝1000（付与時攻撃力1000の上限ちょうど）。
    expect(poison.steps[0]!.ticks.map((tick) => tick.hitPointDamage)).toEqual([1000]);
  });

  it("IT-CAT-IMMUNITY-006 [R-DMG-02, R-EFF-07] SR-194: リリーAS1の無効は13ヒット攻撃2回の全ヒットを0にし（最低1も残さない）、各攻撃の終了で2→1→0と減り、3回目は通常値", () => {
    const holder = holderWith("UNIT_LILY_SINGER", ["ACT_LILY_SINGER_AS1_IMMUNITY"]);
    expect(remainingOf(holder.units, "ACT_LILY_SINGER_AS1_IMMUNITY")).toEqual([2]);

    const first = strike(holder);
    expect(hitDamagesOf(first)).toEqual(new Array<number>(13).fill(0));
    expect(hpLossOf(first)).toBe(0);
    expect(remainingOf(first.units, "ACT_LILY_SINGER_AS1_IMMUNITY")).toEqual([1]);

    const second = strike(first);
    expect(hitDamagesOf(second)).toEqual(new Array<number>(13).fill(0));
    expect(hpLossOf(second)).toBe(0);
    expect(remainingOf(second.units, "ACT_LILY_SINGER_AS1_IMMUNITY")).toEqual([]);

    expect(hpLossOf(strike(second))).toBe(66 * 13);
  });
});
