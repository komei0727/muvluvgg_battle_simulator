import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  confusionStatus,
  observeSkillUse,
  resetExecutedActionIds,
  type BoardOverrides,
  type BoardUnitSpec,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { createSkillDefinitionId } from "../../../domain/catalog/definitions/catalog-ids.js";
import { realDamage, skillUseStarting } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_MAIA_SALON`（【眠れる社交界の淑女】夕凪舞亜）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_MAIA_SALON";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const RANCHOU = "MARKER_MAIA_SALON_RANCHOU";
const HANAMAI = "MARKER_MAIA_SALON_HANAMAI";

/**
 * 「自身がアクティブスキルを使用するたびに」のPS1をクールタイム中に置いて切り離す。
 * 単位をTURNにするのは行動完了時のACTION単位減算に巻き込まれず、クールタイム残数の
 * 変化が観測へ漏れないため。
 */
const PS1_ON_COOLDOWN: BoardOverrides = {
  subject: {
    state: {
      cooldowns: {
        [createSkillDefinitionId("SKL_MAIA_SALON_PS1")]: { unit: "TURN", remaining: 1 },
      },
    },
  },
};

/** HP割合が1体だけ低い敵陣。`LOWEST_HP_RATIO` の判別用。 */
const ENEMY_WITH_LOWEST_HP: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" }, state: { currentHp: 1000 } },
];

/**
 * PS2の契機を作る敵陣。enemy:front は「乱調」持ちでHP61%（一撃で60%を割る）、
 * enemy:left は「乱調」持ちだが同じ一撃を受けても85%で閾値に届かない、
 * enemy:back は「乱調」を持たない。
 */
const RANCHOU_ENEMIES: readonly BoardUnitSpec[] = [
  {
    id: "enemy:front",
    position: { column: "CENTER", row: "FRONT" },
    state: { currentHp: 6100 },
    markers: [{ markerId: RANCHOU }],
  },
  {
    id: "enemy:left",
    position: { column: "LEFT", row: "FRONT" },
    state: { currentHp: 9000 },
    markers: [{ markerId: RANCHOU }],
  },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_MAIA_SALON_EX",
    intent:
      "最もHP割合が低い敵単体に威力156で攻撃する。さらに敵全体の行動速度を1行動の間20%低下させ（重複可）、味方全体の行動速度を1行動の間12.5%上昇させる（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAIA_SALON_EX" },
    board: { enemies: ENEMY_WITH_LOWEST_HP },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAIA_SALON_EX_DAMAGE", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_MAIA_SALON_EX_ENEMY_SPEED_DOWN",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_MAIA_SALON_EX_ENEMY_SPEED_DOWN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MAIA_SALON_EX_ENEMY_SPEED_DOWN", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_MAIA_SALON_EX_ALLY_SPEED_UP",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_MAIA_SALON_EX_ALLY_SPEED_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_MAIA_SALON_EX_ALLY_SPEED_UP", targets: ["ally:back"] },
      ],
      hpDeltas: { "enemy:back": -780 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAIA_SALON_EX_ALLY_SPEED_UP",
          magnitude: 0.125,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_MAIA_SALON_EX_ALLY_SPEED_UP",
          magnitude: 0.125,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_MAIA_SALON_EX_ALLY_SPEED_UP",
          magnitude: 0.125,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_MAIA_SALON_EX_ENEMY_SPEED_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_MAIA_SALON_EX_ENEMY_SPEED_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_MAIA_SALON_EX_ENEMY_SPEED_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAIA_SALON_AS1",
    intent:
      "敵2体に対して自身が2回行動を終えるまでの間「乱調」を付与し、威力54.6で攻撃する。さらに1行動の間、対象の与ダメージを20%減少させるデバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAIA_SALON_AS1" },
    board: PS1_ON_COOLDOWN,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAIA_SALON_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAIA_SALON_AS1_MARKER", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAIA_SALON_AS1_DMG_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAIA_SALON_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MAIA_SALON_AS1_MARKER", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MAIA_SALON_AS1_DMG_DOWN", targets: ["enemy:left"] },
      ],
      hpDeltas: { "enemy:front": -273, "enemy:left": -273 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_MAIA_SALON_AS1_DMG_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_MAIA_SALON_AS1_DMG_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      markers: [
        { unitId: "enemy:front", markerId: RANCHOU, stackCount: 1 },
        { unitId: "enemy:left", markerId: RANCHOU, stackCount: 1 },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MAIA_SALON_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAIA_SALON_AS1",
    intent: "すでに対象が「乱調」を所持している場合は新たに付与しない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAIA_SALON_AS1" },
    board: {
      ...PS1_ON_COOLDOWN,
      enemies: [
        {
          // HPを満タンにしてPS2（「乱調」持ちのHPが60%以下）の巻き込みを避ける。
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 10000 },
          markers: [{ markerId: RANCHOU }],
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAIA_SALON_AS1_DAMAGE", targets: ["enemy:front"] },
        // `KEEP_EXISTING` は既存の「乱調」をそのまま残すため、段数は1のままで
        // `markers` の差分に enemy:front は現れない。
        { effectActionDefinitionId: "ACT_MAIA_SALON_AS1_MARKER", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAIA_SALON_AS1_DMG_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAIA_SALON_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MAIA_SALON_AS1_MARKER", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MAIA_SALON_AS1_DMG_DOWN", targets: ["enemy:left"] },
      ],
      hpDeltas: { "enemy:front": -273, "enemy:left": -273 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_MAIA_SALON_AS1_DMG_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_MAIA_SALON_AS1_DMG_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      markers: [{ unitId: "enemy:left", markerId: RANCHOU, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MAIA_SALON_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAIA_SALON_AS2",
    intent:
      "敵単体に威力109.2で攻撃し、1行動の間対象の行動速度を80低下させる（重複可）。さらに1行動の間得られるEXゲージを50%減少させるデバフを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAIA_SALON_AS2" },
    board: PS1_ON_COOLDOWN,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAIA_SALON_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAIA_SALON_AS2_SPEED_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAIA_SALON_AS2_EX_GAIN_DOWN", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -546 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_MAIA_SALON_AS2_SPEED_DOWN",
          magnitude: -80,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_MAIA_SALON_AS2_EX_GAIN_DOWN",
          magnitude: -0.5,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAIA_SALON_PS1",
    intent:
      "自身がアクティブスキルを使用するたびに発動。「華舞」を所持していなかった場合、「華舞」を1つ付与する。さらに自身の最大HPを3.15%上昇させる（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MAIA_SALON_PS1",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_MAIA_SALON_AS2",
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAIA_SALON_PS1_MARKER", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MAIA_SALON_PS1_MAX_HP_UP", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAIA_SALON_PS1_MAX_HP_UP",
          magnitude: 0.0315,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: HANAMAI, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAIA_SALON_AS2",
    intent: "（混乱中のAS使用でもPS1が発動する）自身がアクティブスキルを使用するたびに発動",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAIA_SALON_AS2" },
    // 混乱（R-CFS-01）はASのDAMAGE stepが指すTargetBindingの`side`を反転させる。
    // 反転後の候補には使用者自身が距離0で含まれ、`order: DEFAULT` が距離順に並べる
    // ため、実際に発行される `SkillUseStarting.targetUnitIds` は自分自身になる。
    // 原文「自身がアクティブスキルを使用するたびに」は対象陣営を限定していないので、
    // この形でもPS1が候補化されなければならない（trigger の `targetSelector` を
    // `ENEMY` で絞ると取りこぼす）。反転先は合成せず実 `resolveSkillOrder` に決めさせる。
    board: { subject: { state: { appliedEffects: [confusionStatus("ally:subject")] } } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAIA_SALON_PS1_MARKER", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MAIA_SALON_PS1_MAX_HP_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MAIA_SALON_AS2_DAMAGE", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MAIA_SALON_AS2_SPEED_DOWN", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MAIA_SALON_AS2_EX_GAIN_DOWN", targets: ["ally:subject"] },
      ],
      // 546（威力109.2%）に混乱倍率（1 - 0.3）が乗って382。
      hpDeltas: { "ally:subject": -382 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAIA_SALON_PS1_MAX_HP_UP",
          magnitude: 0.0315,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAIA_SALON_AS2_SPEED_DOWN",
          magnitude: -80,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAIA_SALON_AS2_EX_GAIN_DOWN",
          magnitude: -0.5,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: HANAMAI, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAIA_SALON_PS1",
    intent: "自身が「華舞」を所持していた場合最大HP×5.85%分自身のHPを回復し",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MAIA_SALON_PS1",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_MAIA_SALON_AS2",
      }),
      triggeredBy: "ally:subject",
    },
    board: { subject: { markers: [{ markerId: HANAMAI }] } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAIA_SALON_PS1_HEAL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MAIA_SALON_PS1_MAX_HP_UP", targets: ["ally:subject"] },
      ],
      hpDeltas: { "ally:subject": 585 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAIA_SALON_PS1_MAX_HP_UP",
          magnitude: 0.0315,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAIA_SALON_PS1",
    intent:
      "(不成立): 自身のEXスキル使用では発動しない（「アクティブスキルを」使用した場合に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MAIA_SALON_PS1",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "EX",
        skillDefinitionId: "SKL_MAIA_SALON_EX",
      }),
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_MAIA_SALON_PS2",
    intent:
      "「乱調」を所持している敵のHPが60%以下になった際に発動。敵全体に威力212で攻撃する。攻撃後、敵全体から「乱調」をすべて解除する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MAIA_SALON_PS2",
      trigger: realDamage({
        from: "ally:subject",
        to: "enemy:front",
        skillType: "AS",
        power: 1,
        event: "HitPointReduced",
      }),
      triggeredBy: "ally:subject",
    },
    board: { enemies: RANCHOU_ENEMIES },
    expected: {
      // 契機の一撃（HP6100→5600、割合56%）は観測の基準線へ繰り込む。
      actions: [
        { effectActionDefinitionId: "ACT_MAIA_SALON_PS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAIA_SALON_PS2_CLEAR_MARKER", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAIA_SALON_PS2_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MAIA_SALON_PS2_CLEAR_MARKER", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MAIA_SALON_PS2_DAMAGE", targets: ["enemy:back"] },
        {
          // 「乱調」を持たない敵では解除するものが無い。
          effectActionDefinitionId: "ACT_MAIA_SALON_PS2_CLEAR_MARKER",
          targets: ["enemy:back"],
          resultKind: "SKIPPED",
        },
      ],
      hpDeltas: {
        "enemy:front": -1060,
        "enemy:left": -1060,
        "enemy:back": -1060,
      },
      // 「乱調」を持っていた敵からは保持ごと無くなる。
      markersRemoved: [
        { unitId: "enemy:front", markerId: RANCHOU, stackCount: 1 },
        { unitId: "enemy:left", markerId: RANCHOU, stackCount: 1 },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAIA_SALON_PS2",
    intent: "(不成立): 「乱調」を所持していない敵のHPが減っても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MAIA_SALON_PS2",
      trigger: realDamage({
        from: "ally:subject",
        to: "enemy:back",
        skillType: "AS",
        power: 1,
        event: "HitPointReduced",
      }),
      triggeredBy: "ally:subject",
    },
    board: { enemies: RANCHOU_ENEMIES },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_MAIA_SALON_PS2",
    intent: "(不成立): 「乱調」持ちでもHPが60%を上回っている間は発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MAIA_SALON_PS2",
      trigger: realDamage({
        from: "ally:subject",
        to: "enemy:left",
        skillType: "AS",
        power: 1,
        event: "HitPointReduced",
      }),
      triggeredBy: "ally:subject",
    },
    board: { enemies: RANCHOU_ENEMIES },
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_MAIA_SALON (【眠れる社交界の淑女】夕凪舞亜)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-MAIA-SALON-001: $skillDefinitionId — $intent",
    ({ use, board, precedingActions, random, expected }) => {
      expect(
        observeSkillUse({
          snapshot,
          unitDefinitionId: UNIT_DEFINITION_ID,
          use,
          ...(board === undefined ? {} : { board }),
          ...(precedingActions === undefined ? {} : { precedingActions }),
          ...(random === undefined ? {} : { random: random() }),
        }),
      ).toEqual(expected);
    },
  );

  it("IT-UNIT-MAIA-SALON-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
    const unit = unitFrom(snapshot, UNIT_DEFINITION_ID);
    const declared = [
      ...unit.activeSkillDefinitionIds,
      ...unit.passiveSkillDefinitionIds,
      unit.extraSkillDefinitionId,
    ];
    expect([...new Set(BEHAVIOURS.map((entry) => entry.skillDefinitionId))].sort()).toEqual(
      [...declared].sort(),
    );
  });

  it("IT-UNIT-MAIA-SALON-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
    resetExecutedActionIds();
    for (const { use, board, precedingActions, random } of BEHAVIOURS) {
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use,
        ...(board === undefined ? {} : { board }),
        ...(precedingActions === undefined ? {} : { precedingActions }),
        ...(random === undefined ? {} : { random: random() }),
      });
    }
    expect(
      unexecutedEffectActionIds(
        unitEffectActionClosure(snapshot, UNIT_DEFINITION_ID),
        collectedExecutedActionIds(),
      ),
    ).toEqual([]);
  });
});
