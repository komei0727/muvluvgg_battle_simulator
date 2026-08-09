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
import { skillUseCompleted, turnStarted } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_SIENA_OFFSTAGE`(【舞台を降りた元歌姫】シエナ・クラーク)のユニット単位
 * production結合テスト(`12_テスト戦略.md`「ユニット効果軸」)。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_SIENA_OFFSTAGE";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** PS1のBRANCHが `elseSteps` を選ぶ盤面（対象が物理タイプでない）。 */
const NON_PHYSICAL_TARGET: BoardOverrides = {
  enemies: [
    {
      id: "enemy:front",
      position: { column: "CENTER", row: "FRONT" },
      unitType: "ENERGY",
      state: { currentExtraGauge: 3 },
    },
    { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
    { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
  ],
};

/** PS1が削るEXゲージを持つ敵陣（既定の物理タイプのまま）。 */
const PHYSICAL_TARGET: BoardOverrides = {
  enemies: [
    {
      id: "enemy:front",
      position: { column: "CENTER", row: "FRONT" },
      state: { currentExtraGauge: 3 },
    },
    { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
    { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
  ],
};

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_SIENA_OFFSTAGE_EX",
    intent:
      "敵全体に威力189.6でEN攻撃し、最もHP割合の低い敵1体に対して追加で威力47.4のEN攻撃を行う。さらに自身に次の攻撃で与えるダメージを30%上昇させるバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SIENA_OFFSTAGE_EX" },
    expected: {
      // HP割合が並ぶ盤面では前列・左優先の同点処理で enemy:left が追加攻撃を受ける。
      actions: [
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_EX_DAMAGE", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_EX_DAMAGE_EXTRA",
          targets: ["enemy:left"],
        },
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_EX_DMG_UP", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:front": -948, "enemy:left": -1185, "enemy:back": -948 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_EX_DMG_UP",
          magnitude: 0.3,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SIENA_OFFSTAGE_AS1",
    intent: "スキルの発動タイミングでチャージを開始（消費ポイント2・クールタイム2行動）",
    use: { kind: "CHARGE", skillDefinitionId: "SKL_SIENA_OFFSTAGE_AS1", phase: "START" },
    expected: {
      charge: "SKL_SIENA_OFFSTAGE_AS1",
      resources: [{ unitId: "ally:subject", resource: "AP", delta: -2 }],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SIENA_OFFSTAGE_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SIENA_OFFSTAGE_AS1",
    intent: "次に自身の行動順が巡ってきた際、敵全体に威力212でEN攻撃する",
    use: { kind: "CHARGE", skillDefinitionId: "SKL_SIENA_OFFSTAGE_AS1", phase: "RELEASE" },
    expected: {
      charge: null,
      actions: [
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_AS1_DAMAGE", targets: ["enemy:back"] },
      ],
      hpDeltas: { "enemy:front": -1060, "enemy:left": -1060, "enemy:back": -1060 },
      // 解放も自身の1行動であるため、開始時に置かれた自分のクールタイムが1つ減る。
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SIENA_OFFSTAGE_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SIENA_OFFSTAGE_AS2",
    intent: "最もHP割合の低い敵単体に威力180.2でEN攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SIENA_OFFSTAGE_AS2" },
    expected: {
      // 攻撃ASの使用完了そのものがPS2の契機になるため、同じスキル使用の中で
      // 自己バフ2件が連鎖する。
      actions: [
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_AS2_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS2_SPEED_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS2_DMG_UP", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:left": -901 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS2_SPEED_UP",
          magnitude: 50,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS2_DMG_UP",
          magnitude: 0.2,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        // AS使用分の1と、連鎖したPS2の消費PP分の2。
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 3 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SIENA_OFFSTAGE_AS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SIENA_OFFSTAGE_PS1",
    intent:
      "ターン開始時に発動。敵単体の会心率を5%低下させ、EXゲージを1削る。さらに対象が物理タイプだった場合、対象が次に受ける攻撃の被ダメージを40%増加させるデバフを付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SIENA_OFFSTAGE_PS1",
      trigger: turnStarted({ unit: "ally:subject", turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    board: PHYSICAL_TARGET,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS1_CRIT_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS1_EX_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS1_DMG_UP", targets: ["enemy:front"] },
      ],
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS1_CRIT_DOWN",
          magnitude: -0.05,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS1_DMG_UP",
          magnitude: 0.4,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "enemy:front", resource: "EX_GAUGE", delta: -1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SIENA_OFFSTAGE_PS1",
    intent: "（物理タイプでない対象）被ダメージ増加デバフの腕は選ばれない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SIENA_OFFSTAGE_PS1",
      trigger: turnStarted({ unit: "ally:subject", turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    board: NON_PHYSICAL_TARGET,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS1_CRIT_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS1_EX_DOWN", targets: ["enemy:front"] },
      ],
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS1_CRIT_DOWN",
          magnitude: -0.05,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "enemy:front", resource: "EX_GAUGE", delta: -1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SIENA_OFFSTAGE_PS1",
    intent: "(不成立): 契機は自身のターン開始であり、敵のターン開始では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SIENA_OFFSTAGE_PS1",
      trigger: turnStarted({ unit: "enemy:front", turnNumber: 1 }),
      triggeredBy: "enemy:front",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_SIENA_OFFSTAGE_PS2",
    intent:
      "自身がアクティブスキルで攻撃した後に発動。2行動の間自身の行動速度を50上昇させる（重複可）さらに自身に次の攻撃で与えるダメージを20%上昇させるバフを付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SIENA_OFFSTAGE_PS2",
      // 攻撃ASの完了。契機は攻撃先の陣営ではなく使用スキルIDで判定される。
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:left"],
        skillType: "AS",
        skillDefinitionId: "SKL_SIENA_OFFSTAGE_AS2",
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS2_SPEED_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS2_DMG_UP", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS2_SPEED_UP",
          magnitude: 50,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS2_DMG_UP",
          magnitude: 0.2,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SIENA_OFFSTAGE_PS2",
    intent: "(不成立): 攻撃を伴わないEXの使用完了では発動しない（契機は攻撃ASに限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SIENA_OFFSTAGE_PS2",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "EX",
        skillDefinitionId: "SKL_SIENA_OFFSTAGE_EX",
      }),
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_SIENA_OFFSTAGE (【舞台を降りた元歌姫】シエナ・クラーク)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-SIENA-OFFSTAGE-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-SIENA-OFFSTAGE-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-SIENA-OFFSTAGE-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
