import { describe, expect, it } from "vitest";
import { loadProductionSnapshot } from "../../testing/fixtures/index.js";
import {
  chanceEvasionOf,
  dispellableStatModOf,
  hitRolls,
  type HitRoll,
} from "../../testing/production-unit/evasion.js";
import {
  effectKindKeyFromDefinitionId,
  type AppliedEffect,
} from "../../domain/battle/model/applied-effect.js";
import { createEffectActionDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { createEffectInstanceId } from "../../domain/shared/event-ids.js";
import { createBattleUnitId } from "../../domain/shared/ids.js";
import {
  PRODUCTION_CATALOG_DIR,
  observeSkillUse,
  type BoardOverrides,
  type BoardUnitSpec,
  type SkillUse,
  type SkillUseObservation,
} from "../../testing/production-unit/skill-behaviour.js";

/**
 * R-SKL-06 #4a（Issue #827）: 攻撃後効果がどの攻撃の命中を参照するかはスキルごとに
 * 異なる。初撃だけ・追加攻撃だけ・どちらか・範囲内の会心と各対象の命中の組み合わせ・
 * 主対象の命中に連動した全体付与を、実`catalog/`の定義で区別して確かめる。
 *
 * ヒットごとの命中／回避は確率50%の回避と抽選列（`hitRolls`）で作る。各ケースは
 * HPの減り方でも命中したヒットを確かめ、抽選列が意図どおりに消費されたことを保証する。
 */

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  "UNIT_MIRIAM_MAGE",
  "UNIT_JUNKA_CHILDHOOD",
  "UNIT_NOEL_RUMBLE",
  "UNIT_SIENA_DIVA",
  "UNIT_LYDIA_GENIUS",
  "UNIT_SAYA_BUNNY",
  "UNIT_CLARA_SANTA",
  "UNIT_URUU_TIMID",
  "UNIT_MAIA_SALON",
  "UNIT_SHOUKA_SCHEMER",
  "UNIT_HARRIET_SAGE",
  "UNIT_KATE_PALADIN",
]);

type Outcome = "HIT" | "EVADE";

const FRONT = { column: "CENTER", row: "FRONT" } as const;
const LEFT = { column: "LEFT", row: "FRONT" } as const;
const BACK = { column: "CENTER", row: "BACK" } as const;

function enemy(
  id: string,
  position: BoardUnitSpec["position"],
  options: {
    readonly evasive?: boolean;
    readonly currentHp?: number;
    readonly currentExtraGauge?: number;
    readonly effects?: readonly AppliedEffect[];
    readonly markers?: BoardUnitSpec["markers"];
  } = {},
): BoardUnitSpec {
  return {
    id,
    position,
    ...(options.markers === undefined ? {} : { markers: options.markers }),
    state: {
      ...(options.currentHp === undefined ? {} : { currentHp: options.currentHp }),
      ...(options.currentExtraGauge === undefined
        ? {}
        : { currentExtraGauge: options.currentExtraGauge }),
      appliedEffects: [
        ...(options.evasive === true ? [chanceEvasionOf(id)] : []),
        ...(options.effects ?? []),
      ],
    },
  };
}

/** 前列中央だけが回避判定を持つ既定の敵3体。 */
const FRONT_EVASIVE: readonly BoardUnitSpec[] = [
  enemy("enemy:front", FRONT, { evasive: true }),
  enemy("enemy:left", LEFT),
  enemy("enemy:back", BACK),
];

function observe(
  unitDefinitionId: string,
  skillDefinitionId: string,
  rolls: readonly HitRoll[],
  board: BoardOverrides,
  use: Partial<SkillUse> = {},
): SkillUseObservation {
  return observeSkillUse({
    snapshot,
    unitDefinitionId,
    use: { kind: "ACTIVE", skillDefinitionId, ...use } as SkillUse,
    board,
    random: hitRolls(rolls),
  });
}

function removedFrom(observation: SkillUseObservation, unitId: string): string[] {
  return (observation.effectsRemoved ?? [])
    .filter((effect) => effect.unitId === unitId)
    .map((effect) => effect.effectActionDefinitionId);
}

/** 実行された（`APPLIED`の）EffectActionを「効果ID@対象」で並べる。 */
function executed(observation: SkillUseObservation): string[] {
  return (observation.actions ?? [])
    .filter((action) => action.resultKind === undefined)
    .flatMap((action) => action.targets.map((t) => `${action.effectActionDefinitionId}@${t}`));
}

function appliedTo(observation: SkillUseObservation, effectActionDefinitionId: string): string[] {
  return (observation.effectsApplied ?? [])
    .filter((effect) => effect.effectActionDefinitionId === effectActionDefinitionId)
    .map((effect) => effect.unitId);
}

/** 初撃／追加攻撃の命中×回避4通り。 */
const FOUR_WAYS: readonly { readonly first: Outcome; readonly extra: Outcome }[] = [
  { first: "HIT", extra: "HIT" },
  { first: "HIT", extra: "EVADE" },
  { first: "EVADE", extra: "HIT" },
  { first: "EVADE", extra: "EVADE" },
];

describe("命中条件の参照攻撃（初撃限定・追加限定・いずれか）", () => {
  it.each(FOUR_WAYS)(
    "IT-CAT-HITCOND-011 [R-SKL-06] SR-087: ミリアムAS1の与ダメージ低下は初撃の命中だけを条件にする（初撃$first・追加$extra）",
    ({ first, extra }) => {
      // 初撃3体 → 追加攻撃3体の順に解決する。初撃312・追加156。
      const observation = observe(
        "UNIT_MIRIAM_MAGE",
        "SKL_MIRIAM_MAGE_AS1",
        [first, "PLAIN", "PLAIN", extra, "PLAIN", "PLAIN"],
        { enemies: FRONT_EVASIVE },
      );

      const hp = (first === "HIT" ? 312 : 0) + (extra === "HIT" ? 156 : 0);
      expect(observation.hpDeltas?.["enemy:front"]).toBe(hp === 0 ? undefined : -hp);
      expect(appliedTo(observation, "ACT_MIRIAM_MAGE_AS1_DMG_DOWN")).toEqual(
        first === "HIT"
          ? ["enemy:front", "enemy:left", "enemy:back"]
          : ["enemy:left", "enemy:back"],
      );
    },
  );

  it("IT-CAT-HITCOND-012 [R-SKL-06] SR-087: ミリアムAS1は敵3体それぞれの初撃命中で判定する（命中/回避が混在する盤面）", () => {
    const observation = observe(
      "UNIT_MIRIAM_MAGE",
      "SKL_MIRIAM_MAGE_AS1",
      // 前：命中→回避、左：回避→命中、後：回避→回避
      ["HIT", "EVADE", "EVADE", "EVADE", "HIT", "EVADE"],
      {
        enemies: [
          enemy("enemy:front", FRONT, { evasive: true }),
          enemy("enemy:left", LEFT, { evasive: true }),
          enemy("enemy:back", BACK, { evasive: true }),
        ],
      },
    );

    expect(observation.hpDeltas).toEqual({ "enemy:front": -312, "enemy:left": -156 });
    expect(appliedTo(observation, "ACT_MIRIAM_MAGE_AS1_DMG_DOWN")).toEqual(["enemy:front"]);
  });

  it.each([
    {
      sr: "SR-246",
      unit: "UNIT_JUNKA_CHILDHOOD",
      skill: "SKL_JUNKA_CHILDHOOD_AS1",
      effect: "ACT_JUNKA_CHILDHOOD_AS1_DEBUFF",
      // 最寄り（前列中央）→ 隣接2体 → 生存していれば最寄りへ追加。
      rolls: (first: Outcome, extra: Outcome) => [first, "PLAIN", "PLAIN", extra] as const,
    },
    {
      sr: "SR-257",
      unit: "UNIT_NOEL_RUMBLE",
      skill: "SKL_NOEL_RUMBLE_EX",
      effect: "ACT_NOEL_RUMBLE_EX_BURN",
      rolls: (first: Outcome, extra: Outcome) => [first, "PLAIN", "PLAIN", extra] as const,
      use: { actionType: "EX" } as const,
    },
    {
      sr: "SR-304",
      unit: "UNIT_SIENA_DIVA",
      skill: "SKL_SIENA_DIVA_AS2",
      effect: "ACT_SIENA_DIVA_AS2_DMG_DOWN",
      rolls: (first: Outcome, extra: Outcome) => [first, extra] as const,
      subject: { markers: [{ markerId: "MARKER_SIENA_RHYTHMICAL", stackCount: 1 }] },
    },
    {
      sr: "SR-398",
      unit: "UNIT_LYDIA_GENIUS",
      skill: "SKL_LYDIA_GENIUS_AS2",
      effect: "ACT_LYDIA_GENIUS_AS2_DEBUFF",
      // 本体2ヒット → 追加1ヒット。本体は2ヒットとも同じ成否にする。
      rolls: (first: Outcome, extra: Outcome) => [first, first, extra] as const,
    },
  ])(
    "IT-CAT-HITCOND-013 [R-SKL-06] $sr: $skill の低下は追加攻撃の命中だけを条件にする（4通り）",
    ({ unit, skill, effect, rolls, ...rest }) => {
      for (const { first, extra } of FOUR_WAYS) {
        const observation = observe(
          unit,
          skill,
          rolls(first, extra),
          {
            enemies: FRONT_EVASIVE,
            ...("subject" in rest ? { subject: rest.subject } : {}),
          },
          "use" in rest ? rest.use : {},
        );
        const hits = (observation.actions ?? []).filter(
          (action) => action.targets.includes("enemy:front") && action.resultKind === undefined,
        );
        // 抽選列どおりに初撃・追加攻撃の成否が出ていること（命中したDAMAGEの件数）。
        expect(
          hits.filter((action) => action.effectActionDefinitionId.includes("DAMAGE")).length,
          `${first}/${extra}`,
        ).toBe((first === "HIT" ? 1 : 0) + (extra === "HIT" ? 1 : 0));
        expect(appliedTo(observation, effect), `${first}/${extra}`).toEqual(
          extra === "HIT" ? ["enemy:front"] : [],
        );
      }
    },
  );

  it.each(FOUR_WAYS)(
    "IT-CAT-HITCOND-014 [R-SKL-06] SR-291: 沙耶AS1の与ダメージ低下は初撃・第2撃のいずれかの命中で付く（初撃$first・第2撃$extra）",
    ({ first, extra }) => {
      const observation = observe("UNIT_SAYA_BUNNY", "SKL_SAYA_BUNNY_AS1", [first, extra], {
        enemies: FRONT_EVASIVE,
      });

      const hp = (first === "HIT" ? 780 : 0) + (extra === "HIT" ? 546 : 0);
      expect(observation.hpDeltas?.["enemy:front"]).toBe(hp === 0 ? undefined : -hp);
      expect(appliedTo(observation, "ACT_SAYA_BUNNY_AS1_DEBUFF")).toEqual(
        first === "HIT" || extra === "HIT" ? ["enemy:front"] : [],
      );
    },
  );

  it.each([
    { main: "HIT", tagged: true },
    { main: "EVADE", tagged: false },
  ] as const)(
    "IT-CAT-HITCOND-015 [R-SKL-06] SR-272: クララAS1のサンタタグは主対象への初撃が命中したときだけ付き、後半の別敵への命中で代替しない（初撃$main）",
    ({ main, tagged }) => {
      // 主対象＝後列優先・最高HP割合（後列中央）、後半＝最低HP割合（前列中央）。
      const observation = observe("UNIT_CLARA_SANTA", "SKL_CLARA_SANTA_AS1", [main, "PLAIN"], {
        enemies: [
          enemy("enemy:front", FRONT, { currentHp: 3000 }),
          enemy("enemy:left", LEFT),
          enemy("enemy:back", BACK, { evasive: true }),
        ],
      });

      expect(observation.hpDeltas?.["enemy:front"]).toBeLessThan(0);
      expect((observation.markers ?? []).map((marker) => marker.unitId)).toEqual(
        tagged ? ["enemy:back"] : [],
      );
    },
  );

  it("IT-CAT-HITCOND-016 [R-SKL-06] SR-272: 主対象と後半の対象が同じでも、初撃を回避したなら後半の命中でタグを付けない", () => {
    const observation = observe("UNIT_CLARA_SANTA", "SKL_CLARA_SANTA_AS1", ["EVADE", "HIT"], {
      enemies: [
        enemy("enemy:front", FRONT),
        enemy("enemy:left", LEFT),
        enemy("enemy:back", BACK, { evasive: true, currentHp: 3000 }),
      ],
    });

    expect(observation.hpDeltas?.["enemy:back"]).toBeLessThan(0);
    expect(observation.markers ?? []).toEqual([]);
  });
});

describe("範囲内の会心と対象別の命中（SR-013・SR-014）", () => {
  const CRIT_BOARD = { combatStats: { criticalRate: 0.5 } } as const;

  it("IT-CAT-HITCOND-017 [R-SKL-06] SR-013: うるうAS1は列のどこかの会心で非会心の命中敵にも両デバフを付け、回避した敵には付けない", () => {
    const debuffs = (observation: SkillUseObservation) => [
      ...appliedTo(observation, "ACT_URUU_TIMID_AS1_DMG_TAKEN_UP"),
      ...appliedTo(observation, "ACT_URUU_TIMID_AS1_CRIT_DOWN"),
    ];
    const enemies = [
      enemy("enemy:front", FRONT),
      enemy("enemy:left", LEFT, { evasive: true }),
      enemy("enemy:back", BACK),
    ];
    // 列（前列）は前列中央 → 前列左の順に解決する。
    const critAndHit = observe("UNIT_URUU_TIMID", "SKL_URUU_TIMID_AS1", ["CRIT", "HIT"], {
      ...CRIT_BOARD,
      enemies,
    });
    expect(debuffs(critAndHit).sort()).toEqual(
      ["enemy:front", "enemy:front", "enemy:left", "enemy:left"].sort(),
    );

    const critAndEvade = observe("UNIT_URUU_TIMID", "SKL_URUU_TIMID_AS1", ["CRIT", "EVADE"], {
      ...CRIT_BOARD,
      enemies,
    });
    expect(critAndEvade.hpDeltas?.["enemy:left"]).toBeUndefined();
    expect(debuffs(critAndEvade)).toEqual(["enemy:front", "enemy:front"]);

    const noCrit = observe("UNIT_URUU_TIMID", "SKL_URUU_TIMID_AS1", ["PLAIN", "HIT"], {
      ...CRIT_BOARD,
      enemies,
    });
    expect(debuffs(noCrit)).toEqual([]);
  });

  it("IT-CAT-HITCOND-018 [R-SKL-06] SR-014: うるうEXの被ダメージ増加は攻撃全体の会心と、その敵への最初の5ヒットの命中で付き、後の追加1ヒットで代替しない", () => {
    const observation = observe(
      "UNIT_URUU_TIMID",
      "SKL_URUU_TIMID_EX",
      [
        // 前列中央：1ヒット目が会心
        "CRIT",
        "PLAIN",
        "PLAIN",
        "PLAIN",
        "PLAIN",
        // 前列左：5ヒット全回避
        "EVADE",
        "EVADE",
        "EVADE",
        "EVADE",
        "EVADE",
        // 後列中央：1ヒットだけ命中（非会心）
        "HIT",
        "EVADE",
        "EVADE",
        "EVADE",
        "EVADE",
        // 会心時の追加1ヒット（前列左にも命中する）
        "PLAIN",
        "HIT",
        "HIT",
      ],
      {
        ...CRIT_BOARD,
        enemies: [
          enemy("enemy:front", FRONT),
          enemy("enemy:left", LEFT, { evasive: true }),
          enemy("enemy:back", BACK, { evasive: true }),
        ],
      },
      { actionType: "EX" },
    );

    // 被ダメージ＋100%は直後の追加1ヒットで消費されるため、付与の開始で見る。
    expect(executed(observation)).toContain("ACT_URUU_TIMID_EX_DAMAGE_CRIT@enemy:left");
    expect(
      executed(observation).filter((a) => a.startsWith("ACT_URUU_TIMID_EX_DMG_TAKEN_UP")),
    ).toEqual([
      "ACT_URUU_TIMID_EX_DMG_TAKEN_UP@enemy:front",
      "ACT_URUU_TIMID_EX_DMG_TAKEN_UP@enemy:back",
    ]);
  });

  it("IT-CAT-HITCOND-019 [R-SKL-06] SR-014: うるうEXは攻撃全体に会心が無ければ命中した敵にも付けない", () => {
    const observation = observe(
      "UNIT_URUU_TIMID",
      "SKL_URUU_TIMID_EX",
      new Array<HitRoll>(15).fill("PLAIN"),
      CRIT_BOARD,
      { actionType: "EX" },
    );

    expect(executed(observation).some((a) => a.startsWith("ACT_URUU_TIMID_EX_DMG_TAKEN_UP"))).toBe(
      false,
    );
    expect(executed(observation).some((a) => a.startsWith("ACT_URUU_TIMID_EX_DAMAGE_CRIT"))).toBe(
      false,
    );
  });
});

describe("主対象の命中に連動した全体付与（SR-102）", () => {
  const ALLIES_UP = ["ally:subject", "ally:front", "ally:back"].sort();

  it.each([
    { main: "HIT", currentHp: 3000, enemiesDown: ["enemy:front", "enemy:left", "enemy:back"] },
    { main: "EVADE", currentHp: 3000, enemiesDown: [] },
    // 撃破した場合は他の生存敵へ付く。
    { main: "HIT", currentHp: 1, enemiesDown: ["enemy:left", "enemy:back"] },
  ] as const)(
    "IT-CAT-HITCOND-020 [R-SKL-06] SR-102: マイアEXの敵全体の速度低下は単体攻撃の命中に連動し、味方の速度上昇は常に付く（$main・HP$currentHp）",
    ({ main, currentHp, enemiesDown }) => {
      const observation = observe(
        "UNIT_MAIA_SALON",
        "SKL_MAIA_SALON_EX",
        [main],
        {
          enemies: [
            enemy("enemy:front", FRONT, { evasive: true, currentHp }),
            enemy("enemy:left", LEFT),
            enemy("enemy:back", BACK),
          ],
        },
        { actionType: "EX" },
      );

      expect(observation.hpDeltas?.["enemy:front"]).toBe(
        main === "EVADE" ? undefined : currentHp === 1 ? -1 : -780,
      );
      expect(appliedTo(observation, "ACT_MAIA_SALON_EX_ENEMY_SPEED_DOWN")).toEqual(enemiesDown);
      expect(appliedTo(observation, "ACT_MAIA_SALON_EX_ALLY_SPEED_UP").sort()).toEqual(ALLIES_UP);
    },
  );
});

describe("攻撃後のBUFF解除（SR-209・SR-294）", () => {
  const DEF_UP = "ACT_SHOUKA_SCHEMER_AS2_DEF_UP";
  const buffs = (id: string, count: number) =>
    Array.from({ length: count }, (_, index) =>
      dispellableStatModOf(id, DEF_UP, { index, stat: "DEFENSE" }),
    );

  it("IT-CAT-HITCOND-021 [R-SKL-06] SR-209: 翔華EXは命中した生存敵だけから古いBUFFを最大3個解除し、味方全体の状態異常免疫は回避と独立して付く", () => {
    const observation = observe(
      "UNIT_SHOUKA_SCHEMER",
      "SKL_SHOUKA_SCHEMER_EX",
      ["EVADE", "PLAIN", "PLAIN"],
      {
        enemies: [
          enemy("enemy:front", FRONT, { evasive: true, effects: buffs("enemy:front", 4) }),
          enemy("enemy:left", LEFT, { effects: buffs("enemy:left", 4) }),
          enemy("enemy:back", BACK, { currentHp: 1, effects: buffs("enemy:back", 1) }),
        ],
      },
      { actionType: "EX" },
    );

    expect(removedFrom(observation, "enemy:front")).toEqual([]);
    expect(removedFrom(observation, "enemy:left")).toEqual([DEF_UP, DEF_UP, DEF_UP]);
    expect(executed(observation)).not.toContain("ACT_SHOUKA_SCHEMER_EX_REMOVE_BUFF@enemy:back");
    expect(appliedTo(observation, "ACT_SHOUKA_SCHEMER_EX_IMMUNITY").sort()).toEqual(
      ["ally:subject", "ally:front", "ally:back"].sort(),
    );
  });

  const attackDebuff = (holderId: string): AppliedEffect =>
    dispellableStatModOf(holderId, "ACT_SHOUKA_SCHEMER_AS1_ATK_DOWN", {
      category: "DEBUFF",
      stat: "ATTACK",
    });

  it.each([
    { roll: "HIT", attackDebuffed: false, removed: 1 },
    { roll: "EVADE", attackDebuffed: false, removed: 0 },
    { roll: "HIT", attackDebuffed: true, removed: 1 },
    { roll: "EVADE", attackDebuffed: true, removed: 0 },
  ] as const)(
    "IT-CAT-HITCOND-022 [R-SKL-06] SR-294: 翔華AS3はどちらの分岐でも命中した敵からだけBUFFを1個解除する（$roll・攻撃力デバフ$attackDebuffed）",
    ({ roll, attackDebuffed, removed }) => {
      const observation = observe("UNIT_SHOUKA_SCHEMER", "SKL_SHOUKA_SCHEMER_AS3", [roll], {
        enemies: [
          enemy("enemy:front", FRONT, {
            evasive: true,
            effects: [
              ...buffs("enemy:front", 2),
              ...(attackDebuffed ? [attackDebuff("enemy:front")] : []),
            ],
          }),
          enemy("enemy:left", LEFT),
          enemy("enemy:back", BACK),
        ],
      });

      expect(observation.hpDeltas?.["enemy:front"]).toBe(
        roll === "EVADE" ? undefined : attackDebuffed ? -873 : -624,
      );
      expect(removedFrom(observation, "enemy:front")).toEqual(new Array(removed).fill(DEF_UP));
    },
  );
});

describe("カースの新規付与と既存カースの清算（SR-297）", () => {
  const harriet = (curses: number, roll: HitRoll) =>
    observe("UNIT_HARRIET_SAGE", "SKL_HARRIET_SAGE_AS1", [roll, "PLAIN", "PLAIN"], {
      enemies: [
        enemy("enemy:front", FRONT, {
          evasive: true,
          markers: [{ markerId: "MARKER_CURSE", stackCount: curses }],
        }),
        enemy("enemy:left", LEFT),
        enemy("enemy:back", BACK),
      ],
    });
  const onFront = (observation: SkillUseObservation) =>
    executed(observation)
      .filter((action) => action.endsWith("@enemy:front"))
      .map((action) => action.replace("@enemy:front", ""));

  it("IT-CAT-HITCOND-023 [R-SKL-06] SR-297: 回避した敵には新規カース・両低下を付けない（既存3個は3のまま）", () => {
    expect(onFront(harriet(3, "EVADE"))).toEqual([]);
    expect(onFront(harriet(3, "HIT"))).toEqual([
      "ACT_HARRIET_SAGE_AS1_DAMAGE",
      "ACT_HARRIET_SAGE_AS1_MARKER",
      "ACT_HARRIET_SAGE_AS1_ATKDOWN",
      "ACT_HARRIET_SAGE_AS1_DMGDOWN",
      "ACT_HARRIET_SAGE_AS1_PP_ZERO",
      "ACT_HARRIET_SAGE_AS1_REMOVE_CURSE",
    ]);
  });

  it("IT-CAT-HITCOND-024 [R-SKL-06] SR-297: 既存カース4個の清算（PP0・全カース消去）は本体を回避しても実行する", () => {
    expect(onFront(harriet(4, "EVADE"))).toEqual([
      "ACT_HARRIET_SAGE_AS1_PP_ZERO",
      "ACT_HARRIET_SAGE_AS1_REMOVE_CURSE",
    ]);
  });

  /** 使用者（ハリエット）の攻撃を`covererId`が全量肩代わりする状態（R-INT-02）。 */
  const coveredBy = (covererId: string): AppliedEffect => {
    const definitionId = createEffectActionDefinitionId("ACT_TEST_COVER");
    return {
      effectInstanceId: createEffectInstanceId("TEST_COVER"),
      effectActionDefinitionId: definitionId,
      kindKey: effectKindKeyFromDefinitionId(definitionId),
      duplicate: true,
      sourceUnitId: createBattleUnitId(covererId),
      targetUnitId: createBattleUnitId("ally:subject"),
      magnitude: 0,
      categories: ["DEBUFF"],
      cover: {
        covererUnitId: createBattleUnitId(covererId),
        damageShareRate: 1,
        guardRate: 0,
        actionKinds: ["DAMAGE"],
      },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
  };

  it("IT-CAT-HITCOND-028 [R-SKL-06, R-INT-02] SR-297: 攻撃範囲外の肩代わり者が4個目のカースを受けたら、その肩代わり者を清算する", () => {
    const observation = observe("UNIT_HARRIET_SAGE", "SKL_HARRIET_SAGE_AS1", ["PLAIN"], {
      subject: { state: { appliedEffects: [coveredBy("enemy:far")] } },
      enemies: [
        // 前列中央に隣接する敵はいない（攻撃は前列中央の1回だけ）。
        enemy("enemy:front", FRONT),
        {
          id: "enemy:far",
          position: { column: "RIGHT", row: "BACK" },
          markers: [{ markerId: "MARKER_CURSE", stackCount: 3 }],
          state: { currentPp: 4 },
        },
      ],
    });

    expect(observation.hpDeltas?.["enemy:front"]).toBeUndefined();
    expect(observation.hpDeltas?.["enemy:far"]).toBeLessThan(0);
    const onFar = executed(observation)
      .filter((action) => action.endsWith("@enemy:far"))
      .map((action) => action.replace("@enemy:far", ""));
    expect(onFar).toEqual([
      "ACT_HARRIET_SAGE_AS1_MARKER",
      "ACT_HARRIET_SAGE_AS1_ATKDOWN",
      "ACT_HARRIET_SAGE_AS1_DMGDOWN",
      "ACT_HARRIET_SAGE_AS1_PP_ZERO",
      "ACT_HARRIET_SAGE_AS1_REMOVE_CURSE",
    ]);
    // 元の対象（カースなし）は清算しない。
    expect(executed(observation).filter((action) => action.endsWith("@enemy:front"))).toEqual([
      "ACT_HARRIET_SAGE_AS1_DAMAGE@enemy:front",
    ]);
  });

  it("IT-CAT-HITCOND-029 [R-SKL-06, R-INT-02] SR-297: 肩代わりされた元の対象が既存カース4個なら、元の対象も清算する", () => {
    const observation = observe("UNIT_HARRIET_SAGE", "SKL_HARRIET_SAGE_AS1", ["PLAIN"], {
      subject: { state: { appliedEffects: [coveredBy("enemy:far")] } },
      enemies: [
        enemy("enemy:front", FRONT, { markers: [{ markerId: "MARKER_CURSE", stackCount: 4 }] }),
        { id: "enemy:far", position: { column: "RIGHT", row: "BACK" } },
      ],
    });

    expect(executed(observation).filter((action) => action.endsWith("@enemy:front"))).toEqual([
      "ACT_HARRIET_SAGE_AS1_DAMAGE@enemy:front",
      "ACT_HARRIET_SAGE_AS1_PP_ZERO@enemy:front",
      "ACT_HARRIET_SAGE_AS1_REMOVE_CURSE@enemy:front",
    ]);
    // 肩代わり者は新規カース1個だけで、清算しない。
    expect(
      executed(observation).filter((action) => action.startsWith("ACT_HARRIET_SAGE_AS1_PP_ZERO")),
    ).toEqual(["ACT_HARRIET_SAGE_AS1_PP_ZERO@enemy:front"]);
  });
});

describe("祝福の斬撃の抽選低下（SR-328）", () => {
  // 4択（EX減少・与ダメージ低下・自己回復・なし）を等重みで1つ選ぶ。0.3は2番目。
  const PICK_DMG_DOWN = 0.3;
  const PICK_EX_DOWN = 0.1;
  const PICK_SELF_HEAL = 0.6;

  const kate = (roll: HitRoll, picks: readonly [number, number], second: HitRoll = roll) =>
    observe(
      "UNIT_KATE_PALADIN",
      "SKL_KATE_PALADIN_AS1",
      [roll, roll, roll, roll, picks[0], second, second, second, second, picks[1]],
      {
        enemies: [
          enemy("enemy:front", FRONT, { evasive: true, currentExtraGauge: 5 }),
          enemy("enemy:left", LEFT),
          enemy("enemy:back", BACK),
        ],
      },
    );

  it("IT-CAT-HITCOND-025 [R-SKL-06] SR-328: 全8ヒットを回避した敵には、両抽選が与ダメージ低下でも付けない", () => {
    const evaded = kate("EVADE", [PICK_DMG_DOWN, PICK_DMG_DOWN]);
    expect(evaded.hpDeltas?.["enemy:front"]).toBeUndefined();
    expect(appliedTo(evaded, "ACT_KATE_PALADIN_AS1_DMG_DOWN")).toEqual([]);

    const hit = kate("HIT", [PICK_DMG_DOWN, PICK_DMG_DOWN]);
    expect(appliedTo(hit, "ACT_KATE_PALADIN_AS1_DMG_DOWN")).toEqual(["enemy:front", "enemy:front"]);
  });

  it.each([
    // 前半の抽選は前半4ヒット、後半の抽選は前後8ヒットのいずれかの命中を参照する（Q-SRV-03）。
    { first: "HIT", second: "EVADE", debuffs: 2 },
    { first: "EVADE", second: "HIT", debuffs: 1 },
  ] as const)(
    "IT-CAT-HITCOND-027 [R-SKL-06] SR-328: 各抽選はその時点までの命中を参照する（前半$first・後半$second → 低下$debuffs件）",
    ({ first, second, debuffs }) => {
      const observation = kate(first, [PICK_DMG_DOWN, PICK_DMG_DOWN], second);
      expect(observation.hpDeltas?.["enemy:front"]).toBeLessThan(0);
      expect(appliedTo(observation, "ACT_KATE_PALADIN_AS1_DMG_DOWN")).toEqual(
        new Array(debuffs).fill("enemy:front"),
      );
    },
  );

  it("IT-CAT-HITCOND-026 [R-SKL-06] SR-328: 直接のEX減少と自己回復は全回避でも抽選どおりに起きる", () => {
    const observation = kate("EVADE", [PICK_EX_DOWN, PICK_SELF_HEAL]);
    expect(executed(observation)).toEqual(
      expect.arrayContaining([
        "ACT_KATE_PALADIN_AS1_EX_DOWN@enemy:front",
        "ACT_KATE_PALADIN_AS1_SELF_HEAL_20@ally:subject",
      ]),
    );
  });
});
