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
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  skillUseCompleted,
  skillUseStarting,
  turnStarted,
} from "../../../testing/production-unit/trigger-events.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";

/**
 * `UNIT_LAURA_MOUNTAIN`（【みんなを見守る山ガール】黒森ラウラ）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_LAURA_MOUNTAIN";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/**
 * `RANDOM_BRANCH` の `INDEPENDENT` は腕ごとに1回 `random.next()` を消費し、
 * `next() < probability` で成立させる。先頭から順に腕の抽選値を置き、残りは
 * 命中・会心を外れ側へ倒す 0.99 で埋める。
 */
function rolls(...draws: readonly number[]): () => SequenceRandomSource {
  return () => new SequenceRandomSource([...draws, ...new Array<number>(64).fill(0.99)]);
}

/** 自身のAS使用開始。PS1の契機。 */
const OWN_AS_STARTING = skillUseStarting({
  actor: "ally:subject",
  targets: ["enemy:front"],
  skillType: "AS",
  skillDefinitionId: "SKL_LAURA_MOUNTAIN_AS1",
});

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_LAURA_MOUNTAIN_EX",
    intent: "敵全体に威力104.28で攻撃し、対象の攻撃力を15%低下させる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LAURA_MOUNTAIN_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_EX_ATKDOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_EX_ATKDOWN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_EX_ATKDOWN", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -521,
        "enemy:left": -521,
        "enemy:back": -521,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_EX_ATKDOWN",
          magnitude: -0.15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_EX_ATKDOWN",
          magnitude: -0.15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_EX_ATKDOWN",
          magnitude: -0.15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LAURA_MOUNTAIN_AS1",
    intent: "敵単体に威力84.8で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LAURA_MOUNTAIN_AS1" },
    expected: {
      // 使用開始でPS1（「自身がアクティブスキルで攻撃する前に発動」）が実経路で走り、
      // 攻撃力バフを付けてこの攻撃へ乗せる（確率抽選2つは既定の抽選列では外れる）。
      // 攻撃力1000×1.0525から防御500を引いた552に威力84.8%で468（切り捨て）。
      actions: [
        { effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_PS1_ATK_BUFF", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_AS1_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -468 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LAURA_MOUNTAIN_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LAURA_MOUNTAIN_PS1",
    intent:
      "自身がアクティブスキルで攻撃する前に発動。このスキルに続く自身の攻撃での攻撃力を最高7%上昇させる。このバフは生存している味方の数が多いほど高い効果を発揮する。さらに・60%の確率で、攻撃に1行動の炎上を追加する。炎上は攻撃力×30%の持続ダメージを与える。さらに対象に対し、自身が次の行動を終えるまでの間、HP回復量を20%減少させるデバフを追加する・60%の確率で、対象に隣接する敵にも同威力で攻撃する。さらにスキル対象となった全ての敵に対し、1行動の間与ダメージを7.5%減少させるデバフを付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LAURA_MOUNTAIN_PS1",
      trigger: OWN_AS_STARTING,
      triggeredBy: "ally:subject",
    },
    random: rolls(0.1, 0.1),
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_PS1_ATK_BUFF", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_PS1_BURN", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_PS1_BURN_HEALING_DOWN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_PS1_ADJACENT_DAMAGE",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_PS1_ENEMY_DEBUFF",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_PS1_ADJACENT_DAMAGE",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_PS1_ENEMY_DEBUFF",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_PS1_ENEMY_DEBUFF",
          targets: ["enemy:front"],
        },
      ],
      // 攻撃力バフ（生存している味方3体×1.75%＝5.25%。上限7%＝4体には届かない）は
      // 隣接攻撃の1発目で消費され、その1発だけが468になる（2発目は424へ戻る）。
      // 原文では隣接攻撃は「続く自身の攻撃」に付く追加攻撃だが、定義はPS側の攻撃として
      // 表しているため、`NEXT_OUTGOING_ATTACK` の消費点がASではなくここに来る。
      hpDeltas: { "enemy:left": -468, "enemy:back": -424 },
      effectsApplied: [
        {
          // 炎上量は消費前の攻撃力1052.5の30%。
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_PS1_BURN",
          magnitude: 315.75,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_PS1_BURN_HEALING_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_PS1_ENEMY_DEBUFF",
          magnitude: -0.075,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_PS1_ENEMY_DEBUFF",
          magnitude: -0.075,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_PS1_ENEMY_DEBUFF",
          magnitude: -0.075,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LAURA_MOUNTAIN_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LAURA_MOUNTAIN_PS1",
    intent: "（確率抽選が2つとも外れた場合）攻撃力上昇バフだけが残る",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LAURA_MOUNTAIN_PS1",
      trigger: OWN_AS_STARTING,
      triggeredBy: "ally:subject",
    },
    random: rolls(0.9, 0.9),
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_PS1_ATK_BUFF", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          // 生存している味方3体 × 1.75%。上限7%（＝4体）には届かない。
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_PS1_ATK_BUFF",
          magnitude: 0.052500000000000005,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LAURA_MOUNTAIN_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LAURA_MOUNTAIN_AS1",
    intent: "（混乱中のAS攻撃でもPS1が発動する）自身がアクティブスキルで攻撃する前に発動",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LAURA_MOUNTAIN_AS1" },
    // 混乱（R-CFS-01）はASのDAMAGE stepが指すTargetBindingの`side`を反転させる。
    // 反転後の候補には使用者自身が距離0で含まれ、`order: DEFAULT` が距離順に並べる
    // ため、実際に発行される `SkillUseStarting.targetUnitIds` は自分自身になる。
    // 原文「自身がアクティブスキルで攻撃する前」は攻撃先の陣営を限定していないので、
    // この形でもPS1が候補化されなければならない（trigger の `targetSelector` を
    // `ENEMY` で絞ると取りこぼす）。反転先は合成せず実 `resolveSkillOrder` に決めさせる。
    board: { subject: { state: { appliedEffects: [confusionStatus("ally:subject")] } } },
    random: rolls(0.9, 0.9),
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_PS1_ATK_BUFF", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_AS1_DAMAGE", targets: ["ally:subject"] },
      ],
      // 攻撃力1052.5 - 防御500 に威力84.8%で468、さらに混乱倍率（1 - 0.3）が乗って327。
      // 攻撃力バフはこの自傷攻撃で消費されるため `effectsApplied` には残らない。
      hpDeltas: { "ally:subject": -327 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LAURA_MOUNTAIN_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LAURA_MOUNTAIN_PS1",
    intent: "(不成立): 自身のEXスキル使用では発動しない（「アクティブスキルで攻撃する前」に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LAURA_MOUNTAIN_PS1",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "EX",
        skillDefinitionId: "SKL_LAURA_MOUNTAIN_EX",
      }),
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_LAURA_MOUNTAIN_PS1",
    intent: "(不成立): 他の味方のAS使用では発動しない（「自身が」攻撃する場合に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LAURA_MOUNTAIN_PS1",
      trigger: skillUseStarting({
        actor: "ally:front",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_LAURA_MOUNTAIN_AS1",
      }),
      triggeredBy: "ally:front",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_LAURA_MOUNTAIN_PS2",
    intent:
      "ターン開始時に発動。1行動の間、自身の会心率を10%、会心ダメージを12.5%上昇させる（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LAURA_MOUNTAIN_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_PS2_CRIT_RATE", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_PS2_CRIT_DMG", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_PS2_CRIT_RATE",
          magnitude: 0.1,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_PS2_CRIT_DMG",
          magnitude: 0.125,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LAURA_MOUNTAIN_PS2",
    intent: "(不成立): 自身以外の味方が生存していない場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LAURA_MOUNTAIN_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    board: { allies: [] },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_LAURA_MOUNTAIN_PS3",
    intent:
      "他の味方がアクティブスキルで攻撃した後に発動。攻撃された敵単体に対して威力95.4で追撃する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LAURA_MOUNTAIN_PS3",
      trigger: skillUseCompleted({
        actor: "ally:front",
        targets: ["enemy:back"],
        skillType: "AS",
      }),
      triggeredBy: "ally:front",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LAURA_MOUNTAIN_PS3_DAMAGE", targets: ["enemy:back"] },
      ],
      hpDeltas: { "enemy:back": -477 },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LAURA_MOUNTAIN_PS3", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LAURA_MOUNTAIN_PS3",
    intent: "(不成立): 自身のAS使用では発動しない（「他の味方が」攻撃した場合に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LAURA_MOUNTAIN_PS3",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:back"],
        skillType: "AS",
      }),
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_LAURA_MOUNTAIN_PS3",
    intent: "(不成立): 味方のEXスキル使用では発動しない（「アクティブスキルで」に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LAURA_MOUNTAIN_PS3",
      trigger: skillUseCompleted({
        actor: "ally:front",
        targets: ["enemy:back"],
        skillType: "EX",
      }),
      triggeredBy: "ally:front",
    },
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_LAURA_MOUNTAIN (【みんなを見守る山ガール】黒森ラウラ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-LAURA-MOUNTAIN-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-LAURA-MOUNTAIN-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-LAURA-MOUNTAIN-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
