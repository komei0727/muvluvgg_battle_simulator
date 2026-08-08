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
  type PrecedingAction,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  criticalCheckResolved,
  skillUseCompleted,
} from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_EVIE_KYONSHI`（【キョンシーハッカー】エヴィ・レーナルト）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_EVIE_KYONSHI";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  "UNIT_OLGA_VETERAN",
]);

/** PS2は自身のAS完了そのものを契機に持つため、AS 1回の観測には必ず連鎖が含まれる。 */
const PS2_CHAIN = {
  action: {
    effectActionDefinitionId: "ACT_EVIE_KYONSHI_PS2_CRIT_UP",
    targets: ["ally:subject"],
  },
  effect: {
    unitId: "ally:subject",
    effectActionDefinitionId: "ACT_EVIE_KYONSHI_PS2_CRIT_UP",
    magnitude: 0.015,
    timeLimit: { unit: "BATTLE", count: 1 },
  },
  cooldown: {
    unitId: "ally:subject",
    skillDefinitionId: "SKL_EVIE_KYONSHI_PS2",
    remaining: 1,
  },
} as const;

/**
 * 混乱（R-CFS-01）はASの`DAMAGE` stepのTargetSelectorを反転させ、
 * `SkillUseStarting`/`SkillUseCompleted.targetUnitIds` にも反転後の味方が入る。
 * 「自身がアクティブスキルで攻撃する」ことは変わらないため、この経路でもPSは
 * 発動しなければならない。前提は実 production 定義で作る。
 */
const CONFUSED: readonly PrecedingAction[] = [
  { effectActionDefinitionId: "ACT_OLGA_VETERAN_EX_CONFUSION", target: "SELF" },
];

/** 混乱はその行動の`DAMAGE`で消費され、観測では解除として現れる。 */
const CONFUSION_CONSUMED = {
  unitId: "ally:subject",
  effectActionDefinitionId: "ACT_OLGA_VETERAN_EX_CONFUSION",
  magnitude: 0,
  timeLimit: { unit: "ACTION", count: 1 },
  statusKind: "CONFUSION",
} as const;

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_EVIE_KYONSHI_EX",
    intent:
      "相手の防御力とシールドを50%無視して敵全体に威力34.32で5ヒットEN攻撃し、1行動の間与ダメージを20%減少させるデバフを付与する（重複可）。さらに自身に対し、1行動の間与ダメージを10%上昇させるバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_EVIE_KYONSHI_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_EVIE_KYONSHI_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_EVIE_KYONSHI_EX_DEBUFF", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_EVIE_KYONSHI_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_EVIE_KYONSHI_EX_DEBUFF", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_EVIE_KYONSHI_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_EVIE_KYONSHI_EX_DEBUFF", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_EVIE_KYONSHI_EX_SELF_BUFF", targets: ["ally:subject"] },
      ],
      // 防御力50%無視で実効防御は250。1ヒット257（(1000-250)×34.32%）×5ヒット。
      hpDeltas: {
        "enemy:front": -1285,
        "enemy:left": -1285,
        "enemy:back": -1285,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_EVIE_KYONSHI_EX_SELF_BUFF",
          magnitude: 0.1,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_EVIE_KYONSHI_EX_DEBUFF",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_EVIE_KYONSHI_EX_DEBUFF",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_EVIE_KYONSHI_EX_DEBUFF",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_EVIE_KYONSHI_AS1",
    intent: "敵3体に威力89.04で2ヒットEN攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_EVIE_KYONSHI_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_EVIE_KYONSHI_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_EVIE_KYONSHI_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_EVIE_KYONSHI_AS1_DAMAGE", targets: ["enemy:back"] },
        PS2_CHAIN.action,
      ],
      // 1ヒット445（(1000-500)×89.04%）×2ヒット。
      hpDeltas: {
        "enemy:front": -890,
        "enemy:left": -890,
        "enemy:back": -890,
      },
      effectsApplied: [PS2_CHAIN.effect],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_EVIE_KYONSHI_AS1", remaining: 1 },
        PS2_CHAIN.cooldown,
      ],
    },
  },
  {
    skillDefinitionId: "SKL_EVIE_KYONSHI_AS2",
    intent: "敵単体に威力212でEN攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_EVIE_KYONSHI_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_EVIE_KYONSHI_AS2_DAMAGE", targets: ["enemy:front"] },
        PS2_CHAIN.action,
      ],
      hpDeltas: {
        "enemy:front": -1060,
      },
      effectsApplied: [PS2_CHAIN.effect],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [PS2_CHAIN.cooldown],
    },
  },
  {
    skillDefinitionId: "SKL_EVIE_KYONSHI_PS1",
    intent: "自身の攻撃が会心攻撃になるたびに発動。敵2体に対して威力159でEN攻撃する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_EVIE_KYONSHI_PS1",
      trigger: criticalCheckResolved({
        source: "ally:subject",
        target: "enemy:front",
        result: true,
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_EVIE_KYONSHI_PS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_EVIE_KYONSHI_PS1_DAMAGE", targets: ["enemy:left"] },
      ],
      hpDeltas: {
        "enemy:front": -795,
        "enemy:left": -795,
      },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_EVIE_KYONSHI_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_EVIE_KYONSHI_PS1",
    intent: "(不成立): 会心攻撃にならなかった会心判定では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_EVIE_KYONSHI_PS1",
      trigger: criticalCheckResolved({
        source: "ally:subject",
        target: "enemy:front",
        result: false,
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_EVIE_KYONSHI_PS2",
    intent: "自身がアクティブスキルで攻撃した直後に発動。自身の会心率を1.5%上昇させる（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_EVIE_KYONSHI_PS2",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_EVIE_KYONSHI_AS2",
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [PS2_CHAIN.action],
      effectsApplied: [PS2_CHAIN.effect],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [PS2_CHAIN.cooldown],
    },
  },
  {
    skillDefinitionId: "SKL_EVIE_KYONSHI_PS2",
    intent: "(不成立): 攻撃しないスキル使用（EX）の完了では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_EVIE_KYONSHI_PS2",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "EX",
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_EVIE_KYONSHI_PS2",
    intent:
      "(発動): 混乱で攻撃対象が味方側へ反転しても、アクティブスキルで攻撃した事実は変わらず発動する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_EVIE_KYONSHI_AS2" },
    precedingActions: CONFUSED,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_EVIE_KYONSHI_AS2_DAMAGE", targets: ["ally:subject"] },
        PS2_CHAIN.action,
      ],
      // 混乱倍率0.7が掛かった (1000-500)×212%×0.7。
      hpDeltas: {
        "ally:subject": -742,
      },
      effectsApplied: [PS2_CHAIN.effect],
      effectsRemoved: [CONFUSION_CONSUMED],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [PS2_CHAIN.cooldown],
    },
  },
];

describe("production Catalog UNIT_EVIE_KYONSHI (【キョンシーハッカー】エヴィ・レーナルト)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-EVIE-KYONSHI-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-EVIE-KYONSHI-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-EVIE-KYONSHI-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
