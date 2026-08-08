import { describe, expect, it } from "vitest";
import { createSkillDefinitionId } from "../../../domain/catalog/definitions/catalog-ids.js";
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
import { criticalCheckResolved } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_SAYA_BUNNY`（【発情バニー】紫雲沙耶）のユニット単位production結合テスト
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

const UNIT_DEFINITION_ID = "UNIT_SAYA_BUNNY";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_SAYA_BUNNY_AS1",
    intent: "オッドイーブン: 敵単体へ威力156で1ヒット、威力109.2でもう1ヒットし与ダメージ減デバフ",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SAYA_BUNNY_AS1" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_SAYA_BUNNY_AS1_DAMAGE_HIT1",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_SAYA_BUNNY_AS1_DEBUFF",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_SAYA_BUNNY_AS1_DAMAGE_HIT2",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1326,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SAYA_BUNNY_AS1_DEBUFF",
          magnitude: -0.3,
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
          skillDefinitionId: "SKL_SAYA_BUNNY_AS1",
          remaining: 4,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SAYA_BUNNY_AS1",
    intent: "同上: 自身に「グッドラック」があるとき、2ヒット目の威力は156になる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SAYA_BUNNY_AS1" },
    board: { subject: { markers: [{ markerId: "MARKER_GOOD_LUCK" }] } },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_SAYA_BUNNY_AS1_DAMAGE_HIT1",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_SAYA_BUNNY_AS1_DEBUFF",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_SAYA_BUNNY_AS1_DAMAGE_HIT2_BOOSTED",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1560,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SAYA_BUNNY_AS1_DEBUFF",
          magnitude: -0.3,
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
          skillDefinitionId: "SKL_SAYA_BUNNY_AS1",
          remaining: 4,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SAYA_BUNNY_AS2",
    intent: "ハイローベット: 残りHPが少ない順に敵3体へ威力109.2で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SAYA_BUNNY_AS2" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_SAYA_BUNNY_AS2_CRIT_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_SAYA_BUNNY_AS2_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_SAYA_BUNNY_AS2_DAMAGE",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_SAYA_BUNNY_AS2_DAMAGE",
          targets: ["enemy:back"],
        },
      ],
      hpDeltas: {
        "enemy:front": -546,
        "enemy:left": -546,
        "enemy:back": -546,
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
          skillDefinitionId: "SKL_SAYA_BUNNY_AS2",
          remaining: 2,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SAYA_BUNNY_AS2",
    intent: "同上: 最も残りHPが少ない対象のHPが60%以下なら、この攻撃の会心率が15%上昇する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SAYA_BUNNY_AS2" },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 3000 },
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_SAYA_BUNNY_AS2_CRIT_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_SAYA_BUNNY_AS2_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_SAYA_BUNNY_AS2_DAMAGE",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_SAYA_BUNNY_AS2_DAMAGE",
          targets: ["enemy:back"],
        },
      ],
      hpDeltas: {
        "enemy:front": -546,
        "enemy:left": -546,
        "enemy:back": -546,
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
          skillDefinitionId: "SKL_SAYA_BUNNY_AS2",
          remaining: 2,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SAYA_BUNNY_AS3",
    intent: "ストレートアップ: 敵単体へ威力265で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SAYA_BUNNY_AS3" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_SAYA_BUNNY_AS3_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1325,
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
    skillDefinitionId: "SKL_SAYA_BUNNY_PS1",
    intent: "ジャックポット: 自身の攻撃が会心になるたびに会心率+2.5%・会心ダメージ+8.75%",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SAYA_BUNNY_PS1",
      trigger: criticalCheckResolved({
        source: "ally:subject",
        target: "enemy:front",
        result: true,
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_SAYA_BUNNY_PS1_CRIT_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_SAYA_BUNNY_PS1_CRIT_DMG_UP",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SAYA_BUNNY_PS1_CRIT_UP",
          magnitude: 0.025,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SAYA_BUNNY_PS1_CRIT_DMG_UP",
          magnitude: 0.0875,
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
    skillDefinitionId: "SKL_SAYA_BUNNY_PS1",
    intent: "(不成立): 会心になったのが自身の攻撃でなければ発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SAYA_BUNNY_PS1",
      trigger: criticalCheckResolved({ source: "ally:front", target: "enemy:front", result: true }),
      triggeredBy: "ally:front",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_SAYA_BUNNY_EX",
    intent:
      "バニー＆ベット: 最も近い敵へ威力339.2、対象を除く敵全体へ威力48.75で4ヒット。自身へグッドラックを付与しオッドイーブンのCTをリセットする",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SAYA_BUNNY_EX" },
    board: {
      subject: {
        state: {
          cooldowns: {
            [createSkillDefinitionId("SKL_SAYA_BUNNY_AS1")]: { unit: "ACTION", remaining: 2 },
          },
        },
      },
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_SAYA_BUNNY_EX_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_SAYA_BUNNY_EX_DAMAGE_EXTRA",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_SAYA_BUNNY_EX_DAMAGE_EXTRA",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_SAYA_BUNNY_EX_MARKER",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_SAYA_BUNNY_EX_CD_RESET",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1696,
        "enemy:left": -972,
        "enemy:back": -972,
      },
      markers: [
        {
          unitId: "ally:subject",
          markerId: "MARKER_GOOD_LUCK",
          stackCount: 1,
        },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_SAYA_BUNNY_AS1",
          remaining: 0,
        },
      ],
    },
  },
];

describe("production Catalog UNIT_SAYA_BUNNY (【発情バニー】紫雲沙耶)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-SAYA-BUNNY-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-SAYA-BUNNY-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-SAYA-BUNNY-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
