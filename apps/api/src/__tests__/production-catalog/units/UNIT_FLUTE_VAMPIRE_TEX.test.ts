import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
import { recoverTurnResources } from "../../../domain/battle/model/battle-unit.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import { openPassiveChain } from "../../../testing/production-unit/passive-activation.js";
import { observeActivationCounters } from "../../../testing/production-unit/runtime-counter.js";
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardOverrides,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { realDamage, turnStarted } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_FLUTE_VAMPIRE_TEX`（【＃激カワ吸血鬼配信者♪】フルート・メルヴィル・戦術演習版）の
 * ユニット単位production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 戦術演習の敵専用（`category: EXERCISE_ENEMY`、R-TEX-11）。プレイアブル版
 * `UNIT_FLUTE_VAMPIRE` との差分は「極限」状態の機構がまるごと無いことに由来する:
 *
 * - AS1: 「極限」時だけでなく常に、攻撃の前に自身の現在HPの1.25%を消費する
 *   （プレイアブル版25%の1/20。最大HP比で測る量がTEX版で1/20になる法則と同じ）
 * - PS1: 契機がHP10%以下からターン開始時へ変わり、全回復と「極限」付与が無くなる。
 *   最大AP+1は現在APも同じだけ増やす
 * - PS2: 「極限」時は発動しない制限が無くなる
 * - PS3: 致死耐えバフと1戦闘1回制限が無くなり、1ターン目には発動しない
 */

const UNIT_DEFINITION_ID = "UNIT_FLUTE_VAMPIRE_TEX";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** そのPSが戦闘中に1度発動済みである局面。 */
function alreadyActivated(skillDefinitionId: string): BoardOverrides {
  return {
    subject: {
      state: {
        skillCounters: {
          [createSkillDefinitionId(skillDefinitionId)]: {
            [createRuntimeCounterId(`${skillDefinitionId}_ACTIVATIONS`)]: { value: 1, carry: 0 },
          },
        },
      },
    },
  };
}

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_EX",
    intent:
      "自身に最も近い敵前後列に威力101.4で攻撃する。攻撃後に最も近い位置にいる敵単体が生存していた場合、敵単体に威力46.8でもう一度攻撃する。更に与えたダメージの60%分自身のHPを回復する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_EX" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_TEX_EX_DAMAGE_COLUMN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_TEX_EX_DAMAGE_COLUMN",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_TEX_EX_DAMAGE_FOLLOWUP",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_TEX_EX_SELF_HEAL",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "ally:subject": 748,
        "enemy:front": -741,
        "enemy:back": -507,
      },
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_EX",
    intent: "(分岐): 最も近い位置にいる敵単体が生存していなければ、もう一度の攻撃は行わない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_EX" },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 507 },
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_TEX_EX_DAMAGE_COLUMN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_TEX_EX_DAMAGE_COLUMN",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_TEX_EX_SELF_HEAL",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "ally:subject": 608,
        "enemy:front": -507,
        "enemy:back": -507,
      },
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_AS1",
    intent: "自身の現在HPの1.25%を消費し、敵単体に威力85.8で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_AS1" },
    expected: {
      // 消費が攻撃より先に起きる。現在HP5000×1.25%＝62.5は62へ切り捨てる（R-NUM-02）。
      actions: [
        {
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_TEX_AS1_HP_COST",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_TEX_AS1_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "ally:subject": -62,
        "enemy:front": -429,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_AS1",
    intent: "(境界): 消費するのは最大HPではなく現在HPの1.25%である — HP2000なら25消費",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_AS1" },
    board: { subject: { state: { currentHp: 2000 } } },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_TEX_AS1_HP_COST",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_TEX_AS1_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "ally:subject": -25,
        "enemy:front": -429,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_PS1",
    intent:
      "ターン開始時に発動、自身の最大APを１増やす（解除不可）。さらに自身に対し、2行動の間与ダメージを25%上昇させるバフを付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_PS1",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_TEX_PS1_MAX_AP_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_TEX_PS1_DMG_UP",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_TEX_PS1_MAX_AP_UP",
          magnitude: 1,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_TEX_PS1_DMG_UP",
          magnitude: 0.25,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      // 最大APの増加分だけ所持APも増える（raiseCurrent）。
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: 1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_PS1",
    intent: "(不成立): このスキルは戦闘中に1度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_PS1",
      trigger: turnStarted({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    board: alreadyActivated("SKL_FLUTE_VAMPIRE_TEX_PS1"),
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_PS2",
    intent:
      "自身がアクティブスキルで攻撃された後に発動。攻撃してきた敵単体に対し威力84.8で反撃し、攻撃を1ヒットだけ回避するバフを自身に付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_PS2",
      trigger: realDamage({ from: "enemy:left", to: "ally:subject", skillType: "AS" }),
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_TEX_PS2_COUNTER", targets: ["enemy:left"] },
        {
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_TEX_PS2_EVASION",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "enemy:left": -424,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_TEX_PS2_EVASION",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
          statusKind: "HIT_EVASION",
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_PS2", remaining: 3 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_PS2",
    intent: "(不成立): EXスキルで攻撃された後には発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_PS2",
      trigger: realDamage({ from: "enemy:left", to: "ally:subject", skillType: "EX" }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_PS3",
    intent:
      "ターン開始時に発動。最も遠い位置にいる敵単体に対し、次に受ける攻撃の被ダメージが20%増加するデバフを付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_PS3",
      trigger: turnStarted({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    // 同じターン開始で発動するPS1は1ターン目に発動済みとして外す。
    board: alreadyActivated("SKL_FLUTE_VAMPIRE_TEX_PS1"),
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_TEX_PS3_DEBUFF", targets: ["enemy:back"] },
      ],
      effectsApplied: [
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_TEX_PS3_DEBUFF",
          magnitude: 0.2,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_PS3",
    intent: "(不成立): このスキルは１ターン目には発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_PS3",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_PS3",
    intent:
      "(境界): 発動回数の制限は無く、3ターン目にも発動する。同じデバフを既に持つ敵へも重ねて付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_PS3",
      trigger: turnStarted({ turnNumber: 3 }),
      triggeredBy: "ally:subject",
      turnNumber: 3,
    },
    board: alreadyActivated("SKL_FLUTE_VAMPIRE_TEX_PS1"),
    precedingActions: [
      { effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_TEX_PS3_DEBUFF", target: "ENEMY" },
    ],
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_TEX_PS3_DEBUFF", targets: ["enemy:back"] },
      ],
      effectsApplied: [
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_TEX_PS3_DEBUFF",
          magnitude: 0.2,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
];

describe("production Catalog UNIT_FLUTE_VAMPIRE_TEX (【＃激カワ吸血鬼配信者♪】フルート・メルヴィル・戦術演習版)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-FLUTE-VAMPIRE-TEX-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-FLUTE-VAMPIRE-TEX-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-FLUTE-VAMPIRE-TEX-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-FLUTE-VAMPIRE-TEX-004 (MODIFY_RESOURCE_CAPACITY raiseCurrent): SKL_FLUTE_VAMPIRE_TEX_PS1 は最大APと現在APを同じだけ1上げ、不変の基準値は動かさない。上がった上限は次のターンのリソース回復も満たす", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, {
      subject: { state: { currentAp: 2 } },
    });
    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: "ally:subject",
      battleId: "B_FLUTE_TEX_CAPACITY",
    });
    const after = chain.fire(turnStarted({ turnNumber: 1 }), board.units);

    const subject = after.find((unit) => unit.battleUnitId === "ally:subject")!;
    expect(subject.maximumAp).toBe(board.subject.maximumAp + 1);
    expect(subject.baseMaximumAp).toBe(board.subject.baseMaximumAp);
    // プレイアブル版（現在APは追随しない）と異なり、上限の増加分だけ所持APも増える。
    expect(subject.currentAp).toBe(3);
    expect(recoverTurnResources(subject).currentAp).toBe(board.subject.maximumAp + 1);
  });

  it("IT-UNIT-FLUTE-VAMPIRE-TEX-005 (R-EFF-11): PS1 が宣言する発動回数counterは自分自身の PassiveActivated でだけ増え、PS3 は発動回数counterを持たない", () => {
    expect(observeActivationCounters(snapshot, UNIT_DEFINITION_ID)).toEqual({
      declarations: [
        {
          skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_PS1",
          counter: "SKL_FLUTE_VAMPIRE_TEX_PS1_ACTIVATIONS",
          scope: "SKILL_RUNTIME",
          amount: 1,
        },
      ],
      changesByActivatedSkill: {
        SKL_FLUTE_VAMPIRE_TEX_PS1: [
          {
            skillDefinitionId: "SKL_FLUTE_VAMPIRE_TEX_PS1",
            counter: "SKL_FLUTE_VAMPIRE_TEX_PS1_ACTIVATIONS",
            before: 0,
            after: 1,
            valueChanged: true,
          },
        ],
      },
      changesOnUnrelatedSkill: [],
    });
  });
});
