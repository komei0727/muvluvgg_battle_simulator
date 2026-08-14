import { describe, expect, it } from "vitest";
import type { BattleDefinitions } from "../../../domain/battle/model/battle-definitions.js";
import type { BattleUnit } from "../../../domain/battle/model/battle-unit.js";
import type { DamageResultRegistry } from "../../../domain/battle/skill/formula-evaluator.js";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import { observeLifecycleDamageProbe } from "../../../testing/production-unit/damage-probe.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import {
  activatedPassiveSkillIds,
  openPassiveChain,
} from "../../../testing/production-unit/passive-activation.js";
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardUnitSpec,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { realDamage, turnStarted } from "../../../testing/production-unit/trigger-events.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";

/**
 * `UNIT_ANIS_SWEETDEVIL_TEX`（【渚のスイートデビル】アニス・ベネット・戦術演習版）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * このユニットは戦術演習の敵専用（`category: EXERCISE_ENEMY`、R-TEX-11）で、原文は
 * `raw/units/` のwiki転記ではなく**ゲーム内スクリーンショットからの転記**である。
 * `intent` はそのスクリーンショットの効果説明文で、転記が正しいかをレビューできる
 * 唯一の接点になる。プレイアブル版 `UNIT_ANIS_SWEETDEVIL` との差分は、ステータスと
 * PS1+（発動閾値 最大HP15%→0.75%・クールタイム1→2行動）・PS2+（閾値 最大HP30%→1.5%・
 * 集計と回復の対象に自身を含む）・PS3+（汐風の付与先を隣接味方→自身・戦闘中1回制限の
 * 撤廃・軽減の閾値 現在HP20%→2%）である。
 *
 * 盤面は攻撃力1000・防御力500・現在HP5000/最大HP10000（`skill-behaviour.ts`）。
 * 演習の敵は単騎で動くが、`-001` の表は分岐の両腕を見るために味方2体を置いた
 * 既定盤面を使う。単騎ならではの帰結（EXが自身へ2加算する・PS2が自身の被弾を
 * 集計する）は `-005`／`-006` が単騎の盤面で固定する。
 */

const UNIT_DEFINITION_ID = "UNIT_ANIS_SWEETDEVIL_TEX";
const SHIOKAZE = "MARKER_ANIS_SWEETDEVIL_TEX_SHIOKAZE";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/**
 * EXの `RANDOM_BRANCH` は `WEIGHTED_ONE`（weight 1:1）を3回引く。抽選値が前半なら
 * 味方側、後半なら敵側の腕になるため、抽選列で腕を固定する。表は `-001` と `-003` の
 * 2回まわされるため、`SkillBehaviourCase.random` は生成関数で持つ。
 */
const ALWAYS_ALLY = (): SequenceRandomSource =>
  new SequenceRandomSource(new Array<number>(16).fill(0));
const ALWAYS_ENEMY = (): SequenceRandomSource =>
  new SequenceRandomSource(new Array<number>(16).fill(0.99));

/** PS2の集計対象は「『汐風』所持者」。既定盤面では前列の味方だけへ持たせる。 */
const ALLIES_WITH_SHIOKAZE: readonly BoardUnitSpec[] = [
  {
    id: "ally:front",
    position: { column: "LEFT", row: "FRONT" },
    markers: [{ markerId: SHIOKAZE, stackCount: 3 }],
  },
  { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
];

/**
 * 「汐風」所持者が累計で最大HP×1.5%（150ダメージ）を受ける一撃。実ダメージ
 * pipelineが `DamageApplied` を出し、`counterUpdates` が閾値を跨いで
 * `RuntimeCounterChanged` を発行し、それがPS2の契機になる。
 */
const SHIOKAZE_THRESHOLD_HIT = realDamage({
  from: "enemy:front",
  to: "ally:front",
  skillType: "AS",
  power: 1,
});

/** 1ヒットで最大HP×0.75%（75ダメージ）を超える被弾。PS1の `DAMAGE_MAX_HP_RATIO` を満たす。 */
const HEAVY_HIT = realDamage({
  from: "enemy:front",
  to: "ally:subject",
  skillType: "AS",
  power: 3,
  event: "HitPointReduced",
});

/** 同じ経路で最大HP×0.75%に届かない被弾（50ダメージ）。 */
const LIGHT_HIT = realDamage({
  from: "enemy:front",
  to: "ally:subject",
  skillType: "AS",
  power: 0.1,
  event: "HitPointReduced",
});

/** (SKL_ID, スクリーンショット原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_EX",
    intent:
      "自身以外を優先した味方単体か、自身に最も近い敵単体からランダムに3回対象を抽出し、抽選1回につき以下の効果を付与する（対象が味方の場合）1行動の間攻撃力を15%上昇させる（重複可）。さらに対象の味方と自身に対し、EXゲージを1加算する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_EX" },
    random: ALWAYS_ALLY,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_EX_ATK_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_EX_EX_GAIN", targets: ["ally:front"] },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_EX_EX_GAIN",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_EX_ATK_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_EX_EX_GAIN", targets: ["ally:front"] },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_EX_EX_GAIN",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_EX_ATK_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_EX_EX_GAIN", targets: ["ally:front"] },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_EX_EX_GAIN",
          targets: ["ally:subject"],
        },
      ],
      // 「重複可」のため3回分が別インスタンスで積み上がる。
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_EX_ATK_UP",
          magnitude: 0.15,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_EX_ATK_UP",
          magnitude: 0.15,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_EX_ATK_UP",
          magnitude: 0.15,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 3 },
        { unitId: "ally:front", resource: "EX_GAUGE", delta: 3 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_EX",
    intent: "（対象が敵の場合）1行動の間防御力を15%低下させる（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_EX" },
    random: ALWAYS_ENEMY,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_EX_DEF_DOWN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_EX_DEF_DOWN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_EX_DEF_DOWN",
          targets: ["enemy:front"],
        },
      ],
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_EX_DEF_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_EX_DEF_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_EX_DEF_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_AS1",
    intent:
      "敵単体に威力21.2で4ヒットEN攻撃する。対象がEXゲージを1以上所持していた場合、対象のEXゲージを1削り、自身のEXゲージを1加算する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_AS1" },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentExtraGauge: 2 },
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_AS1_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_AS1_EX_DRAIN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_AS1_EX_GAIN",
          targets: ["ally:subject"],
        },
      ],
      // (1000-500)×0.212=106を4ヒットで424。
      hpDeltas: { "enemy:front": -424 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        // AP消費で+1（R-ACT-03）、スキル自身のEX加算で+1。
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
        { unitId: "enemy:front", resource: "EX_GAUGE", delta: -1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_AS1",
    intent: "(対象のEXゲージ0): 削り取りと自身への加算はどちらも行わない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_AS1" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_AS1_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: { "enemy:front": -424 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_PS1",
    intent:
      "自身が敵からの攻撃1ヒットで、最大HP×0.75%以上のダメージを負った際に発動。自身に対し1行動の間得られるEXゲージが100%増加するバフを付与する（重複可）。EXゲージが3以上：EXゲージを2消費し、被ダメージの100%分回復する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_PS1",
      trigger: HEAVY_HIT,
    },
    // 分岐が読む「所持状況」はPP消費に伴うEX獲得（R-ACT-03、+1）の**後**の値。
    // 盤面2からPS使用で3になり、「3以上」の腕を引く。
    board: { subject: { state: { currentExtraGauge: 2 } } },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS1_EX_GAIN_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS1_EX_COST_2",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS1_HEAL_FULL",
          targets: ["ally:subject"],
        },
      ],
      // 契機のヒット（(1000-500)×3=1500）は基準線へ繰り込まれ、その100%を回復する。
      hpDeltas: { "ally:subject": 1500 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS1_EX_GAIN_UP",
          magnitude: 1,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        // PP消費で+1、スキル自身の消費で-2。
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: -1 },
      ],
      // クールタイムはプレイアブル版の1行動から2行動へ延びている。
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_PS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_PS1",
    intent: "EXゲージが2：EXゲージを1消費し、被ダメージの50%分回復する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_PS1",
      trigger: HEAVY_HIT,
    },
    // 盤面1からPS使用で2になり、「2」の腕を引く。
    board: { subject: { state: { currentExtraGauge: 1 } } },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS1_EX_GAIN_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS1_EX_COST_1",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS1_HEAL_HALF",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: { "ally:subject": 750 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS1_EX_GAIN_UP",
          magnitude: 1,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [{ unitId: "ally:subject", resource: "PP", delta: -1 }],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_PS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_PS1",
    intent: "(不成立): 自身のEXゲージが0の場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_PS1",
      trigger: HEAVY_HIT,
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_PS1",
    intent: "(不成立): 1ヒットの被ダメージが最大HP×0.75%に届かない場合は発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_PS1",
      trigger: LIGHT_HIT,
    },
    board: { subject: { state: { currentExtraGauge: 3 } } },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_PS2",
    intent:
      "「汐風」を所持している味方が累計で最大HP×1.5%のダメージを受けるたびに発動。対象の味方単体のHPを威力47.5で回復し、付与されている「汐風」を1つ解除する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_PS2",
      trigger: SHIOKAZE_THRESHOLD_HIT,
    },
    board: { allies: ALLIES_WITH_SHIOKAZE },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS2_HEAL", targets: ["ally:front"] },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS2_REMOVE_SHIOKAZE",
          targets: ["ally:front"],
        },
      ],
      // 回復者（アニス）の攻撃力1000×47.5%＝475。防御力は差し引かない（R-HEAL-01 #1）。
      hpDeltas: { "ally:front": 475 },
      // `REMOVE_MARKER count: 1` は3段から1段だけ剥がすため、消滅ではなく
      // 段数変化（3→2）として現れる。
      markers: [{ unitId: "ally:front", markerId: SHIOKAZE, stackCount: 2 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_PS2",
    intent: "さらに自身が2以上EXゲージを所持していた場合、EXゲージを1消費して自身のPPを1加算する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_PS2",
      trigger: SHIOKAZE_THRESHOLD_HIT,
    },
    board: { allies: ALLIES_WITH_SHIOKAZE, subject: { state: { currentExtraGauge: 2 } } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS2_HEAL", targets: ["ally:front"] },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS2_REMOVE_SHIOKAZE",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS2_EX_COST",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS2_PP_GAIN",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: { "ally:front": 475 },
      markers: [{ unitId: "ally:front", markerId: SHIOKAZE, stackCount: 2 }],
      // PP消費(-1)とPP加算(+1)、PP消費由来のEX獲得(+1)とEX消費(-1)がそれぞれ
      // 相殺し、収支が動いたリソースは1つも無い。
    },
  },
  {
    skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_PS3",
    intent:
      "ターン開始時に発動。自身に対し「汐風」を3つ付与する。さらに自身の現在HPの2%を超えるダメージのみ3ヒットまで50%減少させる効果を付与し、EXゲージを3加算する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_PS3",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS3_MARKER_SHIOKAZE",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS3_MARKER_SHIOKAZE",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS3_MARKER_SHIOKAZE",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS3_THRESHOLD_DMG_DOWN",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS3_EX_GAIN",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS3_THRESHOLD_DMG_DOWN",
          magnitude: -0.5,
          timeLimit: { unit: "BATTLE", count: 1 },
          consumption: { kind: "INCOMING_HIT", maxCount: 3 },
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: SHIOKAZE, stackCount: 3 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        // PP消費で+1、スキル自身の加算で+3。
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 4 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_PS3",
    intent:
      "(毎ターン再発動): プレイアブル版と異なり戦闘中1回の制限が無く、後続ターンの開始時も同じだけ発動する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_PS3",
      trigger: turnStarted({ turnNumber: 5 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS3_MARKER_SHIOKAZE",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS3_MARKER_SHIOKAZE",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS3_MARKER_SHIOKAZE",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS3_THRESHOLD_DMG_DOWN",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS3_EX_GAIN",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_PS3_THRESHOLD_DMG_DOWN",
          magnitude: -0.5,
          timeLimit: { unit: "BATTLE", count: 1 },
          consumption: { kind: "INCOMING_HIT", maxCount: 3 },
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: SHIOKAZE, stackCount: 3 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 4 },
      ],
    },
  },
];

describe("production Catalog UNIT_ANIS_SWEETDEVIL_TEX (【渚のスイートデビル】アニス・ベネット・戦術演習版)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-ANIS-SWEETDEVIL-TEX-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-ANIS-SWEETDEVIL-TEX-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-ANIS-SWEETDEVIL-TEX-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-ANIS-SWEETDEVIL-TEX-004 (R-PS-03): PS1+とPS2+は同じ解決スコープでは片方しか発動しない", () => {
    // 「ヒートアップ・ラブと同じタイミングでは発動しない」。両者は別イベントで
    // 候補化される（PS1＝`HitPointReduced`／PS2＝`RuntimeCounterChanged`）ため、
    // `resetScope: RESOLUTION_SCOPE` のcounterを互いに1本ずつ宣言して排他を作る。
    // 1解決スコープ＝`openPassiveChain` 1本で、どちらの順番でも後発が落ちる。
    const strikeInto = (
      chain: ReturnType<typeof openPassiveChain>,
      damageResults: DamageResultRegistry,
      units: readonly BattleUnit[],
      targetUnitId: string,
      power: number,
      definitions: BattleDefinitions,
    ): readonly BattleUnit[] =>
      observeLifecycleDamageProbe({
        definitions,
        units,
        attackerUnitId: "enemy:front",
        targetUnitId,
        power,
        damageResults,
        onFactEventForPassiveChain: (event, current) => chain.fireRecorded(event, current),
      }).units;

    // 汐風所持の味方が閾値（最大HP×1.5%＝150）を超え、同じスコープでアニス自身も
    // 最大HP×0.75%（75）以上を被弾する状況を作る。
    const boardOf = () =>
      productionBoard(snapshot, UNIT_DEFINITION_ID, {
        allies: ALLIES_WITH_SHIOKAZE,
        subject: { state: { currentExtraGauge: 2 } },
      });

    const allyFirst = boardOf();
    const resultsA: DamageResultRegistry = new Map();
    const chainA = openPassiveChain({
      definitions: allyFirst.definitions,
      actorUnitId: "enemy:front",
      battleId: "B_ANIS_TEX_EXCLUSIVE_A",
      damageResults: resultsA,
    });
    const afterAllyHit = strikeInto(
      chainA,
      resultsA,
      allyFirst.units,
      "ally:front",
      1,
      allyFirst.definitions,
    );
    strikeInto(chainA, resultsA, afterAllyHit, "ally:subject", 3, allyFirst.definitions);
    expect(activatedPassiveSkillIds(chainA)).toEqual(["SKL_ANIS_SWEETDEVIL_TEX_PS2"]);

    const selfFirst = boardOf();
    const resultsB: DamageResultRegistry = new Map();
    const chainB = openPassiveChain({
      definitions: selfFirst.definitions,
      actorUnitId: "enemy:front",
      battleId: "B_ANIS_TEX_EXCLUSIVE_B",
      damageResults: resultsB,
    });
    const afterSelfHit = strikeInto(
      chainB,
      resultsB,
      selfFirst.units,
      "ally:subject",
      3,
      selfFirst.definitions,
    );
    strikeInto(chainB, resultsB, afterSelfHit, "ally:front", 1, selfFirst.definitions);
    expect(activatedPassiveSkillIds(chainB)).toEqual(["SKL_ANIS_SWEETDEVIL_TEX_PS1"]);
  });

  it("IT-UNIT-ANIS-SWEETDEVIL-TEX-005: PS2+は自身の被弾を集計し、自身を回復する — 単騎の演習敵でも死にスキルにならない", () => {
    // プレイアブル版は集計・回復の対象から自身を除いていた（`targetSelector:
    // OTHER_ALLY` ＋ `EXCLUDE_RESOLVED_UNIT SELF`）。演習敵は単騎で「味方」が
    // 自身しか居ないため、その2箇所を外したことが差分点になる。単騎の盤面で
    // 「自身の被弾で発動し、自身が回復する」ところまで実経路で固定する。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, {
      allies: [],
      subject: { state: { currentHp: 5000 }, markers: [{ markerId: SHIOKAZE, stackCount: 3 }] },
    });
    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: "enemy:front",
      battleId: "B_ANIS_TEX_SELF_AGGREGATION",
    });
    const after = observeLifecycleDamageProbe({
      definitions: board.definitions,
      units: board.units,
      attackerUnitId: "enemy:front",
      targetUnitId: "ally:subject",
      // (1000-500)×1＝500 は閾値（最大HP×1.5%＝150）を跨ぐ。
      power: 1,
      onFactEventForPassiveChain: (event, current) => chain.fireRecorded(event, current),
    }).units;

    expect(activatedPassiveSkillIds(chain)).toEqual(["SKL_ANIS_SWEETDEVIL_TEX_PS2"]);
    const subject = after.find((unit) => unit.battleUnitId === "ally:subject")!;
    // 被弾500 → 回復475（攻撃力1000×47.5%）で、差し引き5000-500+475=4975。
    expect(subject.currentHp).toBe(4975);
    // 汐風は1つだけ剥がれる（3→2）。
    expect(subject.markerStates.find((marker) => marker.markerId === SHIOKAZE)?.stackCount).toBe(2);
  });

  it("IT-UNIT-ANIS-SWEETDEVIL-TEX-006: 単騎の演習敵ではEXの味方分岐が自身へ解決され、1抽選につきEXゲージが2加算される", () => {
    // `SELF_LOWEST_PRIORITY` は「自身以外を優先」であって「自身を除外」ではない。
    // 他に味方が居ない演習盤面では対象が自身へ解決され、「対象の味方と自身に
    // EX+1」が同じユニットへ2回入る。既定盤面（味方3体）では現れない帰結なので、
    // 単騎で固定する。
    const observed = observeSkillUse({
      snapshot,
      unitDefinitionId: UNIT_DEFINITION_ID,
      use: { kind: "ACTIVE", skillDefinitionId: "SKL_ANIS_SWEETDEVIL_TEX_EX" },
      board: { allies: [] },
      random: ALWAYS_ALLY(),
    });

    expect(observed.actions).toEqual(
      Array.from({ length: 3 }).flatMap(() => [
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_EX_ATK_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_EX_EX_GAIN",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_TEX_EX_EX_GAIN",
          targets: ["ally:subject"],
        },
      ]),
    );
    // 抽選3回 × （対象分1 + 自身分1）＝ 6。
    expect(observed.resources).toEqual([
      { unitId: "ally:subject", resource: "EX_GAUGE", delta: 6 },
    ]);
  });

  it("IT-UNIT-ANIS-SWEETDEVIL-TEX-007 (R-DMG-07): PS3+の閾値付き軽減は現在HP2%を超えたヒットだけを50%減らし、そのヒットでだけ3回分を消費する", () => {
    // `-001` のPS3行は付与そのもの（`damageThreshold` と `consumption` の宣言）
    // までを固定する。閾値の比較演算子（`GT`）も、消費が「軽減を適用したヒット」
    // だけで起きること（R-DMG-07 #6）も、実ダメージを通してはじめて現れる。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, {
      subject: { state: { currentHp: 10000 } },
    });
    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: "ally:subject",
      battleId: "B_ANIS_TEX_THRESHOLD",
    });
    const guarded = chain.fire(turnStarted({ turnNumber: 1 }), board.units);

    const strike = (units: readonly BattleUnit[], power: number) =>
      observeLifecycleDamageProbe({
        definitions: board.definitions,
        units,
        attackerUnitId: "enemy:front",
        targetUnitId: "ally:subject",
        power,
      });

    // 現在HP10000の2%＝200ちょうどは `op: GT` を満たさない。素通しで、消費も起きない。
    const atThreshold = strike(guarded, 0.4);
    expect(atThreshold.hpDeltas["ally:subject"]).toBe(-200);
    expect(atThreshold.consumptions).toEqual([]);

    // 200を超えれば成立する。威力0.402＝201が50%減されて100（切り捨て）になる。
    const overThreshold = strike(guarded, 0.402);
    expect(overThreshold.hpDeltas["ally:subject"]).toBe(-100);
    expect(overThreshold.consumptions).toHaveLength(1);
  });
});
