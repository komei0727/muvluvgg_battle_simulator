import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
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
import {
  skillUseCompleted,
  turnCompleting,
} from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_MERU_SIRIUS`（【シリウスシュガーのエース】桃園める）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_MERU_SIRIUS";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** 攻撃力が1体だけ高い敵陣。`HIGHEST_ATTACK` の判別用。 */
const ENEMY_WITH_HIGHEST_ATTACK: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  {
    id: "enemy:left",
    position: { column: "LEFT", row: "FRONT" },
    state: { combatStats: { ...BOARD_COMBAT_STATS, attack: 2000 } },
  },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** HP割合が最も低い敵。5ヒット後も30%を割らない位置に置く。 */
const ENEMY_LOWEST_ABOVE_THRESHOLD: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, state: { currentHp: 9000 } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, state: { currentHp: 9000 } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** HP32%の敵。5ヒットでちょうど30%を割る。 */
const ENEMY_LOWEST_CROSSING_THRESHOLD: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, state: { currentHp: 9000 } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, state: { currentHp: 9000 } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" }, state: { currentHp: 3200 } },
];

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_MERU_SIRIUS_EX",
    intent:
      "敵全体に威力117で攻撃し、2攻撃の間、被ダメージを50%増加させるデバフを付与する（重複可）。さらに最も攻撃力の高い敵単体に対し、1行動分の気絶を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_SIRIUS_EX" },
    board: { enemies: ENEMY_WITH_HIGHEST_ATTACK },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MERU_SIRIUS_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MERU_SIRIUS_EX_DMG_UP", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MERU_SIRIUS_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MERU_SIRIUS_EX_DMG_UP", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MERU_SIRIUS_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_MERU_SIRIUS_EX_DMG_UP", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_MERU_SIRIUS_EX_STUN", targets: ["enemy:left"] },
      ],
      // 被ダメージ増加は各対象の攻撃の**後**に付くため、このEX自身のダメージには乗らない。
      hpDeltas: {
        "enemy:front": -585,
        "enemy:left": -585,
        "enemy:back": -585,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_MERU_SIRIUS_EX_DMG_UP",
          magnitude: 0.5,
          timeLimit: { unit: "HIT", count: 2 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_MERU_SIRIUS_EX_DMG_UP",
          magnitude: 0.5,
          timeLimit: { unit: "HIT", count: 2 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_MERU_SIRIUS_EX_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_MERU_SIRIUS_EX_DMG_UP",
          magnitude: 0.5,
          timeLimit: { unit: "HIT", count: 2 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_SIRIUS_AS1",
    intent: "最もHP割合の低い敵単体に威力28.08で5ヒット攻撃する（HPが30%を下回らない場合）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_SIRIUS_AS1" },
    board: { enemies: ENEMY_LOWEST_ABOVE_THRESHOLD },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MERU_SIRIUS_AS1_DAMAGE", targets: ["enemy:back"] },
      ],
      // 1ヒット140（切り捨て）×5。残HP4300（43%）で追撃条件を満たさない。
      hpDeltas: { "enemy:back": -700 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MERU_SIRIUS_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_SIRIUS_AS1",
    intent: "この攻撃によって対象のHPが30%を下回った場合、追加で威力75の攻撃を行う",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_SIRIUS_AS1" },
    board: { enemies: ENEMY_LOWEST_CROSSING_THRESHOLD },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MERU_SIRIUS_AS1_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_MERU_SIRIUS_AS1_DAMAGE_EXTRA", targets: ["enemy:back"] },
      ],
      // 32%から5ヒット700で25%へ落ちるため追撃375が乗る。
      hpDeltas: { "enemy:back": -1075 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MERU_SIRIUS_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_SIRIUS_AS2",
    intent: "敵単体に威力78で攻撃する。敵のHPが少ないほどダメージが増加する(+200%まで)",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_SIRIUS_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MERU_SIRIUS_AS2_DAMAGE", targets: ["enemy:front"] },
      ],
      // 基礎390に、HP割合50%ぶんの増加（上限+200%の半分＝+100%）が乗る。
      hpDeltas: { "enemy:front": -780 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_SIRIUS_AS2",
    intent: "（満HPの敵では）増加が乗らず基礎ダメージのままになる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_SIRIUS_AS2" },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 10000 },
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MERU_SIRIUS_AS2_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -390 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_SIRIUS_PS1",
    intent:
      "他の味方がアクティブスキルで攻撃した後に発動。味方が攻撃した敵単体に威力85.8で追撃する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MERU_SIRIUS_PS1",
      trigger: skillUseCompleted({
        actor: "ally:front",
        targets: ["enemy:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:front",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MERU_SIRIUS_PS1_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -429 },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MERU_SIRIUS_PS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_SIRIUS_PS1",
    intent: "対象のHPが30%以下だった場合、この攻撃の与ダメージが60%増加する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MERU_SIRIUS_PS1",
      trigger: skillUseCompleted({
        actor: "ally:front",
        targets: ["enemy:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:front",
    },
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
          effectActionDefinitionId: "ACT_MERU_SIRIUS_PS1_DAMAGE_BOOSTED",
          targets: ["enemy:front"],
        },
      ],
      // 429の+60%で686（切り捨て）。
      hpDeltas: { "enemy:front": -686 },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MERU_SIRIUS_PS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_SIRIUS_PS1",
    intent: "(不成立): 自身のAS使用では発動しない（「他の味方が」攻撃した場合に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MERU_SIRIUS_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_MERU_SIRIUS_PS1",
    intent: "(不成立): 味方のEXスキル使用では発動しない（「アクティブスキルで」に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MERU_SIRIUS_PS1",
      trigger: skillUseCompleted({
        actor: "ally:front",
        targets: ["enemy:front"],
        skillType: "EX",
      }),
      triggeredBy: "ally:front",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_MERU_SIRIUS_PS2",
    intent:
      "ターン終了時に発動。最も攻撃力が高い敵単体に威力156で攻撃し、2行動の間与ダメージを45%減少させるデバフを付与する(重複可)。このスキルは2の倍数ターンごとに発動する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MERU_SIRIUS_PS2",
      trigger: turnCompleting({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    board: { enemies: ENEMY_WITH_HIGHEST_ATTACK },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MERU_SIRIUS_PS2_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MERU_SIRIUS_PS2_DMG_DOWN", targets: ["enemy:left"] },
      ],
      hpDeltas: { "enemy:left": -780 },
      effectsApplied: [
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_MERU_SIRIUS_PS2_DMG_DOWN",
          magnitude: -0.45,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MERU_SIRIUS_PS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_SIRIUS_PS2",
    intent: "(不成立): 奇数ターンの終了時には発動しない（2の倍数ターンごとに限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MERU_SIRIUS_PS2",
      trigger: turnCompleting({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
      turnNumber: 1,
    },
    board: { enemies: ENEMY_WITH_HIGHEST_ATTACK },
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_MERU_SIRIUS (【シリウスシュガーのエース】桃園める)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-MERU-SIRIUS-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-MERU-SIRIUS-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-MERU-SIRIUS-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
