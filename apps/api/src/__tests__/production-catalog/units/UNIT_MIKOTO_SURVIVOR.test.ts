import { describe, expect, it } from "vitest";
import {
  initialSnapshotFor,
  loadProductionSnapshot,
  reconstruct,
  unitFrom,
} from "../../../testing/fixtures/index.js";
import type { BattleUnit } from "../../../domain/battle/model/battle-unit.js";
import {
  createEffectActionDefinitionId,
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
import { createBattleUnitId } from "../../../domain/shared/ids.js";
import { openPassiveChain } from "../../../testing/production-unit/passive-activation.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import { observeCumulativeThresholdCounter } from "../../../testing/production-unit/runtime-counter.js";
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardUnitSpec,
  type PrecedingAction,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { realDamage, skillUseCompleted } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_MIKOTO_SURVIVOR`（【ナチュラルボーンサバイバー】鎧衣美琴）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_MIKOTO_SURVIVOR";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  "UNIT_OLGA_VETERAN",
]);

/** HP割合が最も低い敵を1体だけ作る（EXの対象選択を判別可能にする）。 */
const WOUNDED_LEFT_ENEMIES: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, state: { currentHp: 1000 } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** PS2は自身のAS完了そのものを契機に持つため、攻撃ASの観測には必ず連鎖が含まれる。 */
const PS2_CHAIN_ACTION = {
  effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_PS2_DMG_UP",
  targets: ["ally:subject"],
} as const;

const PS2_CHAIN_EFFECT = {
  unitId: "ally:subject",
  effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_PS2_DMG_UP",
  magnitude: 0.2,
  timeLimit: { unit: "ACTION", count: 1 },
} as const;

const PS2_COOLDOWN = {
  unitId: "ally:subject",
  skillDefinitionId: "SKL_MIKOTO_SURVIVOR_PS2",
  remaining: 1,
} as const;

/** 累計で最大HP×10%（1000ダメージ）に達する一撃。 */
const CUMULATIVE_THRESHOLD_HIT = realDamage({
  from: "enemy:front",
  to: "ally:subject",
  skillType: "AS",
  power: 2,
});

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
    skillDefinitionId: "SKL_MIKOTO_SURVIVOR_EX",
    intent:
      "最もHP割合が低い敵単体に対し、威力234で攻撃する。さらに自身に対し、2行動の間攻撃が必ず会心攻撃になるバフと、攻撃力×45%のシールドを付与する。シールドは自身の2行動後に消滅する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MIKOTO_SURVIVOR_EX" },
    board: { enemies: WOUNDED_LEFT_ENEMIES },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_EX_DAMAGE", targets: ["enemy:left"] },
        {
          effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_EX_CRIT_GUARANTEE",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_EX_SHIELD", targets: ["ally:subject"] },
      ],
      // 残りHP1000のためダメージは1170ではなく実際に減った分だけになる。
      hpDeltas: {
        "enemy:left": -1000,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_EX_CRIT_GUARANTEE",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2 },
          statusKind: "CRITICAL_GUARANTEE",
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_EX_SHIELD",
          // 攻撃力1000 × 45%。
          magnitude: 450,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_TARGET" },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MIKOTO_SURVIVOR_AS1",
    intent:
      "自身に最も近い位置にいる敵単体に威力189.6、および隣接する敵2体に対して威力113.76で攻撃し、1行動の間対象全ての防御力を35%低下させる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MIKOTO_SURVIVOR_AS1" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_AS1_DAMAGE_BASE",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_AS1_DEFDOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_AS1_DAMAGE_ADJ", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_AS1_DEFDOWN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_AS1_DAMAGE_ADJ", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_AS1_DEFDOWN", targets: ["enemy:back"] },
        PS2_CHAIN_ACTION,
      ],
      hpDeltas: {
        "enemy:front": -948,
        "enemy:left": -568,
        "enemy:back": -568,
      },
      effectsApplied: [
        PS2_CHAIN_EFFECT,
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_AS1_DEFDOWN",
          magnitude: -0.35,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_AS1_DEFDOWN",
          magnitude: -0.35,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_AS1_DEFDOWN",
          magnitude: -0.35,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MIKOTO_SURVIVOR_AS1", remaining: 1 },
        PS2_COOLDOWN,
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MIKOTO_SURVIVOR_AS2",
    intent: "敵単体に威力212で攻撃する（対象を倒せなかった場合は会心率上昇は起きない）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MIKOTO_SURVIVOR_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_AS2_DAMAGE", targets: ["enemy:front"] },
        PS2_CHAIN_ACTION,
      ],
      hpDeltas: {
        "enemy:front": -1060,
      },
      effectsApplied: [PS2_CHAIN_EFFECT],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [PS2_COOLDOWN],
    },
  },
  {
    skillDefinitionId: "SKL_MIKOTO_SURVIVOR_AS2",
    intent: "この攻撃よって対象を倒した場合、味方全体の会心率を5%上昇させる（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MIKOTO_SURVIVOR_AS2" },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 500 },
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_AS2_CRIT_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_AS2_CRIT_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_AS2_CRIT_UP", targets: ["ally:back"] },
        PS2_CHAIN_ACTION,
      ],
      hpDeltas: {
        "enemy:front": -500,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_AS2_CRIT_UP",
          magnitude: 0.05,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        PS2_CHAIN_EFFECT,
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_AS2_CRIT_UP",
          magnitude: 0.05,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_AS2_CRIT_UP",
          magnitude: 0.05,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [PS2_COOLDOWN],
    },
  },
  {
    skillDefinitionId: "SKL_MIKOTO_SURVIVOR_PS1",
    intent:
      "累計で最大HP×10%のダメージを受けた際に発動。自身にAPが残っている場合、APを1消費して自身のEXゲージを満タンの状態にし、2行動の間自身の攻撃力を10%上昇させ、さらに他の味方のEXゲージを1ずつ加算する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MIKOTO_SURVIVOR_PS1",
      trigger: CUMULATIVE_THRESHOLD_HIT,
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_PS1_AP_DOWN", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_PS1_EX_FULL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_PS1_ATK_UP", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_PS1_ALLY_EX_UP",
          targets: ["ally:front"],
        },
        { effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_PS1_ALLY_EX_UP", targets: ["ally:back"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_PS1_ATK_UP",
          magnitude: 0.1,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        // 0から上限10へ。
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 10 },
        { unitId: "ally:front", resource: "EX_GAUGE", delta: 1 },
        { unitId: "ally:back", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MIKOTO_SURVIVOR_PS1", remaining: 5 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MIKOTO_SURVIVOR_PS1",
    intent: "(分岐): 自身のAPが残っていない場合、自身のEXゲージを満タンの状態にする",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MIKOTO_SURVIVOR_PS1",
      trigger: CUMULATIVE_THRESHOLD_HIT,
    },
    board: { subject: { state: { currentAp: 0 } } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_PS1_EX_FULL", targets: ["ally:subject"] },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 10 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MIKOTO_SURVIVOR_PS1", remaining: 5 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MIKOTO_SURVIVOR_PS1",
    intent: "(不成立): 累計が最大HP×10%へ届かないダメージでは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MIKOTO_SURVIVOR_PS1",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:subject",
        skillType: "AS",
        power: 1,
      }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_MIKOTO_SURVIVOR_PS2",
    intent:
      "自身がアクティブスキルで攻撃した後に発動。自身に対し、1行動の間与ダメージを20%増加させるバフを付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MIKOTO_SURVIVOR_PS2",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_MIKOTO_SURVIVOR_AS2",
      }),
    },
    expected: {
      actions: [PS2_CHAIN_ACTION],
      effectsApplied: [PS2_CHAIN_EFFECT],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [PS2_COOLDOWN],
    },
  },
  {
    skillDefinitionId: "SKL_MIKOTO_SURVIVOR_PS2",
    intent: "(不成立): 同じく攻撃するEXの使用完了では発動しない（アクティブスキルではない）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MIKOTO_SURVIVOR_PS2",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "EX",
        skillDefinitionId: "SKL_MIKOTO_SURVIVOR_EX",
      }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_MIKOTO_SURVIVOR_PS2",
    intent:
      "(発動): 混乱で攻撃対象が味方側へ反転しても、アクティブスキルで攻撃した事実は変わらず発動する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MIKOTO_SURVIVOR_AS2" },
    precedingActions: CONFUSED,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MIKOTO_SURVIVOR_AS2_DAMAGE", targets: ["ally:subject"] },
        PS2_CHAIN_ACTION,
      ],
      // 混乱倍率0.7が掛かった (1000-500)×212%×0.7。
      hpDeltas: {
        "ally:subject": -742,
      },
      effectsApplied: [PS2_CHAIN_EFFECT],
      effectsRemoved: [CONFUSION_CONSUMED],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [PS2_COOLDOWN],
    },
  },
];

describe("production Catalog UNIT_MIKOTO_SURVIVOR (【ナチュラルボーンサバイバー】鎧衣美琴)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-MIKOTO-SURVIVOR-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-MIKOTO-SURVIVOR-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-MIKOTO-SURVIVOR-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-MIKOTO-SURVIVOR-004 (R-EFF-11): PS1 の累計ダメージ閾値counterは、閾値に届かない被弾では carry だけを動かし、実 catalog/ の trigger 条件がその RuntimeCounterChanged を valueChanged で弾く。ちょうど閾値・閾値2つぶんの被弾では公開値が動き、条件が成立する", () => {
    // `RuntimeCounterChanged` は carry だけが動いた被弾でも追跡のために発行される
    // （`14_Catalog定義スキーマ.md`「counterUpdates」）。条件側で判別できないと、
    // 閾値に達していない被弾のたびにPSが発動してしまう。
    expect(
      observeCumulativeThresholdCounter(snapshot, UNIT_DEFINITION_ID, "SKL_MIKOTO_SURVIVOR_PS1"),
    ).toEqual({
      declaration: {
        counter: "SKL_MIKOTO_SURVIVOR_PS1_CUMULATIVE_DAMAGE_RATIO",
        scope: "SKILL_RUNTIME",
        maxHpRatio: 0.1,
      },
      triggerEventType: "RuntimeCounterChanged",
      subThreshold: {
        changes: [
          {
            skillDefinitionId: "SKL_MIKOTO_SURVIVOR_PS1",
            counter: "SKL_MIKOTO_SURVIVOR_PS1_CUMULATIVE_DAMAGE_RATIO",
            before: 0,
            after: 0,
            valueChanged: false,
          },
        ],
        triggerMatched: false,
      },
      atThreshold: {
        changes: [
          {
            skillDefinitionId: "SKL_MIKOTO_SURVIVOR_PS1",
            counter: "SKL_MIKOTO_SURVIVOR_PS1_CUMULATIVE_DAMAGE_RATIO",
            before: 0,
            after: 1,
            valueChanged: true,
          },
        ],
        triggerMatched: true,
      },
      crossing: {
        changes: [
          {
            skillDefinitionId: "SKL_MIKOTO_SURVIVOR_PS1",
            counter: "SKL_MIKOTO_SURVIVOR_PS1_CUMULATIVE_DAMAGE_RATIO",
            before: 0,
            after: 2,
            valueChanged: true,
          },
        ],
        triggerMatched: true,
      },
    });
  });

  it("IT-UNIT-MIKOTO-SURVIVOR-005 (R-EFF-11): 閾値に届かない被弾はcarryだけを進めて RuntimeCounterChanged を valueChanged: false で残し、2発目で公開値が動く。carryは公開差分に載らず、独立Reducerはcounterの公開値だけを復元する", () => {
    // `-001` のPS1行は「1発で閾値へ届く被弾」と「届かない被弾」を持つが、**複数発に
    // 分かれた被弾が積み上がって跨ぐ**ことは表せない。契機の `DamageApplied` は
    // 積み上がりを刻むために手組みする（実pipelineを通した形そのものは
    // `-001` の `realDamage` 行が持つ）。
    const skillDefinitionId = createSkillDefinitionId("SKL_MIKOTO_SURVIVOR_PS1");
    const counterId = createRuntimeCounterId("SKL_MIKOTO_SURVIVOR_PS1_CUMULATIVE_DAMAGE_RATIO");
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const initial = initialSnapshotFor(board.units);
    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: "enemy:front",
      battleId: "B_MIKOTO_CUMULATIVE",
    });
    // 閾値（最大HP×10%）のちょうど半分。2発で初めて跨ぐ。
    const hitPointDamage = board.subject.combatStats.maximumHp * 0.05;

    const damageApplied = (hpBefore: number) =>
      chain.recorder.record({
        eventType: "DamageApplied",
        category: "FACT",
        turnNumber: 1,
        cycleNumber: 1,
        actionId: chain.actionId,
        resolutionScopeId: chain.resolutionScopeId,
        parentEventId: chain.rootEventId,
        rootEventId: chain.rootEventId,
        sourceUnitId: createBattleUnitId("enemy:front"),
        targetUnitIds: [createBattleUnitId("ally:subject")],
        payload: {
          effectActionDefinitionId: createEffectActionDefinitionId("ACT_TEST_CUMULATIVE_HIT"),
          hitIndex: 1,
          targetUnitId: createBattleUnitId("ally:subject"),
          calculatedDamage: hitPointDamage,
          // シールド未所持の対象なので全量がHPへ向かう（R-SHD-02/03）。
          hpDirectDamage: 0,
          typedShieldAbsorbed: 0,
          untypedShieldAbsorbed: 0,
          subUnitAbsorbed: 0,
          discardedDamage: 0,
          hitPointDamage,
          hpBefore,
          hpAfter: hpBefore - hitPointDamage,
          defeated: false,
        },
        stateDelta: {
          units: {
            [createBattleUnitId("ally:subject")]: {
              hp: { before: hpBefore, after: hpBefore - hitPointDamage },
            },
          },
        },
      });

    const damaged = (units: readonly BattleUnit[]) =>
      units.map((unit) =>
        unit.battleUnitId === "ally:subject"
          ? { ...unit, currentHp: unit.currentHp - hitPointDamage }
          : unit,
      );

    const afterFirst = chain.fireRecorded(
      damageApplied(board.subject.currentHp),
      damaged(board.units),
    );
    const hpBeforeSecond = afterFirst.find(
      (unit) => unit.battleUnitId === "ally:subject",
    )!.currentHp;
    const afterSecond = chain.fireRecorded(damageApplied(hpBeforeSecond), damaged(afterFirst));
    const subject = afterSecond.find((unit) => unit.battleUnitId === "ally:subject")!;

    expect(chain.eventsOfType("RuntimeCounterChanged").map((event) => event.payload)).toMatchObject(
      [
        { counter: counterId, before: 0, after: 0, valueChanged: false },
        { counter: counterId, before: 0, after: 1, valueChanged: true },
      ],
    );
    expect(
      chain.eventsOfType("PassiveActivated").map((event) => event.payload.skillDefinitionId),
    ).toEqual([skillDefinitionId]);
    expect(subject.skillCounters?.[skillDefinitionId]?.[counterId]).toEqual({ value: 1, carry: 0 });

    const reconstructed = reconstruct(initial, chain.recorder);
    expect(reconstructed.units[createBattleUnitId("ally:subject")]).toMatchObject({
      hp: subject.currentHp,
      skillCounters: { [skillDefinitionId]: { [counterId]: 1 } },
    });
    // carryは内部状態であり公開差分には載らない。
    expect(
      reconstructed.units[createBattleUnitId("ally:subject")]?.skillCounterCarry,
    ).toBeUndefined();
  });
});
