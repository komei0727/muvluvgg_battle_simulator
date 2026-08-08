import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import { createSkillDefinitionId } from "../../../domain/catalog/definitions/catalog-ids.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  resetExecutedActionIds,
  type BoardOverrides,
  type BoardUnitSpec,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { realDamage, unitDefeated } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_CHIYURU_NEWYEAR`（【新春のメイズ研究者】月ヶ瀬ちゆる）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_CHIYURU_NEWYEAR";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const MOCHI = "MARKER_CHIYURU_NEWYEAR_MOCHI";
const AS1 = createSkillDefinitionId("SKL_CHIYURU_NEWYEAR_AS1");

/** 「除災招福」がクールタイム中である局面（リセットの効きはここでしか観測できない）。 */
const AS1_ON_COOLDOWN: BoardOverrides = {
  subject: { state: { cooldowns: { [AS1]: { unit: "TURN", remaining: 99 } } } },
};

/**
 * 攻撃後にちょうど5000へ落ちるHPを持つ敵配置。現在HP割合で決まる毒の効果量を
 * 丸めのない500にする。
 */
const ENEMIES_FALLING_TO_5000: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, state: { currentHp: 5636 } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, state: { currentHp: 5636 } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" }, state: { currentHp: 5636 } },
];

/** 累計で最大HP×40%（4000ダメージ）に達する一撃。 */
const CUMULATIVE_THRESHOLD_HIT = realDamage({
  from: "enemy:front",
  to: "ally:subject",
  skillType: "AS",
  power: 8,
});

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_CHIYURU_NEWYEAR_EX",
    intent:
      "敵全体に威力127.2で攻撃し、2行動の毒を付与する。さらにスキル「除災招福」のクールタイムをリセットして再び使用できるようにし、自身に「お餅」を1つ付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_NEWYEAR_EX" },
    board: { ...AS1_ON_COOLDOWN, enemies: ENEMIES_FALLING_TO_5000 },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_EX_POISON", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_EX_POISON", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_EX_POISON", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_EX_CD_RESET", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_EX_MOCHI", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "enemy:front": -636,
        "enemy:left": -636,
        "enemy:back": -636,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_EX_POISON",
          magnitude: 500,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_EX_POISON",
          magnitude: 500,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_EX_POISON",
          magnitude: 500,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: MOCHI, stackCount: 1 }],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_CHIYURU_NEWYEAR_AS1", remaining: 0 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_NEWYEAR_AS1",
    intent:
      "付与されている「お餅」1つにつき、自身の攻撃力を3%、防御力を6%上昇させる（重複可）（最大6つまで）。このバフは自身が次の行動を終えるまで継続する。加えて敵横一列に威力39で3ヒット攻撃し、与えたダメージの25%分自身のHPを回復する。さらに対象に対し、2行動の間HP回復を無効にするデバフを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_NEWYEAR_AS1" },
    board: { subject: { markers: [{ markerId: MOCHI, stackCount: 2 }] } },
    expected: {
      // 敵横一列＝基準敵と同じ行。既定盤面では敵前列の2体。
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_DEF_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_HEAL_BLOCK",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_HEAL_BLOCK", targets: ["enemy:left"] },
        {
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_HEAL_SELF",
          targets: ["ally:subject"],
        },
      ],
      // 攻撃力バフ後の1000×1.06から1ヒット218（(1060-500)×39%）×3ヒット。
      // 回復は与えた合計1308の25%。
      hpDeltas: {
        "ally:subject": 327,
        "enemy:front": -654,
        "enemy:left": -654,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_ATK_UP",
          magnitude: 0.06,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_TARGET" },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_DEF_UP",
          magnitude: 0.12,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_TARGET" },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_HEAL_BLOCK",
          magnitude: -1,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_HEAL_BLOCK",
          magnitude: -1,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_CHIYURU_NEWYEAR_AS1", remaining: 99 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_NEWYEAR_AS1",
    intent: "(不成立): このスキルは戦闘中に1度しか発動できない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_NEWYEAR_AS1" },
    board: AS1_ON_COOLDOWN,
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_NEWYEAR_AS2",
    intent: "敵単体に威力148.4で攻撃し、1行動の間攻撃力を5%低下させる（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_NEWYEAR_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS2_ATK_DOWN", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -742,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS2_ATK_DOWN",
          magnitude: -0.05,
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
    skillDefinitionId: "SKL_CHIYURU_NEWYEAR_PS1",
    intent:
      "敵または他の味方が倒された際に発動。自身のHPを最大HP×15%回復し、戦闘終了まで自身の最大HPを5%上昇させる（重複可）（解除不可）。さらにスキル「除災招福」のクールタイムをリセットして再び使用できるようにし、自身に「お餅」を1つ付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIYURU_NEWYEAR_PS1",
      trigger: unitDefeated({ unit: "enemy:left", defeatedBy: "ally:subject" }),
      triggeredBy: "ally:subject",
    },
    board: AS1_ON_COOLDOWN,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_PS1_HEAL", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_PS1_MAX_HP_UP",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_PS1_CD_RESET", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_PS1_MOCHI", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "ally:subject": 1500,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_PS1_MAX_HP_UP",
          magnitude: 0.05,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: MOCHI, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_CHIYURU_NEWYEAR_AS1", remaining: 0 },
        { unitId: "ally:subject", skillDefinitionId: "SKL_CHIYURU_NEWYEAR_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_NEWYEAR_PS2",
    intent:
      "累計で最大HP×40%のダメージを受けるたびに発動。自身に対し、最大HP×20%のシールドを付与する。シールドは2行動後に消滅する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIYURU_NEWYEAR_PS2",
      trigger: CUMULATIVE_THRESHOLD_HIT,
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_PS2_SHIELD", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_PS2_SHIELD",
          magnitude: 2000,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_NEWYEAR_PS2",
    intent: "(不成立): 累計が最大HP×40%に達していないダメージでは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIYURU_NEWYEAR_PS2",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:subject",
        skillType: "AS",
        power: 4,
      }),
    },
    expected: {
      activated: false,
    },
  },
];

describe("production Catalog UNIT_CHIYURU_NEWYEAR (【新春のメイズ研究者】月ヶ瀬ちゆる)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-CHIYURU-NEWYEAR-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-CHIYURU-NEWYEAR-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-CHIYURU-NEWYEAR-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
