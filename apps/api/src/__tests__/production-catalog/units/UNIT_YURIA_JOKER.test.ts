import { describe, expect, it } from "vitest";
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
  type BoardOverrides,
  type BoardUnitSpec,
  type PrecedingAction,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { realDamage, skillUseCompleted } from "../../../testing/production-unit/trigger-events.js";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";

/**
 * `UNIT_YURIA_JOKER`（【自由に煌めくジョーカーカード】ユリア・バーンズ）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 *
 * `LOWEST_DEFENSE`ターゲット順序・`TARGET_EFFECT_COUNT`条件種別（いずれもIssue #649で
 * 追加）のproduction初使用であり、それぞれPS1・PS2の行が個別に検証する。
 */

const UNIT_DEFINITION_ID = "UNIT_YURIA_JOKER";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const RESONANCE = "MARKER_YURIA_JOKER_RESONANCE";

/** AS1・AS2の「呼応が最も少ない敵を優先」を、既定の同点(0個)ではなく判別させる盤面。 */
const ENEMIES_WITH_MIXED_RESONANCE: readonly BoardUnitSpec[] = [
  {
    id: "enemy:front",
    position: { column: "CENTER", row: "FRONT" },
    markers: [{ markerId: RESONANCE, stackCount: 6 }],
  },
  {
    id: "enemy:left",
    position: { column: "LEFT", row: "FRONT" },
    markers: [{ markerId: RESONANCE, stackCount: 4 }],
  },
  {
    id: "enemy:back",
    position: { column: "CENTER", row: "BACK" },
    markers: [{ markerId: RESONANCE, stackCount: 8 }],
  },
];

/** AS1の発動ガード（自身の呼応が10個以上）を成立させる盤面。 */
const SUBJECT_AT_RESONANCE_CAP: BoardOverrides = {
  subject: { markers: [{ markerId: RESONANCE, stackCount: 10 }] },
};

/** PS1の対象選択（防御力最低の敵を優先）を判別させる盤面。 */
const ENEMIES_WITH_LOW_DEFENSE: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, combatStats: { defense: 200 } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

const PS1_SKILL_ID = createSkillDefinitionId("SKL_YURIA_JOKER_PS1");
const PS1_TRIGGER_COUNT_ID = createRuntimeCounterId("SKL_YURIA_JOKER_PS1_TRIGGER_COUNT");

/** PS1は「アクティブスキル3回目の使用」でだけ発動する。counterを2に置いて次を3回目にする。 */
const PS1_COUNTER_AT_TWO: BoardOverrides = {
  subject: {
    state: {
      skillCounters: { [PS1_SKILL_ID]: { [PS1_TRIGGER_COUNT_ID]: { value: 2, carry: 0 } } },
    },
  },
  enemies: ENEMIES_WITH_LOW_DEFENSE,
};

const PS1_TRIGGER = skillUseCompleted({
  actor: "ally:subject",
  targets: ["enemy:front"],
  skillType: "AS",
  skillDefinitionId: "SKL_YURIA_JOKER_AS2",
});

/** 累計で最大HP(10000)×10%＝1000ダメージに達する一撃（(1000-500)×3=1500）。 */
const CUMULATIVE_THRESHOLD_HIT = realDamage({
  from: "enemy:front",
  to: "ally:subject",
  skillType: "AS",
  power: 3,
});

/** 累計が最大HP×10%に届かない一撃（(1000-500)×1=500）。 */
const BELOW_THRESHOLD_HIT = realDamage({
  from: "enemy:front",
  to: "ally:subject",
  skillType: "AS",
  power: 1,
});

/** 自身に「解除可能なバフ」を2つ持たせる前提アクション。 */
const TWO_SELF_BUFFS: readonly PrecedingAction[] = [
  { effectActionDefinitionId: "ACT_YURIA_JOKER_PS1_ATK_UP", target: "SELF" },
  { effectActionDefinitionId: "ACT_YURIA_JOKER_PS1_ATK_UP", target: "SELF" },
];

/** 自身に「解除可能なバフ」を1つだけ持たせる前提アクション（発動ガードの不成立用）。 */
const ONE_SELF_BUFF: readonly PrecedingAction[] = [
  { effectActionDefinitionId: "ACT_YURIA_JOKER_PS1_ATK_UP", target: "SELF" },
];

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_YURIA_JOKER_EX",
    intent:
      "敵全体に威力156でEN攻撃する。対象が「呼応」状態の場合、「呼応」１つにつき一時的に防御力を7.5%低下させてから攻撃する（重複可・最大10個まで）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_YURIA_JOKER_EX" },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          markers: [{ markerId: RESONANCE, stackCount: 4 }],
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_YURIA_JOKER_EX_DEF_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_YURIA_JOKER_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_YURIA_JOKER_EX_DEF_DOWN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_YURIA_JOKER_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_YURIA_JOKER_EX_DEF_DOWN", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_YURIA_JOKER_EX_DAMAGE", targets: ["enemy:back"] },
      ],
      // 呼応4個の前列（防御力500→350）は(1000-350)×1.56=1014。呼応0個は分岐なしで
      // (1000-500)×1.56=780。
      hpDeltas: { "enemy:front": -1014, "enemy:left": -780, "enemy:back": -780 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_YURIA_JOKER_EX_DEF_DOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_YURIA_JOKER_EX_DEF_DOWN",
          magnitude: -0,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_YURIA_JOKER_EX_DEF_DOWN",
          magnitude: -0,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_YURIA_JOKER_AS1",
    intent:
      "「呼応」が最も少ない敵を優先して敵単体に威力254.4でEN攻撃し、対象と自身に「呼応」を１つずつ付与する（解除不可）。対象が「呼応」状態の場合、「呼応」１つにつき一時的に防御力を3.5%低下させてから攻撃する（重複化・最大10個まで）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_YURIA_JOKER_AS1" },
    board: { enemies: ENEMIES_WITH_MIXED_RESONANCE },
    expected: {
      // 呼応最少はenemy:left(4個)。防御力500→430((1000-430)×2.544=1450.08→1450)。
      actions: [
        { effectActionDefinitionId: "ACT_YURIA_JOKER_AS1_DEF_DOWN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_YURIA_JOKER_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_YURIA_JOKER_AS1_MARKER", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_YURIA_JOKER_AS1_MARKER", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:left": -1450 },
      effectsApplied: [
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_YURIA_JOKER_AS1_DEF_DOWN",
          magnitude: -0.14,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      // 呼応付与はダメージ計算の後: enemy:leftは4→5、自身は0→1。
      markers: [
        { unitId: "ally:subject", markerId: RESONANCE, stackCount: 1 },
        { unitId: "enemy:left", markerId: RESONANCE, stackCount: 5 },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_YURIA_JOKER_AS1",
    intent: "(不成立): 自身が所持している「呼応」が10個以上の場合、このスキルは発動しない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_YURIA_JOKER_AS1" },
    board: SUBJECT_AT_RESONANCE_CAP,
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_YURIA_JOKER_AS2",
    intent:
      "「呼応」が最も少ない敵を優先し、敵単体に威力95.4で３ヒットEN攻撃する。対象が「呼応」状態の場合、「呼応」１つにつき一時的に防御力を3.5%低下させてから攻撃する（重複化・最大10個まで）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_YURIA_JOKER_AS2" },
    board: { enemies: ENEMIES_WITH_MIXED_RESONANCE },
    expected: {
      // 呼応最少はenemy:left(4個)。防御力500→430。1ヒット(1000-430)×0.954=543.78→543、3ヒットで1629。
      actions: [
        { effectActionDefinitionId: "ACT_YURIA_JOKER_AS2_DEF_DOWN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_YURIA_JOKER_AS2_DAMAGE", targets: ["enemy:left"] },
      ],
      hpDeltas: { "enemy:left": -1629 },
      effectsApplied: [
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_YURIA_JOKER_AS2_DEF_DOWN",
          magnitude: -0.14,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_YURIA_JOKER_PS1",
    intent:
      "アクティブスキルを3回使用する度に発動。最も防御力の低い敵単体に威力156でEN攻撃し、対象が次に受ける攻撃での被ダメージを20%増加させるデバフを付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YURIA_JOKER_PS1",
      trigger: PS1_TRIGGER,
      triggeredBy: "ally:subject",
    },
    board: PS1_COUNTER_AT_TWO,
    expected: {
      // 防御力最低はenemy:left(200)。(1000-200)×1.56=1248。
      actions: [
        { effectActionDefinitionId: "ACT_YURIA_JOKER_PS1_DAMAGE", targets: ["enemy:left"] },
        {
          effectActionDefinitionId: "ACT_YURIA_JOKER_PS1_INCOMING_DMG_UP",
          targets: ["enemy:left"],
        },
      ],
      hpDeltas: { "enemy:left": -1248 },
      effectsApplied: [
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_YURIA_JOKER_PS1_INCOMING_DMG_UP",
          magnitude: 0.2,
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
    skillDefinitionId: "SKL_YURIA_JOKER_PS1",
    intent:
      "さらに自身が所持している「呼応」の数が10個以上の場合、自身のAPを１加算し、自身の攻撃力を５％上昇させる（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YURIA_JOKER_PS1",
      trigger: PS1_TRIGGER,
      triggeredBy: "ally:subject",
    },
    board: {
      ...PS1_COUNTER_AT_TWO,
      subject: {
        ...PS1_COUNTER_AT_TWO.subject,
        state: { ...PS1_COUNTER_AT_TWO.subject?.state, currentAp: 3 },
        markers: [{ markerId: RESONANCE, stackCount: 10 }],
      },
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_YURIA_JOKER_PS1_DAMAGE", targets: ["enemy:left"] },
        {
          effectActionDefinitionId: "ACT_YURIA_JOKER_PS1_INCOMING_DMG_UP",
          targets: ["enemy:left"],
        },
        { effectActionDefinitionId: "ACT_YURIA_JOKER_PS1_AP_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_YURIA_JOKER_PS1_ATK_UP", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:left": -1248 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_YURIA_JOKER_PS1_ATK_UP",
          magnitude: 0.05,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_YURIA_JOKER_PS1_INCOMING_DMG_UP",
          magnitude: 0.2,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: 1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_YURIA_JOKER_PS1",
    intent: "(不成立): 1回目・2回目の使用では発動しない(「3回使用するたび」に限る)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YURIA_JOKER_PS1",
      trigger: PS1_TRIGGER,
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_YURIA_JOKER_PS2",
    intent:
      "累計で最大HP×1０％のダメージを受けるたびに発動。自身にかけられているバフを２つ解除し、１行動の間自身の攻撃力を25%上昇させる（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YURIA_JOKER_PS2",
      trigger: CUMULATIVE_THRESHOLD_HIT,
    },
    precedingActions: TWO_SELF_BUFFS,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_YURIA_JOKER_PS2_REMOVE_BUFFS", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_YURIA_JOKER_PS2_ATK_UP", targets: ["ally:subject"] },
      ],
      effectsRemoved: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_YURIA_JOKER_PS1_ATK_UP",
          magnitude: 0.05,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_YURIA_JOKER_PS1_ATK_UP",
          magnitude: 0.05,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_YURIA_JOKER_PS2_ATK_UP",
          magnitude: 0.25,
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
    skillDefinitionId: "SKL_YURIA_JOKER_PS2",
    intent: "(不成立): 累計が最大HP×10%に達していないダメージでは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YURIA_JOKER_PS2",
      trigger: BELOW_THRESHOLD_HIT,
    },
    precedingActions: TWO_SELF_BUFFS,
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_YURIA_JOKER_PS2",
    intent: "(不成立): 解除可能なバフを２つ以上所持していない場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YURIA_JOKER_PS2",
      trigger: CUMULATIVE_THRESHOLD_HIT,
    },
    precedingActions: ONE_SELF_BUFF,
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_YURIA_JOKER (【自由に煌めくジョーカーカード】ユリア・バーンズ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-YURIA-JOKER-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-YURIA-JOKER-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-YURIA-JOKER-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
