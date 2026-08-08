import { describe, expect, it } from "vitest";
import {} from "../../../domain/catalog/definitions/catalog-ids.js";
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
  turnCompleting,
  unitBeingAttacked,
  unitDefeated,
} from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_DOROTHEA_GRACE`（【ノーブル・グレイス】ドロテア・カークランド）のユニット単位production結合テスト
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

const UNIT_DEFINITION_ID = "UNIT_DOROTHEA_GRACE";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_DOROTHEA_GRACE_AS1",
    intent: "敵単体へ威力233.2で攻撃する。HPを70%以下にできなければ気絶は付かない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_DOROTHEA_GRACE_AS1" },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 10000 },
        },
        {
          id: "enemy:left",
          position: { column: "LEFT", row: "FRONT" },
          state: { currentHp: 10000 },
        },
        {
          id: "enemy:back",
          position: { column: "CENTER", row: "BACK" },
          state: { currentHp: 10000 },
        },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_AS1_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1166,
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
    skillDefinitionId: "SKL_DOROTHEA_GRACE_AS1",
    intent: "同上: この攻撃で対象のHPを70%以下にした場合、1行動分の気絶を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_DOROTHEA_GRACE_AS1" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_AS1_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_AS1_STUN",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1166,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_AS1_STUN",
          magnitude: 0,
          timeLimit: {
            unit: "ACTION",
            count: 1,
          },
          statusKind: "STUN",
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
    },
  },
  {
    skillDefinitionId: "SKL_DOROTHEA_GRACE_PS1",
    intent: "自身が攻撃される直前に発動し、敵の攻撃を75%ガードする",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_DOROTHEA_GRACE_PS1",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:subject" }),
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS1_GUARD",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS1_GUARD",
          magnitude: -0.75,
          consumption: {
            kind: "NEXT_INCOMING_ATTACK",
            maxCount: 1,
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
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_DOROTHEA_GRACE_PS1",
          remaining: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_DOROTHEA_GRACE_PS1",
    intent: "(不成立): 攻撃されたのが自身でなければ発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_DOROTHEA_GRACE_PS1",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:front" }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_DOROTHEA_GRACE_PS2",
    intent: "ターン終了時、味方後列へ攻防バフ。後列のコミカル属性の味方にはEXゲージも加算する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_DOROTHEA_GRACE_PS2",
      trigger: turnCompleting({ unit: "ally:subject", turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    board: {
      allies: [
        { id: "ally:front", position: { column: "LEFT", row: "FRONT" } },
        { id: "ally:back", position: { column: "CENTER", row: "BACK" }, attribute: "COMICAL" },
        { id: "ally:right", position: { column: "RIGHT", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS2_ATK_UP",
          targets: ["ally:back"],
        },
        {
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS2_DEF_UP",
          targets: ["ally:back"],
        },
        {
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS2_ATK_UP",
          targets: ["ally:right"],
        },
        {
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS2_DEF_UP",
          targets: ["ally:right"],
        },
        {
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS2_EX_UP",
          targets: ["ally:back"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS2_ATK_UP",
          magnitude: 0.3,
          timeLimit: {
            unit: "ACTION",
            count: 2,
          },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS2_DEF_UP",
          magnitude: 0.2,
          timeLimit: {
            unit: "ACTION",
            count: 2,
          },
        },
        {
          unitId: "ally:right",
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS2_ATK_UP",
          magnitude: 0.3,
          timeLimit: {
            unit: "ACTION",
            count: 2,
          },
        },
        {
          unitId: "ally:right",
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS2_DEF_UP",
          magnitude: 0.2,
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
        {
          unitId: "ally:back",
          resource: "EX_GAUGE",
          delta: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_DOROTHEA_GRACE_PS2",
    intent: "(不成立): 存在している味方の数が4体未満のときは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_DOROTHEA_GRACE_PS2",
      trigger: turnCompleting({ unit: "ally:subject", turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    board: {
      allies: [{ id: "ally:back", position: { column: "CENTER", row: "BACK" } }],
      enemies: [{ id: "enemy:front", position: { column: "CENTER", row: "FRONT" } }],
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_DOROTHEA_GRACE_PS3",
    intent: "他の味方が倒された際に発動し、味方全体へ攻防バフとEXゲージ加算を与える",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_DOROTHEA_GRACE_PS3",
      trigger: unitDefeated({ unit: "ally:front", defeatedBy: "enemy:front" }),
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS3_ATK_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS3_DEF_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS3_EX_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS3_ATK_UP",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS3_DEF_UP",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS3_EX_UP",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS3_ATK_UP",
          targets: ["ally:back"],
        },
        {
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS3_DEF_UP",
          targets: ["ally:back"],
        },
        {
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS3_EX_UP",
          targets: ["ally:back"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS3_ATK_UP",
          magnitude: 0.1,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS3_DEF_UP",
          magnitude: 0.1,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS3_ATK_UP",
          magnitude: 0.1,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS3_DEF_UP",
          magnitude: 0.1,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS3_ATK_UP",
          magnitude: 0.1,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_PS3_DEF_UP",
          magnitude: 0.1,
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
          delta: 2,
        },
        {
          unitId: "ally:front",
          resource: "EX_GAUGE",
          delta: 1,
        },
        {
          unitId: "ally:back",
          resource: "EX_GAUGE",
          delta: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_DOROTHEA_GRACE_EX",
    intent:
      "自身のデバフを全解除し、敵単体へ威力381.52で攻撃して2行動分の気絶を付与する（対象は生存）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_DOROTHEA_GRACE_EX" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_EX_REMOVE_DEBUFFS",
          targets: ["ally:subject"],
          resultKind: "SKIPPED",
        },
        {
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_EX_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_EX_STUN",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1907,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_EX_STUN",
          magnitude: 0,
          timeLimit: {
            unit: "ACTION",
            count: 2,
          },
          statusKind: "STUN",
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_DOROTHEA_GRACE_EX",
    intent: "同上: この攻撃で対象を倒した場合、自身のAPを1加算する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_DOROTHEA_GRACE_EX" },
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
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_EX_REMOVE_DEBUFFS",
          targets: ["ally:subject"],
          resultKind: "SKIPPED",
        },
        {
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_EX_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_EX_STUN",
          targets: ["enemy:front"],
          resultKind: "SKIPPED",
        },
        {
          effectActionDefinitionId: "ACT_DOROTHEA_GRACE_EX_AP_UP",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1,
      },
      resources: [
        {
          unitId: "ally:subject",
          resource: "AP",
          delta: 1,
        },
      ],
    },
  },
];

describe("production Catalog UNIT_DOROTHEA_GRACE (【ノーブル・グレイス】ドロテア・カークランド)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-DOROTHEA-GRACE-001: $skillDefinitionId — $intent",
    ({ use, board, expected }) => {
      expect(
        observeSkillUse({
          snapshot,
          unitDefinitionId: UNIT_DEFINITION_ID,
          use,
          ...(board === undefined ? {} : { board }),
        }),
      ).toEqual(expected);
    },
  );

  it("IT-UNIT-DOROTHEA-GRACE-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-DOROTHEA-GRACE-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
    // 全ID網羅監査（`UT-AUDIT-UNITCOV-001`）は「IDが文字列として書かれているか」しか
    // 見ないため、表に載っているだけで一度も実行されない定義を見逃す。実行された
    // 集合そのものを閉包と突き合わせる。表をこのテスト内で回し直すのは、
    // 収集器がモジュール全域の状態であり、テストファイル間の isolation 設定に
    // 結果を依存させないため。
    resetExecutedActionIds();
    for (const { use, board } of BEHAVIOURS) {
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use,
        ...(board === undefined ? {} : { board }),
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
