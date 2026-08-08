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
  criticalCheckResolved,
  turnStarted,
} from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_LAYLA_ENTREPRENEUR`（【戦うアントレプレナー】レイラ・ジェンキンス）のユニット単位production結合テスト
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

const UNIT_DEFINITION_ID = "UNIT_LAYLA_ENTREPRENEUR";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_AS1",
    intent: "敵前後列へ威力187.2で攻撃し、自身の会心率+30%。対象が物理タイプなら追撃はしない側の腕",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_AS1" },
    board: {
      enemies: [
        { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, unitType: "ENERGY" },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, unitType: "ENERGY" },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" }, unitType: "ENERGY" },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_AS1_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_AS1_DAMAGE",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_AS1_CRIT_UP",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "enemy:front": -936,
        "enemy:back": -936,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_AS1_CRIT_UP",
          magnitude: 0.3,
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
          delta: -2,
        },
        {
          unitId: "ally:subject",
          resource: "EX_GAUGE",
          delta: 2,
        },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_AS1",
          remaining: 2,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_AS1",
    intent: "同上: 対象が物理タイプの場合、威力78でもう1回攻撃を行う",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_AS1" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_AS1_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_AS1_DAMAGE",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_AS1_CRIT_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_AS1_DAMAGE_EXTRA",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1326,
        "enemy:back": -936,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_AS1_CRIT_UP",
          magnitude: 0.3,
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
          delta: -2,
        },
        {
          unitId: "ally:subject",
          resource: "EX_GAUGE",
          delta: 2,
        },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_AS1",
          remaining: 2,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_AS2",
    intent: "敵単体へ威力42.4で4ヒット攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_AS2" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_AS2_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -848,
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
    skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_PS1",
    intent: "ターン開始時、自身の会心率+20%と4スキル分の必中バフを付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_PS1",
      trigger: turnStarted({ unit: "ally:subject", turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_PS1_CRIT_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_PS1_GUARANTEED_HIT",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_PS1_CRIT_UP",
          magnitude: 0.2,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_PS1_GUARANTEED_HIT",
          magnitude: 0,
          timeLimit: {
            unit: "SKILL_USE",
            count: 4,
          },
          statusKind: "GUARANTEED_HIT",
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
    skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_PS1",
    intent: "(不成立): このスキルは戦闘中に1度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_PS1",
      trigger: turnStarted({ unit: "ally:subject", turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    board: {
      subject: {
        state: {
          skillCounters: {
            [createSkillDefinitionId("SKL_LAYLA_ENTREPRENEUR_PS1")]: {
              [createRuntimeCounterId("SKL_LAYLA_ENTREPRENEUR_PS1_ACTIVATIONS")]: {
                value: 1,
                carry: 0,
              },
            },
          },
        },
      },
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_PS2",
    intent: "自身の攻撃が4回会心になるたびに発動し、敵単体へ威力159と最大HP×20%のダメージを与える",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_PS2",
      trigger: criticalCheckResolved({
        source: "ally:subject",
        target: "enemy:front",
        result: true,
      }),
      triggeredBy: "ally:subject",
    },
    board: {
      subject: {
        state: {
          skillCounters: {
            [createSkillDefinitionId("SKL_LAYLA_ENTREPRENEUR_PS2")]: {
              [createRuntimeCounterId("SKL_LAYLA_ENTREPRENEUR_PS2_TRIGGER_COUNT")]: {
                value: 3,
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
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_PS2_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_PS2_DAMAGE_MAXHP",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -2795,
      },
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
    skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_PS2",
    intent: "(不成立): 会心にならなかった攻撃では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_PS2",
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
    skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_EX",
    intent: "敵横一列へ威力18.72で12ヒット攻撃し、自身へ次の被攻撃を1度無効にする効果を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_EX" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_EX_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_EX_DAMAGE",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_EX_IMMUNITY",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1116,
        "enemy:left": -1116,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_EX_IMMUNITY",
          magnitude: 0,
          consumption: {
            kind: "NEXT_INCOMING_ATTACK",
            maxCount: 1,
          },
          statusKind: "DAMAGE_IMMUNITY",
        },
      ],
    },
  },
];

describe("production Catalog UNIT_LAYLA_ENTREPRENEUR (【戦うアントレプレナー】レイラ・ジェンキンス)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-LAYLA-ENTREPRENEUR-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-LAYLA-ENTREPRENEUR-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-LAYLA-ENTREPRENEUR-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
