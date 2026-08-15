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
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { realDamage, unitDefeated } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_YURIA_WILDCARD`（【享楽のワイルドカード】ユリア・バーンズ）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_YURIA_WILDCARD";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_YURIA_WILDCARD_EX",
    intent: "敵単体の防御力とシールドを無視し、威力200.8で攻撃する（HP40%超: 増加なしの腕）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_YURIA_WILDCARD_EX" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_YURIA_WILDCARD_EX_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      // 防御力無視のため素の攻撃力1000が威力へ乗る（`攻撃力 - 防御力` ではない）。
      hpDeltas: {
        "enemy:front": -2008,
      },
    },
  },
  {
    skillDefinitionId: "SKL_YURIA_WILDCARD_EX",
    intent: "ターゲットのHPが40%以下の場合、この攻撃の与ダメージが50%増加する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_YURIA_WILDCARD_EX" },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 4000 },
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_YURIA_WILDCARD_EX_DAMAGE_BOOSTED",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -3012,
      },
    },
  },
  {
    skillDefinitionId: "SKL_YURIA_WILDCARD_EX",
    intent: "さらにこの攻撃で敵を倒した場合、敵全体のAPを1ずつ削る",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_YURIA_WILDCARD_EX" },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 1000 },
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      // 撃破そのものがPS1（「自身が敵を倒した際に発動」）の契機になる。R-ATM-01により
      // その候補は撃破時点で検出され、発動はEXの全step（続くBRANCH stepを含む）が
      // 解決した後になる。
      actions: [
        {
          effectActionDefinitionId: "ACT_YURIA_WILDCARD_EX_DAMAGE_BOOSTED",
          targets: ["enemy:front"],
        },
        // 倒した当人は`includeDefeated`を持たない選択から外れ、適用は行われない。
        {
          effectActionDefinitionId: "ACT_YURIA_WILDCARD_EX_AP_DOWN",
          targets: ["enemy:front"],
          resultKind: "SKIPPED",
        },
        {
          effectActionDefinitionId: "ACT_YURIA_WILDCARD_EX_AP_DOWN",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_YURIA_WILDCARD_EX_AP_DOWN",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_YURIA_WILDCARD_PS1_EX_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_YURIA_WILDCARD_PS1_DEF_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_YURIA_WILDCARD_PS1_SHIELD",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1000,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_YURIA_WILDCARD_PS1_DEF_UP",
          magnitude: 0.1,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_YURIA_WILDCARD_PS1_SHIELD",
          magnitude: 500,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
        { unitId: "enemy:left", resource: "AP", delta: -1 },
        { unitId: "enemy:back", resource: "AP", delta: -1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_YURIA_WILDCARD_AS1",
    intent:
      "自身から最も遠い位置にいる敵単体に威力254.4で攻撃し、3行動分の炎上を付与する。炎上は攻撃力×30%の持続ダメージを与える",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_YURIA_WILDCARD_AS1" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_YURIA_WILDCARD_AS1_DAMAGE",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_YURIA_WILDCARD_AS1_BURN",
          targets: ["enemy:back"],
        },
      ],
      hpDeltas: {
        "enemy:back": -1272,
      },
      effectsApplied: [
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_YURIA_WILDCARD_AS1_BURN",
          magnitude: 300,
          timeLimit: { unit: "ACTION", count: 3 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_YURIA_WILDCARD_AS1",
          remaining: 2,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_YURIA_WILDCARD_AS2",
    intent: "敵単体に威力60.24で5ヒット攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_YURIA_WILDCARD_AS2" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_YURIA_WILDCARD_AS2_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1505,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_YURIA_WILDCARD_PS1",
    intent:
      "自身が敵を倒した際に発動。自身のEXゲージを1加算し、防御力を10%上昇させる(重複可)。さらに自身に攻撃力×50%の物理攻撃を防ぐシールドを付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YURIA_WILDCARD_PS1",
      trigger: unitDefeated({ unit: "enemy:front", defeatedBy: "ally:subject" }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_YURIA_WILDCARD_PS1_EX_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_YURIA_WILDCARD_PS1_DEF_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_YURIA_WILDCARD_PS1_SHIELD",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_YURIA_WILDCARD_PS1_DEF_UP",
          magnitude: 0.1,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_YURIA_WILDCARD_PS1_SHIELD",
          magnitude: 500,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        // PS発動によるEX獲得（消費PP分の1）と、`ACT_..._PS1_EX_UP` の加算1。
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_YURIA_WILDCARD_PS1",
    intent: "(不成立): 味方が倒れても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YURIA_WILDCARD_PS1",
      trigger: unitDefeated({ unit: "ally:front", defeatedBy: "enemy:front" }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_YURIA_WILDCARD_PS2",
    intent:
      "自身がアクティブスキルで攻撃された後に発動。攻撃してきた敵単体に威力301.2で反撃し、対象のEXゲージを1削る",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YURIA_WILDCARD_PS2",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "AS" }),
    },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentExtraGauge: 3 },
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_YURIA_WILDCARD_PS2_COUNTER",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_YURIA_WILDCARD_PS2_EX_DOWN",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1506,
      },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "enemy:front", resource: "EX_GAUGE", delta: -1 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_YURIA_WILDCARD_PS2",
          remaining: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_YURIA_WILDCARD_PS2",
    intent: "(不成立): パッシブスキルによるダメージでは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YURIA_WILDCARD_PS2",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "PS" }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_YURIA_WILDCARD_PS2",
    intent: "(不成立): 味方が受けたダメージでは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YURIA_WILDCARD_PS2",
      trigger: realDamage({ from: "enemy:front", to: "ally:front", skillType: "AS" }),
    },
    expected: {
      activated: false,
    },
  },
];

describe("production Catalog UNIT_YURIA_WILDCARD (【享楽のワイルドカード】ユリア・バーンズ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-YURIA-WILDCARD-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-YURIA-WILDCARD-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-YURIA-WILDCARD-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
