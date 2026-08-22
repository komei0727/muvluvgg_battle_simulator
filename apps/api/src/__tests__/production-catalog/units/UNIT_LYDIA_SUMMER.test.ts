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
import { observeActivationCounters } from "../../../testing/production-unit/runtime-counter.js";
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  resetExecutedActionIds,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { effectApplied, turnStarted } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_LYDIA_SUMMER`（【おたすけさんぽ・イン・サマー】リディア・エルドリッジ）の
 * ユニット単位production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_LYDIA_SUMMER";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** PS2は戦闘中1度しか発動しない。発動済みcounterを1に置いて不成立側を作る。 */
const PS2_ALREADY_ACTIVATED = {
  subject: {
    state: {
      skillCounters: {
        [createSkillDefinitionId("SKL_LYDIA_SUMMER_PS2")]: {
          [createRuntimeCounterId("SKL_LYDIA_SUMMER_PS2_ACTIVATIONS")]: { value: 1, carry: 0 },
        },
      },
    },
  },
};

/** AS1の「最も最大HPが高い敵単体」を敵前列中央へ固定し、隣接2体（左・後列）を作る盤面。 */
const HIGHEST_HP_AT_FRONT_CENTER = {
  enemies: [
    {
      id: "enemy:front",
      position: { column: "CENTER", row: "FRONT" } as const,
      combatStats: { maximumHp: 20000 },
    },
    { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } as const },
    { id: "enemy:back", position: { column: "CENTER", row: "BACK" } as const },
  ],
};

/** 基準（最も最大HPが高い敵）自身が後列にいる盤面。隣接は前列中央1体だけになる。 */
const HIGHEST_HP_IN_BACK_ROW = {
  enemies: [
    {
      id: "enemy:back",
      position: { column: "CENTER", row: "BACK" } as const,
      combatStats: { maximumHp: 20000 },
    },
    { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } as const },
  ],
};

/** AS2の「後列中央」が存在しない盤面（前列2体だけ）。 */
const NO_BACK_CENTER = {
  enemies: [
    { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } as const },
    { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } as const },
  ],
};

/** AS2の攻撃1発だけを敵単体へ通し、サブユニットの追加ダメージ／デバフを相乗りさせる盤面。 */
const SINGLE_BACK_CENTER_ENEMY = {
  enemies: [{ id: "enemy:back", position: { column: "CENTER", row: "BACK" } as const }],
};

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_LYDIA_SUMMER_EX",
    intent:
      "自身に対しサブユニット「うみのともだちⅡ」を３つ付与する。「うみのともだちⅡ」は自身の最大HP×50%のHPを持ち、攻撃時に攻撃力×25%のダメージを追加するが、同時に付与された対象の攻撃力を7.5%低下させる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LYDIA_SUMMER_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LYDIA_SUMMER_EX_SUBUNIT", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LYDIA_SUMMER_EX_SUBUNIT", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LYDIA_SUMMER_EX_SUBUNIT", targets: ["ally:subject"] },
      ],
      // 最大HP10000×50%＝5000。
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LYDIA_SUMMER_EX_SUBUNIT",
          magnitude: 5000,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LYDIA_SUMMER_EX_SUBUNIT",
          magnitude: 5000,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LYDIA_SUMMER_EX_SUBUNIT",
          magnitude: 5000,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LYDIA_SUMMER_AS1",
    intent:
      "最も最大HPが高い敵単体、および対象に隣接する2体に対し、威力84.8で攻撃する（回避不可）。攻撃対象が後列に編成されていた場合、追加で対象の現在HP×7.5%のダメージを与える。追加ダメージは自身の攻撃力×15%を上限とする",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LYDIA_SUMMER_AS1" },
    board: HIGHEST_HP_AT_FRONT_CENTER,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LYDIA_SUMMER_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LYDIA_SUMMER_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_LYDIA_SUMMER_AS1_DAMAGE", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_LYDIA_SUMMER_AS1_BACKROW_BONUS",
          targets: ["enemy:back"],
        },
      ],
      // 基準・隣接2体とも424（(1000-500)×84.8%）。後列のenemy:backだけ追加で
      // MIN(現在HP5000×7.5%=375, 攻撃力1000×15%=150)=150を上乗せされる。
      hpDeltas: {
        "enemy:front": -424,
        "enemy:left": -424,
        "enemy:back": -424 - 150,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LYDIA_SUMMER_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LYDIA_SUMMER_AS1",
    intent: "同上: 基準（最も最大HPが高い敵）自身が後列にいた場合もその基準へ追加ダメージが乗る",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LYDIA_SUMMER_AS1" },
    board: HIGHEST_HP_IN_BACK_ROW,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LYDIA_SUMMER_AS1_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_LYDIA_SUMMER_AS1_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_LYDIA_SUMMER_AS1_BACKROW_BONUS",
          targets: ["enemy:back"],
        },
      ],
      hpDeltas: {
        "enemy:back": -424 - 150,
        "enemy:front": -424,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LYDIA_SUMMER_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LYDIA_SUMMER_AS2",
    intent: "後列中央の敵単体に威力169.6、その他の全ての敵に威力15.6で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LYDIA_SUMMER_AS2" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_LYDIA_SUMMER_AS2_DAMAGE_CENTER",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_LYDIA_SUMMER_AS2_DAMAGE_OTHERS",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_LYDIA_SUMMER_AS2_DAMAGE_OTHERS",
          targets: ["enemy:left"],
        },
      ],
      // 後列中央848（(1000-500)×169.6%）、その他78（×15.6%）。
      hpDeltas: { "enemy:back": -848, "enemy:front": -78, "enemy:left": -78 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LYDIA_SUMMER_AS2",
    intent: "同上: 後列中央が空でも残りの敵全体への攻撃は成立する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LYDIA_SUMMER_AS2" },
    board: NO_BACK_CENTER,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_LYDIA_SUMMER_AS2_DAMAGE_OTHERS",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_LYDIA_SUMMER_AS2_DAMAGE_OTHERS",
          targets: ["enemy:left"],
        },
      ],
      hpDeltas: { "enemy:front": -78, "enemy:left": -78 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LYDIA_SUMMER_AS2",
    intent:
      "（「うみのともだちⅡ」保持下）攻撃時に自身の攻撃力×25%のダメージを追加し、対象の攻撃力を7.5%低下させる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LYDIA_SUMMER_AS2" },
    board: SINGLE_BACK_CENTER_ENEMY,
    precedingActions: [{ effectActionDefinitionId: "ACT_LYDIA_SUMMER_EX_SUBUNIT", target: "SELF" }],
    expected: {
      // 追加ダメージとデバフはEffectAction群の解決器ではなくサブユニットの付与
      // フックから直接適用されるため、実行済みEffectActionの列には現れない
      // （SHIRANA_SORAの子機Ⅰと同じ規約）。
      actions: [
        { effectActionDefinitionId: "ACT_LYDIA_SUMMER_AS2_DAMAGE_CENTER", targets: ["enemy:back"] },
      ],
      // 通常攻撃848に、保持者の攻撃力1000＋付与時攻撃力1000×25%－対象防御力500＝750が乗る。
      hpDeltas: { "enemy:back": -(848 + 750) },
      effectsApplied: [
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_LYDIA_SUMMER_SUBUNIT_ATK_DOWN_L",
          magnitude: -0.075,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LYDIA_SUMMER_AS2",
    intent:
      "（「うみのともだちⅢ」保持下）攻撃時に自身の攻撃力×8.5%のダメージを追加し、対象の攻撃力を2.5%低下させる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LYDIA_SUMMER_AS2" },
    board: SINGLE_BACK_CENTER_ENEMY,
    precedingActions: [
      { effectActionDefinitionId: "ACT_LYDIA_SUMMER_PS2_SUBUNIT", target: "SELF" },
    ],
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LYDIA_SUMMER_AS2_DAMAGE_CENTER", targets: ["enemy:back"] },
      ],
      // 通常攻撃848に、保持者の攻撃力1000＋付与時攻撃力1000×8.5%－対象防御力500＝585が乗る。
      hpDeltas: { "enemy:back": -(848 + 585) },
      effectsApplied: [
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_LYDIA_SUMMER_SUBUNIT_ATK_DOWN_S",
          magnitude: -0.025,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LYDIA_SUMMER_PS1",
    intent:
      "自身に敵からデバフが付与された際に発動。付与されているデバフを1つ解除し、自身にサブユニット「うみのともだちⅠ」を1つ付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LYDIA_SUMMER_PS1",
      trigger: effectApplied({
        source: "enemy:front",
        target: "ally:subject",
        effectKind: "APPLY_STAT_MOD",
        categories: ["DEBUFF"],
      }),
      triggeredBy: "ally:subject",
    },
    precedingActions: [
      { effectActionDefinitionId: "ACT_LYDIA_SUMMER_SUBUNIT_ATK_DOWN_L", target: "SELF" },
    ],
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_LYDIA_SUMMER_PS1_REMOVE_DEBUFF",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_LYDIA_SUMMER_PS1_SUBUNIT", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LYDIA_SUMMER_PS1_SUBUNIT",
          magnitude: 5000,
        },
      ],
      effectsRemoved: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LYDIA_SUMMER_SUBUNIT_ATK_DOWN_L",
          magnitude: -0.075,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LYDIA_SUMMER_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LYDIA_SUMMER_PS1",
    intent: "(不成立): 敵からバフ（デバフ以外）が付与されても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LYDIA_SUMMER_PS1",
      trigger: effectApplied({
        source: "enemy:front",
        target: "ally:subject",
        effectKind: "APPLY_STAT_MOD",
        categories: ["BUFF"],
      }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_LYDIA_SUMMER_PS1",
    intent: "(不成立): 味方からデバフが付与されても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LYDIA_SUMMER_PS1",
      trigger: effectApplied({
        source: "ally:front",
        target: "ally:subject",
        effectKind: "APPLY_STAT_MOD",
        categories: ["DEBUFF"],
      }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_LYDIA_SUMMER_PS1",
    intent: "(不成立): このスキルは戦闘開始時には発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LYDIA_SUMMER_PS1",
      trigger: effectApplied({
        source: "enemy:front",
        target: "ally:subject",
        effectKind: "APPLY_STAT_MOD",
        categories: ["DEBUFF"],
      }),
      resolutionPhase: "BATTLE_START",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_LYDIA_SUMMER_PS1",
    intent: "(不成立): このスキルはターン開始時には発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LYDIA_SUMMER_PS1",
      trigger: effectApplied({
        source: "enemy:front",
        target: "ally:subject",
        effectKind: "APPLY_STAT_MOD",
        categories: ["DEBUFF"],
      }),
      resolutionPhase: "TURN_START",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_LYDIA_SUMMER_PS1",
    intent: "(不成立): このスキルはターン終了時には発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LYDIA_SUMMER_PS1",
      trigger: effectApplied({
        source: "enemy:front",
        target: "ally:subject",
        effectKind: "APPLY_STAT_MOD",
        categories: ["DEBUFF"],
      }),
      resolutionPhase: "TURN_END",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_LYDIA_SUMMER_PS2",
    intent:
      "ターン開始時に発動。自身および自身と同じ横一列にいる他の味方にサブユニット「うみのともだちⅢ」を1つ付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LYDIA_SUMMER_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      // 既定盤面: 自身(CENTER,FRONT)と同じ横一列(FRONT)はally:front(LEFT,FRONT)だけ。
      actions: [
        { effectActionDefinitionId: "ACT_LYDIA_SUMMER_PS2_SUBUNIT", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LYDIA_SUMMER_PS2_SUBUNIT", targets: ["ally:front"] },
      ],
      // 最大HP10000×15%＝1500。
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LYDIA_SUMMER_PS2_SUBUNIT",
          magnitude: 1500,
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_LYDIA_SUMMER_PS2_SUBUNIT",
          magnitude: 1500,
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LYDIA_SUMMER_PS2",
    intent: "(不成立): このスキルは戦闘中に一度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LYDIA_SUMMER_PS2",
      trigger: turnStarted({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    board: PS2_ALREADY_ACTIVATED,
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_LYDIA_SUMMER (【おたすけさんぽ・イン・サマー】リディア・エルドリッジ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-LYDIA-SUMMER-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-LYDIA-SUMMER-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-LYDIA-SUMMER-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-LYDIA-SUMMER-004 (R-EFF-11): PS2 が宣言する発動回数counterは、自分自身の PassiveActivated でだけ増える。このユニットのものではないPSの発動では動かない", () => {
    expect(observeActivationCounters(snapshot, UNIT_DEFINITION_ID)).toEqual({
      declarations: [
        {
          skillDefinitionId: "SKL_LYDIA_SUMMER_PS2",
          counter: "SKL_LYDIA_SUMMER_PS2_ACTIVATIONS",
          scope: "SKILL_RUNTIME",
          amount: 1,
        },
      ],
      changesByActivatedSkill: {
        SKL_LYDIA_SUMMER_PS2: [
          {
            skillDefinitionId: "SKL_LYDIA_SUMMER_PS2",
            counter: "SKL_LYDIA_SUMMER_PS2_ACTIVATIONS",
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
