import { describe, expect, it } from "vitest";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
import { reduceStateDeltas } from "../../../domain/battle/lifecycle/state-delta-reducer.js";
import {
  initialSnapshotFor,
  loadProductionSnapshot,
  unitFrom,
} from "../../../testing/fixtures/index.js";
import type { AppliedEffect } from "../../../domain/battle/model/applied-effect.js";
import type { BattleDefinitions } from "../../../domain/battle/model/battle-definitions.js";
import type { DamageResultRegistry } from "../../../domain/battle/skill/formula-evaluator.js";
import type { BattleUnit } from "../../../domain/battle/model/battle-unit.js";
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
import {
  hitPointReduced,
  realDamage,
  turnStarted,
} from "../../../testing/production-unit/trigger-events.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";

/**
 * `UNIT_ANIS_SWEETDEVIL`（【渚のスイートデビル】アニス・ベネット）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 既存キャラクターの夏バリアントで、`characterId` は `UNIT_ANIS_TROUBLEMAKER` と同じ
 * `CHAR_ANIS_BENNETT`、所属も同じ `AFF_CHAOS_MAIDEN` を共有する。
 *
 * `DMG-012`（Issue #452）が追加した2機構の **production 初使用** である。
 *
 * - PS1のtrigger条件 `DAMAGE_MAX_HP_RATIO`（1ヒットで最大HP×15%以上被弾）。
 * - PS3が配る `APPLY_DAMAGE_MOD.damageThreshold`（現在HPの20%を超えるダメージのみ
 *   3ヒットまで50%減、`R-DMG-07`）。
 *
 * 盤面は攻撃力1000・防御力500・現在HP5000/最大HP10000（`skill-behaviour.ts`）。
 * `SKILL_POWER` のダメージは `(1000 - 500) × power` の切り捨て、`HEAL` の
 * `SKILL_POWER` は回復者の攻撃力×power（防御力を差し引かない、R-HEAL-01 #1）。
 */

const UNIT_DEFINITION_ID = "UNIT_ANIS_SWEETDEVIL";
const SHIOKAZE = "MARKER_ANIS_SWEETDEVIL_SHIOKAZE";

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

/** PS3は戦闘中1度しか発動しない。発動済みの状態をcounterで作る。 */
const PS3_ALREADY_ACTIVATED = {
  subject: {
    state: {
      skillCounters: {
        [createSkillDefinitionId("SKL_ANIS_SWEETDEVIL_PS3")]: {
          [createRuntimeCounterId("SKL_ANIS_SWEETDEVIL_PS3_ACTIVATIONS")]: { value: 1, carry: 0 },
        },
      },
    },
  },
};

/** PS2の集計対象は「自身以外の『汐風』所持者」。前列の味方だけへ持たせる。 */
const ALLIES_WITH_SHIOKAZE: readonly BoardUnitSpec[] = [
  {
    id: "ally:front",
    position: { column: "LEFT", row: "FRONT" },
    markers: [{ markerId: SHIOKAZE, stackCount: 3 }],
  },
  { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
];

/**
 * 「汐風」所持者が累計で最大HP×30%（3000ダメージ）を受ける一撃。実ダメージ
 * pipelineが `DamageApplied` を出し、`counterUpdates` が閾値を跨いで
 * `RuntimeCounterChanged` を発行し、それがPS2の契機になる。
 */
const SHIOKAZE_THRESHOLD_HIT = realDamage({
  from: "enemy:front",
  to: "ally:front",
  skillType: "AS",
  power: 6,
});

/** 1ヒットで最大HP×15%（1500ダメージ）を超える被弾。PS1の `DAMAGE_MAX_HP_RATIO` を満たす。 */
const HEAVY_HIT = realDamage({
  from: "enemy:front",
  to: "ally:subject",
  skillType: "AS",
  power: 3,
  event: "HitPointReduced",
});

/** 同じ経路で最大HP×15%に届かない被弾（1000ダメージ）。 */
const LIGHT_HIT = realDamage({
  from: "enemy:front",
  to: "ally:subject",
  skillType: "AS",
  power: 2,
  event: "HitPointReduced",
});

/** (SKL_ID, raw原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_ANIS_SWEETDEVIL_EX",
    intent:
      "自身以外を優先した味方単体か、自身に最も近い敵単体からランダムに3回対象を抽出し、抽選1回につき以下の効果を付与する（対象が味方の場合）1行動の間攻撃力を15%上昇させる（重複可）。さらに対象の味方と自身に対し、EXゲージを1加算する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ANIS_SWEETDEVIL_EX" },
    random: ALWAYS_ALLY,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_EX_ATK_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_EX_EX_GAIN", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_EX_EX_GAIN", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_EX_ATK_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_EX_EX_GAIN", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_EX_EX_GAIN", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_EX_ATK_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_EX_EX_GAIN", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_EX_EX_GAIN", targets: ["ally:subject"] },
      ],
      // 「重複可」のため3回分が別インスタンスで積み上がる。
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_EX_ATK_UP",
          magnitude: 0.15,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_EX_ATK_UP",
          magnitude: 0.15,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_EX_ATK_UP",
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
    skillDefinitionId: "SKL_ANIS_SWEETDEVIL_EX",
    intent: "（対象が敵の場合）1行動の間防御力を15%低下させる（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ANIS_SWEETDEVIL_EX" },
    random: ALWAYS_ENEMY,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_EX_DEF_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_EX_DEF_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_EX_DEF_DOWN", targets: ["enemy:front"] },
      ],
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_EX_DEF_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_EX_DEF_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_EX_DEF_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ANIS_SWEETDEVIL_AS1",
    intent:
      "敵単体に威力21.2で4ヒットEN攻撃する。対象がEXゲージを1以上所持していた場合、対象のEXゲージを1削り、自身のEXゲージを1加算する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ANIS_SWEETDEVIL_AS1" },
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
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_AS1_EX_DRAIN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_AS1_EX_GAIN", targets: ["ally:subject"] },
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
    skillDefinitionId: "SKL_ANIS_SWEETDEVIL_AS1",
    intent: "(対象のEXゲージ0): 削り取りと自身への加算はどちらも行わない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ANIS_SWEETDEVIL_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_AS1_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -424 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ANIS_SWEETDEVIL_PS1",
    intent:
      "自身が敵からの攻撃1ヒットで、最大HP×15%以上のダメージを負った際に発動。自身に対し1行動の間得られるEXゲージが100%増加するバフを付与する（重複可）。EXゲージが3以上：EXゲージを2消費し、被ダメージの100%分回復する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ANIS_SWEETDEVIL_PS1",
      trigger: HEAVY_HIT,
    },
    // 分岐が読む「所持状況」はPP消費に伴うEX獲得（R-ACT-03、+1）の**後**の値。
    // 盤面2からPS使用で3になり、「3以上」の腕を引く。
    board: { subject: { state: { currentExtraGauge: 2 } } },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_PS1_EX_GAIN_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_PS1_EX_COST_2",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_PS1_HEAL_FULL",
          targets: ["ally:subject"],
        },
      ],
      // 契機のヒット（(1000-500)×3=1500）は基準線へ繰り込まれ、その100%を回復する。
      hpDeltas: { "ally:subject": 1500 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_PS1_EX_GAIN_UP",
          magnitude: 1,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        // PP消費で+1、スキル自身の消費で-2。
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: -1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_ANIS_SWEETDEVIL_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ANIS_SWEETDEVIL_PS1",
    intent: "EXゲージが2：EXゲージを1消費し、被ダメージの50%分回復する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ANIS_SWEETDEVIL_PS1",
      trigger: HEAVY_HIT,
    },
    // 盤面1からPS使用で2になり、「2」の腕を引く。
    board: { subject: { state: { currentExtraGauge: 1 } } },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_PS1_EX_GAIN_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_PS1_EX_COST_1",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_PS1_HEAL_HALF",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: { "ally:subject": 750 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_PS1_EX_GAIN_UP",
          magnitude: 1,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [{ unitId: "ally:subject", resource: "PP", delta: -1 }],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_ANIS_SWEETDEVIL_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ANIS_SWEETDEVIL_PS1",
    intent: "(不成立): 自身のEXゲージが0の場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ANIS_SWEETDEVIL_PS1",
      trigger: HEAVY_HIT,
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_ANIS_SWEETDEVIL_PS1",
    intent: "(不成立): 1ヒットの被ダメージが最大HP×15%に届かない場合は発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ANIS_SWEETDEVIL_PS1",
      trigger: LIGHT_HIT,
    },
    board: { subject: { state: { currentExtraGauge: 3 } } },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_ANIS_SWEETDEVIL_PS2",
    intent:
      "自身以外の「汐風」を所持している味方が累計で最大HP×30%のダメージを受けるたびに発動。対象の味方単体のHPを威力47.5で回復し、付与されている「汐風」を1つ解除する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ANIS_SWEETDEVIL_PS2",
      trigger: SHIOKAZE_THRESHOLD_HIT,
    },
    board: { allies: ALLIES_WITH_SHIOKAZE },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_PS2_HEAL", targets: ["ally:front"] },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_PS2_REMOVE_SHIOKAZE",
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
    skillDefinitionId: "SKL_ANIS_SWEETDEVIL_PS2",
    intent: "さらに自身が2以上EXゲージを所持していた場合、EXゲージを1消費して自身のPPを1加算する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ANIS_SWEETDEVIL_PS2",
      trigger: SHIOKAZE_THRESHOLD_HIT,
    },
    board: { allies: ALLIES_WITH_SHIOKAZE, subject: { state: { currentExtraGauge: 2 } } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_PS2_HEAL", targets: ["ally:front"] },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_PS2_REMOVE_SHIOKAZE",
          targets: ["ally:front"],
        },
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_PS2_EX_COST", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_PS2_PP_GAIN", targets: ["ally:subject"] },
      ],
      hpDeltas: { "ally:front": 475 },
      markers: [{ unitId: "ally:front", markerId: SHIOKAZE, stackCount: 2 }],
      // PP消費(-1)とPP加算(+1)、PP消費由来のEX獲得(+1)とEX消費(-1)がそれぞれ
      // 相殺し、収支が動いたリソースは1つも無い。
    },
  },
  {
    skillDefinitionId: "SKL_ANIS_SWEETDEVIL_PS3",
    intent:
      "ターン開始時に発動。自身に隣接する味方に対し「汐風」を3つ付与する。さらに自身に対し、自身の現在HPの20%を超えるダメージのみ3ヒットまで50%減少させる効果を付与し、EXゲージを3加算する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ANIS_SWEETDEVIL_PS3",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_PS3_MARKER_SHIOKAZE",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_PS3_MARKER_SHIOKAZE",
          targets: ["ally:back"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_PS3_MARKER_SHIOKAZE",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_PS3_MARKER_SHIOKAZE",
          targets: ["ally:back"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_PS3_MARKER_SHIOKAZE",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_PS3_MARKER_SHIOKAZE",
          targets: ["ally:back"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_PS3_THRESHOLD_DMG_DOWN",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_PS3_EX_GAIN", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ANIS_SWEETDEVIL_PS3_THRESHOLD_DMG_DOWN",
          magnitude: -0.5,
          timeLimit: { unit: "BATTLE", count: 1 },
          consumption: { kind: "INCOMING_HIT", maxCount: 3 },
        },
      ],
      markers: [
        { unitId: "ally:front", markerId: SHIOKAZE, stackCount: 3 },
        { unitId: "ally:back", markerId: SHIOKAZE, stackCount: 3 },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        // PP消費で+1、スキル自身の加算で+3。
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 4 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ANIS_SWEETDEVIL_PS3",
    intent: "(不成立): このスキルは戦闘中に一度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ANIS_SWEETDEVIL_PS3",
      trigger: turnStarted({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
    },
    board: PS3_ALREADY_ACTIVATED,
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_ANIS_SWEETDEVIL (【渚のスイートデビル】アニス・ベネット)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-ANIS-SWEETDEVIL-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-ANIS-SWEETDEVIL-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-ANIS-SWEETDEVIL-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-ANIS-SWEETDEVIL-004 (R-PS-03): PS1とPS2は同じ解決スコープでは片方しか発動しない", () => {
    // 「ヒートアップ・ラブと同じタイミングでは発動しない」。両者は別イベントで
    // 候補化される（PS1＝`HitPointReduced`／PS2＝`RuntimeCounterChanged`）ため、
    // R-PS-03の同時発動制限グループ（**同じイベントで候補になったPSだけ**を1グループに
    // する）には決して同居しない。`resetScope: RESOLUTION_SCOPE` のcounterで
    // 「この解決スコープで相手が発動したか」を互いに見る形で排他を作っている。
    // 1解決スコープ＝`openPassiveChain` 1本で、どちらの順番でも後発が落ちることを見る。
    // PS1の回復は `DAMAGE_RECEIVED_RATIO`／`LAST_DAMAGE_RECEIVED` を読むため、実戦闘の
    // `action-skill-use-resolver` と同じく1解決スコープにつき1つのレジストリを
    // 打撃側とPS連鎖側で共有する。
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

    // 汐風所持の味方が閾値（最大HP×30%＝3000）を超え、同じスコープでアニス自身も
    // 最大HP×15%（1500）以上を被弾する状況を作る。
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
      battleId: "B_ANIS_EXCLUSIVE_A",
      damageResults: resultsA,
    });
    const afterAllyHit = strikeInto(
      chainA,
      resultsA,
      allyFirst.units,
      "ally:front",
      6,
      allyFirst.definitions,
    );
    strikeInto(chainA, resultsA, afterAllyHit, "ally:subject", 3, allyFirst.definitions);
    expect(activatedPassiveSkillIds(chainA)).toEqual(["SKL_ANIS_SWEETDEVIL_PS2"]);

    const selfFirst = boardOf();
    const resultsB: DamageResultRegistry = new Map();
    const chainB = openPassiveChain({
      definitions: selfFirst.definitions,
      actorUnitId: "enemy:front",
      battleId: "B_ANIS_EXCLUSIVE_B",
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
    strikeInto(chainB, resultsB, afterSelfHit, "ally:front", 6, selfFirst.definitions);
    expect(activatedPassiveSkillIds(chainB)).toEqual(["SKL_ANIS_SWEETDEVIL_PS1"]);
  });

  it("IT-UNIT-ANIS-SWEETDEVIL-006 (R-PS-01, R-HEAL-01): PS1の被弾→発動→回復は公開差分だけで復元できる", () => {
    // `-001` はHP差分の観測、`-004` は発動したスキルIDだけを見るため、どちらも
    // `HealApplied` の `stateDelta` が欠落しても成功してしまう。被弾と回復の両区間を
    // 独立Reducerで復元して、公開差分だけで同じ最終状態へ届くことを固定する。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, {
      subject: { state: { currentHp: 10000, currentExtraGauge: 2 } },
    });
    const damageResults: DamageResultRegistry = new Map();

    // 被弾区間: 最大HP×15%（1500）以上の一撃。PS連鎖はまだ挿さない。
    const hit = observeLifecycleDamageProbe({
      definitions: board.definitions,
      units: board.units,
      attackerUnitId: "enemy:front",
      targetUnitId: "ally:subject",
      power: 3,
      damageResults,
    });
    expect(hit.hpDeltas["ally:subject"]).toBe(-1500);
    expect(
      reduceStateDeltas(
        initialSnapshotFor(board.units, { include: ["effects"] }),
        hit.recorder
          .getEvents()
          .flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta])),
      ),
    ).toEqual(initialSnapshotFor(hit.units, { include: ["effects"] }));

    // 発動→回復区間: 同じ解決スコープの `HitPointReduced` からPS1を解決する。
    // 直前DAMAGE結果レジストリを共有しているため `LAST_DAMAGE_RECEIVED` が引ける。
    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: "enemy:front",
      battleId: "B_ANIS_PS1_HEAL",
      damageResults,
    });
    const eventsBefore = chain.recorder.getEvents().length;
    const healed = chain.fire(
      hitPointReduced({
        source: "enemy:front",
        target: "ally:subject",
        damage: 1500,
        hpBefore: 10000,
      }),
      hit.units,
    );
    expect(activatedPassiveSkillIds(chain)).toEqual(["SKL_ANIS_SWEETDEVIL_PS1"]);
    // EX3（盤面2＋PP消費分1）で「3以上」の腕を引き、被ダメージ1500の100%を回復する。
    expect(healed.find((unit) => unit.battleUnitId === "ally:subject")!.currentHp).toBe(10000);
    // PS使用はクールタイムと排他用counterも動かすため、射影に含めて突き合わせる
    // （HP・効果だけを見ると、それらのStateDeltaが欠けても気付けない）。
    const restorationProjection = { include: ["effects", "cooldowns", "skillCounters"] } as const;
    expect(
      reduceStateDeltas(
        initialSnapshotFor(hit.units, restorationProjection),
        chain.recorder
          .getEvents()
          .slice(eventsBefore)
          .flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta])),
      ),
    ).toEqual(initialSnapshotFor(healed, restorationProjection));
  });

  it("IT-UNIT-ANIS-SWEETDEVIL-005 (R-DMG-07): PS3の閾値付き軽減は現在HP20%を超えたヒットだけを50%減らし、そのヒットでだけ3回分を消費する", () => {
    // `-001` のPS3行は付与そのもの（`damageThreshold` と `consumption` の宣言）
    // までを固定する。閾値の比較演算子（`GT`）も、消費が「軽減を適用したヒット」
    // だけで起きること（R-DMG-07 #6）も、実ダメージを通してはじめて現れる。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, {
      subject: { state: { currentHp: 10000 } },
    });
    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: "ally:subject",
      battleId: "B_ANIS_THRESHOLD",
    });
    const guarded = chain.fire(turnStarted({ turnNumber: 1 }), board.units);
    const reductionsOf = (units: readonly BattleUnit[]): readonly AppliedEffect[] =>
      units
        .find((unit) => unit.battleUnitId === "ally:subject")!
        .appliedEffects.filter(
          (effect) =>
            effect.effectActionDefinitionId === "ACT_ANIS_SWEETDEVIL_PS3_THRESHOLD_DMG_DOWN",
        );
    expect(reductionsOf(guarded)).toHaveLength(1);

    const strike = (units: readonly BattleUnit[], power: number) =>
      observeLifecycleDamageProbe({
        definitions: board.definitions,
        units,
        attackerUnitId: "enemy:front",
        targetUnitId: "ally:subject",
        power,
      });

    // 現在HP10000の20%＝2000ちょうどは `op: GT` を満たさない。素通しで、消費も起きない。
    const atThreshold = strike(guarded, 4);
    expect(atThreshold.hpDeltas["ally:subject"]).toBe(-2000);
    expect(reductionsOf(atThreshold.units)).toHaveLength(1);
    expect(atThreshold.consumptions).toEqual([]);

    // 2001以上なら成立する。威力4.002＝2001が50%減されて1000（切り捨て）になる。
    const overThreshold = strike(guarded, 4.002);
    expect(overThreshold.hpDeltas["ally:subject"]).toBe(-1000);
    expect(overThreshold.consumptions).toHaveLength(1);

    // 3ヒット目までは軽減され、4ヒット目は残数が尽きて素通しになる。
    let units = guarded;
    const applied: number[] = [];
    for (let hit = 0; hit < 4; hit += 1) {
      const observed = strike(units, 4.002);
      applied.push(observed.hpDeltas["ally:subject"]!);
      units = observed.units;
    }
    // 現在HPが減るほど閾値（現在HP×20%）も下がるため、4ヒット目まで閾値自体は
    // 満たし続ける。差が出るのは消費し切ったかどうかだけである。
    expect(applied.slice(0, 3).every((delta) => delta === -1000)).toBe(true);
    expect(applied[3]).toBe(-2001);
    expect(reductionsOf(units)).toEqual([]);

    // 独立Reducer復元は**枯渇するヒット**で取る。1発目（残数3→2）では
    // `EffectExpired` が出ないため、失効差分の欠落を検出できない。2回消費済みの
    // 状態から3回目の成立ヒットを与え、`EffectConsumptionChanged` と
    // `EffectExpired` のStateDeltaだけで「効果が消えた最終状態」へ復元できることを見る。
    let twiceConsumed = guarded;
    for (let hit = 0; hit < 2; hit += 1) {
      twiceConsumed = strike(twiceConsumed, 4.002).units;
    }
    expect(reductionsOf(twiceConsumed)).toHaveLength(1);

    const depletingHit = strike(twiceConsumed, 4.002);
    expect(reductionsOf(depletingHit.units)).toEqual([]);
    expect(
      depletingHit.expirations.map((expiration) => expiration.effectActionDefinitionId),
    ).toContain("ACT_ANIS_SWEETDEVIL_PS3_THRESHOLD_DMG_DOWN");
    expect(
      reduceStateDeltas(
        initialSnapshotFor(twiceConsumed, { include: ["effects"] }),
        depletingHit.recorder
          .getEvents()
          .flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta])),
      ),
    ).toEqual(initialSnapshotFor(depletingHit.units, { include: ["effects"] }));
  });
});
