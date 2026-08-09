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
  type BoardUnitSpec,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { turnStarted, unitBeingAttacked } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_LUCIE_MAID`（【忠義の狂犬メイド】リュシー・ムーアクロフト）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_LUCIE_MAID";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** 「敵前後列」は基準敵と同じ列（縦）の敵。既定盤面ではCENTER列の前列・後列2体。 */
const ENERGY_ENEMIES: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, unitType: "ENERGY" },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, unitType: "ENERGY" },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" }, unitType: "ENERGY" },
];

/**
 * 同じ「敵前後列」（CENTER列）に物理型とEN型が混ざる盤面。対象別条件が対象ごとに
 * 評価されることは、集合が同じ型で揃っていると当たり外れの差として現れない。
 */
const MIXED_TYPE_ENEMIES: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, unitType: "PHYSICAL" },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, unitType: "ENERGY" },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" }, unitType: "ENERGY" },
];

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_LUCIE_MAID_EX",
    intent:
      "敵前後列に威力54.6で3ヒット攻撃する。さらに自身の攻撃力を2行動の間30%上昇させ(重複可)、2行動の間デバフを無効化するバフを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LUCIE_MAID_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LUCIE_MAID_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LUCIE_MAID_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_LUCIE_MAID_EX_ATK_UP", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_LUCIE_MAID_EX_DEBUFF_IMMUNITY",
          targets: ["ally:subject"],
        },
      ],
      // 1ヒット273（(1000-500)×54.6%）×3ヒット。
      hpDeltas: {
        "enemy:front": -819,
        "enemy:back": -819,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LUCIE_MAID_EX_ATK_UP",
          magnitude: 0.3,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LUCIE_MAID_EX_DEBUFF_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LUCIE_MAID_AS1",
    intent:
      "敵前後列に威力190.76で攻撃し、1行動の間行動速度を150低下させる。さらに対象が物理タイプまたは敏捷タイプだった場合、1行動分の気絶を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LUCIE_MAID_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_SPEED_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_SPEED_DOWN", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_STUN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_STUN", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -953,
        "enemy:back": -953,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_SPEED_DOWN",
          magnitude: -150,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_SPEED_DOWN",
          magnitude: -150,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LUCIE_MAID_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LUCIE_MAID_AS1",
    intent: "(対象): 対象が物理タイプでも敏捷タイプでもない場合、気絶は付与されない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LUCIE_MAID_AS1" },
    board: { enemies: ENERGY_ENEMIES },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_SPEED_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_SPEED_DOWN", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -953,
        "enemy:back": -953,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_SPEED_DOWN",
          magnitude: -150,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_SPEED_DOWN",
          magnitude: -150,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LUCIE_MAID_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LUCIE_MAID_AS2",
    intent: "敵単体に威力140.4で攻撃する。さらに対象に隣接する敵に対し、威力62.4で追加攻撃を行う",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LUCIE_MAID_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LUCIE_MAID_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LUCIE_MAID_AS2_DAMAGE_EXTRA", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_LUCIE_MAID_AS2_DAMAGE_EXTRA", targets: ["enemy:back"] },
      ],
      // 隣接は上下左右のみ。既定盤面ではenemy:front（CENTER FRONT）に対し
      // enemy:left（LEFT FRONT）とenemy:back（CENTER BACK）が該当する。
      hpDeltas: {
        "enemy:front": -702,
        "enemy:left": -312,
        "enemy:back": -312,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LUCIE_MAID_PS1",
    intent: "自身が物理タイプまたは敏捷タイプの敵から攻撃される直前に発動。物理攻撃を75%ガードする",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LUCIE_MAID_PS1",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:subject" }),
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LUCIE_MAID_PS1_GUARD", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LUCIE_MAID_PS1_GUARD",
          magnitude: -0.75,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LUCIE_MAID_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LUCIE_MAID_PS1",
    intent: "(不成立): 物理タイプでも敏捷タイプでもない敵からの攻撃では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LUCIE_MAID_PS1",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:subject" }),
    },
    board: { enemies: ENERGY_ENEMIES },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_LUCIE_MAID_PS2",
    intent:
      "ターン開始時に発動。敵前後列に威力169.6で先制攻撃する。対象が物理タイプまたは敏捷タイプだった場合、PPを1削る",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LUCIE_MAID_PS2",
      trigger: turnStarted({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LUCIE_MAID_PS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LUCIE_MAID_PS2_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_LUCIE_MAID_PS2_PP_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LUCIE_MAID_PS2_PP_DOWN", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -848,
        "enemy:back": -848,
      },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
        { unitId: "enemy:front", resource: "PP", delta: -1 },
        { unitId: "enemy:back", resource: "PP", delta: -1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LUCIE_MAID_PS2",
    intent: "(不成立): このスキルは1ターン目には発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LUCIE_MAID_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
      turnNumber: 1,
    },
    expected: {
      activated: false,
    },
  },
];

describe("production Catalog UNIT_LUCIE_MAID (【忠義の狂犬メイド】リュシー・ムーアクロフト)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-LUCIE-MAID-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-LUCIE-MAID-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-LUCIE-MAID-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-LUCIE-MAID-004 (R-TGT-09): SKL_LUCIE_MAID_AS2's BINDING_DERIVED+ADJACENT_ORTHOGONAL binding reaches only the enemies orthogonally adjacent to the resolved base — an enemy in neither the base's row nor its column takes nothing", () => {
    expect(
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use: { kind: "ACTIVE", skillDefinitionId: "SKL_LUCIE_MAID_AS2" },
        board: {
          enemies: [
            { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
            { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
            { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
            { id: "enemy:far", position: { column: "RIGHT", row: "BACK" } },
          ],
        },
      }),
    ).toEqual({
      actions: [
        { effectActionDefinitionId: "ACT_LUCIE_MAID_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LUCIE_MAID_AS2_DAMAGE_EXTRA", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_LUCIE_MAID_AS2_DAMAGE_EXTRA", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -702,
        "enemy:left": -312,
        "enemy:back": -312,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    });
  });

  it("IT-UNIT-LUCIE-MAID-005 (R-PS-01): SKL_LUCIE_MAID_PS1's trigger condition reads the attacker's UnitDefinition — a PHYSICAL and an AGILE attacker both activate it, an ENERGY one does not", () => {
    const guardedBy = (enemies: readonly BoardUnitSpec[]): boolean =>
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use: {
          kind: "PASSIVE",
          skillDefinitionId: "SKL_LUCIE_MAID_PS1",
          trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:subject" }),
        },
        board: { enemies },
      }).activated !== false;

    const attackerOfType = (
      unitType: NonNullable<BoardUnitSpec["unitType"]>,
    ): readonly BoardUnitSpec[] => [
      { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, unitType },
      { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, unitType: "ENERGY" },
      { id: "enemy:back", position: { column: "CENTER", row: "BACK" }, unitType: "ENERGY" },
    ];

    expect(guardedBy(attackerOfType("PHYSICAL"))).toBe(true);
    expect(guardedBy(attackerOfType("AGILE"))).toBe(true);
    expect(guardedBy(attackerOfType("ENERGY"))).toBe(false);
  });

  it("IT-UNIT-LUCIE-MAID-006 (R-SKL-06): AS1の対象別条件 `OR(UNIT_TYPE PHYSICAL, AGILE)` は同じ対象集合の中で対象ごとに評価され、混在した列では物理型だけが気絶を受け取る（速度低下は全員が受ける）", () => {
    expect(
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use: { kind: "ACTIVE", skillDefinitionId: "SKL_LUCIE_MAID_AS1" },
        board: { enemies: MIXED_TYPE_ENEMIES },
      }),
    ).toEqual({
      actions: [
        { effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_SPEED_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_SPEED_DOWN", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_STUN", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -953,
        "enemy:back": -953,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_SPEED_DOWN",
          magnitude: -150,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_SPEED_DOWN",
          magnitude: -150,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LUCIE_MAID_AS1", remaining: 2 },
      ],
    });
  });

  it("IT-UNIT-LUCIE-MAID-007 (R-SKL-06): PS2の同じ対象別条件も対象ごとに評価され、混在した列では物理型のPPだけが削られる（攻撃は全員が受ける）", () => {
    expect(
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use: {
          kind: "PASSIVE",
          skillDefinitionId: "SKL_LUCIE_MAID_PS2",
          trigger: turnStarted({ turnNumber: 2 }),
          triggeredBy: "ally:subject",
          turnNumber: 2,
        },
        board: { enemies: MIXED_TYPE_ENEMIES },
      }),
    ).toEqual({
      actions: [
        { effectActionDefinitionId: "ACT_LUCIE_MAID_PS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LUCIE_MAID_PS2_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_LUCIE_MAID_PS2_PP_DOWN", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -848,
        "enemy:back": -848,
      },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
        { unitId: "enemy:front", resource: "PP", delta: -1 },
      ],
    });
  });
});
