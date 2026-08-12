import { describe, expect, it } from "vitest";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
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
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { realDamage, turnStarted } from "../../../testing/production-unit/trigger-events.js";
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
});
