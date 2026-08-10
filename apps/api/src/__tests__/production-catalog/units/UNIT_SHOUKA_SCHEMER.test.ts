import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  resetExecutedActionIds,
  type BoardUnitSpec,
  type PrecedingAction,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { turnCompleting } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_SHOUKA_SCHEMER`(【風紀委員会の策謀家】姜小花)のユニット単位production
 * 結合テスト(`12_テスト戦略.md`「ユニット効果軸」)。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_SHOUKA_SCHEMER";

/**
 * AS3の分岐は「攻撃力の」デバフだけを見る。小花自身は防御力デバフを配らないため、
 * 不成立側を手組みの`AppliedEffect`ではなく実 production 定義で作れるよう、防御力
 * デバフ源となる別ユニットの定義だけを併せて読み込む。`-002`／`-003` はこのユニットの
 * Skill・EffectAction閉包だけを見るため、閉包の判定には影響しない。
 */
const DEFENSE_DEBUFF_SOURCE_UNIT_ID = "UNIT_CHIYURU_MAZE";
const DEFENSE_DEBUFF_ACTION_ID = "ACT_CHIYURU_MAZE_AS1_DEF_DOWN";

/**
 * 使用者自身のバフが解除されないことの対照に使う定義。小花のバフはいずれも
 * `timeLimit: ACTION(1)` で、**自身が行動すればその行動の終わりに必ず失効する**
 * （R-EFF-06）ため、解除されなかったことの証拠にならない。戦闘終了まで残る
 * 実 production のバフを1件だけ併せて読み込む。
 */
const SELF_BUFF_SOURCE_UNIT_ID = "UNIT_NOEL_RUMBLE";
const SELF_BUFF_ACTION_ID = "ACT_NOEL_RUMBLE_PS1_ATK_UP";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  DEFENSE_DEBUFF_SOURCE_UNIT_ID,
  SELF_BUFF_SOURCE_UNIT_ID,
]);

/** 解除対象のバフを最も近い敵へ実 production 定義で用意する。 */
const ENEMY_HAS_BUFF: readonly PrecedingAction[] = [
  { effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_AS2_DEF_UP", target: "ENEMY" },
];

/** AS3のBRANCHが読む「攻撃力デバフ」を実 production 定義で用意する。 */
const ENEMY_HAS_ATTACK_DEBUFF: readonly PrecedingAction[] = [
  { effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_AS1_ATK_DOWN", target: "ENEMY" },
];

/** PS1が削るEXゲージを持つ敵陣。 */
const ENEMIES_WITH_EX: readonly BoardUnitSpec[] = [
  {
    id: "enemy:front",
    position: { column: "CENTER", row: "FRONT" },
    state: { currentExtraGauge: 3 },
  },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_SHOUKA_SCHEMER_EX",
    intent:
      "敵全体に威力150.6で攻撃し、対象にかけられたバフを3つまで解除する。さらに味方全体に対し、2行動の間状態異常を無効化するバフを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_SCHEMER_EX" },
    precedingActions: ENEMY_HAS_BUFF,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_EX_REMOVE_BUFF", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_EX_DAMAGE", targets: ["enemy:left"] },
        // バフを持たない対象では解除自体が起きない。
        {
          effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_EX_REMOVE_BUFF",
          targets: ["enemy:left"],
          resultKind: "SKIPPED",
        },
        { effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_EX_DAMAGE", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_EX_REMOVE_BUFF",
          targets: ["enemy:back"],
          resultKind: "SKIPPED",
        },
        { effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_EX_IMMUNITY", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_EX_IMMUNITY", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_EX_IMMUNITY", targets: ["ally:back"] },
      ],
      // enemy:front だけは前提の防御力+5%（525）が乗った状態でダメージを受ける。
      hpDeltas: { "enemy:front": -715, "enemy:left": -753, "enemy:back": -753 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_EX_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_EX_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_EX_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      effectsRemoved: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_AS2_DEF_UP",
          magnitude: 0.05,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHOUKA_SCHEMER_AS1",
    intent: "敵単体の攻撃力を1行動の間50%低下させる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_SCHEMER_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_AS1_ATK_DOWN", targets: ["enemy:front"] },
      ],
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_AS1_ATK_DOWN",
          magnitude: -0.5,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SHOUKA_SCHEMER_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHOUKA_SCHEMER_AS2",
    intent:
      "攻撃力が最も高い敵単体に威力132.6で攻撃する。さらに対象の攻撃力を30%低下させる（重複可）が、同時に防御力を5%上昇させてしまう（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_SCHEMER_AS2" },
    // 攻撃力を上げた enemy:back が「最も高い敵」になり、既定の最短距離順を上書きする。
    board: {
      enemies: [
        { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        {
          id: "enemy:back",
          position: { column: "CENTER", row: "BACK" },
          combatStats: { attack: 2000 },
        },
      ],
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_AS2_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_AS2_ATK_DOWN", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_AS2_DEF_UP", targets: ["enemy:back"] },
      ],
      hpDeltas: { "enemy:back": -663 },
      effectsApplied: [
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_AS2_ATK_DOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_AS2_DEF_UP",
          magnitude: 0.05,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SHOUKA_SCHEMER_AS2", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHOUKA_SCHEMER_AS3",
    intent:
      "敵単体に威力124.8で攻撃する。…さらに対象にかけられているバフを1つ解除する（対象の攻撃力にデバフがかけられていない場合）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_SCHEMER_AS3" },
    precedingActions: ENEMY_HAS_BUFF,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_AS3_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_AS3_REMOVE_BUFF",
          targets: ["enemy:front"],
        },
      ],
      // 前提の防御力+5%（525）が乗った状態のダメージ。
      hpDeltas: { "enemy:front": -592 },
      effectsRemoved: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_AS2_DEF_UP",
          magnitude: 0.05,
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
    skillDefinitionId: "SKL_SHOUKA_SCHEMER_AS3",
    intent: "対象の攻撃力がデバフがかけられていた場合、この攻撃によるダメージが40%増加する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_SCHEMER_AS3" },
    precedingActions: ENEMY_HAS_ATTACK_DEBUFF,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_AS3_DAMAGE_VS_ATTACK_DEBUFF",
          targets: ["enemy:front"],
        },
        // 解除できるバフを持たない対象では解除自体が起きない。
        {
          effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_AS3_REMOVE_BUFF",
          targets: ["enemy:front"],
          resultKind: "SKIPPED",
        },
      ],
      hpDeltas: { "enemy:front": -873 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHOUKA_SCHEMER_PS1",
    intent:
      "ターン終了時に発動。敵単体の攻撃力を3.5%低下させ（重複可）、EXゲージを1削る。このスキルは1ターン目には発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SHOUKA_SCHEMER_PS1",
      trigger: turnCompleting({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    board: { enemies: ENEMIES_WITH_EX },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_PS1_ATK_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_PS1_EX_DOWN", targets: ["enemy:front"] },
      ],
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_PS1_ATK_DOWN",
          magnitude: -0.035,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "enemy:front", resource: "EX_GAUGE", delta: -1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHOUKA_SCHEMER_PS1",
    intent: "(不成立): 1ターン目のターン終了では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SHOUKA_SCHEMER_PS1",
      trigger: turnCompleting({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    board: { enemies: ENEMIES_WITH_EX },
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_SHOUKA_SCHEMER (【風紀委員会の策謀家】姜小花)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-SHOUKA-SCHEMER-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-SHOUKA-SCHEMER-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-SHOUKA-SCHEMER-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-SHOUKA-SCHEMER-004 (R-EFF-02): AS3の分岐は `statKinds: [ATTACK]` で絞り込むため、防御力デバフを持つ対象では40%増加せず通常版が走る（絞り込みが無ければ「何らかのデバフ」への近似が残る）", () => {
    const observe = (precedingActions: readonly PrecedingAction[]) =>
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_SCHEMER_AS3" },
        precedingActions,
      });

    // 攻撃力デバフ: 増加版（威力174.72）が選ばれる。
    expect(observe(ENEMY_HAS_ATTACK_DEBUFF).actions).toEqual([
      {
        effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_AS3_DAMAGE_VS_ATTACK_DEBUFF",
        targets: ["enemy:front"],
      },
      {
        effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_AS3_REMOVE_BUFF",
        targets: ["enemy:front"],
        resultKind: "SKIPPED",
      },
    ]);

    // 防御力デバフ: 同じ `DEBUFF` カテゴリでも通常版（威力124.8）のまま。
    // 防御力が500→400へ下がっている分だけダメージは増えるが、腕は切り替わらない。
    expect(
      observe([{ effectActionDefinitionId: DEFENSE_DEBUFF_ACTION_ID, target: "ENEMY" }]),
    ).toEqual({
      actions: [
        { effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_AS3_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_AS3_REMOVE_BUFF",
          targets: ["enemy:front"],
          resultKind: "SKIPPED",
        },
      ],
      hpDeltas: { "enemy:front": -748 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    });
  });

  it("IT-UNIT-SHOUKA-SCHEMER-005 (R-EFF-02): EXは「3つまで」・AS3は「1つ」で解除件数が頭打ちになり、どちらも対象は敵であって使用者自身のバフには触れない", () => {
    // `-001` のEX／AS3行は解除対象を敵1体につき1つしか持たないため、上限そのものは
    // 現れない（上限が無くても同じ観測になる）。上限より多い前提を実 production 定義で
    // 積み、あわせて同じバフを使用者自身にも持たせて、対象束縛が `SELF` へ倒れていない
    // ことを解除件数と同じ観測の中で固定する。
    const enemyBuffs: readonly PrecedingAction[] = Array.from({ length: 4 }, () => ({
      effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_AS2_DEF_UP",
      target: "ENEMY" as const,
    }));
    const removedDefUp = (count: number) =>
      Array.from({ length: count }, () => ({
        unitId: "enemy:front",
        effectActionDefinitionId: "ACT_SHOUKA_SCHEMER_AS2_DEF_UP",
        magnitude: 0.05,
        timeLimit: { unit: "ACTION", count: 1 },
      }));
    const removedBy = (skillDefinitionId: string) =>
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use: { kind: "ACTIVE", skillDefinitionId },
        precedingActions: [
          ...enemyBuffs,
          { effectActionDefinitionId: SELF_BUFF_ACTION_ID, target: "SELF" },
        ],
      }).effectsRemoved;

    // 敵の4つのうち3つだけが解除され、4つ目と使用者自身のバフは残る。
    expect(removedBy("SKL_SHOUKA_SCHEMER_EX")).toEqual(removedDefUp(3));
    expect(removedBy("SKL_SHOUKA_SCHEMER_AS3")).toEqual(removedDefUp(1));
  });
});
