import { describe, expect, it } from "vitest";
import { loadProductionSnapshot } from "../../testing/fixtures/index.js";
import {
  observeLifecycleDamageProbe,
  type DamageProbeObservation,
} from "../../testing/production-unit/damage-probe.js";
import { evasionOf } from "../../testing/production-unit/evasion.js";
import {
  PRODUCTION_CATALOG_DIR,
  applyPrecedingActions,
  observeSkillUse,
  productionBoard,
  type BoardOverrides,
} from "../../testing/production-unit/skill-behaviour.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import {
  effectKindKeyFromDefinitionId,
  type AppliedEffect,
} from "../../domain/battle/model/applied-effect.js";
import { createEffectActionDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { createEffectInstanceId } from "../../domain/shared/event-ids.js";
import { createBattleUnitId } from "../../domain/shared/ids.js";
import type { DamageType } from "../../domain/catalog/definitions/catalog-enums.js";

/**
 * R-EFF-07（Issue #828）: 攻撃回数で消費する効果は、1回の攻撃（1 DAMAGE EffectAction）の
 * 全対象・全ヒットへ適用してから1回分を消費する。シールドの容量は攻撃をまたいで共有し、
 * 属性限定の効果は宣言した属性の攻撃でだけ消費する。実`catalog/`の定義で確かめる。
 *
 * 被攻撃側は保持者（`ally:subject`）へ実定義を前提アクションで付け、`enemy:front`から
 * 合成の1攻撃を撃つ。盤面は攻撃力1000・防御力500のため威力0.132で1ヒット66になり、
 * 評価シートの「66×13ヒット」の例をそのまま再現できる。
 */

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  "UNIT_RAMI_NEWYEAR",
  "UNIT_ROSIE_ARTIST",
  "UNIT_JUNKA_CHILDHOOD",
  "UNIT_LILY_SINGER",
  "UNIT_YIFEI_STORM",
  "UNIT_MAO_COMMITTEE",
  "UNIT_MERU_SIRIUS",
  "UNIT_HIIRO_LONEWOLF",
  "UNIT_SHIRANA_LUCKY",
  "UNIT_OLGA_NADYA_BOND",
  "UNIT_NANAE_COMMANDER",
  "UNIT_SAYA_BUNNY",
  "UNIT_LAURA_MOUNTAIN",
  "UNIT_ROSIE_CAMPAIGN",
  "UNIT_SUIRAN_CASINO",
]);

const HOLDER = "ally:subject";
/** 1ヒット66（(1000 - 500) × 0.132）。 */
const POWER_66 = 0.132;

interface Holder {
  readonly units: readonly BattleUnit[];
  readonly definitions: ReturnType<typeof productionBoard>["definitions"];
}

/** 保持者へ実定義の効果を（同じ定義なら重ねて）付けた盤面。 */
function holderWith(
  unitDefinitionId: string,
  effectActionDefinitionIds: readonly string[],
  board: BoardOverrides = {},
): Holder {
  const production = productionBoard(snapshot, unitDefinitionId, board);
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

interface Strike {
  readonly hitCount?: number;
  readonly damageType?: DamageType;
  /** 先頭から回避させるヒット数（R-HIT-04のNヒット回避で作る）。 */
  readonly evadedHits?: number;
  /** 同じ値を渡した攻撃は同じ行動の中の攻撃になる（`consumption.scope: ACTION`）。 */
  readonly actionId?: string;
}

/** 保持者へ1回の攻撃を撃ち、次の攻撃へ引き継ぐ盤面と観測を返す。 */
function strike(holder: Holder, options: Strike = {}): DamageProbeObservation & Holder {
  const hitCount = options.hitCount ?? 13;
  const evadedHits = options.evadedHits ?? 0;
  const units =
    evadedHits > 0
      ? holder.units.map((unit) =>
          unit.battleUnitId === HOLDER
            ? { ...unit, appliedEffects: [...unit.appliedEffects, evasionOf(HOLDER, evadedHits)] }
            : unit,
        )
      : holder.units;
  const observation = observeLifecycleDamageProbe({
    definitions: holder.definitions,
    units,
    attackerUnitId: "enemy:front",
    targetUnitId: HOLDER,
    power: POWER_66,
    hitCount,
    damageType: options.damageType ?? "PHYSICAL",
    accuracy: evadedHits > 0 ? "NORMAL" : "GUARANTEED",
    ...(options.actionId === undefined ? {} : { actionId: options.actionId }),
  });
  return { ...observation, definitions: holder.definitions };
}

/** 一連の攻撃をこの順に撃ち、各攻撃で保持者が失ったHPを返す。 */
function hpLossesOf(holder: Holder, strikes: readonly Strike[]): number[] {
  const losses: number[] = [];
  let current = holder;
  for (const options of strikes) {
    const observed = strike(current, options);
    losses.push(-(observed.hpDeltas[HOLDER] ?? 0));
    current = observed;
  }
  return losses;
}

function effectsOf(units: readonly BattleUnit[], effectActionDefinitionId: string) {
  return units
    .find((unit) => unit.battleUnitId === HOLDER)!
    .appliedEffects.filter(
      (effect) => effect.effectActionDefinitionId === effectActionDefinitionId,
    );
}

function remainingOf(units: readonly BattleUnit[], effectActionDefinitionId: string) {
  return effectsOf(units, effectActionDefinitionId).map((effect) => ({
    consumption: effect.duration.consumptionRemaining,
    shield: effect.shield?.remaining,
  }));
}

describe("被攻撃回数で消費する補正（攻撃1回の全ヒットへ適用）", () => {
  it("IT-CAT-ATKCONS-001 [R-EFF-07] SR-177: めるEXの被ダメージ＋50%は2攻撃の全ヒットに乗り、3攻撃目は通常値", () => {
    const holder = holderWith("UNIT_MERU_SIRIUS", ["ACT_MERU_SIRIUS_EX_DMG_UP"]);
    expect(hpLossesOf(holder, [{}, {}, {}])).toEqual([99 * 13, 99 * 13, 66 * 13]);
  });

  it("IT-CAT-ATKCONS-002 [R-EFF-07] SR-229: オルガ＆ナージャPS2の30%／75%ガードは1攻撃の全13ヒットを軽減し、次の攻撃へ持ち越さない", () => {
    const guard30 = holderWith("UNIT_OLGA_NADYA_BOND", ["ACT_OLGA_NADYA_BOND_PS2_GUARD_30"]);
    expect(hpLossesOf(guard30, [{}, {}])).toEqual([46 * 13, 66 * 13]);
    const guard75 = holderWith("UNIT_OLGA_NADYA_BOND", ["ACT_OLGA_NADYA_BOND_PS2_GUARD_75"]);
    expect(hpLossesOf(guard75, [{}, {}])).toEqual([16 * 13, 66 * 13]);
  });

  it("IT-CAT-ATKCONS-003 [R-EFF-07] SR-207: しらなPS2の物理軽減は2攻撃の全ヒットを46にし、EN攻撃では軽減せずに1回分を消費する", () => {
    const holder = holderWith("UNIT_SHIRANA_LUCKY", ["ACT_SHIRANA_LUCKY_PS2_GUARD"]);
    expect(hpLossesOf(holder, [{}, {}, {}])).toEqual([598, 598, 858]);

    const afterEn = strike(holder, { damageType: "EN" });
    expect(-afterEn.hpDeltas[HOLDER]!).toBe(858);
    expect(remainingOf(afterEn.units, "ACT_SHIRANA_LUCKY_PS2_GUARD")).toEqual([
      { consumption: 1, shield: undefined },
    ]);
  });

  it("IT-CAT-ATKCONS-004 [R-EFF-07] SR-255: 七彩PS1のEN軽減はEN攻撃3回の全ヒットを軽減し、物理攻撃では消費しない", () => {
    const holder = holderWith("UNIT_NANAE_COMMANDER", ["ACT_NANAE_COMMANDER_PS1_DMG_DOWN"]);
    const afterPhysical = strike(holder);
    expect(-afterPhysical.hpDeltas[HOLDER]!).toBe(858);
    expect(remainingOf(afterPhysical.units, "ACT_NANAE_COMMANDER_PS1_DMG_DOWN")).toEqual([
      { consumption: 3, shield: undefined },
    ]);
    const en = { damageType: "EN" } as const;
    expect(hpLossesOf(afterPhysical, [en, en, en, en])).toEqual([598, 598, 598, 858]);
  });

  it("IT-CAT-ATKCONS-005 [R-EFF-07] SR-121・SR-195: リリーPS2の自己EN被ダメージ増加とPS1のEN軽減は物理攻撃では残り、次のEN攻撃の全ヒットで使い切る", () => {
    const vulnerable = holderWith("UNIT_LILY_SINGER", ["ACT_LILY_SINGER_PS2_SELF_EN_VULN"]);
    // 66 × 1.1 = 72.6 → 72
    expect(hpLossesOf(vulnerable, [{}, { damageType: "EN" }, { damageType: "EN" }])).toEqual([
      858,
      72 * 13,
      858,
    ]);
    const guarded = holderWith("UNIT_LILY_SINGER", ["ACT_LILY_SINGER_PS1_EN_DAMAGE_DOWN"]);
    // 66 × 0.75 = 49.5 → 49
    expect(hpLossesOf(guarded, [{}, { damageType: "EN" }, { damageType: "EN" }])).toEqual([
      858,
      49 * 13,
      858,
    ]);
  });

  it("IT-CAT-ATKCONS-006 [R-EFF-07][R-HIT-04] SR-056: ロージーEXの自己軽減は被攻撃1回の全ヒットを75%軽減し、最初の1ヒットを回避した攻撃でも残り12ヒットへ乗ってから消える", () => {
    const holder = holderWith("UNIT_ROSIE_ARTIST", ["ACT_ROSIE_ARTIST_EX_DMG_DOWN"]);
    expect(hpLossesOf(holder, [{}, {}])).toEqual([16 * 13, 66 * 13]);

    // 消費は命中判定の前（R-DMG-05 #1）のため、回避されたヒットも消費の契機になる。
    const partlyEvaded = strike(holder, { evadedHits: 1 });
    expect(-partlyEvaded.hpDeltas[HOLDER]!).toBe(16 * 12);
    expect(effectsOf(partlyEvaded.units, "ACT_ROSIE_ARTIST_EX_DMG_DOWN")).toEqual([]);
  });

  it("IT-CAT-ATKCONS-007 [R-EFF-07] SR-191・SR-194: ヒイロPS2の気絶無効は3攻撃、リリーAS1のダメージ無効は2攻撃で、攻撃ごとに1つずつ減る", () => {
    const counts = (holder: Holder, effectActionDefinitionId: string, attacks: number) => {
      const seen: (number | undefined)[] = [];
      let current = holder;
      for (let i = 0; i < attacks; i += 1) {
        current = strike(current);
        seen.push(
          effectsOf(current.units, effectActionDefinitionId)[0]?.duration.consumptionRemaining,
        );
      }
      return seen;
    };
    expect(
      counts(
        holderWith("UNIT_HIIRO_LONEWOLF", ["ACT_HIIRO_LONEWOLF_PS2_STUN_IMMUNITY"]),
        "ACT_HIIRO_LONEWOLF_PS2_STUN_IMMUNITY",
        3,
      ),
    ).toEqual([2, 1, undefined]);

    const immune = holderWith("UNIT_LILY_SINGER", ["ACT_LILY_SINGER_AS1_IMMUNITY"]);
    expect(counts(immune, "ACT_LILY_SINGER_AS1_IMMUNITY", 2)).toEqual([1, undefined]);
    expect(hpLossesOf(immune, [{}, {}, {}])[2]).toBe(858);
  });

  it("IT-CAT-ATKCONS-008 [R-EFF-07] SR-406: 翠蘭PS1の攻撃者への被ダメージ＋50%は2ヒットのまま（攻撃単位へ変えない）", () => {
    const holder = holderWith("UNIT_SUIRAN_CASINO", ["ACT_SUIRAN_CASINO_PS1_DEBUFF"]);
    expect(hpLossesOf(holder, [{}])).toEqual([99 * 2 + 66 * 11]);
  });
});

describe("行動全体を覆う消費（consumption.scope: ACTION）", () => {
  it("IT-CAT-ATKCONS-016 [R-EFF-07] SR-395: ロージーPS3の75%軽減は敵の攻撃行動の全ヒット・同じ行動の別の攻撃にも乗り、行動外の次の攻撃へ持ち越さない", () => {
    const holder = holderWith("UNIT_ROSIE_CAMPAIGN", ["ACT_ROSIE_CAMPAIGN_PS3_DMG_DOWN"]);
    const action = "B_ROSIE_PS3:action:enemy";
    const first = strike(holder, { actionId: action });
    expect(-first.hpDeltas[HOLDER]!).toBe(16 * 13);
    // 使い切っても行動の完了（`action-completion.ts`）までは残り、同じ行動の続きの攻撃を覆う。
    expect(remainingOf(first.units, "ACT_ROSIE_CAMPAIGN_PS3_DMG_DOWN")).toEqual([
      { consumption: 0, shield: undefined },
    ]);
    const sameAction = strike(first, { actionId: action, hitCount: 2 });
    expect(-sameAction.hpDeltas[HOLDER]!).toBe(16 * 2);

    // 行動外（ターン開始時のPSの攻撃など）では待つ行動が無いため、その攻撃の終了で消える。
    const outsideAction = strike(holder);
    expect(-outsideAction.hpDeltas[HOLDER]!).toBe(16 * 13);
    expect(effectsOf(outsideAction.units, "ACT_ROSIE_CAMPAIGN_PS3_DMG_DOWN")).toEqual([]);
  });

  it.each([
    {
      adjacent: true,
      roll: 0.1,
      expected: { "enemy:front": -468, "enemy:left": -468, "enemy:back": -468 },
    },
    { adjacent: false, roll: 0.9, expected: { "enemy:front": -468 } },
  ])(
    "IT-CAT-ATKCONS-017 [R-EFF-07] SR-331: ラウラPS1の攻撃力補正は当選した隣接攻撃の全対象と元のASの全てに乗る（隣接攻撃$adjacent）",
    ({ roll, expected }) => {
      const observation = observeSkillUse({
        snapshot,
        unitDefinitionId: "UNIT_LAURA_MOUNTAIN",
        use: { kind: "ACTIVE", skillDefinitionId: "SKL_LAURA_MOUNTAIN_AS1" },
        random: new SequenceRandomSource(new Array<number>(32).fill(roll)),
      });
      expect(observation.hpDeltas).toEqual(expected);
    },
  );
});

describe("シールドの攻撃単位の消費（R-SHD-01）", () => {
  it("IT-CAT-ATKCONS-009 [R-EFF-07][R-SHD-01] SR-119: 純夏EXのシールド1000は66×13の1攻撃で残142・残り1回となり、次の攻撃で残量を使って消える", () => {
    const holder = holderWith("UNIT_JUNKA_CHILDHOOD", ["ACT_JUNKA_CHILDHOOD_EX_SHIELD"]);
    const first = strike(holder);
    expect(first.hpDeltas[HOLDER]).toBeUndefined();
    expect(remainingOf(first.units, "ACT_JUNKA_CHILDHOOD_EX_SHIELD")).toEqual([
      { consumption: 1, shield: 142 },
    ]);
    const second = strike(first);
    expect(-second.hpDeltas[HOLDER]!).toBe(858 - 142);
    expect(effectsOf(second.units, "ACT_JUNKA_CHILDHOOD_EX_SHIELD")).toEqual([]);
  });

  it("IT-CAT-ATKCONS-018 [R-EFF-07][R-INT-02] SR-119: 純夏EXのシールドを持つユニットが味方への攻撃を肩代わりすると、実際に受けた保持者で1攻撃分を消費する", () => {
    const holder = holderWith("UNIT_JUNKA_CHILDHOOD", ["ACT_JUNKA_CHILDHOOD_EX_SHIELD"]);
    const coverDefinitionId = createEffectActionDefinitionId("ACT_TEST_COVER");
    // 攻撃者（`enemy:front`）の攻撃を保持者が全量肩代わりする状態（R-INT-02）。
    const coveredByHolder: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("TEST_COVER"),
      effectActionDefinitionId: coverDefinitionId,
      kindKey: effectKindKeyFromDefinitionId(coverDefinitionId),
      duplicate: true,
      sourceUnitId: createBattleUnitId(HOLDER),
      targetUnitId: createBattleUnitId("enemy:front"),
      magnitude: 0,
      categories: ["DEBUFF"],
      cover: {
        covererUnitId: createBattleUnitId(HOLDER),
        damageShareRate: 1,
        guardRate: 0,
        actionKinds: ["DAMAGE"],
      },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
    const units = holder.units.map((unit) =>
      unit.battleUnitId === "enemy:front"
        ? { ...unit, appliedEffects: [...unit.appliedEffects, coveredByHolder] }
        : unit,
    );
    const observed = observeLifecycleDamageProbe({
      definitions: holder.definitions,
      units,
      attackerUnitId: "enemy:front",
      targetUnitId: "ally:front",
      power: POWER_66,
      hitCount: 3,
    });

    expect(observed.redirects.map((redirect) => redirect.newTargetUnitId)).toEqual([
      HOLDER,
      HOLDER,
      HOLDER,
    ]);
    expect(remainingOf(observed.units, "ACT_JUNKA_CHILDHOOD_EX_SHIELD")).toEqual([
      { consumption: 1, shield: 1000 - 66 * 3 },
    ]);
  });

  it("IT-CAT-ATKCONS-010 [R-EFF-07][R-SHD-01] SR-119: 少ヒットの攻撃が2回続くと、容量が残っていても2攻撃目の終了で消える", () => {
    const holder = holderWith("UNIT_JUNKA_CHILDHOOD", ["ACT_JUNKA_CHILDHOOD_EX_SHIELD"]);
    const first = strike(holder, { hitCount: 2 });
    expect(remainingOf(first.units, "ACT_JUNKA_CHILDHOOD_EX_SHIELD")).toEqual([
      { consumption: 1, shield: 1000 - 132 },
    ]);
    const second = strike(first, { hitCount: 2 });
    expect(second.hpDeltas[HOLDER]).toBeUndefined();
    expect(effectsOf(second.units, "ACT_JUNKA_CHILDHOOD_EX_SHIELD")).toEqual([]);
  });

  it("IT-CAT-ATKCONS-011 [R-EFF-07][R-SHD-01] SR-153: 真桜AS1のシールド500は1攻撃の全ヒットで500を吸収してHP減少358、少ヒットの攻撃でも残量ごと消える", () => {
    // 現在HP8000の6.25%＝500。
    const board = { subject: { state: { currentHp: 8000 } } };
    const holder = holderWith("UNIT_MAO_COMMITTEE", ["ACT_MAO_COMMITTEE_AS1_SHIELD"], board);
    const full = strike(holder);
    expect(-full.hpDeltas[HOLDER]!).toBe(358);
    expect(effectsOf(full.units, "ACT_MAO_COMMITTEE_AS1_SHIELD")).toEqual([]);

    const light = strike(holder, { hitCount: 2 });
    expect(light.hpDeltas[HOLDER]).toBeUndefined();
    expect(effectsOf(light.units, "ACT_MAO_COMMITTEE_AS1_SHIELD")).toEqual([]);
  });

  it("IT-CAT-ATKCONS-012 [R-EFF-07][R-SHD-01] SR-406: 翠蘭PS1のシールド2000は66×13の全858を吸収し、重ねた2枚とも同じ攻撃の終了で消える", () => {
    const holder = holderWith("UNIT_SUIRAN_CASINO", [
      "ACT_SUIRAN_CASINO_PS1_SHIELD",
      "ACT_SUIRAN_CASINO_PS1_SHIELD",
    ]);
    expect(effectsOf(holder.units, "ACT_SUIRAN_CASINO_PS1_SHIELD")).toHaveLength(2);
    const observed = strike(holder);
    expect(observed.hpDeltas[HOLDER]).toBeUndefined();
    expect(effectsOf(observed.units, "ACT_SUIRAN_CASINO_PS1_SHIELD")).toEqual([]);
  });

  it("IT-CAT-ATKCONS-013 [R-EFF-07][R-EFF-09] SR-139: 亦菲AS2のシールドを2組重ねても、1回の被攻撃で両組のシールドが消え、他スキルの（行動数で消える）シールドは残る", () => {
    const holder = holderWith("UNIT_YIFEI_STORM", [
      "ACT_YIFEI_STORM_AS2_SHIELD",
      "ACT_LILY_SINGER_PS2_SHIELD",
    ]);
    const shielded = holderWith("UNIT_YIFEI_STORM", ["ACT_YIFEI_STORM_AS2_SHIELD"]);
    const stacked: Holder = {
      definitions: holder.definitions,
      units: holder.units.map((unit) =>
        unit.battleUnitId === HOLDER
          ? {
              ...unit,
              appliedEffects: [
                ...effectsOf(shielded.units, "ACT_YIFEI_STORM_AS2_SHIELD").map((effect) => ({
                  ...effect,
                  effectInstanceId:
                    `${effect.effectInstanceId}:second` as typeof effect.effectInstanceId,
                })),
                ...unit.appliedEffects,
              ],
            }
          : unit,
      ),
    };
    expect(effectsOf(stacked.units, "ACT_YIFEI_STORM_AS2_SHIELD")).toHaveLength(2);
    const observed = strike(stacked, { hitCount: 4 });
    expect(effectsOf(observed.units, "ACT_YIFEI_STORM_AS2_SHIELD")).toEqual([]);
    expect(effectsOf(observed.units, "ACT_LILY_SINGER_PS2_SHIELD")).toHaveLength(1);
  });
});

describe("攻撃側の次の攻撃で消費する補正（範囲攻撃の全対象）", () => {
  const damageOf = (observation: ReturnType<typeof observeSkillUse>, unitId: string) =>
    -(observation.hpDeltas?.[unitId] ?? 0);

  it("IT-CAT-ATKCONS-014 [R-EFF-07] SR-019: ラミPS1の与ダメージ＋20%と抽選の補正は破魔砲の前後2体の両方に乗り、攻撃後に消える", () => {
    const board: BoardOverrides = {};
    const fortune = [
      "ACT_RAMI_NEWYEAR_PS1_DMG_UP",
      "ACT_RAMI_NEWYEAR_PS1_ATK_UP_10",
      "ACT_RAMI_NEWYEAR_PS1_PIERCE_DAIKICHI",
    ];
    const use = { kind: "ACTIVE", skillDefinitionId: "SKL_RAMI_NEWYEAR_AS1" } as const;
    const plain = observeSkillUse({ snapshot, unitDefinitionId: "UNIT_RAMI_NEWYEAR", use, board });
    const boosted = observeSkillUse({
      snapshot,
      unitDefinitionId: "UNIT_RAMI_NEWYEAR",
      use,
      board,
      precedingActions: fortune.map((effectActionDefinitionId) => ({
        effectActionDefinitionId,
        target: "SELF" as const,
      })),
    });

    expect(damageOf(plain, "enemy:front")).toBe(damageOf(plain, "enemy:back"));
    expect(damageOf(boosted, "enemy:front")).toBeGreaterThan(damageOf(plain, "enemy:front"));
    expect(damageOf(boosted, "enemy:back")).toBe(damageOf(boosted, "enemy:front"));
    expect(
      (boosted.effectsRemoved ?? []).map((effect) => effect.effectActionDefinitionId).sort(),
    ).toEqual([...fortune].sort());
  });

  it("IT-CAT-ATKCONS-015 [R-EFF-07][R-CRT-01] SR-292: さやAS2の会心率＋15ポイントは同じ攻撃の3体全員に使われ、各819になる", () => {
    const observation = observeSkillUse({
      snapshot,
      unitDefinitionId: "UNIT_SAYA_BUNNY",
      use: { kind: "ACTIVE", skillDefinitionId: "SKL_SAYA_BUNNY_AS2" },
      random: new SequenceRandomSource(new Array<number>(16).fill(0.1)),
    });
    expect(observation.hpDeltas).toEqual({
      "enemy:front": -819,
      "enemy:left": -819,
      "enemy:back": -819,
    });
  });
});
