import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import { observeClassificationTrigger } from "../../../testing/production-unit/effect-application.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import {
  BOARD_COMBAT_STATS,
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardOverrides,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  effectApplied,
  skillUseCompleted,
  turnStarted,
} from "../../../testing/production-unit/trigger-events.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";

/**
 * `UNIT_URUU_TIMID`（【臆病な褒められたがり少女】波瀬うるう）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_URUU_TIMID";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/**
 * 攻撃力が最も高い味方を一意にする盤面。PS1/PS2 の `HIGHEST_ATTACK` は同値の
 * 候補が並ぶと「誰が選ばれたか」を検証できないため、1体だけ攻撃力を上げる。
 */
const DISTINCT_ATTACK_ALLIES: BoardOverrides = {
  allies: [
    {
      id: "ally:front",
      position: { column: "LEFT", row: "FRONT" },
      state: { combatStats: { ...BOARD_COMBAT_STATS, attack: 2000 } },
    },
    { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
  ],
};

/** 会心率を100%にした盤面。会心分岐（`LAST_RESULT.criticalHitCount`）の腕を作る。 */
const ALWAYS_CRITICAL: BoardOverrides = {
  ...DISTINCT_ATTACK_ALLIES,
  combatStats: { criticalRate: 1 },
};

/** 会心判定を必ず当たり側へ倒す抽選列。 */
function critical(): SequenceRandomSource {
  return new SequenceRandomSource(new Array<number>(64).fill(0));
}

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_URUU_TIMID_AS1",
    intent: "敵横一列に威力93.6でEN攻撃する（会心なし: 会心分岐へ進まない）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_URUU_TIMID_AS1" },
    board: DISTINCT_ATTACK_ALLIES,
    expected: {
      // PS1（「自身がアクティブスキルで攻撃した後に発動」）はAS完了そのものを契機に
      // 持つため、AS 1回の観測には必ずPS1の連鎖が含まれる。
      actions: [
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_AS1_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_AS1_DAMAGE",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_PS1_SELF_CRIT_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_PS1_ALLY_CRIT_UP",
          targets: ["ally:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -468,
        "enemy:left": -468,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_URUU_TIMID_PS1_SELF_CRIT_UP",
          magnitude: 0.05,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_URUU_TIMID_PS1_ALLY_CRIT_UP",
          magnitude: 0.05,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_URUU_TIMID_PS1",
          remaining: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_URUU_TIMID_AS1",
    intent:
      "この攻撃で会心攻撃が発生した場合、戦闘終了まで対象の被ダメージを5%増加させるデバフ付与し、会心率を2%低下させる（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_URUU_TIMID_AS1" },
    board: ALWAYS_CRITICAL,
    random: critical,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_AS1_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_AS1_DAMAGE",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_AS1_DMG_TAKEN_UP",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_AS1_CRIT_DOWN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_AS1_DMG_TAKEN_UP",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_AS1_CRIT_DOWN",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_PS1_SELF_CRIT_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_PS1_ALLY_CRIT_UP",
          targets: ["ally:front"],
        },
      ],
      // 会心倍率は 1.5 + 会心ダメージ上昇率 0.5 = 2.0。
      hpDeltas: {
        "enemy:front": -936,
        "enemy:left": -936,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_URUU_TIMID_PS1_SELF_CRIT_UP",
          magnitude: 0.05,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_URUU_TIMID_PS1_ALLY_CRIT_UP",
          magnitude: 0.05,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_URUU_TIMID_AS1_DMG_TAKEN_UP",
          magnitude: 0.05,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_URUU_TIMID_AS1_CRIT_DOWN",
          magnitude: -0.02,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_URUU_TIMID_AS1_DMG_TAKEN_UP",
          magnitude: 0.05,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_URUU_TIMID_AS1_CRIT_DOWN",
          magnitude: -0.02,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_URUU_TIMID_PS1",
          remaining: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_URUU_TIMID_EX",
    intent: "敵全体に威力28.44で5ヒットEN攻撃する（会心なし: 追撃の腕へ進まない）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_URUU_TIMID_EX" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_EX_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_EX_DAMAGE",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_EX_DAMAGE",
          targets: ["enemy:back"],
        },
      ],
      hpDeltas: {
        "enemy:front": -710,
        "enemy:left": -710,
        "enemy:back": -710,
      },
    },
  },
  {
    skillDefinitionId: "SKL_URUU_TIMID_EX",
    intent:
      "この攻撃で会心攻撃が発生した場合、一時的に被ダメージを100%上昇させるデバフを付与し(重複可)、威力28.44でもう1ヒットEN攻撃を行う",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_URUU_TIMID_EX" },
    board: { combatStats: { criticalRate: 1 } },
    random: critical,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_EX_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_EX_DAMAGE",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_EX_DAMAGE",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_EX_DMG_TAKEN_UP",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_EX_DMG_TAKEN_UP",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_EX_DMG_TAKEN_UP",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_EX_DAMAGE_CRIT",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_EX_DAMAGE_CRIT",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_EX_DAMAGE_CRIT",
          targets: ["enemy:back"],
        },
      ],
      // 会心5ヒット 284×5 に、被ダメージ+100%を受けた追撃1ヒット 284×2 が続く。
      hpDeltas: {
        "enemy:front": -1988,
        "enemy:left": -1988,
        "enemy:back": -1988,
      },
    },
  },
  {
    skillDefinitionId: "SKL_URUU_TIMID_PS1",
    intent:
      "自身がアクティブスキルで攻撃した後に発動。1行動の間自身の会心率を5%上昇させる（重複可）。さらに最も攻撃力が高い味方の会心率を1行動の間5%上昇させる（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_URUU_TIMID_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:subject",
    },
    board: DISTINCT_ATTACK_ALLIES,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_PS1_SELF_CRIT_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_PS1_ALLY_CRIT_UP",
          targets: ["ally:front"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_URUU_TIMID_PS1_SELF_CRIT_UP",
          magnitude: 0.05,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_URUU_TIMID_PS1_ALLY_CRIT_UP",
          magnitude: 0.05,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_URUU_TIMID_PS1",
          remaining: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_URUU_TIMID_PS1",
    intent: "(不成立): EXスキルの完了では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_URUU_TIMID_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "EX",
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_URUU_TIMID_PS2",
    intent:
      "ターン開始時に発動。1行動の間攻撃力が最も高い味方の攻撃力を45%(重複可)、会心率を25%上昇させる(重複可)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_URUU_TIMID_PS2",
      trigger: turnStarted({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    board: DISTINCT_ATTACK_ALLIES,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_PS2_ATK_UP",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_PS2_CRIT_UP",
          targets: ["ally:front"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_URUU_TIMID_PS2_ATK_UP",
          magnitude: 0.45,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_URUU_TIMID_PS2_CRIT_UP",
          magnitude: 0.25,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_URUU_TIMID_PS2",
          remaining: 2,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_URUU_TIMID_PS2",
    intent: "(不成立): このスキルは1ターン目には発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_URUU_TIMID_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_URUU_TIMID_PS3",
    intent:
      "自身にデバフが付与された際に発動。2行動の間、自身の会心率を10%上昇させる。さらにデバフをかけてきた相手に対し、次の攻撃で受ける被ダメージを40%増加させるデバフを付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_URUU_TIMID_PS3",
      trigger: effectApplied({
        source: "enemy:front",
        target: "ally:subject",
        effectKind: "APPLY_STAT_MOD",
        categories: ["DEBUFF"],
      }),
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_PS3_CRIT_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_URUU_TIMID_PS3_DMG_UP_DEBUFF",
          targets: ["enemy:front"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_URUU_TIMID_PS3_CRIT_UP",
          magnitude: 0.1,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_URUU_TIMID_PS3_DMG_UP_DEBUFF",
          magnitude: 0.4,
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
    skillDefinitionId: "SKL_URUU_TIMID_PS3",
    intent: "(不成立): バフの付与では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_URUU_TIMID_PS3",
      trigger: effectApplied({
        source: "enemy:front",
        target: "ally:subject",
        effectKind: "APPLY_STAT_MOD",
        categories: ["BUFF"],
      }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_URUU_TIMID_PS3",
    intent: "(不成立): 味方が付与したデバフでは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_URUU_TIMID_PS3",
      trigger: effectApplied({
        source: "ally:front",
        target: "ally:subject",
        effectKind: "APPLY_STAT_MOD",
        categories: ["DEBUFF"],
      }),
      triggeredBy: "ally:front",
    },
    expected: {
      activated: false,
    },
  },
];

describe("production Catalog UNIT_URUU_TIMID (【臆病な褒められたがり少女】波瀬うるう)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-URUU-TIMID-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-URUU-TIMID-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-URUU-TIMID-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-URUU-TIMID-004 (R-PS-01): PS3の「敵から自身にデバフが付与された際」は、実 resolver が `EffectApplied` へ載せた分類と発生源の帰属で判定される", () => {
    // `-001` のPS3行が使う契機イベントはハーネスが組み立てたもので、payload の
    // `categories` はテスト側の宣言でしかない。**実装がその効果をどう分類したか**は
    // 実 resolver に発行させたイベントにしか現れない。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const trigger = (effectActionDefinitionId: string, from: string) =>
      observeClassificationTrigger({
        definitions: board.definitions,
        units: board.units,
        effectActionDefinitionId,
        from,
        to: "ally:subject",
        battleId: `B_URUU_CLASSIFY_${effectActionDefinitionId}_${from}`,
      });

    expect(trigger("ACT_URUU_TIMID_AS1_CRIT_DOWN", "enemy:front")).toEqual({
      classification: { effectKind: "APPLY_STAT_MOD", categories: ["DEBUFF"] },
      activated: ["SKL_URUU_TIMID_PS3"],
    });
    // 同じデバフでも味方が付けたものは `sourceSelector: ENEMY` に当たらない。
    expect(trigger("ACT_URUU_TIMID_AS1_CRIT_DOWN", "ally:front")).toEqual({
      classification: { effectKind: "APPLY_STAT_MOD", categories: ["DEBUFF"] },
      activated: [],
    });
    expect(trigger("ACT_URUU_TIMID_PS2_ATK_UP", "enemy:front")).toEqual({
      classification: { effectKind: "APPLY_STAT_MOD", categories: ["BUFF"] },
      activated: [],
    });
    // 被ダメージ**増加**は `magnitude` が正でも保持者を弱化するのでデバフ。
    expect(trigger("ACT_URUU_TIMID_AS1_DMG_TAKEN_UP", "enemy:front")).toEqual({
      classification: { effectKind: "APPLY_DAMAGE_MOD", categories: ["DAMAGE_MOD", "DEBUFF"] },
      activated: ["SKL_URUU_TIMID_PS3"],
    });
  });
});
