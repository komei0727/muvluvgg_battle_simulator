import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import {
  BOARD_COMBAT_STATS,
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  resetExecutedActionIds,
  type BoardUnitSpec,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { realDamage, turnStarted } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_CHIZURU_DOMESTIC`（【ドメスティックなリーダー】榊千鶴）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_CHIZURU_DOMESTIC";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const ANTIGRAV = "MARKER_CHIZURU_DOMESTIC_ANTIGRAV";

/** 敵後列だけ最大HPを下げた配置（`LOWEST_MAX_HP`が既定順と別の敵を選ぶことを作る）。 */
const LOWEST_MAX_HP_BACK: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  {
    id: "enemy:back",
    position: { column: "CENTER", row: "BACK" },
    state: { combatStats: { ...BOARD_COMBAT_STATS, maximumHp: 8000 } },
  },
];

/** 累計で最大HP×85%（8500ダメージ）に達する一撃。耐えられるHPから受ける。 */
const CUMULATIVE_THRESHOLD_HIT = realDamage({
  from: "enemy:front",
  to: "ally:subject",
  skillType: "AS",
  power: 17,
});

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_CHIZURU_DOMESTIC_EX",
    intent:
      "前列を優先し、敵横一列に威力117で攻撃する。さらに与えたダメージの70%分自身のHPを回復する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIZURU_DOMESTIC_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_EX_HEAL", targets: ["ally:subject"] },
      ],
      // 前列優先の基準敵と同じ行＝敵前列2体。回復は与えた合計1170の70%。
      hpDeltas: {
        "ally:subject": 819,
        "enemy:front": -585,
        "enemy:left": -585,
      },
    },
  },
  {
    skillDefinitionId: "SKL_CHIZURU_DOMESTIC_AS1",
    intent: "敵2体に威力95.4で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIZURU_DOMESTIC_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_AS1_DAMAGE", targets: ["enemy:left"] },
      ],
      hpDeltas: {
        "enemy:front": -477,
        "enemy:left": -477,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIZURU_DOMESTIC_AS1",
    intent: "自身が「反重力おさげ」を所持していた場合、さらに1行動の気絶を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIZURU_DOMESTIC_AS1" },
    board: { subject: { markers: [{ markerId: ANTIGRAV }] } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_AS1_STUN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_AS1_STUN", targets: ["enemy:left"] },
      ],
      hpDeltas: {
        "enemy:front": -477,
        "enemy:left": -477,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_AS1_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_AS1_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIZURU_DOMESTIC_PS1",
    intent:
      "ターン開始時に発動。最大HPが最も低い敵単体に威力50で先制攻撃する。さらに対象と自身の間にリンクを付与し、1ターンの間自身が受けたダメージの35%を対象に送り込む状態にする",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIZURU_DOMESTIC_PS1",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    board: { enemies: LOWEST_MAX_HP_BACK },
    expected: {
      // 既定順では敵前列が先だが、最大HPが最も低い敵後列が対象になる。
      actions: [
        { effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_PS1_DAMAGE", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_PS1_DAMAGE_LINK",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "enemy:back": -250,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_PS1_DAMAGE_LINK",
          magnitude: 0.35,
          timeLimit: { unit: "TURN", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_CHIZURU_DOMESTIC_PS1", remaining: 99 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIZURU_DOMESTIC_PS1",
    intent: "(不成立): このスキルは戦闘中に1度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIZURU_DOMESTIC_PS1",
      trigger: turnStarted({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    board: {
      subject: {
        state: {
          skillCounters: {
            [createSkillDefinitionId("SKL_CHIZURU_DOMESTIC_PS1")]: {
              [createRuntimeCounterId("SKL_CHIZURU_DOMESTIC_PS1_ACTIVATIONS")]: {
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
    skillDefinitionId: "SKL_CHIZURU_DOMESTIC_PS2",
    intent:
      "自身がアクティブスキルで攻撃される直前に発動。自身に対し、致死ダメージを1度だけ耐えてHPを最大HP×75%回復するバフを付与する。さらに自身の最大HPを30%上昇させる（解除不可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIZURU_DOMESTIC_PS2",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:subject",
        skillType: "AS",
        event: "UnitBeingAttacked",
      }),
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_PS2_DEATH_SURVIVAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_PS2_MAXHP_UP",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_PS2_DEATH_SURVIVAL",
          magnitude: 0,
          timeLimit: { unit: "BATTLE", count: 1 },
          consumption: { kind: "LETHAL_DAMAGE", maxCount: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_PS2_MAXHP_UP",
          magnitude: 0.3,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_CHIZURU_DOMESTIC_PS2", remaining: 99 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIZURU_DOMESTIC_PS2",
    intent: "(不成立): EXスキルで攻撃される直前では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIZURU_DOMESTIC_PS2",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:subject",
        skillType: "EX",
        event: "UnitBeingAttacked",
      }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_CHIZURU_DOMESTIC_PS3",
    intent:
      "累計で最大HP×85%のダメージを受けた際に発動。自身に最も近い敵単体に対し、次の攻撃での与ダメージを65%減少させるデバフと、1行動の気絶を付与する。さらに自身に対し、1行動の間受けるダメージを無効にする効果と、1行動の「反重力おさげ」を付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIZURU_DOMESTIC_PS3",
      trigger: CUMULATIVE_THRESHOLD_HIT,
    },
    // 8500ダメージを耐えて発動できるよう、満タンから受ける。
    board: { subject: { state: { currentHp: 10000 } } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_PS3_DMG_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_PS3_STUN", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_PS3_IMMUNITY",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_PS3_MARKER", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_PS3_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "DAMAGE_IMMUNITY",
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_PS3_DMG_DOWN",
          magnitude: -0.65,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CHIZURU_DOMESTIC_PS3_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: ANTIGRAV, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIZURU_DOMESTIC_PS3",
    intent: "(不成立): 累計が最大HP×85%に達していないダメージでは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIZURU_DOMESTIC_PS3",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:subject",
        skillType: "AS",
        power: 8,
      }),
    },
    board: { subject: { state: { currentHp: 10000 } } },
    expected: {
      activated: false,
    },
  },
];

describe("production Catalog UNIT_CHIZURU_DOMESTIC (【ドメスティックなリーダー】榊千鶴)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-CHIZURU-DOMESTIC-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-CHIZURU-DOMESTIC-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-CHIZURU-DOMESTIC-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
