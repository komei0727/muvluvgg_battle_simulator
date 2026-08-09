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
  type BoardOverrides,
  type BoardUnitSpec,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { turnCompleting, unitDefeated } from "../../../testing/production-unit/trigger-events.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";

/**
 * `UNIT_RAVEL_MODEL`(【気高きランウェイモデル】レイヴェル・ブライトリーフ)のユニット
 * 単位production結合テスト(`12_テスト戦略.md`「ユニット効果軸」)。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_RAVEL_MODEL";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const TARGET_MARKER = "MARKER_RAVEL_MODEL_TARGET";

/** 既定対象の敵へ「ターゲット」をN個持たせた盤面。AS1の個数分岐の判別用。 */
function enemiesWithTargetMarkers(stackCount: number): readonly BoardUnitSpec[] {
  return [
    {
      id: "enemy:front",
      position: { column: "CENTER", row: "FRONT" },
      markers: [{ markerId: TARGET_MARKER, stackCount }],
    },
    { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
    { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
  ];
}

/** 会心を必ず発生させる盤面と抽選列。AS2の会心分岐の判別用。 */
const ALWAYS_CRITICAL: BoardOverrides = { combatStats: { criticalRate: 1 } };

function critical(): SequenceRandomSource {
  return new SequenceRandomSource(new Array<number>(64).fill(0));
}

/**
 * 「ターゲット」を持ち、削れるEXゲージも持つ敵陣。PS2の対象抽出（`HAS_MARKER`）と
 * EXゲージ減少の両方を判別できるようにする。
 */
const MARKED_ENEMIES_WITH_EX: readonly BoardUnitSpec[] = [
  {
    id: "enemy:front",
    position: { column: "CENTER", row: "FRONT" },
    state: { currentExtraGauge: 3 },
    markers: [{ markerId: TARGET_MARKER, stackCount: 1 }],
  },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, state: { currentExtraGauge: 3 } },
  {
    id: "enemy:back",
    position: { column: "CENTER", row: "BACK" },
    state: { currentExtraGauge: 3 },
    markers: [{ markerId: TARGET_MARKER, stackCount: 2 }],
  },
];

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_RAVEL_MODEL_EX",
    intent:
      "敵全体に威力85.8で攻撃し、「ターゲット」を1つ付与する。さらに次の攻撃で受ける被ダメージを20%増加させるデバフを付与する(重複可)",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAVEL_MODEL_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_EX_MARK", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_EX_DMG_UP_DEBUFF", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_EX_MARK", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_EX_DMG_UP_DEBUFF", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_EX_MARK", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_EX_DMG_UP_DEBUFF", targets: ["enemy:back"] },
      ],
      hpDeltas: { "enemy:front": -429, "enemy:left": -429, "enemy:back": -429 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_RAVEL_MODEL_EX_DMG_UP_DEBUFF",
          magnitude: 0.2,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_RAVEL_MODEL_EX_DMG_UP_DEBUFF",
          magnitude: 0.2,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_RAVEL_MODEL_EX_DMG_UP_DEBUFF",
          magnitude: 0.2,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
      markers: [
        { unitId: "enemy:front", markerId: TARGET_MARKER, stackCount: 1 },
        { unitId: "enemy:left", markerId: TARGET_MARKER, stackCount: 1 },
        { unitId: "enemy:back", markerId: TARGET_MARKER, stackCount: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAVEL_MODEL_AS1",
    intent: "敵単体に威力116.6で攻撃する(対象に「ターゲット」が付与されていない場合)",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAVEL_MODEL_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_AS1_DAMAGE_T0", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -583 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_RAVEL_MODEL_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAVEL_MODEL_AS1",
    intent: "1つ：この攻撃のダメージは10%増加する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAVEL_MODEL_AS1" },
    board: { enemies: enemiesWithTargetMarkers(1) },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_AS1_DAMAGE_T1", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -641 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_RAVEL_MODEL_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAVEL_MODEL_AS1",
    intent: "2つ：この攻撃のダメージは20%増加する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAVEL_MODEL_AS1" },
    board: { enemies: enemiesWithTargetMarkers(2) },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_AS1_DAMAGE_T2", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -699 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_RAVEL_MODEL_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAVEL_MODEL_AS1",
    intent:
      "3つ以上：この攻撃のダメージは30%増加し、1行動の炎上を付与する。炎上は攻撃力×30%の持続ダメージを与える",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAVEL_MODEL_AS1" },
    board: { enemies: enemiesWithTargetMarkers(3) },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_AS1_DAMAGE_T3", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_AS1_BURN", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -757 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_RAVEL_MODEL_AS1_BURN",
          magnitude: 300,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_RAVEL_MODEL_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAVEL_MODEL_AS2",
    intent: "敵単体に威力120.48で攻撃する(会心が発生しなかった場合)",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAVEL_MODEL_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_AS2_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -602 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAVEL_MODEL_AS2",
    intent: "この攻撃で会心攻撃が発生した場合、対象に「ターゲット」を1つ付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAVEL_MODEL_AS2" },
    board: ALWAYS_CRITICAL,
    random: critical,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_AS2_MARK_CRIT", targets: ["enemy:front"] },
      ],
      // 会心（基本1.5倍 + 会心ダメージ+50%）が乗って1204。
      hpDeltas: { "enemy:front": -1204 },
      markers: [{ unitId: "enemy:front", markerId: TARGET_MARKER, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAVEL_MODEL_AS2",
    intent: "さらに攻撃対象が「ターゲット」を3つ以上付与されていた場合、1行動分の気絶を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAVEL_MODEL_AS2" },
    board: { ...ALWAYS_CRITICAL, enemies: enemiesWithTargetMarkers(3) },
    random: critical,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_AS2_MARK_CRIT", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_AS2_STUN", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -1204 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_RAVEL_MODEL_AS2_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
      ],
      markers: [{ unitId: "enemy:front", markerId: TARGET_MARKER, stackCount: 4 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAVEL_MODEL_PS1",
    intent:
      "他の味方が敵に倒された際に発動。味方を倒した敵に対して威力70.2で攻撃して、「ターゲット」を1つ付与し、対象が次の攻撃で受けるダメージを30%増加させるデバフを付与する(重複可)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_RAVEL_MODEL_PS1",
      trigger: unitDefeated({ unit: "ally:front", defeatedBy: "enemy:left" }),
      triggeredBy: "enemy:left",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_PS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_PS1_MARK", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_PS1_DMG_UP_DEBUFF", targets: ["enemy:left"] },
      ],
      hpDeltas: { "enemy:left": -351 },
      effectsApplied: [
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_RAVEL_MODEL_PS1_DMG_UP_DEBUFF",
          magnitude: 0.3,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
      markers: [{ unitId: "enemy:left", markerId: TARGET_MARKER, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAVEL_MODEL_PS1",
    intent: "(不成立): 敵が倒された際には発動しない(「味方が敵に倒された際」に限る)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_RAVEL_MODEL_PS1",
      trigger: unitDefeated({ unit: "enemy:left", defeatedBy: "ally:front" }),
      triggeredBy: "ally:front",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_RAVEL_MODEL_PS2",
    intent:
      "ターン終了時に発動。「ターゲット」を付与された敵全員に対してEXゲージを1つ削り、対象が2回行動を終えるまでの間、防御力を30%低下させる",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_RAVEL_MODEL_PS2",
      trigger: turnCompleting({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    board: { enemies: MARKED_ENEMIES_WITH_EX },
    expected: {
      // 「ターゲット」を持たない enemy:left は対象に入らない。
      actions: [
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_PS2_EX_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_PS2_DEF_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_PS2_EX_DOWN", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_RAVEL_MODEL_PS2_DEF_DOWN", targets: ["enemy:back"] },
      ],
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_RAVEL_MODEL_PS2_DEF_DOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_RAVEL_MODEL_PS2_DEF_DOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "enemy:front", resource: "EX_GAUGE", delta: -1 },
        { unitId: "enemy:back", resource: "EX_GAUGE", delta: -1 },
      ],
    },
  },
];

describe("production Catalog UNIT_RAVEL_MODEL (【気高きランウェイモデル】レイヴェル・ブライトリーフ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-RAVEL-MODEL-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-RAVEL-MODEL-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-RAVEL-MODEL-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
