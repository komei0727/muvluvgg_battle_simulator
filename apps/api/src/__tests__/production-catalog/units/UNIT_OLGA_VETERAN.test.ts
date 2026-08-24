import { describe, expect, it } from "vitest";
import { shieldPoolsOf } from "../../../domain/battle/combat/shield-policy.js";
import { subUnitDurabilityTotal } from "../../../domain/battle/combat/sub-unit-policy.js";
import type { BattleDomainEvent } from "../../../domain/battle/events/domain-event.js";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import { removalDeclarationOf } from "../../../testing/production-unit/removal-declaration.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import {
  observeDamageProbe,
  observeLifecycleDamageProbe,
} from "../../../testing/production-unit/damage-probe.js";
import { observeEffectExpiry } from "../../../testing/production-unit/effect-expiry.js";
import { observeActivationCounters } from "../../../testing/production-unit/runtime-counter.js";
import {
  PRODUCTION_CATALOG_DIR,
  applyPrecedingActions,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardUnitSpec,
  type PrecedingAction,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { skillUseCompleted, turnStarted } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_OLGA_VETERAN`(【歴戦の鉄母】オルガ・ヴォルコワ)のユニット単位production
 * 結合テスト(`12_テスト戦略.md`「ユニット効果軸」)。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_OLGA_VETERAN";

/**
 * オルガ自身はシールドを配らないため、PS1の解除が宣言する2カテゴリのうち
 * `SHIELD` 側は自前の定義では前提を作れない。実 production のシールドを1件だけ
 * 併せて読み込む。
 */
const SHIELD_ACTION_ID = "ACT_MEIYA_FATED_PS1_SHIELD";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  "UNIT_MEIYA_FATED",
]);

const VIGILANCE = "MARKER_OLGA_VETERAN_VIGILANCE";

/** 自身を後列へ置き、味方前列を ally:front 1体だけにした盤面。AS1の後列分岐用。 */
const SUBJECT_IN_BACK_ROW = {
  subject: { position: { column: "CENTER", row: "BACK" } as const },
  allies: [
    { id: "ally:front", position: { column: "LEFT", row: "FRONT" } },
    { id: "ally:back", position: { column: "RIGHT", row: "BACK" } },
  ] as readonly BoardUnitSpec[],
};

/** PS1は「アクティブスキル4回目の使用」でだけ発動する。counterを3に置いて次を4回目にする。 */
const PS1_COUNTER_AT_THREE = {
  subject: {
    state: {
      skillCounters: {
        [createSkillDefinitionId("SKL_OLGA_VETERAN_PS1")]: {
          [createRuntimeCounterId("SKL_OLGA_VETERAN_PS1_TRIGGER_COUNT")]: { value: 3, carry: 0 },
        },
      },
    },
  },
};

/** PS2は戦闘中1度しか発動しない。発動済みcounterを1に置いて不成立側を作る。 */
const PS2_ALREADY_ACTIVATED = {
  subject: {
    state: {
      skillCounters: {
        [createSkillDefinitionId("SKL_OLGA_VETERAN_PS2")]: {
          [createRuntimeCounterId("SKL_OLGA_VETERAN_PS2_ACTIVATIONS")]: { value: 1, carry: 0 },
        },
      },
    },
  },
};

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_OLGA_VETERAN_EX",
    intent:
      "敵全体に1行動の混乱を付与する。混乱はアクティブスキルで攻撃する際、本来の対象の逆陣営に攻撃を行う。この際のダメージは30%減少する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_OLGA_VETERAN_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_EX_CONFUSION", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_EX_CONFUSION", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_EX_CONFUSION", targets: ["enemy:back"] },
      ],
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_EX_CONFUSION",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "CONFUSION",
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_EX_CONFUSION",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "CONFUSION",
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_EX_CONFUSION",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "CONFUSION",
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_OLGA_VETERAN_AS1",
    intent: "敵横一列に威力171.6でEN攻撃する。さらに与えた全ダメージの12.5%分自身のHPを回復する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_OLGA_VETERAN_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS1_HEAL", targets: ["ally:subject"] },
      ],
      // 1体858（威力171.6%）×2体の合計1716の12.5%＝214（切り捨て）。
      hpDeltas: { "enemy:front": -858, "enemy:left": -858, "ally:subject": 214 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_OLGA_VETERAN_AS1", remaining: 3 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_OLGA_VETERAN_AS1",
    intent:
      "自身が後列にいた場合味方前列にも威力25でEN攻撃するが、同時に対象のEXゲージを1追加し、1行動の間与ダメージを15%増加させる(重複可)",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_OLGA_VETERAN_AS1" },
    board: SUBJECT_IN_BACK_ROW,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS1_ALLY_DAMAGE", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS1_ALLY_EX_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS1_ALLY_DMG_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS1_HEAL", targets: ["ally:subject"] },
      ],
      // 回復は味方前列へ与えた125も含めた総ダメージ1841の12.5%＝230（切り捨て）。
      hpDeltas: {
        "enemy:front": -858,
        "enemy:left": -858,
        "ally:front": -125,
        "ally:subject": 230,
      },
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_AS1_ALLY_DMG_UP",
          magnitude: 0.15,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "ally:front", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_OLGA_VETERAN_AS1", remaining: 3 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_OLGA_VETERAN_AS2",
    intent:
      "敵単体に威力212でEN攻撃し、与えたダメージの17.5%分自身のHPを回復する。さらに対象に対し2行動の「警戒」を付与し、自身に対し2行動の間「警戒」を所持している敵から受ける攻撃の被ダメージを35%減少させる効果を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_OLGA_VETERAN_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS2_HEAL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS2_MARKER", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS2_DMG_DOWN", targets: ["ally:subject"] },
      ],
      // 1060（威力212%）の17.5%＝185（切り捨て）。
      hpDeltas: { "enemy:front": -1060, "ally:subject": 185 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_AS2_DMG_DOWN",
          magnitude: -0.35,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      markers: [{ unitId: "enemy:front", markerId: VIGILANCE, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_OLGA_VETERAN_PS1",
    intent:
      "自身がアクティブスキルを4回使用するたびに発動。自身に付与されているシールドとサブユニットをすべて解除し、自身の攻撃力をこのスキル中のみ30%上昇させて(重複可)、2行動の間、自身の最大HP×15%のHPを持ち、攻撃時に攻撃力×10.6%のENダメージを追加するサブユニット「カムラッドⅡ」を3つ付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_OLGA_VETERAN_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_OLGA_VETERAN_AS2",
      }),
      triggeredBy: "ally:subject",
    },
    board: PS1_COUNTER_AT_THREE,
    // 解除対象のサブユニットを実 production 定義（PS2が配るカムラッドⅠ）で用意する。
    precedingActions: [
      { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_SUBUNIT", target: "SELF" },
    ],
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_REMOVE_SHIELD_SUBUNIT",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_SUBUNIT", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_SUBUNIT", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_SUBUNIT", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_ATK_UP",
          magnitude: 0.3,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_SUBUNIT",
          magnitude: 1500,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_SUBUNIT",
          magnitude: 1500,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_SUBUNIT",
          magnitude: 1500,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      effectsRemoved: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_SUBUNIT",
          magnitude: 1500,
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_OLGA_VETERAN_PS1",
    intent: "(不成立): 1〜3回目の使用では発動しない(「4回使用するたび」に限る)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_OLGA_VETERAN_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_OLGA_VETERAN_AS2",
      }),
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_OLGA_VETERAN_PS2",
    intent:
      "ターン開始時に発動。自身の現在HPの60%を消費して、自身の最大HP×15%のHPを持ち、攻撃時に攻撃力×5.46%のENダメージを追加するサブユニット「カムラッドⅠ」を3つ付与する。さらに自身に対し、致死ダメージを1度だけ耐えてHPを最大HP×50%回復するバフを付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_OLGA_VETERAN_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_HP_COST", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_SUBUNIT", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_SUBUNIT", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_SUBUNIT", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_DEATH_SURVIVAL",
          targets: ["ally:subject"],
        },
      ],
      // 現在HP5000の60%を消費。
      hpDeltas: { "ally:subject": -3000 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_SUBUNIT",
          magnitude: 1500,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_SUBUNIT",
          magnitude: 1500,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_SUBUNIT",
          magnitude: 1500,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_DEATH_SURVIVAL",
          // 耐えた後のHPと回復量は消費時に評価するため、付与時点の効果量は持たない。
          magnitude: 0,
          timeLimit: { unit: "BATTLE", count: 1 },
          consumption: { kind: "LETHAL_DAMAGE", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_OLGA_VETERAN_PS2", remaining: 99 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_OLGA_VETERAN_PS2",
    intent: "(不成立): このスキルは戦闘中に1度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_OLGA_VETERAN_PS2",
      trigger: turnStarted({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    board: PS2_ALREADY_ACTIVATED,
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_OLGA_VETERAN (【歴戦の鉄母】オルガ・ヴォルコワ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-OLGA-VETERAN-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-OLGA-VETERAN-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-OLGA-VETERAN-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-OLGA-VETERAN-004 (R-EFF-11): PS2 が宣言する発動回数counterは、自分自身の PassiveActivated でだけ増える。このユニットのものではないPSの発動では動かない", () => {
    // counterの増減は `-001` の振る舞い表の観測に載らない（表はスキル使用1回が
    // 起こしたことを見るもので、`RuntimeCounterChanged` は契機イベントから
    // `detectRuntimeCounterUpdates` が独立に起こす）。宣言は実 `catalog/` の
    // ユニット定義から導くため、counterを持つPSが増えれば行が増えて落ちる。
    expect(observeActivationCounters(snapshot, UNIT_DEFINITION_ID)).toEqual({
      declarations: [
        {
          skillDefinitionId: "SKL_OLGA_VETERAN_PS2",
          counter: "SKL_OLGA_VETERAN_PS2_ACTIVATIONS",
          scope: "SKILL_RUNTIME",
          amount: 1,
        },
      ],
      changesByActivatedSkill: {
        SKL_OLGA_VETERAN_PS2: [
          {
            skillDefinitionId: "SKL_OLGA_VETERAN_PS2",
            counter: "SKL_OLGA_VETERAN_PS2_ACTIVATIONS",
            before: 0,
            after: 1,
            valueChanged: true,
          },
        ],
      },
      changesOnUnrelatedSkill: [],
    });
  });

  it("IT-UNIT-OLGA-VETERAN-005 [R-CFS-01, R-CFS-02] (R-CFS-01/R-CFS-02, BOUNDARY): EXが配る混乱は、保持者がアクティブスキルで攻撃する行動でTargetSelectorの陣営を反転させ、そのダメージを30%減らす。攻撃力が実効防御力以下の相手には攻撃力×10%へ差し替わる", () => {
    // 付与とその効果が働く攻撃は別のスキル使用であり、`-001` のEX行は付与しか
    // 表せない。混乱を保持したユニットが実際に攻撃する場面は、そのユニットの
    // スキル構成に依存するため、混乱を配る当のオルガ自身へ実定義で付けて観測する。
    const CONFUSED: readonly PrecedingAction[] = [
      { effectActionDefinitionId: "ACT_OLGA_VETERAN_EX_CONFUSION", target: "SELF" },
    ];

    // R-CFS-01: `DAMAGE` が対象に取るbindingが `BINDING_DERIVED` の場合、その
    // `base` binding も再帰的に反転する。AS1の「敵横一列」は基準（`TGT_BASE`）から
    // 導く `SAME_ROW_AS_BASE` であり、基準を敵陣営に残すと `area` が基準と同じ陣営
    // だけを採るため候補が0件になり、混乱中のAS1が一切ダメージを与えなくなる。
    expect(
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use: { kind: "ACTIVE", skillDefinitionId: "SKL_OLGA_VETERAN_AS1" },
        precedingActions: CONFUSED,
      }),
    ).toEqual({
      actions: [
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS1_DAMAGE", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS1_DAMAGE", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS1_HEAL", targets: ["ally:subject"] },
      ],
      // 基準は反転後の陣営から選び直されて距離0の自身になり、その横一列（自身と
      // ally:front）へ入る。通常の858（威力171.6%）に混乱倍率0.7が掛かって600、
      // 自身は与えた合計1200の12.5%＝150を同じ行動の中で回復して差し引き-450。
      hpDeltas: { "ally:subject": -450, "ally:front": -600 },
      effectsRemoved: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_EX_CONFUSION",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "CONFUSION",
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_OLGA_VETERAN_AS1", remaining: 3 },
      ],
    });

    // 単独の `SELECT` binding でも同じ反転が働く。AS2の「敵単体」が自陣営の1体に
    // なり、R-TGT-02のデフォルト順（使用者からのマンハッタン距離が昇順）で距離0の
    // 使用者自身が選ばれる。同じbindingを見る「警戒」の付与も反転後の対象へ行く。
    expect(
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use: { kind: "ACTIVE", skillDefinitionId: "SKL_OLGA_VETERAN_AS2" },
        precedingActions: CONFUSED,
      }),
    ).toEqual({
      actions: [
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS2_DAMAGE", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS2_HEAL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS2_MARKER", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS2_DMG_DOWN", targets: ["ally:subject"] },
      ],
      // 通常の1060（威力212%）に混乱倍率0.7が掛かって742。自傷の17.5%＝129を
      // 同じ行動の中で回復するため差し引き-613になる。
      hpDeltas: { "ally:subject": -613 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_AS2_DMG_DOWN",
          magnitude: -0.35,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      // 1行動の混乱はこの攻撃で消費されて失効する。
      effectsRemoved: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_EX_CONFUSION",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "CONFUSION",
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: VIGILANCE, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    });

    // R-CFS-02の境界は対象選択とは独立に効く。実効防御力を攻撃力と同値に置いた
    // 相手を1体だけ混ぜ、同じ1回の付与から2発撃ち分ける。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, {
      enemies: [
        { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
        {
          id: "enemy:left",
          position: { column: "LEFT", row: "FRONT" },
          combatStats: { defense: 1000 },
        },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    });
    const confused = applyPrecedingActions(board, CONFUSED);
    const against = (targetUnitId: string) =>
      observeDamageProbe({
        units: confused,
        attackerUnitId: "ally:subject",
        targetUnitId,
        battleId: `B_OLGA_CONFUSION_${targetUnitId}`,
      });

    // 防御力500: 差分500がそのまま基礎ダメージ。混乱倍率0.7で350。
    expect(against("enemy:front").confusionDamageMultiplier).toBe(0.7);
    expect(against("enemy:front").calculated.finalDamage).toBe(350);
    // 防御力1000 = 攻撃力1000（R-CFS-02は「以下」で差し替える）: 基礎ダメージは
    // 攻撃力×10%＝100へ差し替わり、混乱倍率0.7で70。差し替えが無ければ差分0 →
    // R-DMG-02の最低1ダメージになる。
    expect(against("enemy:left").calculated.finalDamage).toBe(70);
  });

  it("IT-UNIT-OLGA-VETERAN-006 [R-EFF-02] (R-EFF-02): PS1の解除は `SHIELD` と `SUBUNIT` の2カテゴリを取り、同じstepで付与される「カムラッドⅡ」3体より前に走る", () => {
    // `-001` のPS1行は前提にサブユニット1体しか置かないため、宣言の2カテゴリのうち
    // `SHIELD` 側が働いているかは現れない。シールドと旧サブユニット2体を実 production
    // 定義で積み、解除が両方を空にしたうえで新しい3体だけが残ることを固定する
    // （解除が付与より後ろに置かれていれば、その3体が自分の解除に巻き込まれる）。
    // 「すべて」は上限の**不在**であり、実行結果からは「上限がたまたま投入件数と
    // 同じ」と区別できない。宣言そのものを固定して、`maxRemovals` の混入を落とす。
    expect(removalDeclarationOf(snapshot, "ACT_OLGA_VETERAN_PS1_REMOVE_SHIELD_SUBUNIT")).toEqual({
      categories: ["SHIELD", "SUBUNIT"],
      maxRemovals: null,
    });

    const shieldAndSubUnits: readonly PrecedingAction[] = [
      { effectActionDefinitionId: SHIELD_ACTION_ID, target: "SELF" },
      { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_SUBUNIT", target: "SELF" },
      { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_SUBUNIT", target: "SELF" },
    ];
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, PS1_COUNTER_AT_THREE);
    const held = applyPrecedingActions(board, shieldAndSubUnits).find(
      (unit) => unit.battleUnitId === "ally:subject",
    )!;
    expect(shieldPoolsOf(held.appliedEffects)).toEqual({
      physical: 0,
      energy: 0,
      untyped: 550,
    });
    expect(subUnitDurabilityTotal(held.appliedEffects)).toBe(3000);

    const grantedSubUnit = {
      unitId: "ally:subject",
      effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_SUBUNIT",
      magnitude: 1500,
      timeLimit: { unit: "ACTION", count: 2 },
    };
    const removedSubUnit = {
      unitId: "ally:subject",
      effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_SUBUNIT",
      magnitude: 1500,
    };

    expect(
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use: {
          kind: "PASSIVE",
          skillDefinitionId: "SKL_OLGA_VETERAN_PS1",
          trigger: skillUseCompleted({
            actor: "ally:subject",
            targets: ["enemy:front"],
            skillType: "AS",
            skillDefinitionId: "SKL_OLGA_VETERAN_AS2",
          }),
          triggeredBy: "ally:subject",
        },
        board: PS1_COUNTER_AT_THREE,
        precedingActions: shieldAndSubUnits,
      }),
    ).toEqual({
      actions: [
        {
          effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_REMOVE_SHIELD_SUBUNIT",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_SUBUNIT", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_SUBUNIT", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_SUBUNIT", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_ATK_UP",
          magnitude: 0.3,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        grantedSubUnit,
        grantedSubUnit,
        grantedSubUnit,
      ],
      effectsRemoved: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: SHIELD_ACTION_ID,
          magnitude: 550,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        removedSubUnit,
        removedSubUnit,
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
    });
  });

  it("IT-UNIT-OLGA-VETERAN-007 [R-SUB-01, R-SUB-02] (R-SUB-01/R-SUB-02): 「3つ付与する」カムラッドⅠは**以後の自分の攻撃**へ3ヒットぶんの追加ENダメージを足し、存続期間を書かないため行動終了を跨いでも失効しない。2行動のカムラッドⅡだけが2回目の行動終了で揃って失効する", () => {
    // `-001` のPS1／PS2行は付与そのもの（耐久力1500の3件と、カムラッドⅡだけが持つ
    // 2行動）までを固定する。ここが引き受けるのは (a) 保持数だけ追加ヒットが増える
    // こと（R-SUB-02第2項）と (b) 存続期間を持たないインスタンスが行動終了で減らない
    // ことで、どちらも別の行動を跨がないと現れない。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const camrad1 = (count: number): readonly PrecedingAction[] =>
      Array.from({ length: count }, () => ({
        effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_SUBUNIT",
        target: "SELF" as const,
      }));
    const strike = (precedingActions: readonly PrecedingAction[], battleId: string) =>
      observeLifecycleDamageProbe({
        definitions: board.definitions,
        units: applyPrecedingActions(board, precedingActions),
        attackerUnitId: "ally:subject",
        targetUnitId: "enemy:front",
        power: 1,
        battleId,
      });
    const damageTypes = (recorder: { getEvents: () => readonly BattleDomainEvent[] }) =>
      recorder
        .getEvents()
        .filter(
          (event): event is Extract<BattleDomainEvent, { eventType: "DamageCalculated" }> =>
            event.eventType === "DamageCalculated",
        )
        .map((event) => ({
          effectActionDefinitionId: String(event.payload.effectActionDefinitionId),
          damageType: event.payload.damageType,
          finalDamage: event.payload.finalDamage,
        }));

    // 追加ダメージ = 所持者の攻撃力1000 + 付与者の付与時攻撃力1000 × 5.46%
    //              - 対象の防御力500 = 554.6 → 切り捨てて554（R-DMG-02）。
    const additional = {
      effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_SUBUNIT",
      damageType: "EN",
      finalDamage: 554,
    };
    // 契機の一撃（攻撃力1000 - 防御力500 = 500）だけの対照。
    expect(damageTypes(strike([], "B_OLGA_SUBUNIT_NONE").recorder)).toEqual([
      {
        effectActionDefinitionId: "ACT_TEST_DAMAGE_PROBE",
        damageType: "PHYSICAL",
        finalDamage: 500,
      },
    ]);
    const armed = strike(camrad1(3), "B_OLGA_SUBUNIT_THREE");
    expect(damageTypes(armed.recorder)).toEqual([
      {
        effectActionDefinitionId: "ACT_TEST_DAMAGE_PROBE",
        damageType: "PHYSICAL",
        finalDamage: 500,
      },
      additional,
      additional,
      additional,
    ]);
    expect(armed.hpDeltas).toEqual({ "enemy:front": -(500 + 554 * 3) });

    // 期間を書くカムラッドⅡ3件と、書かないカムラッドⅠ3件を同じ保持者へ並べる。
    const both = applyPrecedingActions(board, [
      ...camrad1(3),
      ...Array.from({ length: 3 }, () => ({
        effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_SUBUNIT",
        target: "SELF" as const,
      })),
    ]);
    const expired = {
      unitId: "ally:subject",
      effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_SUBUNIT",
      reason: "TIME_LIMIT",
      cascaded: false,
    };
    const observed = observeEffectExpiry({
      units: both,
      definitions: board.definitions,
      steps: [
        { kind: "ACTION_END", actor: "ally:subject" },
        { kind: "ACTION_END", actor: "ally:subject" },
      ],
      battleId: "B_OLGA_SUBUNIT_EXPIRY",
    });
    // 存続期間を持たないカムラッドⅠは `remaining` にキーごと現れない。
    expect(observed.steps).toEqual([
      {
        step: "ACTION_END(ally:subject)",
        remaining: {
          "ally:subject/ACT_OLGA_VETERAN_PS1_SUBUNIT": 1,
          "ally:subject/ACT_OLGA_VETERAN_PS1_SUBUNIT#2": 1,
          "ally:subject/ACT_OLGA_VETERAN_PS1_SUBUNIT#3": 1,
        },
      },
      { step: "ACTION_END(ally:subject)", remaining: {}, expired: [expired, expired, expired] },
    ]);
    // カムラッドⅠは耐久力が尽きるまで存続する（2回の行動終了を跨いで3件のまま）。
    expect(
      observed.units
        .find((unit) => unit.battleUnitId === "ally:subject")!
        .appliedEffects.filter(
          (effect) => effect.effectActionDefinitionId === "ACT_OLGA_VETERAN_PS2_SUBUNIT",
        )
        .map((effect) => effect.subUnit?.durability),
    ).toEqual([1500, 1500, 1500]);
  });

  it("IT-UNIT-OLGA-VETERAN-008 [R-SKL-06] (Q-CAT-EFF-16): AS2の「警戒」所持相手からの被ダメージ35%減少は原文に「重複可」が無く重複しない — 既に保持していればAS2を撃ち直しても付与stepごと実行されない", () => {
    // `APPLY_DAMAGE_MOD` は `STACKABLE` しか受理せず合成側で最強1件を選ぶ経路が
    // 無いため、2件目を作らないことで重複なしへ揃える（`BRANCH` のelse腕）。
    const observed = observeSkillUse({
      snapshot,
      unitDefinitionId: UNIT_DEFINITION_ID,
      use: { kind: "ACTIVE", skillDefinitionId: "SKL_OLGA_VETERAN_AS2" },
      precedingActions: [
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS2_DMG_DOWN", target: "SELF" },
      ],
    });

    expect(observed.actions?.map((action) => action.effectActionDefinitionId) ?? []).not.toContain(
      "ACT_OLGA_VETERAN_AS2_DMG_DOWN",
    );
    // 攻撃・回復・「警戒」付与は同じスキルの別効果であり、ガードの対象ではない。
    expect(observed.actions?.map((action) => action.effectActionDefinitionId) ?? []).toContain(
      "ACT_OLGA_VETERAN_AS2_MARKER",
    );
  });
});
