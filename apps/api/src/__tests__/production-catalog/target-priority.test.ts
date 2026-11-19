import { describe, expect, it } from "vitest";
import { loadProductionSnapshot } from "../../testing/fixtures/index.js";
import { evasionOf } from "../../testing/production-unit/evasion.js";
import {
  PRODUCTION_CATALOG_DIR,
  observeSkillUse,
  type BoardOverrides,
  type BoardUnitSpec,
  type SkillUseObservation,
} from "../../testing/production-unit/skill-behaviour.js";
import type { TargetSelectorDefinition } from "../../domain/catalog/definitions/target-selector-definition.js";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import { skillUseCompleted, turnStarted } from "../../testing/production-unit/trigger-events.js";

/**
 * Issue #831（FIX-07）: 対象優先度・隣接範囲・本人の除外／包含・対象不在時の不発。
 *
 * 実`catalog/`の定義を実経路へ通し、評価シートの確定仕様どおりの対象だけに効果が
 * 届くことを確かめる。
 */

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  "UNIT_MIHIME_SNIPER",
  "UNIT_MIKOTO_SURVIVOR",
  "UNIT_LYDIA_SUMMER",
  "UNIT_LYDIA_SUMMER_TEX",
  "UNIT_FEE_ACTOR",
  "UNIT_AOI_ELEGANT",
  "UNIT_HARRIET_SAGE",
  "UNIT_KOKORO_SPORTSDAY",
  "UNIT_LUNA_HUNGRY",
  "UNIT_KATE_PALADIN",
  "UNIT_LUCIE_MAID",
  "UNIT_URUU_SUMMER",
  "UNIT_INIA_CRYSKA",
  "UNIT_SHIRANA_LUCKY",
  "UNIT_HIIRO_FREEWOLF",
  "UNIT_MERU_SIRIUS",
  "UNIT_LAURA_MOUNTAIN",
  "UNIT_CHIYURU_MAZE",
  "UNIT_MAO_COMMITTEE",
  "UNIT_JULIE_SNOW",
]);

/** 基準（敵前列中央）の上（後列中央）・左・右・斜めに敵がいる盤面。 */
function crossBoard(base: Partial<BoardUnitSpec> = {}): BoardOverrides {
  return {
    enemies: [
      { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, ...base },
      { id: "enemy:right", position: { column: "RIGHT", row: "FRONT" } },
      { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
      { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      { id: "enemy:diag", position: { column: "LEFT", row: "BACK" } },
    ],
  };
}

function targetsOf(observation: SkillUseObservation, effectActionDefinitionId: string): string[] {
  return (observation.actions ?? [])
    .filter((action) => action.effectActionDefinitionId === effectActionDefinitionId)
    .flatMap((action) => action.targets);
}

function appliedTo(observation: SkillUseObservation, effectActionDefinitionId: string): string[] {
  return (observation.effectsApplied ?? [])
    .filter((effect) => effect.effectActionDefinitionId === effectActionDefinitionId)
    .map((effect) => effect.unitId);
}

function skillOf(skillDefinitionId: string) {
  const skill = snapshot.skills.get(createSkillDefinitionId(skillDefinitionId));
  if (skill === undefined) {
    throw new Error(`missing ${skillDefinitionId}`);
  }
  return skill;
}

function adjacentSelectors(skillDefinitionId: string): TargetSelectorDefinition[] {
  const skill = skillOf(skillDefinitionId);
  if (skill.resolution.kind !== "IMMEDIATE") {
    return [];
  }
  return skill.resolution.targetBindings
    .map((binding) => binding.selector)
    .filter((selector) => selector.area?.kind === "ADJACENT_ORTHOGONAL");
}

describe("FIX-07 隣接2体（R-TGT-04）", () => {
  const ADJACENT_TWO = [
    "SKL_MIHIME_SNIPER_AS2",
    "SKL_MIKOTO_SURVIVOR_AS1",
    "SKL_LYDIA_SUMMER_AS1",
    "SKL_LYDIA_SUMMER_TEX_AS1",
    "SKL_FEE_ACTOR_AS1",
    "SKL_AOI_ELEGANT_AS2",
    "SKL_HARRIET_SAGE_AS1",
    "SKL_KOKORO_SPORTSDAY_PS2",
  ];
  const ADJACENT_ALL = [
    "SKL_LUNA_HUNGRY_AS1",
    "SKL_KATE_PALADIN_AS3",
    "SKL_LUCIE_MAID_AS2",
    "SKL_URUU_SUMMER_EX",
    "SKL_INIA_CRYSKA_AS1",
  ];

  it.each(ADJACENT_TWO)(
    "IT-CAT-TGTPRI-001 [R-TGT-04] %s: 「隣接する2体」は上→左→右→下の順で最大2体を選ぶ",
    (skillDefinitionId) => {
      const selectors = adjacentSelectors(skillDefinitionId);
      expect(selectors).not.toHaveLength(0);
      for (const selector of selectors) {
        expect(selector.count).toBe(2);
        expect(selector.order).toEqual(["ADJACENT_DIRECTION"]);
      }
    },
  );

  it.each(ADJACENT_ALL)(
    "IT-CAT-TGTPRI-002 [R-TGT-04] %s: 「隣接する敵」と全員を指すスキルは上限を持たない",
    (skillDefinitionId) => {
      for (const selector of adjacentSelectors(skillDefinitionId)) {
        expect(selector.count).toBeUndefined();
      }
    },
  );

  it("IT-CAT-TGTPRI-003 [R-TGT-04] (SR-145): フィーAS1は隣接3候補から上（後列）と左だけを攻撃し、右・斜めへは攻撃しない。基準のAP−1は維持", () => {
    const observation = observeSkillUse({
      snapshot,
      unitDefinitionId: "UNIT_FEE_ACTOR",
      use: { kind: "ACTIVE", skillDefinitionId: "SKL_FEE_ACTOR_AS1" },
      board: crossBoard(),
    });

    expect(targetsOf(observation, "ACT_FEE_ACTOR_AS1_DAMAGE_ADJACENT")).toEqual([
      "enemy:back",
      "enemy:left",
    ]);
    expect(observation.resources).toContainEqual({
      unitId: "enemy:front",
      resource: "AP",
      delta: -1,
    });
  });

  it("IT-CAT-TGTPRI-004 [R-TGT-04] (SR-053): 美琴AS1の防御低下は選んだ2体と基準だけに付き、未選択の右には攻撃も低下も無い", () => {
    const observation = observeSkillUse({
      snapshot,
      unitDefinitionId: "UNIT_MIKOTO_SURVIVOR",
      use: { kind: "ACTIVE", skillDefinitionId: "SKL_MIKOTO_SURVIVOR_AS1" },
      board: crossBoard(),
    });

    expect(targetsOf(observation, "ACT_MIKOTO_SURVIVOR_AS1_DAMAGE_ADJ")).toEqual([
      "enemy:back",
      "enemy:left",
    ]);
    expect(appliedTo(observation, "ACT_MIKOTO_SURVIVOR_AS1_DEFDOWN").sort()).toEqual(
      ["enemy:back", "enemy:front", "enemy:left"].sort(),
    );
    expect(observation.hpDeltas?.["enemy:right"]).toBeUndefined();
  });

  it("IT-CAT-TGTPRI-005 [R-TGT-04] (SR-100): リディアAS1は上が欠けると左・右を選び、後列追加も選んだ対象だけに行う", () => {
    const observation = observeSkillUse({
      snapshot,
      unitDefinitionId: "UNIT_LYDIA_SUMMER",
      use: { kind: "ACTIVE", skillDefinitionId: "SKL_LYDIA_SUMMER_AS1" },
      board: {
        enemies: [
          {
            id: "enemy:base",
            position: { column: "CENTER", row: "BACK" },
            combatStats: { maximumHp: 20000 },
          },
          { id: "enemy:down", position: { column: "CENTER", row: "FRONT" } },
          { id: "enemy:left", position: { column: "LEFT", row: "BACK" } },
          { id: "enemy:right", position: { column: "RIGHT", row: "BACK" } },
        ],
      },
    });

    expect(targetsOf(observation, "ACT_LYDIA_SUMMER_AS1_DAMAGE")).toEqual([
      "enemy:base",
      "enemy:left",
      "enemy:right",
    ]);
    expect(targetsOf(observation, "ACT_LYDIA_SUMMER_AS1_BACKROW_BONUS")).toEqual([
      "enemy:base",
      "enemy:left",
      "enemy:right",
    ]);
    expect(observation.hpDeltas?.["enemy:down"]).toBeUndefined();
  });

  it("IT-CAT-TGTPRI-006 [R-TGT-04] (SR-384): 心香PS2はストイック中、基準と選んだ隣接2体のうち命中した生存対象へ与ダメージ低下を付け、回避した隣接と範囲外には付けない", () => {
    const board = crossBoard();
    const observation = observeSkillUse({
      snapshot,
      unitDefinitionId: "UNIT_KOKORO_SPORTSDAY",
      use: {
        kind: "PASSIVE",
        skillDefinitionId: "SKL_KOKORO_SPORTSDAY_PS2",
        trigger: turnStarted({ turnNumber: 1 }),
        triggeredBy: "ally:subject",
      },
      board: {
        ...board,
        subject: { markers: [{ markerId: "MARKER_KOKORO_SPORTSDAY_STOIC" }] },
        enemies: (board.enemies ?? []).map((spec) =>
          spec.id === "enemy:left"
            ? { ...spec, state: { appliedEffects: [evasionOf("enemy:left")] } }
            : spec,
        ),
      },
    });

    expect(targetsOf(observation, "ACT_KOKORO_SPORTSDAY_PS2_DAMAGE")).toEqual([
      "enemy:front",
      "enemy:back",
      "enemy:left",
    ]);
    expect(appliedTo(observation, "ACT_KOKORO_SPORTSDAY_PS2_DMG_DOWN").sort()).toEqual(
      ["enemy:back", "enemy:front"].sort(),
    );
  });
});

describe("FIX-07 本人の除外・包含と2体目の選択順", () => {
  it("IT-CAT-TGTPRI-007 [R-TGT-02] (SR-028): 壬姫AS1の2体目は最初の対象を除いた通常順で選び、HP割合2位へは行かない", () => {
    const observation = observeSkillUse({
      snapshot,
      unitDefinitionId: "UNIT_MIHIME_SNIPER",
      use: { kind: "ACTIVE", skillDefinitionId: "SKL_MIHIME_SNIPER_AS1" },
      board: {
        enemies: [
          { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
          {
            id: "enemy:left",
            position: { column: "LEFT", row: "FRONT" },
            state: { currentHp: 3000 },
          },
          {
            id: "enemy:back",
            position: { column: "CENTER", row: "BACK" },
            state: { currentHp: 2000 },
          },
        ],
      },
    });

    expect(targetsOf(observation, "ACT_MIHIME_SNIPER_AS1_DAMAGE1")).toEqual(["enemy:back"]);
    expect(targetsOf(observation, "ACT_MIHIME_SNIPER_AS1_DAMAGE2")).toEqual(["enemy:front"]);
  });

  it("IT-CAT-TGTPRI-008 [R-TGT-01] (SR-134): 白奈AS2のシールドは本人を除いた最も近い味方へ付き、本人だけの編成でも攻撃は行い本人へは付けない", () => {
    const withAllies = observeSkillUse({
      snapshot,
      unitDefinitionId: "UNIT_SHIRANA_LUCKY",
      use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHIRANA_LUCKY_AS2" },
    });
    const alone = observeSkillUse({
      snapshot,
      unitDefinitionId: "UNIT_SHIRANA_LUCKY",
      use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHIRANA_LUCKY_AS2" },
      board: { allies: [] },
    });

    expect(targetsOf(withAllies, "ACT_SHIRANA_LUCKY_AS2_SHIELD")).toEqual(["ally:front"]);
    expect(targetsOf(alone, "ACT_SHIRANA_LUCKY_AS2_DAMAGE")).toEqual(["enemy:back"]);
    expect(targetsOf(alone, "ACT_SHIRANA_LUCKY_AS2_SHIELD")).toEqual([]);
  });

  it("IT-CAT-TGTPRI-009 [R-TGT-04] (SR-336): 緋色AS1の横列デバフ解除は本人を含む", () => {
    const observation = observeSkillUse({
      snapshot,
      unitDefinitionId: "UNIT_HIIRO_FREEWOLF",
      use: { kind: "ACTIVE", skillDefinitionId: "SKL_HIIRO_FREEWOLF_AS1" },
      precedingActions: [
        { effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_AS1_DEFDOWN", target: "SELF" },
      ],
    });

    expect(targetsOf(observation, "ACT_HIIRO_FREEWOLF_AS1_REMOVE_DEBUFF")).toContain(
      "ally:subject",
    );
    expect(
      (observation.effectsRemoved ?? []).filter(
        (effect) => effect.effectActionDefinitionId === "ACT_MIKOTO_SURVIVOR_AS1_DEFDOWN",
      ),
    ).toHaveLength(1);
  });
});

/**
 * 元スキルの対象優先度で味方、敵A（左）、敵B（前）、敵C（後）の順。通常の選択順なら
 * 前列中央の enemy:front が先頭になるが、追撃は元の優先度の先頭敵だけへ向かう。
 */
const ORIGINAL_TARGETS = ["ally:back", "enemy:left", "enemy:front", "enemy:back"];

/** ちゆるPS1の「シャイ属性の他の味方」を満たす契機役。 */
const SHY_TRIGGER_ALLY: BoardOverrides = {
  allies: [
    { id: "ally:front", position: { column: "LEFT", row: "FRONT" }, attribute: "SHY" },
    { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
  ],
};

function withDefeated(board: BoardOverrides, defeatedId: string): BoardOverrides {
  return {
    ...board,
    enemies: (
      [
        { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ] satisfies BoardUnitSpec[]
    ).map((spec) => (spec.id === defeatedId ? { ...spec, state: { currentHp: 0 } } : spec)),
  };
}

const FOLLOW_UPS = [
  {
    sr: "SR-047",
    unitDefinitionId: "UNIT_MERU_SIRIUS",
    skillDefinitionId: "SKL_MERU_SIRIUS_PS1",
    damage: "ACT_MERU_SIRIUS_PS1_DAMAGE",
  },
  {
    sr: "SR-064",
    unitDefinitionId: "UNIT_LAURA_MOUNTAIN",
    skillDefinitionId: "SKL_LAURA_MOUNTAIN_PS3",
    damage: "ACT_LAURA_MOUNTAIN_PS3_DAMAGE",
  },
  {
    sr: "SR-162",
    unitDefinitionId: "UNIT_CHIYURU_MAZE",
    skillDefinitionId: "SKL_CHIYURU_MAZE_PS1",
    damage: "ACT_CHIYURU_MAZE_PS1_DAMAGE",
  },
];

function followUp(row: (typeof FOLLOW_UPS)[number], board: BoardOverrides) {
  return observeSkillUse({
    snapshot,
    unitDefinitionId: row.unitDefinitionId,
    use: {
      kind: "PASSIVE",
      skillDefinitionId: row.skillDefinitionId,
      trigger: skillUseCompleted({
        actor: "ally:front",
        targets: ORIGINAL_TARGETS,
        skillType: "AS",
      }),
      triggeredBy: "ally:front",
    },
    board,
  });
}

describe("FIX-07 元スキルの対象優先度の先頭敵（R-PS-04）", () => {
  it.each(FOLLOW_UPS)(
    "IT-CAT-TGTPRI-010 [R-PS-04] ($sr) $skillDefinitionId: 元ASの対象優先度で先頭の敵1体だけへ追撃し、味方・後続の敵へは向かわない",
    (row) => {
      const observation = followUp(row, SHY_TRIGGER_ALLY);

      expect(targetsOf(observation, row.damage)).toEqual(["enemy:left"]);
      expect(Object.keys(observation.hpDeltas ?? {})).toEqual(["enemy:left"]);
    },
  );

  it.each(FOLLOW_UPS)(
    "IT-CAT-TGTPRI-011 [R-PS-04] ($sr) $skillDefinitionId: 先頭の敵が撃破済みなら後続が生存していてもPS全体が不発で、PP・CT・EXも動かない",
    (row) => {
      expect(followUp(row, withDefeated(SHY_TRIGGER_ALLY, "enemy:left"))).toEqual({
        activated: false,
      });
    },
  );

  const MAO_COUNTER_AT_TWO: BoardOverrides = {
    subject: {
      state: {
        skillCounters: {
          [createSkillDefinitionId("SKL_MAO_COMMITTEE_PS1")]: {
            [createRuntimeCounterId("SKL_MAO_COMMITTEE_PS1_TRIGGER_COUNT")]: { value: 2, carry: 0 },
          },
        },
      },
    },
  };

  function maoThird(targets: readonly string[], board: BoardOverrides = {}) {
    return observeSkillUse({
      snapshot,
      unitDefinitionId: "UNIT_MAO_COMMITTEE",
      use: {
        kind: "PASSIVE",
        skillDefinitionId: "SKL_MAO_COMMITTEE_PS1",
        trigger: skillUseCompleted({
          actor: "ally:subject",
          targets,
          skillType: "AS",
          skillDefinitionId: "SKL_MAO_COMMITTEE_AS2",
        }),
        triggeredBy: "ally:subject",
      },
      board: { ...MAO_COUNTER_AT_TWO, ...board },
    });
  }

  it("IT-CAT-TGTPRI-012 [R-PS-04] (SR-290): 真央PS1は元の先頭敵だけへ追撃し、他の味方へのバフも付ける", () => {
    const observation = maoThird(["enemy:left", "enemy:front", "enemy:back"]);

    expect(targetsOf(observation, "ACT_MAO_COMMITTEE_PS1_DAMAGE")).toEqual(["enemy:left"]);
    expect(appliedTo(observation, "ACT_MAO_COMMITTEE_PS1_DMG_UP").sort()).toEqual(
      ["ally:back", "ally:front"].sort(),
    );
  });

  it("IT-CAT-TGTPRI-013 [R-PS-04] (SR-290): 真央PS1は先頭敵が撃破済み・敵対象なしならPS全体が不発で、味方バフ・PP・EXも動かない", () => {
    expect(maoThird(["enemy:left", "enemy:front"], withDefeated({}, "enemy:left"))).toEqual({
      activated: false,
    });
    expect(maoThird(["ally:front"])).toEqual({ activated: false });
  });

  it("IT-CAT-TGTPRI-014 [R-PS-04] (SR-192): ジュリーPS2は元EXの先頭敵1体だけへ炎上・回復量低下を付ける", () => {
    const observation = observeSkillUse({
      snapshot,
      unitDefinitionId: "UNIT_JULIE_SNOW",
      use: { kind: "ACTIVE", skillDefinitionId: "SKL_JULIE_SNOW_EX" },
    });

    expect(targetsOf(observation, "ACT_JULIE_SNOW_PS2_BURN")).toEqual(["enemy:front"]);
    expect(targetsOf(observation, "ACT_JULIE_SNOW_PS2_HEALING_DOWN")).toEqual(["enemy:front"]);
  });

  it.each([
    { evading: "enemy:front", fires: false },
    { evading: "enemy:left", fires: true },
  ])(
    "IT-CAT-TGTPRI-015 [R-PS-04] (SR-192): ジュリーPS2は元EXの先頭敵が回避していればPS全体が不発（$evading 回避 → 発動 $fires）",
    ({ evading, fires }) => {
      const observation = observeSkillUse({
        snapshot,
        unitDefinitionId: "UNIT_JULIE_SNOW",
        use: { kind: "ACTIVE", skillDefinitionId: "SKL_JULIE_SNOW_EX" },
        board: {
          enemies: (
            [
              { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
              { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
              { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
            ] satisfies BoardUnitSpec[]
          ).map((spec) =>
            spec.id === evading
              ? { ...spec, state: { appliedEffects: [evasionOf(evading)] } }
              : spec,
          ),
        },
      });

      expect(targetsOf(observation, "ACT_JULIE_SNOW_PS2_BURN")).toEqual(
        fires ? ["enemy:front"] : [],
      );
      expect(
        (observation.cooldowns ?? []).some((c) => c.skillDefinitionId === "SKL_JULIE_SNOW_PS2"),
      ).toBe(fires);
      expect(
        (observation.resources ?? []).some(
          (r) => r.unitId === "ally:subject" && r.resource === "PP",
        ),
      ).toBe(fires);
    },
  );
});
