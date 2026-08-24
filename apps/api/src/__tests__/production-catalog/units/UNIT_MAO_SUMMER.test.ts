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
import { observeCriticalCounterCycle } from "../../../testing/production-unit/runtime-counter.js";
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  resetExecutedActionIds,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  criticalCheckResolved,
  turnStarted,
} from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_MAO_SUMMER`（【真夏の風紀委員長】大賀真桜）のユニット単位production結合
 * テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 既存キャラクターの夏バリアントで、`characterId` は `UNIT_MAO_COMMITTEE` と同じ
 * `CHAR_MAO_OGA` を共有する。EXが配るMarker「解放感」を AS1・AS2・PS1 の3スキルが
 * `BRANCH` で読むため、**同じスキルでも所持／非所持で腕が変わる**。表は両方の腕を
 * 1行ずつ持ち、`-001` が全 `BRANCH` を網羅する。
 *
 * 盤面は攻撃力1000・防御力500・現在HP5000/最大HP10000（`skill-behaviour.ts`）。
 * `SKILL_POWER` のダメージは `(1000 - 500) × power` の切り捨て、`CURRENT_HP_RATIO`
 * のダメージは防御力を差し引かない（R-DMG-01）。
 */

const UNIT_DEFINITION_ID = "UNIT_MAO_SUMMER";
const KAIHOUKAN = "MARKER_MAO_SUMMER_KAIHOUKAN";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** 「解放感」を所持している側の腕を引くための前提盤面。 */
const HOLDING_KAIHOUKAN = { subject: { markers: [{ markerId: KAIHOUKAN }] } };

/** PS1は「2回会心する度に」発動する。counterを1に置いて次の1回を2回目にする。 */
const PS1_COUNTER_AT_ONE = {
  subject: {
    state: {
      skillCounters: {
        [createSkillDefinitionId("SKL_MAO_SUMMER_PS1")]: {
          [createRuntimeCounterId("SKL_MAO_SUMMER_PS1_TRIGGER_COUNT")]: { value: 1, carry: 0 },
        },
      },
    },
  },
};

/** PS2は戦闘中1度しか発動しない。発動済みの状態をcounterで作る。 */
const PS2_ALREADY_ACTIVATED = {
  subject: {
    state: {
      skillCounters: {
        [createSkillDefinitionId("SKL_MAO_SUMMER_PS2")]: {
          [createRuntimeCounterId("SKL_MAO_SUMMER_PS2_ACTIVATIONS")]: { value: 1, carry: 0 },
        },
      },
    },
  },
};

/** (SKL_ID, raw原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_MAO_SUMMER_EX",
    intent:
      "自身に対し、2行動の「解放感」を付与する。「解放感」の効果期間中、自身の攻撃力が15%・与ダメージが10%上昇する（重複可）が、同時に自身が得られるEXゲージが-100%される状態になる。さらに自身に対し、2行動の間5ヒットまで致死ダメージをHP1で耐えるバフを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAO_SUMMER_EX" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_MAO_SUMMER_EX_MARKER_KAIHOUKAN",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_EX_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_EX_DMG_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_EX_EX_GAIN_DOWN", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_MAO_SUMMER_EX_DEATH_SURVIVAL",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAO_SUMMER_EX_ATK_UP",
          magnitude: 0.15,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAO_SUMMER_EX_DMG_UP",
          magnitude: 0.1,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAO_SUMMER_EX_EX_GAIN_DOWN",
          magnitude: -1,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAO_SUMMER_EX_DEATH_SURVIVAL",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2 },
          consumption: { kind: "LETHAL_DAMAGE", maxCount: 5 },
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: KAIHOUKAN, stackCount: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_MAO_SUMMER_AS1",
    intent:
      "敵横一列に威力106でEN攻撃する。攻撃時点で自身のHPが30%以上だった場合、自身の現在HPの15%を消費し、消費分HP×150%のENダメージを与える攻撃を追加で行う",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAO_SUMMER_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAO_SUMMER_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_AS1_HP_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_AS1_HP_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_AS1_HP_COST", targets: ["ally:subject"] },
      ],
      // 本体は(1000-500)×1.06=530。追撃は現在HP5000の15%＝750の150%＝1125で、
      // 消費分×150%と等価になるようダメージを先・コストを後に並べてある。
      hpDeltas: {
        "enemy:front": -1655,
        "enemy:left": -1655,
        "ally:subject": -750,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MAO_SUMMER_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAO_SUMMER_AS1",
    intent: "自身が「解放感」を所持していた場合、威力は116.6に変化する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAO_SUMMER_AS1" },
    board: HOLDING_KAIHOUKAN,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_MAO_SUMMER_AS1_DAMAGE_BOOSTED",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_MAO_SUMMER_AS1_DAMAGE_BOOSTED",
          targets: ["enemy:left"],
        },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_AS1_HP_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_AS1_HP_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_AS1_HP_COST", targets: ["ally:subject"] },
      ],
      // 本体は(1000-500)×1.166=583。追撃分1125は威力の変化を受けない。
      hpDeltas: {
        "enemy:front": -1708,
        "enemy:left": -1708,
        "ally:subject": -750,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MAO_SUMMER_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAO_SUMMER_AS1",
    intent: "(HP30%未満): 追加攻撃とHP消費のどちらも行わず、本体の横一列攻撃だけを行う",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAO_SUMMER_AS1" },
    board: { subject: { state: { currentHp: 2999 } } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAO_SUMMER_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_AS1_DAMAGE", targets: ["enemy:left"] },
      ],
      hpDeltas: { "enemy:front": -530, "enemy:left": -530 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MAO_SUMMER_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAO_SUMMER_AS2",
    intent: "敵3体に威力127.2でEN攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAO_SUMMER_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAO_SUMMER_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_AS2_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_AS2_DAMAGE", targets: ["enemy:back"] },
      ],
      hpDeltas: { "enemy:front": -636, "enemy:left": -636, "enemy:back": -636 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAO_SUMMER_AS2",
    intent: "自身が「解放感」を所持していた場合、さらに1行動の気絶を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAO_SUMMER_AS2" },
    board: HOLDING_KAIHOUKAN,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAO_SUMMER_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_AS2_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_AS2_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_AS2_STUN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_AS2_STUN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_AS2_STUN", targets: ["enemy:back"] },
      ],
      hpDeltas: { "enemy:front": -636, "enemy:left": -636, "enemy:back": -636 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_MAO_SUMMER_AS2_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_MAO_SUMMER_AS2_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_MAO_SUMMER_AS2_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAO_SUMMER_PS1",
    intent:
      "自身の攻撃が2回会心攻撃になるたびに発動。自身が「解放感」を所持していない場合、自身のEXゲージを1加算する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MAO_SUMMER_PS1",
      trigger: criticalCheckResolved({
        source: "ally:subject",
        target: "enemy:front",
        result: true,
      }),
      triggeredBy: "ally:subject",
    },
    board: PS1_COUNTER_AT_ONE,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAO_SUMMER_PS1_EX_GAIN", targets: ["ally:subject"] },
      ],
      // PS使用のPP消費で+1（R-ACT-03）、スキル自身のEX加算で+1。
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAO_SUMMER_PS1",
    intent:
      "自身が「解放感」を所持している場合、自身の会心率を2.5%（重複可）、会心ダメージを8.75%上昇させる（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MAO_SUMMER_PS1",
      trigger: criticalCheckResolved({
        source: "ally:subject",
        target: "enemy:front",
        result: true,
      }),
      triggeredBy: "ally:subject",
    },
    board: {
      subject: { ...HOLDING_KAIHOUKAN.subject, ...PS1_COUNTER_AT_ONE.subject },
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAO_SUMMER_PS1_CRIT_RATE_UP", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_MAO_SUMMER_PS1_CRIT_DAMAGE_UP",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAO_SUMMER_PS1_CRIT_RATE_UP",
          magnitude: 0.025,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAO_SUMMER_PS1_CRIT_DAMAGE_UP",
          magnitude: 0.0875,
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
    skillDefinitionId: "SKL_MAO_SUMMER_PS1",
    intent: "(不成立): 1回目の会心では発動しない（「2回会心攻撃になるたびに」に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MAO_SUMMER_PS1",
      trigger: criticalCheckResolved({
        source: "ally:subject",
        target: "enemy:front",
        result: true,
      }),
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_MAO_SUMMER_PS2",
    intent:
      "ターン開始時に発動。現在HPの30%を消費し、自身に対し、被ダメージを最高50%減少させる効果を付与する（重複可）。この効果は付与時の自身のHPが少ないほど高い効果を発揮し、HP40%地点で最高値となる。さらに自身に対し、自身よりHP割合の高い敵に対する攻撃の与ダメージが10%増加するバフを付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MAO_SUMMER_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAO_SUMMER_PS2_HP_COST", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_PS2_DMG_DOWN", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_PS2_DMG_UP", targets: ["ally:subject"] },
      ],
      // 現在HP5000の30%＝1500を先に消費し、残り3500（35%）で軽減率を評価する。
      // HP40%地点で最高値50%へ達するため、35%はクランプ後の-0.5になる。
      hpDeltas: { "ally:subject": -1500 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAO_SUMMER_PS2_DMG_DOWN",
          magnitude: -0.5,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAO_SUMMER_PS2_DMG_UP",
          magnitude: 0.1,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAO_SUMMER_PS2",
    intent: "(不成立): このスキルは戦闘中に1度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MAO_SUMMER_PS2",
      trigger: turnStarted({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
    },
    board: PS2_ALREADY_ACTIVATED,
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_MAO_SUMMER (【真夏の風紀委員長】大賀真桜)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-MAO-SUMMER-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-MAO-SUMMER-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-MAO-SUMMER-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-MAO-SUMMER-004: the incoming damage reduction PS2 grants scales with the HP left after its own cost, up to the 50% cap", () => {
    // `-001` は既定盤面（消費後35%）でクランプ側だけを固定する。線形部分が
    // 生きていること——HPが多いほど軽減が小さいこと——は別のHPでもう一度観測して
    // はじめて分かる（クランプだけなら定数-0.5と区別できない）。
    const observed = observeSkillUse({
      snapshot,
      unitDefinitionId: UNIT_DEFINITION_ID,
      use: {
        kind: "PASSIVE",
        skillDefinitionId: "SKL_MAO_SUMMER_PS2",
        trigger: turnStarted({ turnNumber: 1 }),
        triggeredBy: "ally:subject",
      },
      board: { subject: { state: { currentHp: 10000 } } },
    });
    // 最大HPの30%＝3000を消費して残り7000（70%）。0〜-0.8333の線形補間で
    // -0.8333 × (1 - 0.7) となり、クランプ（-0.5）には掛からない。
    const reduction = observed.effectsApplied?.find(
      (effect) => effect.effectActionDefinitionId === "ACT_MAO_SUMMER_PS2_DMG_DOWN",
    );
    expect(observed.hpDeltas).toEqual({ "ally:subject": -3000 });
    expect(reduction?.magnitude).toBeCloseTo(-0.24999, 6);
    expect(reduction?.magnitude).toBeGreaterThan(-0.5);
  });

  it("IT-UNIT-MAO-SUMMER-005 [R-EFF-11] (R-EFF-11 RESET, Issue #554): PS1の会心カウンタは、2到達がそのスキル最後の会心でなくても発動し、発動時に0へ戻る。到達後の余剰会心は次回へ繰り越さない", () => {
    // 実挙動: 会心が1ヒット出るたびに加算 → N到達で発動を予約 → スキルの全効果処理
    // 完了後にカウンタを0へ戻す → PSを実行。AS2は敵3体を1回ずつ殴るため、全会心なら
    // 2到達は2体目（＝そのスキル最後の会心ではない）になる。
    const cycle = observeCriticalCounterCycle({
      snapshot,
      unitDefinitionId: UNIT_DEFINITION_ID,
      passiveSkillDefinitionId: "SKL_MAO_SUMMER_PS1",
      counter: "SKL_MAO_SUMMER_PS1_TRIGGER_COUNT",
      uses: [
        { skillDefinitionId: "SKL_MAO_SUMMER_AS2" },
        { skillDefinitionId: "SKL_MAO_SUMMER_AS2" },
      ],
    });

    expect(cycle).toEqual([
      // 3会心（カウンタ1,2,3）で発動は1回だけ（R-PS-07）。3会心目の余剰は繰り越さず
      // カウンタは0へ戻る（旧`modulo`モデルなら3が残り、次は1会心で発動していた）。
      { criticalHits: 3, activations: 1, counterAfter: 0 },
      { criticalHits: 3, activations: 1, counterAfter: 0 },
    ]);
  });
});
