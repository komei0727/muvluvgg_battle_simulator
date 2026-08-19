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
import { realDamage } from "../../../testing/production-unit/trigger-events.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import { observeHitPointRatioCritical } from "../../../testing/production-unit/hit-point-ratio-critical-probe.js";

/**
 * `UNIT_STELLA_STATUE`(【スタチュービューティー】ステラ・ブレーメル)のユニット単位
 * production結合テスト(`12_テスト戦略.md`「ユニット効果軸」)。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_STELLA_STATUE";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const WAKKOU_MARKER = "MARKER_WAKKOU";

/**
 * 確率付与を必ず成立させる抽選列。会心率0の盤面では抽選値0でも会心は発生しない
 * （`0 < 0` は偽）ため、確率だけを当たり側へ倒せる。
 */
function alwaysProc(): SequenceRandomSource {
  return new SequenceRandomSource(new Array<number>(64).fill(0));
}

/** 「惑光」を保持し、PS1の閾値を跨げるHPを持つ敵陣。 */
const MARKED_ENEMIES: readonly BoardUnitSpec[] = [
  {
    id: "enemy:front",
    position: { column: "CENTER", row: "FRONT" },
    state: { currentHp: 4000 },
    markers: [{ markerId: WAKKOU_MARKER, stackCount: 1 }],
  },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** AS2のBRANCHが「惑光」の腕を選ぶ盤面。 */
const MARKED_PRIMARY: BoardOverrides = {
  enemies: [
    {
      id: "enemy:front",
      position: { column: "CENTER", row: "FRONT" },
      markers: [{ markerId: WAKKOU_MARKER, stackCount: 1 }],
    },
    { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
    { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
  ],
};

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_STELLA_STATUE_EX",
    intent:
      "味方全体に対し1行動の間、1ヒットまで100%の確率で攻撃を回避するバフを付与する。さらに敵全体に「惑光」を付与する。…さらに自身にかけられているデバフをすべて解除し、1行動の間、向けられるデバフを無効にするバフを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_STELLA_STATUE_EX" },
    // 解除対象のデバフを実 production 定義（AS1の暗闇）で自身へ用意する。
    precedingActions: [{ effectActionDefinitionId: "ACT_STELLA_STATUE_AS1_BLIND", target: "SELF" }],
    precedingRandom: alwaysProc,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_STELLA_STATUE_EX_EVASION", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_STELLA_STATUE_EX_EVASION", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_STELLA_STATUE_EX_EVASION", targets: ["ally:back"] },
        { effectActionDefinitionId: "ACT_STELLA_STATUE_EX_MARKER", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_STELLA_STATUE_EX_MARKER", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_STELLA_STATUE_EX_MARKER", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_STELLA_STATUE_EX_REMOVE_DEBUFFS",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_STELLA_STATUE_EX_DEBUFF_IMMUNITY",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_STELLA_STATUE_EX_EVASION",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
          statusKind: "EVASION",
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_STELLA_STATUE_EX_DEBUFF_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_STELLA_STATUE_EX_EVASION",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
          statusKind: "EVASION",
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_STELLA_STATUE_EX_EVASION",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
          statusKind: "EVASION",
        },
      ],
      effectsRemoved: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_STELLA_STATUE_AS1_BLIND",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2 },
          statusKind: "BLIND",
        },
      ],
      markers: [
        { unitId: "enemy:front", markerId: WAKKOU_MARKER, stackCount: 1 },
        { unitId: "enemy:left", markerId: WAKKOU_MARKER, stackCount: 1 },
        { unitId: "enemy:back", markerId: WAKKOU_MARKER, stackCount: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_STELLA_STATUE_EX",
    intent: "対象が既に「惑光」を所持している場合は新たに付与しない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_STELLA_STATUE_EX" },
    board: MARKED_PRIMARY,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_STELLA_STATUE_EX_EVASION", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_STELLA_STATUE_EX_EVASION", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_STELLA_STATUE_EX_EVASION", targets: ["ally:back"] },
        { effectActionDefinitionId: "ACT_STELLA_STATUE_EX_MARKER", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_STELLA_STATUE_EX_MARKER", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_STELLA_STATUE_EX_MARKER", targets: ["enemy:back"] },
        // 解除できるデバフを持たないため解除自体が起きない。
        {
          effectActionDefinitionId: "ACT_STELLA_STATUE_EX_REMOVE_DEBUFFS",
          targets: ["ally:subject"],
          resultKind: "SKIPPED",
        },
        {
          effectActionDefinitionId: "ACT_STELLA_STATUE_EX_DEBUFF_IMMUNITY",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_STELLA_STATUE_EX_EVASION",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
          statusKind: "EVASION",
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_STELLA_STATUE_EX_DEBUFF_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_STELLA_STATUE_EX_EVASION",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
          statusKind: "EVASION",
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_STELLA_STATUE_EX_EVASION",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
          statusKind: "EVASION",
        },
      ],
      // 既に1つ持つ enemy:front は `KEEP_EXISTING`/`max: 1` で増えない。
      markers: [
        { unitId: "enemy:left", markerId: WAKKOU_MARKER, stackCount: 1 },
        { unitId: "enemy:back", markerId: WAKKOU_MARKER, stackCount: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_STELLA_STATUE_AS1",
    intent:
      "敵横一列に2行動の暗闇を付与する。暗闇状態は55%の確率でスキルが命中しなくなる。さらに味方全体の会心率を1行動の間5%上昇させる（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_STELLA_STATUE_AS1" },
    random: alwaysProc,
    expected: {
      // 最も近い敵と同じ横一列＝前列2体。後列の enemy:back は入らない。
      actions: [
        { effectActionDefinitionId: "ACT_STELLA_STATUE_AS1_BLIND", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_STELLA_STATUE_AS1_BLIND", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_STELLA_STATUE_AS1_CRIT_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_STELLA_STATUE_AS1_CRIT_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_STELLA_STATUE_AS1_CRIT_UP", targets: ["ally:back"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_STELLA_STATUE_AS1_CRIT_UP",
          magnitude: 0.05,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_STELLA_STATUE_AS1_CRIT_UP",
          magnitude: 0.05,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_STELLA_STATUE_AS1_CRIT_UP",
          magnitude: 0.05,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_STELLA_STATUE_AS1_BLIND",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2 },
          statusKind: "BLIND",
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_STELLA_STATUE_AS1_BLIND",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2 },
          statusKind: "BLIND",
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_STELLA_STATUE_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_STELLA_STATUE_AS2",
    intent:
      "敵単体に威力90で攻撃し、自身に対し1行動の間、1ヒットまで60%の確率で攻撃を回避するバフを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_STELLA_STATUE_AS2" },
    random: alwaysProc,
    expected: {
      // 「惑光」を持たないため増加分岐は選ばれない。
      actions: [
        { effectActionDefinitionId: "ACT_STELLA_STATUE_AS2_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_STELLA_STATUE_AS2_SELF_EVASION",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: { "enemy:front": -450 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_STELLA_STATUE_AS2_SELF_EVASION",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
          statusKind: "EVASION",
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_STELLA_STATUE_AS2",
    intent: "対象が「惑光」を所持している場合、この攻撃によるダメージは50%増加する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_STELLA_STATUE_AS2" },
    board: MARKED_PRIMARY,
    random: alwaysProc,
    expected: {
      // 増加分の675で対象が50%以下へ落ち、「惑光」も持っているためPS1が同じスキル
      // 使用の中で連鎖する。R-ATM-01: PS1の候補はHP減少の時点で検出されるが、発動は
      // AS2の全効果が解決した後になる。
      actions: [
        {
          effectActionDefinitionId: "ACT_STELLA_STATUE_AS2_DAMAGE_BOOSTED",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_STELLA_STATUE_AS2_SELF_EVASION",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_STELLA_STATUE_PS1_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_STELLA_STATUE_PS1_REMOVE_MARKER",
          targets: ["enemy:front"],
        },
      ],
      // AS2の675にPS1の上限1500が積み上がる。
      hpDeltas: { "enemy:front": -2175 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_STELLA_STATUE_AS2_SELF_EVASION",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
          statusKind: "EVASION",
        },
      ],
      markersRemoved: [{ unitId: "enemy:front", markerId: WAKKOU_MARKER, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_STELLA_STATUE_PS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_STELLA_STATUE_PS1",
    intent:
      "「惑光」を所持している敵のHPが50%以下になった際に発動。対象の敵単体に、対象の現在HP×90%のダメージを与える攻撃を行う。この攻撃によるダメージは自身の攻撃力×150%を上限とする攻撃後、対象が所持している「惑光」をすべて解除する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_STELLA_STATUE_PS1",
      trigger: realDamage({
        from: "ally:subject",
        to: "enemy:front",
        skillType: "AS",
        event: "HitPointReduced",
      }),
    },
    board: { enemies: MARKED_ENEMIES },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_STELLA_STATUE_PS1_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_STELLA_STATUE_PS1_REMOVE_MARKER",
          targets: ["enemy:front"],
        },
      ],
      // 契機の一撃（500）で残り3500。その90%＝3150は攻撃力×150%＝1500を超えるため
      // 上限側が採られる。
      hpDeltas: { "enemy:front": -1500 },
      markersRemoved: [{ unitId: "enemy:front", markerId: WAKKOU_MARKER, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_STELLA_STATUE_PS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_STELLA_STATUE_PS1",
    intent: "(不成立): 「惑光」を所持していない敵のHPが50%以下になっても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_STELLA_STATUE_PS1",
      trigger: realDamage({
        from: "ally:subject",
        to: "enemy:left",
        skillType: "AS",
        event: "HitPointReduced",
      }),
    },
    board: { enemies: MARKED_ENEMIES },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_STELLA_STATUE_PS2",
    intent:
      "自身が攻撃を受けた直後に発動。攻撃してきた敵単体に受けたダメージの50%を与える反撃を行い、自身の不足しているHPの35%を回復する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_STELLA_STATUE_PS2",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "AS", power: 2 }),
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_STELLA_STATUE_PS2_COUNTER", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_STELLA_STATUE_PS2_HEAL", targets: ["ally:subject"] },
      ],
      // 契機の被弾は1000。その50%を反撃し、不足HP（10000-4000=6000）の35%を回復する。
      hpDeltas: { "enemy:front": -500, "ally:subject": 2100 },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_STELLA_STATUE_PS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_STELLA_STATUE_PS2",
    intent: "(不成立): 味方への攻撃では発動しない（契機は自身が受けた攻撃に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_STELLA_STATUE_PS2",
      trigger: realDamage({ from: "enemy:front", to: "ally:front", skillType: "AS", power: 2 }),
    },
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_STELLA_STATUE (【スタチュービューティー】ステラ・ブレーメル)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-STELLA-STATUE-001: $skillDefinitionId — $intent",
    ({ use, board, precedingActions, random, precedingRandom, expected }) => {
      expect(
        observeSkillUse({
          snapshot,
          unitDefinitionId: UNIT_DEFINITION_ID,
          use,
          ...(board === undefined ? {} : { board }),
          ...(precedingActions === undefined ? {} : { precedingActions }),
          ...(random === undefined ? {} : { random: random() }),
          ...(precedingRandom === undefined ? {} : { precedingRandom: precedingRandom() }),
        }),
      ).toEqual(expected);
    },
  );

  it("IT-UNIT-STELLA-STATUE-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-STELLA-STATUE-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
    resetExecutedActionIds();
    for (const { use, board, precedingActions, random, precedingRandom } of BEHAVIOURS) {
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use,
        ...(board === undefined ? {} : { board }),
        ...(precedingActions === undefined ? {} : { precedingActions }),
        ...(random === undefined ? {} : { random: random() }),
        ...(precedingRandom === undefined ? {} : { precedingRandom: precedingRandom() }),
      });
    }
    expect(
      unexecutedEffectActionIds(
        unitEffectActionClosure(snapshot, UNIT_DEFINITION_ID),
        collectedExecutedActionIds(),
      ),
    ).toEqual([]);
  });

  it("IT-UNIT-STELLA-STATUE-004 (R-CRT-04): PS1の「対象の現在HP×90%のダメージ」は会心判定を行わない — AS2の威力ベース攻撃は従来どおり会心する", () => {
    const probe = (effectActionDefinitionId: string, skillDefinitionId: string) =>
      observeHitPointRatioCritical({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        effectActionDefinitionId,
        skillDefinitionId,
        attackerHoldsCriticalGuarantee: false,
        battleId: `B_STELLA_STATUE_CRT04_${effectActionDefinitionId}`,
      });

    // 会心率100%の盤面。規則に掛かる側だけが会心判定へ進まず、抽選も1本少ない。
    const ruled = probe("ACT_STELLA_STATUE_PS1_DAMAGE", "SKL_STELLA_STATUE_PS1");
    const control = probe("ACT_STELLA_STATUE_AS2_DAMAGE", "SKL_STELLA_STATUE_AS2");

    expect(ruled.criticalMode).toBe("PREVENTED");
    expect(ruled.isCritical).toBe(false);
    expect(ruled.criticalMultiplier).toBe(1);
    expect(control.criticalMode).toBe("NORMAL");
    expect(control.isCritical).toBe(true);
    expect(control.criticalMultiplier).toBeGreaterThan(1);
    expect(control.randomDraws - ruled.randomDraws).toBe(1);
  });
});
