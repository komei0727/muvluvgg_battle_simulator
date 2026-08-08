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
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  resetExecutedActionIds,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  skillUseCompleted,
  skillUseStarting,
} from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_JUNKA_CHILDHOOD`（【唯一無二の幼なじみ】鑑純夏）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 *
 * 変化しなかった観測項目はキーごと落ちるため、`toEqual` の完全一致が
 * 「宣言した振る舞いが起きること」と「余計なことを起こさないこと」を同時に固定する。
 */

const UNIT_DEFINITION_ID = "UNIT_JUNKA_CHILDHOOD";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_JUNKA_CHILDHOOD_AS1",
    intent:
      "最も近い敵と隣接する敵へ威力148.4で攻撃し、最も近い敵が生存していれば追撃と与ダメージ減デバフを加える",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_JUNKA_CHILDHOOD_AS1" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_AS1_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_AS1_DAMAGE",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_AS1_DAMAGE",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_AS1_DAMAGE_EXTRA",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_AS1_DEBUFF",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -976,
        "enemy:left": -742,
        "enemy:back": -742,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_AS1_DEBUFF",
          magnitude: -0.2,
          timeLimit: {
            unit: "ACTION",
            count: 1,
          },
        },
      ],
      resources: [
        {
          unitId: "ally:subject",
          resource: "AP",
          delta: -1,
        },
        {
          unitId: "ally:subject",
          resource: "EX_GAUGE",
          delta: 1,
        },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_JUNKA_CHILDHOOD_AS1",
          remaining: 2,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_JUNKA_CHILDHOOD_AS1",
    intent: "同上: 最も近い敵を倒し切った場合は追撃を行わない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_JUNKA_CHILDHOOD_AS1" },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 1 },
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, state: { currentHp: 1 } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" }, state: { currentHp: 1 } },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_AS1_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_AS1_DAMAGE",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_AS1_DAMAGE",
          targets: ["enemy:back"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1,
        "enemy:left": -1,
        "enemy:back": -1,
      },
      resources: [
        {
          unitId: "ally:subject",
          resource: "AP",
          delta: -1,
        },
        {
          unitId: "ally:subject",
          resource: "EX_GAUGE",
          delta: 1,
        },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_JUNKA_CHILDHOOD_AS1",
          remaining: 2,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_JUNKA_CHILDHOOD_AS2",
    intent: "敵単体へ威力53で4ヒット攻撃する（対象が生き残ればAP回復はしない）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_JUNKA_CHILDHOOD_AS2" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_AS2_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1060,
      },
      resources: [
        {
          unitId: "ally:subject",
          resource: "AP",
          delta: -1,
        },
        {
          unitId: "ally:subject",
          resource: "EX_GAUGE",
          delta: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_JUNKA_CHILDHOOD_AS2",
    intent: "同上: この攻撃で敵を倒した場合、自身のAPを1回復する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_JUNKA_CHILDHOOD_AS2" },
    board: {
      subject: { state: { currentAp: 2 } },
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 1 },
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, state: { currentHp: 1 } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" }, state: { currentHp: 1 } },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_AS2_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_AS2_AP_UP",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1,
      },
      resources: [
        {
          unitId: "ally:subject",
          resource: "EX_GAUGE",
          delta: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_JUNKA_CHILDHOOD_PS1",
    intent: "自身がASで攻撃する前に発動し、自身へ攻防+5%、自身を除く味方全体へ攻防+2.5%を付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_JUNKA_CHILDHOOD_PS1",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:subject",
    },
    board: { subject: { state: { currentHp: 8000 } } },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS1_ATK_UP_SELF",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS1_DEF_UP_SELF",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS1_ATK_UP_OTHERS",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS1_DEF_UP_OTHERS",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS1_ATK_UP_OTHERS",
          targets: ["ally:back"],
        },
        {
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS1_DEF_UP_OTHERS",
          targets: ["ally:back"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS1_ATK_UP_SELF",
          magnitude: 0.05,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS1_DEF_UP_SELF",
          magnitude: 0.05,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS1_ATK_UP_OTHERS",
          magnitude: 0.025,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS1_DEF_UP_OTHERS",
          magnitude: 0.025,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS1_ATK_UP_OTHERS",
          magnitude: 0.025,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS1_DEF_UP_OTHERS",
          magnitude: 0.025,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
      ],
      resources: [
        {
          unitId: "ally:subject",
          resource: "PP",
          delta: -1,
        },
        {
          unitId: "ally:subject",
          resource: "EX_GAUGE",
          delta: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_JUNKA_CHILDHOOD_PS1",
    intent: "(不成立): 自身のHPが60%未満の場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_JUNKA_CHILDHOOD_PS1",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:subject",
    },
    board: { subject: { state: { currentHp: 5000 } } },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_JUNKA_CHILDHOOD_PS2",
    intent: "アクティブスキルを3回使用するたびに発動し、自身を回復して味方全体へ継続回復を付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_JUNKA_CHILDHOOD_PS2",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:subject",
    },
    board: {
      subject: {
        state: {
          skillCounters: {
            [createSkillDefinitionId("SKL_JUNKA_CHILDHOOD_PS2")]: {
              [createRuntimeCounterId("SKL_JUNKA_CHILDHOOD_PS2_TRIGGER_COUNT")]: {
                value: 2,
                carry: 0,
              },
            },
          },
        },
      },
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS2_HEAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS2_CONTINUOUS_HEAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS2_CONTINUOUS_HEAL",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS2_CONTINUOUS_HEAL",
          targets: ["ally:back"],
        },
      ],
      hpDeltas: {
        "ally:subject": 250,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS2_CONTINUOUS_HEAL",
          magnitude: 0.15,
          timeLimit: {
            unit: "ACTION",
            count: 2,
          },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS2_CONTINUOUS_HEAL",
          magnitude: 0.15,
          timeLimit: {
            unit: "ACTION",
            count: 2,
          },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS2_CONTINUOUS_HEAL",
          magnitude: 0.15,
          timeLimit: {
            unit: "ACTION",
            count: 2,
          },
        },
      ],
      resources: [
        {
          unitId: "ally:subject",
          resource: "PP",
          delta: -1,
        },
        {
          unitId: "ally:subject",
          resource: "EX_GAUGE",
          delta: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_JUNKA_CHILDHOOD_PS2",
    intent: "(不成立): 使用回数が3回に達していなければ発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_JUNKA_CHILDHOOD_PS2",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_JUNKA_CHILDHOOD_EX",
    intent: "自身へ2行動の与ダメージ+60%と、攻撃力×100%（2回まで）のシールドを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_JUNKA_CHILDHOOD_EX" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_EX_DMG_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_EX_SHIELD",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_EX_DMG_UP",
          magnitude: 0.6,
          timeLimit: {
            unit: "ACTION",
            count: 2,
          },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_EX_SHIELD",
          magnitude: 1000,
          consumption: {
            kind: "INCOMING_HIT",
            maxCount: 2,
          },
        },
      ],
    },
  },
];

describe("production Catalog UNIT_JUNKA_CHILDHOOD (【唯一無二の幼なじみ】鑑純夏)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-JUNKA-CHILDHOOD-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-JUNKA-CHILDHOOD-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-JUNKA-CHILDHOOD-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
    // 全ID網羅監査（`UT-AUDIT-UNITCOV-001`）は「IDが文字列として書かれているか」しか
    // 見ないため、表に載っているだけで一度も実行されない定義を見逃す。実行された
    // 集合そのものを閉包と突き合わせる。表をこのテスト内で回し直すのは、
    // 収集器がモジュール全域の状態であり、テストファイル間の isolation 設定に
    // 結果を依存させないため。
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
