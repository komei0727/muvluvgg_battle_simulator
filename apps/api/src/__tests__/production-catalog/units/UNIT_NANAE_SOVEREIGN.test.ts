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
  type BoardUnitSpec,
  type PrecedingAction,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  passiveResolved,
  realDamage,
  unitBeingAttacked,
} from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_NANAE_SOVEREIGN`（【穹を統べる虹色の号令】鳴滝七彩）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * `CHAR_NANAE_NARUTAKI`の2バリアント目（`UNIT_NANAE_COMMANDER`「オールラウンダーな
 * 統率者」と同一キャラクター）。全スキルが「攻勢」自作Marker
 * （`MARKER_NANAE_SOVEREIGN_KOUSEI`）とLinked Effect Group・cover/redirect・
 * `CUMULATIVE_DAMAGE_THRESHOLD`で表現される。
 *
 * PS3「リベンジスタンス」は新しいTargetReference kind `TRIGGER_TARGET_SINGLE`
 * （Issue #661/Q-CAT-EFF-24）のproduction初使用であり、`CUMULATIVE_DAMAGE_THRESHOLD`が
 * 発行する`RuntimeCounterChanged`から、その閾値を跨がせた被弾ユニット1体の
 * `UNIT_TYPE`を直接読んで3分岐する。
 *
 * 盤面は攻撃力1000・防御力500・現在HP5000/最大HP10000（`skill-behaviour.ts`）。
 * `SKILL_POWER`のダメージは`(1000-500)×power`の切り捨て、`HEAL`の`SKILL_POWER`は
 * 回復者の攻撃力×power（防御力を差し引かない、R-HEAL-01 #1）。
 */

const UNIT_DEFINITION_ID = "UNIT_NANAE_SOVEREIGN";
const KOUSEI = "MARKER_NANAE_SOVEREIGN_KOUSEI";

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
 * REMOVE_MARKERが子2つを連動失効させることをこの単位で固定する。
 */
const ONE_EX_KOUSEI_GRANT: readonly PrecedingAction[] = [
  { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_EX_KOUSEI_MARKER", target: "SELF" },
  { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_EX_KOUSEI_IMMUNITY", target: "SELF" },
  { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_EX_KOUSEI_DMG_REDUCE", target: "SELF" },
];

/** PS1/PS3の「自身のHPが50%未満」を作る盤面。 */
const SUBJECT_BELOW_HALF_HP: BoardOverrides = { subject: { state: { currentHp: 4000 } } };

/** PS2の「自身のHPが50%以上・EXゲージ1以上」を作る盤面（既定のHP比率はちょうど50%）。 */
const SUBJECT_WITH_ONE_EX_GAUGE: BoardOverrides = {
  subject: { state: { currentExtraGauge: 1 } },
};

/**
 * PS3の閾値到達を作る一撃。自身(NANAE)の最大HP×20%＝2000ちょうどのダメージを
 * OTHER_ALLYへ与え、`CUMULATIVE_DAMAGE_THRESHOLD`をちょうど跨がせる。
 * 対象タイプ（PHYSICAL/AGILE/ENERGY）は被弾する`ally:front`側のboard設定で作り分ける。
 */
const REVENGE_HIT = realDamage({
  from: "enemy:front",
  to: "ally:front",
  skillType: "AS",
  power: 4,
});

const ALLY_FRONT_PHYSICAL: readonly BoardUnitSpec[] = [
  { id: "ally:front", position: { column: "LEFT", row: "FRONT" }, unitType: "PHYSICAL" },
  { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
];
const ALLY_FRONT_AGILE: readonly BoardUnitSpec[] = [
  { id: "ally:front", position: { column: "LEFT", row: "FRONT" }, unitType: "AGILE" },
  { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
];
const ALLY_FRONT_ENERGY: readonly BoardUnitSpec[] = [
  { id: "ally:front", position: { column: "LEFT", row: "FRONT" }, unitType: "ENERGY" },
  { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
];

/** (SKL_ID, raw原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_EX",
    intent:
      "「攻勢」状態ではない場合、自身にかけられたデバフを全て解除し、自身に「攻勢」を付与する。「攻勢」は自身に向けられるデバフを無効化し、被ダメージを35%減少させる（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NANAE_SOVEREIGN_EX" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_EX_CLEANSE",
          targets: ["ally:subject"],
          // 解除対象のデバフを何も保持していないため不発（SKIPPED）。
          resultKind: "SKIPPED",
        },
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_EX_KOUSEI_MARKER",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_EX_KOUSEI_IMMUNITY",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_EX_KOUSEI_DMG_REDUCE",
          targets: ["ally:subject"],
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: KOUSEI, stackCount: 1 }],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_EX_KOUSEI_IMMUNITY",
          magnitude: 0,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_EX_KOUSEI_DMG_REDUCE",
          magnitude: -0.35,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_EX",
    intent: "(前提付き): 自身にかけられたデバフを保持している場合、それを実際に解除する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NANAE_SOVEREIGN_EX" },
    precedingActions: [
      { effectActionDefinitionId: "ACT_NANAE_COMMANDER_AS2_ATK_DOWN", target: "SELF" },
    ],
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_EX_CLEANSE", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_EX_KOUSEI_MARKER",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_EX_KOUSEI_IMMUNITY",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_EX_KOUSEI_DMG_REDUCE",
          targets: ["ally:subject"],
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: KOUSEI, stackCount: 1 }],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_EX_KOUSEI_IMMUNITY",
          magnitude: 0,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_EX_KOUSEI_DMG_REDUCE",
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
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_EX",
    intent:
      "(分岐): 「攻勢」状態の場合、一時的に自身の攻撃力を25%上昇させて敵全体に威力106で攻撃し、「攻勢」状態を解除する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NANAE_SOVEREIGN_EX" },
    // 実production定義のAPPLY_MARKERを前提として撃つ（`board.subject.markers`の
    // 素のtestMarkerではlinkedEffectGroupId等の実duration定義を持たず、
    // REMOVE_MARKERのカスケード解除を確認できないため）。
    precedingActions: ONE_EX_KOUSEI_GRANT,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_EX_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_EX_DAMAGE", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_EX_REMOVE_KOUSEI",
          targets: ["ally:subject"],
        },
      ],
      // 攻撃力1000×1.25=1250。(1250-500)×1.06=795。
      hpDeltas: { "enemy:front": -795, "enemy:left": -795, "enemy:back": -795 },
      markersRemoved: [{ unitId: "ally:subject", markerId: KOUSEI, stackCount: 1 }],
      // ATK_UPはこの行動の間持続するため（`timeLimit: {unit:ACTION, count:1}`）、
      // 観測時点ではまだ失効していない。
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_EX_ATK_UP",
          magnitude: 0.25,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      effectsRemoved: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_EX_KOUSEI_IMMUNITY",
          magnitude: 0,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_EX_KOUSEI_DMG_REDUCE",
          magnitude: -0.35,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_AS1",
    intent:
      "「攻勢」状態ではない場合、自身が含まれる味方横一列に対し、自身が1回行動を終えるまでの間攻撃力×30%のシールドを付与する。シールドは付与者が倒れると解除される",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NANAE_SOVEREIGN_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_AS1_SHIELD", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_AS1_SHIELD", targets: ["ally:front"] },
      ],
      // 攻撃力1000×0.3=300。
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_AS1_SHIELD",
          magnitude: 300,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_AS1_SHIELD",
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
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_AS1",
    intent: "(分岐): 「攻勢」状態の場合、敵2体に威力127.2で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NANAE_SOVEREIGN_AS1" },
    board: SUBJECT_WITH_KOUSEI,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_AS1_DAMAGE", targets: ["enemy:left"] },
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
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_PS1",
    intent:
      "他の味方が攻撃される前に発動。その行動が終了するまでの間攻撃を自身に引き寄せ、50%をガードし肩代わりする",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NANAE_SOVEREIGN_PS1",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:front", skillType: "AS" }),
    },
    expected: {
      // PS1自身の`PassiveResolved`がPS2の自己参照トリガーを満たし
      // （HP比率50%以上のまま・PS1のPP消費でEXゲージが0→1になり条件成立）、
      // 同じ解決スコープでPS2も連鎖発動する。
      actions: [
        { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_PS1_REDIRECT", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_PS1_COVER", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_PS2_EX_DOWN", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_PS2_HEAL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_PS2_PP_UP", targets: ["ally:subject"] },
      ],
      // 攻撃力1000×0.125=125（PS2のHEAL）。
      hpDeltas: { "ally:subject": 125 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_PS1_REDIRECT",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_PS1_COVER",
          magnitude: 1,
          timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" },
        },
      ],
      // PP: PS1消費(-1)→PS2消費(-1)→PS2の+2加算で4へ戻る（収支0）。
      // EX_GAUGE: PS1のPP消費由来+1→PS2のPP消費由来+1(合計2)→EX_DOWN(-2)で0へ戻る（収支0）。
      // いずれも収支が動かないため`resources`は現れない。
    },
  },
  {
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_PS1",
    intent: "(不成立): 自身のHPが50%未満の場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NANAE_SOVEREIGN_PS1",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:front", skillType: "AS" }),
    },
    board: SUBJECT_BELOW_HALF_HP,
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_PS2",
    intent:
      "パッシブスキルを発動した後に発動。EXゲージを2消費して自身のHPを威力12.5で回復し、さらに自身のPPを2加算する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NANAE_SOVEREIGN_PS2",
      trigger: passiveResolved({
        actor: "ally:subject",
        skillDefinitionId: "SKL_NANAE_SOVEREIGN_PS1",
      }),
    },
    board: SUBJECT_WITH_ONE_EX_GAUGE,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_PS2_EX_DOWN", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_PS2_HEAL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_PS2_PP_UP", targets: ["ally:subject"] },
      ],
      // 攻撃力1000×0.125=125。
      hpDeltas: { "ally:subject": 125 },
      // R-ACT-03のPP消費由来EX獲得(+1)後、盤面の1と合わせて2をEX_DOWN(-2)が
      // ちょうど0まで消費する。PPはコスト消費(-1)と加算(+2、上限4で頭打ち)が
      // 相殺し収支が動かない。
      resources: [{ unitId: "ally:subject", resource: "EX_GAUGE", delta: -1 }],
    },
  },
  {
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_PS2",
    intent: "(不成立): 自身のHPが50%未満の場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NANAE_SOVEREIGN_PS2",
      trigger: passiveResolved({
        actor: "ally:subject",
        skillDefinitionId: "SKL_NANAE_SOVEREIGN_PS1",
      }),
    },
    board: { subject: { state: { currentHp: 4000, currentExtraGauge: 1 } } },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_PS2",
    intent: "(不成立): 自身のEXゲージが0の場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NANAE_SOVEREIGN_PS2",
      trigger: passiveResolved({
        actor: "ally:subject",
        skillDefinitionId: "SKL_NANAE_SOVEREIGN_PS1",
      }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_PS3",
    intent:
      "他の味方が累計で最大HP×20%のダメージを受けるたびに発動。攻撃を受けた味方単体のタイプが物理の場合、自身に被ダメージを5%減少させる効果を付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NANAE_SOVEREIGN_PS3",
      trigger: REVENGE_HIT,
    },
    board: { ...SUBJECT_BELOW_HALF_HP, allies: ALLY_FRONT_PHYSICAL },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_PS3_PHYSICAL_DMG_DOWN",
          targets: ["ally:subject"],
        },
      ],
      // 契機の被弾(1000-500)×4=2000（最大HP10000×20%=2000ちょうどで閾値を跨ぐ）は
      // 基準線へ繰り込み済みのためhpDeltasには現れない。
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_PS3_PHYSICAL_DMG_DOWN",
          magnitude: -0.05,
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
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_PS3",
    intent: "(分岐): タイプが敏捷の場合、自身の会心率を2.5%上昇させる（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NANAE_SOVEREIGN_PS3",
      trigger: REVENGE_HIT,
    },
    board: { ...SUBJECT_BELOW_HALF_HP, allies: ALLY_FRONT_AGILE },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_PS3_AGILE_CRIT_UP",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_PS3_AGILE_CRIT_UP",
          magnitude: 0.025,
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
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_PS3",
    intent: "(分岐): タイプがENの場合、威力40で回復する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NANAE_SOVEREIGN_PS3",
      trigger: REVENGE_HIT,
    },
    board: { ...SUBJECT_BELOW_HALF_HP, allies: ALLY_FRONT_ENERGY },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_NANAE_SOVEREIGN_PS3_EN_HEAL", targets: ["ally:subject"] },
      ],
      // 攻撃力1000×0.4=400。
      hpDeltas: { "ally:subject": 400 },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NANAE_SOVEREIGN_PS3",
    intent: "(不成立): 自身のHPが50%以上の場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NANAE_SOVEREIGN_PS3",
      trigger: REVENGE_HIT,
    },
    board: { allies: ALLY_FRONT_PHYSICAL },
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_NANAE_SOVEREIGN (【穹を統べる虹色の号令】鳴滝七彩)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-NANAE-SOVEREIGN-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-NANAE-SOVEREIGN-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-NANAE-SOVEREIGN-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-NANAE-SOVEREIGN-004: PS2's self-referencing PassiveResolved trigger activates exactly once when the EX_GAUGE gate has exactly 1 to spend, instead of chaining indefinitely", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, SUBJECT_WITH_ONE_EX_GAUGE);
    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: "ally:subject",
      battleId: "B_NANAE_SOVEREIGN_PS2_GATE",
    });
    chain.fire(
      passiveResolved({ actor: "ally:subject", skillDefinitionId: "SKL_NANAE_SOVEREIGN_PS1" }),
      board.units,
    );
    const activations = chain
      .eventsOfType("PassiveActivated")
      .filter((event) => event.payload.skillDefinitionId === "SKL_NANAE_SOVEREIGN_PS2");
    expect(activations).toHaveLength(1);
  });
});
