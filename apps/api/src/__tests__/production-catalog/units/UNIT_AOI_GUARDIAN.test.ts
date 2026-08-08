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
import { realDamage, skillUseStarting } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_AOI_GUARDIAN`（【厳格な規律の守護者】生駒葵）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_AOI_GUARDIAN";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_AOI_GUARDIAN_EX",
    intent:
      "自身のHPを最大HPの60%回復し、2行動の間攻撃力を50%上昇させ（重複可）、気絶無効を付与する。さらに自身に攻撃力×150%までのダメージを防ぐシールドを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_AOI_GUARDIAN_EX" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_EX_HEAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_EX_ATK_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_EX_STUN_IMMUNITY",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_EX_SHIELD",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "ally:subject": 5000,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_EX_ATK_UP",
          magnitude: 0.5,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_EX_STUN_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_EX_SHIELD",
          magnitude: 2250,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_AOI_GUARDIAN_AS1",
    intent:
      "最もHP割合の低い味方単体に、攻撃力×120%までのダメージを防ぐシールドを付与する。さらに2行動の間、行動時に最大HPの5%を継続回復するバフを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_AOI_GUARDIAN_AS1" },
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
      // PS1（「自身がアクティブスキルを使用する直前に発動」）はASの使用開始そのものを
      // 契機に持つため、AS 1回の観測には必ずPS1の連鎖が含まれる。
      actions: [
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_PS1_HEAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_AS1_SHIELD",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_AS1_CONTINUOUS_HEAL",
          targets: ["ally:front"],
        },
      ],
      hpDeltas: {
        "ally:subject": 2500,
      },
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_AS1_SHIELD",
          magnitude: 1200,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_AS1_CONTINUOUS_HEAL",
          magnitude: 500,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        // EX獲得量は使用したスキルの消費ポイントに等しい（AS1=1 + PS1=1）。
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_AOI_GUARDIAN_PS1",
          remaining: 1,
        },
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_AOI_GUARDIAN_AS1",
          remaining: 2,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_AOI_GUARDIAN_AS1",
    intent: "(対象): 自身が最もHP割合の低い味方なら、シールドと継続回復は自身へ向かう",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_AOI_GUARDIAN_AS1" },
    board: { subject: { state: { currentHp: 1000 } } },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_PS1_HEAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_AS1_SHIELD",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_AS1_CONTINUOUS_HEAL",
          targets: ["ally:subject"],
        },
      ],
      // 失ったHP 9000 の50%。回復後もHP割合は最低のまま（AS1の対象は変わらない）。
      hpDeltas: {
        "ally:subject": 4500,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_AS1_SHIELD",
          magnitude: 1200,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_AS1_CONTINUOUS_HEAL",
          magnitude: 500,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_AOI_GUARDIAN_PS1",
          remaining: 1,
        },
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_AOI_GUARDIAN_AS1",
          remaining: 2,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_AOI_GUARDIAN_AS2",
    intent: "敵単体に威力212で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_AOI_GUARDIAN_AS2" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_PS1_HEAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_AS2_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "ally:subject": 2500,
        "enemy:front": -1060,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_AOI_GUARDIAN_PS1",
          remaining: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_AOI_GUARDIAN_PS1",
    intent: "自身がアクティブスキルを使用する直前に発動。自身の失ったHPの50%を回復する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_AOI_GUARDIAN_PS1",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_PS1_HEAL",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "ally:subject": 2500,
      },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_AOI_GUARDIAN_PS1",
          remaining: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_AOI_GUARDIAN_PS1",
    intent: "(不成立): EXスキルの使用直前では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_AOI_GUARDIAN_PS1",
      trigger: skillUseStarting({
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
    skillDefinitionId: "SKL_AOI_GUARDIAN_PS1",
    intent: "(不成立): 味方のアクティブスキル使用では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_AOI_GUARDIAN_PS1",
      trigger: skillUseStarting({
        actor: "ally:front",
        targets: ["enemy:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:front",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_AOI_GUARDIAN_PS2",
    intent:
      "自身がアクティブスキルで攻撃された後に発動。攻撃してきた敵単体に対して受けたダメージの100%のダメージを与える反撃をし、1行動分の気絶を付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_AOI_GUARDIAN_PS2",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "AS" }),
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_PS2_COUNTER",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_PS2_STUN",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -500,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_PS2_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        // EX獲得量は使用したスキルの消費ポイントに等しい（PS2=2）。
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_AOI_GUARDIAN_PS2",
          remaining: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_AOI_GUARDIAN_PS2",
    intent: "さらに対象のHPをこのスキルによって30%以下にした場合、対象のPPを全て削る",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_AOI_GUARDIAN_PS2",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "AS" }),
    },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 3400 },
        },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_PS2_COUNTER",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_PS2_STUN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_PS2_PP_ZERO",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -500,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_PS2_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        // EX獲得量は使用したスキルの消費ポイントに等しい（PS2=2）。
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
        { unitId: "enemy:front", resource: "PP", delta: -4 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_AOI_GUARDIAN_PS2",
          remaining: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_AOI_GUARDIAN_PS2",
    intent: "(不成立): パッシブスキルによるダメージでは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_AOI_GUARDIAN_PS2",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "PS" }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_AOI_GUARDIAN_PS2",
    intent: "(不成立): 味方が受けたダメージでは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_AOI_GUARDIAN_PS2",
      trigger: realDamage({ from: "enemy:front", to: "ally:front", skillType: "AS" }),
    },
    expected: {
      activated: false,
    },
  },
];

describe("production Catalog UNIT_AOI_GUARDIAN (【厳格な規律の守護者】生駒葵)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-AOI-GUARDIAN-001: $skillDefinitionId — $intent",
    ({ use, board, precedingActions, expected }) => {
      expect(
        observeSkillUse({
          snapshot,
          unitDefinitionId: UNIT_DEFINITION_ID,
          use,
          ...(board === undefined ? {} : { board }),
          ...(precedingActions === undefined ? {} : { precedingActions }),
        }),
      ).toEqual(expected);
    },
  );

  it("IT-UNIT-AOI-GUARDIAN-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-AOI-GUARDIAN-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
    resetExecutedActionIds();
    for (const { use, board, precedingActions } of BEHAVIOURS) {
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use,
        ...(board === undefined ? {} : { board }),
        ...(precedingActions === undefined ? {} : { precedingActions }),
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
