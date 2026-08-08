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
import { turnStarted, unitBeingAttacked } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_ANIS_TROUBLEMAKER`（【愛を求めるトラブルメーカー】アニス・ベネット）のユニット単位production結合テスト
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

const UNIT_DEFINITION_ID = "UNIT_ANIS_TROUBLEMAKER";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_ANIS_TROUBLEMAKER_AS1",
    intent: "敵単体へ威力46.18で4ヒット攻撃する（対象が生き残った場合はバフなし）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ANIS_TROUBLEMAKER_AS1" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_AS1_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -920,
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
          skillDefinitionId: "SKL_ANIS_TROUBLEMAKER_AS1",
          remaining: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ANIS_TROUBLEMAKER_AS1",
    intent: "同上: この攻撃で敵を倒した場合、自身の攻撃力+20%・会心率+30%を得る",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ANIS_TROUBLEMAKER_AS1" },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 1 },
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_AS1_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_AS1_ATK_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_AS1_CRIT_UP",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_AS1_ATK_UP",
          magnitude: 0.2,
          timeLimit: {
            unit: "ACTION",
            count: 1,
          },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_AS1_CRIT_UP",
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
          skillDefinitionId: "SKL_ANIS_TROUBLEMAKER_AS1",
          remaining: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ANIS_TROUBLEMAKER_AS2",
    intent: "後列優先で敵単体へ攻撃する。対象がスマート属性でなければ毒は付かない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ANIS_TROUBLEMAKER_AS2" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_AS2_DAMAGE",
          targets: ["enemy:back"],
        },
      ],
      hpDeltas: {
        "enemy:back": -853,
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
    skillDefinitionId: "SKL_ANIS_TROUBLEMAKER_AS2",
    intent: "後列優先で敵単体へ攻撃し、対象がスマート属性なら2行動分の毒を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ANIS_TROUBLEMAKER_AS2" },
    board: {
      enemies: [
        { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" }, attribute: "SMART" },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_AS2_DAMAGE",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_AS2_POISON",
          targets: ["enemy:back"],
        },
      ],
      hpDeltas: {
        "enemy:back": -853,
      },
      effectsApplied: [
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_AS2_POISON",
          magnitude: 414.70000000000005,
          timeLimit: {
            unit: "ACTION",
            count: 2,
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
    },
  },
  {
    skillDefinitionId: "SKL_ANIS_TROUBLEMAKER_PS1",
    intent: "自身が攻撃される直前に発動し、自身へ1ヒットだけ回避するバフを付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ANIS_TROUBLEMAKER_PS1",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:subject" }),
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_PS1_EVASION",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_PS1_EVASION",
          magnitude: 0,
          timeLimit: {
            unit: "ACTION",
            count: 1,
          },
          consumption: {
            kind: "INCOMING_HIT",
            maxCount: 1,
          },
          statusKind: "EVASION",
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
          skillDefinitionId: "SKL_ANIS_TROUBLEMAKER_PS1",
          remaining: 2,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ANIS_TROUBLEMAKER_PS1",
    intent: "(不成立): 攻撃されたのが自身でなければ発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ANIS_TROUBLEMAKER_PS1",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:front" }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_ANIS_TROUBLEMAKER_PS2",
    intent: "ターン開始時、最も近い敵へ先制攻撃と会心不可デバフ、自身へ回避を与える",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ANIS_TROUBLEMAKER_PS2",
      trigger: turnStarted({ unit: "ally:subject", turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_PS2_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_PS2_CRIT_PREVENTION",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_PS2_EVASION",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1004,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_PS2_EVASION",
          magnitude: 0,
          timeLimit: {
            unit: "ACTION",
            count: 1,
          },
          consumption: {
            kind: "INCOMING_HIT",
            maxCount: 1,
          },
          statusKind: "EVASION",
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_PS2_CRIT_PREVENTION",
          magnitude: 0,
          timeLimit: {
            unit: "ACTION",
            count: 2,
          },
          statusKind: "CRITICAL_PREVENTION",
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
    skillDefinitionId: "SKL_ANIS_TROUBLEMAKER_PS2",
    intent: "(不成立): このスキルは1ターン目には発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ANIS_TROUBLEMAKER_PS2",
      trigger: turnStarted({ unit: "ally:subject", turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_ANIS_TROUBLEMAKER_EX",
    intent: "最もHP割合の低い敵へ攻撃してAPを1削り、味方全体へ1ヒット回避バフを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ANIS_TROUBLEMAKER_EX" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_EX_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_EX_AP_DOWN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_EX_EVASION",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_EX_EVASION",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_EX_EVASION",
          targets: ["ally:back"],
        },
      ],
      hpDeltas: {
        "enemy:front": -753,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_EX_EVASION",
          magnitude: 0,
          timeLimit: {
            unit: "ACTION",
            count: 1,
          },
          consumption: {
            kind: "INCOMING_HIT",
            maxCount: 1,
          },
          statusKind: "EVASION",
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_EX_EVASION",
          magnitude: 0,
          timeLimit: {
            unit: "ACTION",
            count: 1,
          },
          consumption: {
            kind: "INCOMING_HIT",
            maxCount: 1,
          },
          statusKind: "EVASION",
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_ANIS_TROUBLEMAKER_EX_EVASION",
          magnitude: 0,
          timeLimit: {
            unit: "ACTION",
            count: 1,
          },
          consumption: {
            kind: "INCOMING_HIT",
            maxCount: 1,
          },
          statusKind: "EVASION",
        },
      ],
      resources: [
        {
          unitId: "enemy:front",
          resource: "AP",
          delta: -1,
        },
      ],
    },
  },
];

describe("production Catalog UNIT_ANIS_TROUBLEMAKER (【愛を求めるトラブルメーカー】アニス・ベネット)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-ANIS-TROUBLEMAKER-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-ANIS-TROUBLEMAKER-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-ANIS-TROUBLEMAKER-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
