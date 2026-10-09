import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import { openPassiveChain } from "../../../testing/production-unit/passive-activation.js";
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardOverrides,
  type PrecedingAction,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  passiveResolved,
  realDamage,
  unitBeingAttacked,
} from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_NANAE_SOVEREIGN_TEX`（破壊：鳴滝七彩・戦術演習版）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 戦術演習の敵専用（`category: EXERCISE_ENEMY`、R-TEX-11）で、原文はゲーム内
 * スクリーンショットからの転記。プレイアブル版 `UNIT_NANAE_SOVEREIGN` との差分は
 * Lv200固定ステータスに加え、`+` が付いたPS1・PS3の2本だけで、EX・AS1・PS2は
 * 威力・倍率・閾値ともに完全一致する。
 *
 * PS1「ランパートシャッター+」: 契機が「他の味方が」から「自身が」へ（Q-TEX-12。
 * 演習の敵陣営は単騎（Q-TEX-01）のため`OTHER_ALLY`のままでは永久に発動しない）。
 * 効果も「攻撃を自身に引き寄せ、50%をガードし肩代わりする」から「攻撃を50%ガード
 * する」へ変わり、`APPLY_TARGET_REDIRECT`／`APPLY_COVER`に代えて自身への
 * `APPLY_DAMAGE_MOD`1件になる。ガードの持続はプレイアブル版の`APPLY_COVER`と同じ
 * `timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" }`（その行動の全ヒットを
 * ガードする）。
 *
 * PS3「リベンジスタンス+」: 契機の対象が「他の味方」から「自身」へ、累計被ダメージの
 * 閾値が最大HP×20%から**1%**へ縮小（被ダメージ量を最大HP比で測る値はTEX版で1/20に
 * なる。`UNIT_HIIRO_FREEWOLF_TEX`のPS1が15%→0.75%だったのと同じ法則で、自身の残HP
 * 割合のゲート（50%）は据え置き）。効果は被弾ユニットのタイプによる3分岐が撤廃され、
 * 威力40の自己回復のみになる。
 *
 * 盤面は攻撃力1000・防御力500・現在HP5000/最大HP10000（`skill-behaviour.ts`）。
 */

const UNIT_DEFINITION_ID = "UNIT_NANAE_SOVEREIGN_TEX";
const KOUSEI = "MARKER_NANAE_SOVEREIGN_TEX_KOUSEI";

/** EXの「デバフを全て解除」を実際に解除させるため、`UNIT_NANAE_COMMANDER`のATK低下デバフを借りる。 */
const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  "UNIT_NANAE_COMMANDER",
]);

/** 「攻勢」状態を保持している盤面。EXの攻撃分岐・AS1の攻撃分岐を成立させる。 */
const SUBJECT_WITH_KOUSEI: BoardOverrides = {
  subject: { markers: [{ markerId: KOUSEI, stackCount: 1 }] },
};

/**
 * EXの「攻勢前」分岐が実際に付与する Linked Effect Group 一式
 * （Marker=PARENT、免疫・被ダメ軽減=CHILD）をそのまま前提として撃つ。
 */
const ONE_EX_KOUSEI_GRANT: readonly PrecedingAction[] = [
  { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_EX_KOUSEI_MARKER", target: "SELF" },
  { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_EX_KOUSEI_IMMUNITY", target: "SELF" },
  { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_EX_KOUSEI_DMG_REDUCE", target: "SELF" },
];

/** PS1/PS3の「自身のHPが50%未満」を作る盤面。 */
const SUBJECT_BELOW_HALF_HP: BoardOverrides = { subject: { state: { currentHp: 4000 } } };

/** PS2の「自身のHPが50%以上・EXゲージ1以上」を作る盤面（既定のHP比率はちょうど50%）。 */
const SUBJECT_WITH_ONE_EX_GAUGE: BoardOverrides = {
  subject: { state: { currentExtraGauge: 1 } },
};

/**
 * PS3の閾値到達を作る一撃。**自身**の最大HP×1%＝100ちょうどのダメージを自身へ与え、
 * `CUMULATIVE_DAMAGE_THRESHOLD`をちょうど跨がせる（プレイアブル版は他の味方への
 * 最大HP×20%＝2000だった）。
 */
const REVENGE_HIT = realDamage({
  from: "enemy:front",
  to: "ally:subject",
  skillType: "AS",
  power: 0.2,
});

/** 閾値（最大HP×1%＝100）に1だけ届かない一撃。 */
const BELOW_THRESHOLD_HIT = realDamage({
  from: "enemy:front",
  to: "ally:subject",
  skillType: "AS",
  power: 0.198,
});

/** (SKL_ID, スクショ原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_EX",
    intent:
      "「攻勢」状態ではない場合、自身にかけられたデバフを全て解除し、自身に「攻勢」を付与する（自身以外解除不可）。「攻勢」は自身に向けられるデバフを無効化し、被ダメージを35%減少させる（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_EX" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_EX_CLEANSE",
          targets: ["ally:subject"],
          // 解除対象のデバフを何も保持していないため不発（SKIPPED）。
          resultKind: "SKIPPED",
        },
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_EX_KOUSEI_MARKER",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_EX_KOUSEI_IMMUNITY",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_EX_KOUSEI_DMG_REDUCE",
          targets: ["ally:subject"],
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: KOUSEI, stackCount: 1 }],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_EX_KOUSEI_IMMUNITY",
          magnitude: 0,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_EX_KOUSEI_DMG_REDUCE",
          magnitude: -0.35,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_EX",
    intent: "(前提付き): 自身にかけられたデバフを保持している場合、それを実際に解除する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_EX" },
    precedingActions: [
      { effectActionDefinitionId: "ACT_NANAE_COMMANDER_AS2_ATK_DOWN", target: "SELF" },
    ],
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_EX_CLEANSE",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_EX_KOUSEI_MARKER",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_EX_KOUSEI_IMMUNITY",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_EX_KOUSEI_DMG_REDUCE",
          targets: ["ally:subject"],
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: KOUSEI, stackCount: 1 }],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_EX_KOUSEI_IMMUNITY",
          magnitude: 0,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_EX_KOUSEI_DMG_REDUCE",
          magnitude: -0.35,
        },
      ],
      effectsRemoved: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_COMMANDER_AS2_ATK_DOWN",
          magnitude: -0.1,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_EX",
    intent:
      "(分岐): 「攻勢」状態の場合、一時的に自身の攻撃力を25%上昇（重複可）させて敵全体に威力106で攻撃し、「攻勢」状態を解除する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_EX" },
    precedingActions: ONE_EX_KOUSEI_GRANT,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_EX_ATK_UP",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_EX_DAMAGE", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_EX_REMOVE_KOUSEI",
          targets: ["ally:subject"],
        },
      ],
      // 攻撃力1000×1.25=1250。(1250-500)×1.06=795。
      hpDeltas: { "enemy:front": -795, "enemy:left": -795, "enemy:back": -795 },
      markersRemoved: [{ unitId: "ally:subject", markerId: KOUSEI, stackCount: 1 }],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_EX_ATK_UP",
          magnitude: 0.25,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      effectsRemoved: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_EX_KOUSEI_IMMUNITY",
          magnitude: 0,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_EX_KOUSEI_DMG_REDUCE",
          magnitude: -0.35,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_AS1",
    intent:
      "「攻勢」状態ではない場合、自身が含まれる味方横一列に対し、自身が1回行動を終えるまでの間攻撃力×30%のシールドを付与する。シールドは付与者が倒れると解除される",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_AS1" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_AS1_SHIELD",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_AS1_SHIELD",
          targets: ["ally:front"],
        },
      ],
      // 攻撃力1000×0.3=300。
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_AS1_SHIELD",
          magnitude: 300,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_AS1_SHIELD",
          magnitude: 300,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_AS1",
    intent: "(分岐): 「攻勢」状態の場合、敵2体に威力127.2で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_AS1" },
    board: SUBJECT_WITH_KOUSEI,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_AS1_DAMAGE",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_AS1_DAMAGE", targets: ["enemy:left"] },
      ],
      // (1000-500)×1.272=636。
      hpDeltas: { "enemy:front": -636, "enemy:left": -636 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_PS1",
    intent: "（同時発動制限）自身が攻撃される前に発動。攻撃を50%ガードする",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_PS1",
      trigger: unitBeingAttacked({
        source: "enemy:front",
        target: "ally:subject",
        skillType: "AS",
      }),
    },
    expected: {
      // PS1自身の`PassiveResolved`がPS2の自己参照トリガーを満たし
      // （HP比率50%以上のまま・PS1のPP消費でEXゲージが0→1になり条件成立）、
      // 同じ解決スコープでPS2も連鎖発動する。
      actions: [
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_PS1_GUARD",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_PS2_EX_DOWN",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_PS2_HEAL", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_PS2_PP_UP",
          targets: ["ally:subject"],
        },
      ],
      // 攻撃力1000×0.125=125（PS2のHEAL）。
      hpDeltas: { "ally:subject": 125 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_PS1_GUARD",
          magnitude: -0.5,
          timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" },
        },
      ],
      // PP: PS1消費(-1)→PS2消費(-1)→PS2の+2加算で4へ戻る（収支0）。
      // EX_GAUGE: PS1のPP消費由来+1→PS2のPP消費由来+1(合計2)→EX_DOWN(-2)で0へ戻る（収支0）。
    },
  },
  {
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_PS1",
    intent: "(不成立): 自身のHPが50%未満の場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_PS1",
      trigger: unitBeingAttacked({
        source: "enemy:front",
        target: "ally:subject",
        skillType: "AS",
      }),
    },
    board: SUBJECT_BELOW_HALF_HP,
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_PS1",
    intent:
      "(不成立・Q-TEX-12): 他の味方が攻撃されても発動しない（契機が「自身が攻撃される前」へ変わっている）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_PS1",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:front", skillType: "AS" }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_PS2",
    intent:
      "パッシブスキルを使用した後に発動。EXゲージを2消費して自身のHPを威力12.5で回復し、さらに自身のPPを2加算する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_PS2",
      trigger: passiveResolved({
        actor: "ally:subject",
        skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_PS1",
      }),
    },
    board: SUBJECT_WITH_ONE_EX_GAUGE,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_PS2_EX_DOWN",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_PS2_HEAL", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_PS2_PP_UP",
          targets: ["ally:subject"],
        },
      ],
      // 攻撃力1000×0.125=125。
      hpDeltas: { "ally:subject": 125 },
      resources: [{ unitId: "ally:subject", resource: "EX_GAUGE", delta: -1 }],
    },
  },
  {
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_PS2",
    intent: "(不成立): 自身のHPが50%未満の場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_PS2",
      trigger: passiveResolved({
        actor: "ally:subject",
        skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_PS1",
      }),
    },
    board: { subject: { state: { currentHp: 4000, currentExtraGauge: 1 } } },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_PS2",
    intent: "(不成立): 自身のEXゲージが0の場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_PS2",
      trigger: passiveResolved({
        actor: "ally:subject",
        skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_PS1",
      }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_PS3",
    intent: "自身が累計で最大HP×1%のダメージを受けるたびに発動。自身のHPを威力40で回復する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_PS3",
      trigger: REVENGE_HIT,
    },
    board: SUBJECT_BELOW_HALF_HP,
    expected: {
      // 検証対象自身は`unitType: PHYSICAL`で、プレイアブル版ならタイプ分岐の物理枝
      // （被ダメージ-5%）へ落ちていた。TEX版は分岐が無く常に回復になる。
      actions: [
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_TEX_PS3_EN_HEAL",
          targets: ["ally:subject"],
        },
      ],
      // 契機の被弾(1000-500)×0.2=100（最大HP10000×1%=100ちょうどで閾値を跨ぐ）は
      // 基準線へ繰り込み済み。回復は攻撃力1000×0.4=400。
      hpDeltas: { "ally:subject": 400 },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_PS3",
    intent:
      "(境界): 累計被ダメージが最大HP×1%に届かない場合は発動しない（プレイアブル版の20%から縮小されている）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_PS3",
      trigger: BELOW_THRESHOLD_HIT,
    },
    board: SUBJECT_BELOW_HALF_HP,
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_PS3",
    intent:
      "(不成立・Q-TEX-12): 他の味方が被弾しても累計に乗らず発動しない（契機の対象が自身へ変わっている）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_PS3",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:front",
        skillType: "AS",
        power: 4,
      }),
    },
    board: SUBJECT_BELOW_HALF_HP,
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_PS3",
    intent: "(不成立): 自身のHPが50%以上の場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_PS3",
      trigger: REVENGE_HIT,
    },
    // 契機の被弾が自身へ来るようになったため、盤面既定のHP5000（ちょうど50%）では
    // 被弾後に4900＝49%へ落ちて条件が成立してしまう。被弾後も50%以上に残る5200から
    // 始めて、ゲートの不成立側を作る。
    board: { subject: { state: { currentHp: 5200 } } },
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_NANAE_SOVEREIGN_TEX (破壊：鳴滝七彩)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-NANAE-SOVEREIGN-TEX-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-NANAE-SOVEREIGN-TEX-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-NANAE-SOVEREIGN-TEX-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-NANAE-SOVEREIGN-TEX-004: PS2's self-referencing PassiveResolved trigger activates exactly once when the EX_GAUGE gate has exactly 1 to spend, instead of chaining indefinitely", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, SUBJECT_WITH_ONE_EX_GAUGE);
    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: "ally:subject",
      battleId: "B_NANAE_SOVEREIGN_TEX_PS2_GATE",
    });
    chain.fire(
      passiveResolved({ actor: "ally:subject", skillDefinitionId: "SKL_NANAE_SOVEREIGN_TEX_PS1" }),
      board.units,
    );
    const activations = chain
      .eventsOfType("PassiveActivated")
      .filter((event) => event.payload.skillDefinitionId === "SKL_NANAE_SOVEREIGN_TEX_PS2");
    expect(activations).toHaveLength(1);
  });
});
