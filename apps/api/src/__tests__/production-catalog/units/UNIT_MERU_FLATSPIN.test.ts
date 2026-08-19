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
  type PrecedingAction,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { skillUseStarting } from "../../../testing/production-unit/trigger-events.js";
import { observeTargetHpRatioCritical } from "../../../testing/production-unit/target-hp-ratio-critical-probe.js";

/**
 * `UNIT_MERU_FLATSPIN`（【蒼き穹舞うフラットスピン】桃園める）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_MERU_FLATSPIN";

/**
 * 「対象が状態異常だった場合」の分岐を実 production 定義で作るため、気絶を配る
 * `UNIT_LUCIE_MAID` と、`APPLY_CONTINUOUS_DAMAGE` 側の状態異常（毒）を配る
 * `UNIT_CHIYURU_MAZE` を併せて読み込む（手組みの`AppliedEffect`を使わない）。
 */
const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  "UNIT_LUCIE_MAID",
  "UNIT_CHIYURU_MAZE",
  "UNIT_OLGA_VETERAN",
]);

/** 前提の気絶が確実に本命の対象へ乗るよう、敵は1体だけの盤面にする。 */
const SINGLE_ENEMY: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
];

const STUNNED_ENEMY: readonly PrecedingAction[] = [
  { effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_STUN", target: "ENEMY" },
];

/** HP割合が最も低い敵を1体だけ作る（EXの対象選択を判別可能にする）。 */
const WOUNDED_LEFT_ENEMIES: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, state: { currentHp: 4000 } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/**
 * PS1は自身のAS開始そのものを契機に持つため、AS 1回の観測には必ず連鎖が含まれる。
 * 攻撃力+40%と与ダメージ+20%は`NEXT_OUTGOING_ATTACK`消費で、続くそのAS自身の攻撃が
 * 消費し切るため観測の差分には残らず、デバフ無効だけが残る。
 */
const PS1_CHAIN_ACTIONS = [
  { effectActionDefinitionId: "ACT_MERU_FLATSPIN_PS1_ATK_UP", targets: ["ally:subject"] },
  { effectActionDefinitionId: "ACT_MERU_FLATSPIN_PS1_DMG_UP", targets: ["ally:subject"] },
  { effectActionDefinitionId: "ACT_MERU_FLATSPIN_PS1_DEBUFF_IMMUNITY", targets: ["ally:subject"] },
] as const;

const PS1_IMMUNITY_EFFECT = {
  unitId: "ally:subject",
  effectActionDefinitionId: "ACT_MERU_FLATSPIN_PS1_DEBUFF_IMMUNITY",
  magnitude: 0,
  timeLimit: { unit: "ACTION", count: 1 },
} as const;

const PS1_COOLDOWN = {
  unitId: "ally:subject",
  skillDefinitionId: "SKL_MERU_FLATSPIN_PS1",
  remaining: 1,
} as const;

/**
 * 混乱（R-CFS-01）はASの`DAMAGE` stepのTargetSelectorを反転させ、
 * `SkillUseStarting`/`SkillUseCompleted.targetUnitIds` にも反転後の味方が入る。
 * 「自身がアクティブスキルで攻撃する」ことは変わらないため、この経路でもPSは
 * 発動しなければならない。前提は実 production 定義で作る。
 */
const CONFUSED: readonly PrecedingAction[] = [
  { effectActionDefinitionId: "ACT_OLGA_VETERAN_EX_CONFUSION", target: "SELF" },
];

/** 混乱はその行動の`DAMAGE`で消費され、観測では解除として現れる。 */
const CONFUSION_CONSUMED = {
  unitId: "ally:subject",
  effectActionDefinitionId: "ACT_OLGA_VETERAN_EX_CONFUSION",
  magnitude: 0,
  timeLimit: { unit: "ACTION", count: 1 },
  statusKind: "CONFUSION",
} as const;

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_MERU_FLATSPIN_EX",
    intent:
      "最もHP割合が低い敵単体に威力179.4で攻撃する。攻撃後に対象が生存していた場合、対象の失ったHP×50%のダメージを与える攻撃を追加で行う。追加攻撃によるダメージは自身の攻撃力×80%を上限とする",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_FLATSPIN_EX" },
    board: { enemies: WOUNDED_LEFT_ENEMIES },
    expected: {
      // EXはアクティブスキルではないためPS1の連鎖は起きない。
      actions: [
        { effectActionDefinitionId: "ACT_MERU_FLATSPIN_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MERU_FLATSPIN_EX_DAMAGE_EXTRA", targets: ["enemy:left"] },
      ],
      // 897（(1000-500)×179.4%）の後、失ったHP6897の50%は3448だが
      // 攻撃力1000×80%の800で頭打ちになる。
      hpDeltas: {
        "enemy:left": -1697,
      },
    },
  },
  {
    skillDefinitionId: "SKL_MERU_FLATSPIN_EX",
    intent: "このスキルによって対象を倒した場合、自身のEXゲージを満タンの状態にする",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_FLATSPIN_EX" },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 500 },
        },
      ],
    },
    expected: {
      // 倒した場合は追加攻撃の分岐へ入らず、EXゲージ満タンの分岐だけが走る。
      actions: [
        { effectActionDefinitionId: "ACT_MERU_FLATSPIN_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MERU_FLATSPIN_EX_GAUGE_FULL", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "enemy:front": -500,
      },
      resources: [{ unitId: "ally:subject", resource: "EX_GAUGE", delta: 10 }],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_FLATSPIN_AS1",
    intent: "攻撃力が最も高い敵単体に威力212で攻撃し、対象のAPを1削る",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_FLATSPIN_AS1" },
    board: { enemies: WOUNDED_LEFT_ENEMIES },
    expected: {
      actions: [
        ...PS1_CHAIN_ACTIONS,
        { effectActionDefinitionId: "ACT_MERU_FLATSPIN_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MERU_FLATSPIN_AS1_AP_DOWN", targets: ["enemy:left"] },
      ],
      // PS1が先に乗るため攻撃力1400・与ダメージ+20%で (1400-500)×212%×1.2。
      hpDeltas: {
        "enemy:left": -2289,
      },
      effectsApplied: [PS1_IMMUNITY_EFFECT],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -2 },
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 4 },
        { unitId: "enemy:left", resource: "AP", delta: -1 },
      ],
      cooldowns: [
        PS1_COOLDOWN,
        { unitId: "ally:subject", skillDefinitionId: "SKL_MERU_FLATSPIN_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_FLATSPIN_AS1",
    intent: "対象が状態異常だった場合、「超集中」のクールタイムを解除する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_FLATSPIN_AS1" },
    board: { enemies: SINGLE_ENEMY },
    precedingActions: STUNNED_ENEMY,
    expected: {
      actions: [
        ...PS1_CHAIN_ACTIONS,
        { effectActionDefinitionId: "ACT_MERU_FLATSPIN_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MERU_FLATSPIN_AS1_AP_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MERU_FLATSPIN_AS1_CD_RESET", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "enemy:front": -2289,
      },
      effectsApplied: [PS1_IMMUNITY_EFFECT],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -2 },
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 4 },
        { unitId: "enemy:front", resource: "AP", delta: -1 },
      ],
      // 連鎖でPS1が置いたクールタイム1が、同じ解決の中で0へ戻される。
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MERU_FLATSPIN_PS1", remaining: 0 },
        { unitId: "ally:subject", skillDefinitionId: "SKL_MERU_FLATSPIN_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_FLATSPIN_AS2",
    intent: "敵単体に威力212で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_FLATSPIN_AS2" },
    expected: {
      actions: [
        ...PS1_CHAIN_ACTIONS,
        { effectActionDefinitionId: "ACT_MERU_FLATSPIN_AS2_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -2289,
      },
      effectsApplied: [PS1_IMMUNITY_EFFECT],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 3 },
      ],
      cooldowns: [
        PS1_COOLDOWN,
        { unitId: "ally:subject", skillDefinitionId: "SKL_MERU_FLATSPIN_AS2", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_FLATSPIN_AS2",
    intent: "対象が状態異常だった場合、さらに威力62.4で追加攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_FLATSPIN_AS2" },
    board: { enemies: SINGLE_ENEMY },
    precedingActions: STUNNED_ENEMY,
    expected: {
      actions: [
        ...PS1_CHAIN_ACTIONS,
        { effectActionDefinitionId: "ACT_MERU_FLATSPIN_AS2_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_MERU_FLATSPIN_AS2_DAMAGE_EXTRA",
          targets: ["enemy:front"],
        },
      ],
      // 追加攻撃はPS1のバフを本命の一撃が使い切った後なので、素の312になる。
      hpDeltas: {
        "enemy:front": -2601,
      },
      effectsApplied: [PS1_IMMUNITY_EFFECT],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 3 },
      ],
      cooldowns: [
        PS1_COOLDOWN,
        { unitId: "ally:subject", skillDefinitionId: "SKL_MERU_FLATSPIN_AS2", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_FLATSPIN_AS3",
    intent: "敵単体に威力124.8で2ヒット攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_FLATSPIN_AS3" },
    expected: {
      actions: [
        ...PS1_CHAIN_ACTIONS,
        { effectActionDefinitionId: "ACT_MERU_FLATSPIN_AS3_DAMAGE", targets: ["enemy:front"] },
      ],
      // PS1のバフは1回の攻撃（EffectAction 1件）ぶんなので、2ヒットとも1347が乗る。
      hpDeltas: {
        "enemy:front": -2694,
      },
      effectsApplied: [PS1_IMMUNITY_EFFECT],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 3 },
      ],
      cooldowns: [PS1_COOLDOWN],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_FLATSPIN_AS3",
    intent:
      "対象が状態異常だった場合、1行動の間対象の与ダメージを25%減少させるデバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_FLATSPIN_AS3" },
    board: { enemies: SINGLE_ENEMY },
    precedingActions: STUNNED_ENEMY,
    expected: {
      actions: [
        ...PS1_CHAIN_ACTIONS,
        { effectActionDefinitionId: "ACT_MERU_FLATSPIN_AS3_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MERU_FLATSPIN_AS3_DMG_DOWN", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -2694,
      },
      effectsApplied: [
        PS1_IMMUNITY_EFFECT,
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_MERU_FLATSPIN_AS3_DMG_DOWN",
          magnitude: -0.25,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 3 },
      ],
      cooldowns: [PS1_COOLDOWN],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_FLATSPIN_PS1",
    intent:
      "自身がアクティブスキルで攻撃する前に発動。このスキルに続く自身の攻撃での攻撃力を40%上昇させる。さらに、このスキルに続く自身の攻撃での与ダメージを20%増加させるバフ（重複可）を付与する。加えて、自身に向けられるデバフを1つまで無効にするバフを付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MERU_FLATSPIN_PS1",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_MERU_FLATSPIN_AS1",
      }),
    },
    expected: {
      actions: [...PS1_CHAIN_ACTIONS],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MERU_FLATSPIN_PS1_ATK_UP",
          magnitude: 0.4,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MERU_FLATSPIN_PS1_DMG_UP",
          magnitude: 0.2,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
        PS1_IMMUNITY_EFFECT,
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [PS1_COOLDOWN],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_FLATSPIN_PS1",
    intent: "(不成立): 同じく攻撃するEXの使用開始では発動しない（アクティブスキルではない）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MERU_FLATSPIN_PS1",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "EX",
        skillDefinitionId: "SKL_MERU_FLATSPIN_EX",
      }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_MERU_FLATSPIN_PS1",
    intent:
      "(発動): 混乱で攻撃対象が味方側へ反転しても、アクティブスキルで攻撃する事実は変わらず発動する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_FLATSPIN_AS3" },
    precedingActions: CONFUSED,
    expected: {
      actions: [
        ...PS1_CHAIN_ACTIONS,
        { effectActionDefinitionId: "ACT_MERU_FLATSPIN_AS3_DAMAGE", targets: ["ally:subject"] },
      ],
      // PS1のバフが乗った1ヒット1347.84へ混乱倍率0.7を掛けた943×2ヒット。
      hpDeltas: {
        "ally:subject": -1886,
      },
      effectsApplied: [PS1_IMMUNITY_EFFECT],
      effectsRemoved: [CONFUSION_CONSUMED],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 3 },
      ],
      cooldowns: [PS1_COOLDOWN],
    },
  },
];

describe("production Catalog UNIT_MERU_FLATSPIN (【蒼き穹舞うフラットスピン】桃園める)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-MERU-FLATSPIN-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-MERU-FLATSPIN-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-MERU-FLATSPIN-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-MERU-FLATSPIN-004 (R-SKL-06): AS2の総称「対象が状態異常だった場合」は `categories: [STATUS]` 一本で照会するため、`APPLY_STATUS` の気絶だけでなく `APPLY_CONTINUOUS_DAMAGE` の毒でも成立し、状態異常ではない単なるデバフでは成立しない", () => {
    const extraAttackTargets = (precedingActions: readonly PrecedingAction[]): readonly string[] =>
      (
        observeSkillUse({
          snapshot,
          unitDefinitionId: UNIT_DEFINITION_ID,
          use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_FLATSPIN_AS2" },
          board: { enemies: SINGLE_ENEMY },
          precedingActions,
        }).actions ?? []
      )
        .filter(
          (action) =>
            action.effectActionDefinitionId === "ACT_MERU_FLATSPIN_AS2_DAMAGE_EXTRA" &&
            action.resultKind === undefined,
        )
        .flatMap((action) => action.targets);

    // 毒（継続ダメージ側の状態異常）でも成立する — 気絶・凍結・暗闇の3項ORでは漏れていた。
    expect(
      extraAttackTargets([
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_POISON", target: "ENEMY" },
      ]),
    ).toEqual(["enemy:front"]);
    expect(extraAttackTargets(STUNNED_ENEMY)).toEqual(["enemy:front"]);

    // 状態異常ではないデバフでは不成立（「何らかのデバフ」への近似ではない）。
    expect(
      extraAttackTargets([
        { effectActionDefinitionId: "ACT_MERU_FLATSPIN_AS3_DMG_DOWN", target: "ENEMY" },
      ]),
    ).toEqual([]);
    expect(extraAttackTargets([])).toEqual([]);
  });

  it("IT-UNIT-MERU-FLATSPIN-005 (R-CRT-04): EXの「対象の失ったHP×50%のダメージ」は会心判定を行わない — 同じEXの威力ベース攻撃は従来どおり会心する", () => {
    const probe = (effectActionDefinitionId: string, skillDefinitionId: string) =>
      observeTargetHpRatioCritical({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        effectActionDefinitionId,
        skillDefinitionId,
        attackerHoldsCriticalGuarantee: false,
        battleId: `B_MERU_FLATSPIN_CRT04_${effectActionDefinitionId}`,
      });

    // 会心率100%の盤面。規則に掛かる側だけが会心判定へ進まず、抽選も1本少ない。
    const ruled = probe("ACT_MERU_FLATSPIN_EX_DAMAGE_EXTRA", "SKL_MERU_FLATSPIN_EX");
    const control = probe("ACT_MERU_FLATSPIN_EX_DAMAGE", "SKL_MERU_FLATSPIN_EX");

    expect(ruled.criticalMode).toBe("PREVENTED");
    expect(ruled.isCritical).toBe(false);
    expect(ruled.criticalMultiplier).toBe(1);
    expect(control.criticalMode).toBe("NORMAL");
    expect(control.isCritical).toBe(true);
    expect(control.criticalMultiplier).toBeGreaterThan(1);
    expect(control.randomDraws - ruled.randomDraws).toBe(1);
  });
});
