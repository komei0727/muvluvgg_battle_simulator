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
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  realDamage,
  turnCompleting,
  turnStarted,
} from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_KOKORO_SPORTSDAY`（【体育祭のサポート役】樋向心香）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_KOKORO_SPORTSDAY";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const STOIC_MARKER_ID = "MARKER_KOKORO_SPORTSDAY_STOIC";

/**
 * 「ストイック」状態はEXが付けるMarkerで、AS1・PS2・PS3の分岐条件になる。
 * 各分岐の「then」側の腕を作るため、保持済みMarkerとして盤面に置く。
 */
const STOIC: BoardOverrides = { subject: { markers: [{ markerId: STOIC_MARKER_ID }] } };

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_KOKORO_SPORTSDAY_EX",
    intent: "敵全体に威力169.6でEN攻撃し、2行動の間自身を「ストイック」状態にする",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KOKORO_SPORTSDAY_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_KOKORO_SPORTSDAY_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KOKORO_SPORTSDAY_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_KOKORO_SPORTSDAY_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_KOKORO_SPORTSDAY_EX_STOIC", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "enemy:front": -848,
        "enemy:left": -848,
        "enemy:back": -848,
      },
      markers: [{ unitId: "ally:subject", markerId: STOIC_MARKER_ID, stackCount: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_KOKORO_SPORTSDAY_AS1",
    intent: "敵単体に威力189.6でEN攻撃する（「ストイック」状態にない場合、追加攻撃は行わない）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KOKORO_SPORTSDAY_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_KOKORO_SPORTSDAY_AS1_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -948,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KOKORO_SPORTSDAY_AS1",
    intent:
      "自身が「ストイック」状態にある場合、さらに後列の敵横一列に対し威力161.16で追加攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KOKORO_SPORTSDAY_AS1" },
    board: {
      ...STOIC,
      enemies: [
        { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
        { id: "enemy:back-right", position: { column: "RIGHT", row: "BACK" } },
      ],
    },
    expected: {
      // 追加攻撃は後列の敵**全員**へ届き、前列の敵には届かない。
      actions: [
        { effectActionDefinitionId: "ACT_KOKORO_SPORTSDAY_AS1_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_KOKORO_SPORTSDAY_AS1_DAMAGE_BACKROW",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_KOKORO_SPORTSDAY_AS1_DAMAGE_BACKROW",
          targets: ["enemy:back-right"],
        },
      ],
      hpDeltas: {
        "enemy:front": -948,
        "enemy:back": -805,
        "enemy:back-right": -805,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KOKORO_SPORTSDAY_PS1",
    intent:
      "自身がアクティブスキルで攻撃された後に発動。敵2体に対し、受けたダメージの120%のダメージを与えるEN反撃をする",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KOKORO_SPORTSDAY_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "AS" }),
    },
    board: STOIC,
    expected: {
      // 受けたダメージ500（攻撃力1000 - 防御力500）の120%。
      actions: [
        { effectActionDefinitionId: "ACT_KOKORO_SPORTSDAY_PS1_COUNTER", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KOKORO_SPORTSDAY_PS1_COUNTER", targets: ["enemy:left"] },
      ],
      hpDeltas: {
        "enemy:front": -600,
        "enemy:left": -600,
      },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KOKORO_SPORTSDAY_PS1",
    intent: "(不成立): このスキルは自身が「ストイック」状態にない場合は発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KOKORO_SPORTSDAY_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "AS" }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_KOKORO_SPORTSDAY_PS1",
    intent: "(不成立): アクティブスキル以外で攻撃されても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KOKORO_SPORTSDAY_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "EX" }),
    },
    board: STOIC,
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_KOKORO_SPORTSDAY_PS2",
    intent:
      "ターン開始時に発動。最も近い位置にいる敵単体、および対象に隣接する2体に対し、威力54.6でEN攻撃する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KOKORO_SPORTSDAY_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_KOKORO_SPORTSDAY_PS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KOKORO_SPORTSDAY_PS2_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_KOKORO_SPORTSDAY_PS2_DAMAGE", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -273,
        "enemy:left": -273,
        "enemy:back": -273,
      },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KOKORO_SPORTSDAY_PS2",
    intent:
      "自身が「ストイック」状態の場合、さらに対象の次の攻撃の与ダメージを30%減少させるデバフを付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KOKORO_SPORTSDAY_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    board: STOIC,
    expected: {
      // デバフが乗るのは「最も近い位置にいる敵単体」だけで、隣接の2体には乗らない。
      actions: [
        { effectActionDefinitionId: "ACT_KOKORO_SPORTSDAY_PS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KOKORO_SPORTSDAY_PS2_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_KOKORO_SPORTSDAY_PS2_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_KOKORO_SPORTSDAY_PS2_DMG_DOWN", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -273,
        "enemy:left": -273,
        "enemy:back": -273,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_KOKORO_SPORTSDAY_PS2_DMG_DOWN",
          magnitude: -0.3,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KOKORO_SPORTSDAY_PS3",
    intent:
      "ターン終了時に発動。最もHP割合の低い味方に対し、自身が次の行動を終えるまでの間、被ダメージを35%減少させる効果を付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KOKORO_SPORTSDAY_PS3",
      trigger: turnCompleting({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    board: {
      allies: [
        {
          id: "ally:front",
          position: { column: "LEFT", row: "FRONT" },
          state: { currentHp: 2000 },
        },
        { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_KOKORO_SPORTSDAY_PS3_DMG_DOWN", targets: ["ally:front"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_KOKORO_SPORTSDAY_PS3_DMG_DOWN",
          magnitude: -0.35,
          // 「自身が次の行動を終えるまで」は付与者側の1行動として期間を数える。
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KOKORO_SPORTSDAY_PS3",
    intent:
      "さらに自身が「ストイック」状態にある場合、対象に対して3行動の間、行動時に威力12.5でHPを回復する効果を付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KOKORO_SPORTSDAY_PS3",
      trigger: turnCompleting({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    board: {
      ...STOIC,
      allies: [
        {
          id: "ally:front",
          position: { column: "LEFT", row: "FRONT" },
          state: { currentHp: 2000 },
        },
        { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_KOKORO_SPORTSDAY_PS3_DMG_DOWN", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_KOKORO_SPORTSDAY_PS3_HEAL", targets: ["ally:front"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_KOKORO_SPORTSDAY_PS3_DMG_DOWN",
          magnitude: -0.35,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_KOKORO_SPORTSDAY_PS3_HEAL",
          // 継続回復の回復量は発火のたびに評価し直すため、付与時の`magnitude`は
          // 威力そのもの（12.5%）を持つ。実回復量は発火時の付与者の攻撃力から決まる。
          magnitude: 0.125,
          timeLimit: { unit: "ACTION", count: 3 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
];

describe("production Catalog UNIT_KOKORO_SPORTSDAY (【体育祭のサポート役】樋向心香)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-KOKORO-SPORTSDAY-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-KOKORO-SPORTSDAY-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-KOKORO-SPORTSDAY-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
