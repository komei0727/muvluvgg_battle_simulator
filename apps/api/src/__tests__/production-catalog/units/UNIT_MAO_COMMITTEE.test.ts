import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "../../../domain/battle/resolution/action-skill-use-resolver.js";
import { EventRecorder } from "../../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../../domain/battle/events/domain-event.js";
import type { BattleUnit } from "../../../domain/battle/model/battle-unit.js";
import type { EffectActionDefinition } from "../../../domain/catalog/definitions/effect-action-definition.js";
import type { SkillDefinition } from "../../../domain/catalog/definitions/skill-definition.js";
import {
  createEffectActionDefinitionId,
  createRuntimeCounterId,
  createSkillDefinitionId,
  createTargetBindingId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
import { createActionId } from "../../../domain/shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../../domain/shared/ids.js";
import {
  applyStateDelta,
  reduceStateDeltas,
} from "../../../domain/battle/events/state-delta-reducer.js";
import {
  definitionsWith,
  initialSnapshotFor,
  loadProductionSnapshot,
  noMissNoCrit,
  unitFrom,
} from "../../../testing/fixtures/index.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import { observeContinuousDamage } from "../../../testing/production-unit/continuous-damage.js";
import { observeDamageProbe } from "../../../testing/production-unit/damage-probe.js";
import { openPassiveChain } from "../../../testing/production-unit/passive-activation.js";
import {
  PRODUCTION_CATALOG_DIR,
  applyPrecedingActions,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  selectedActiveSkill,
  type BoardUnitSpec,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { skillUseCompleted, turnStarted } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_MAO_COMMITTEE`（【ポンコツいいんちょ】大賀真桜）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_MAO_COMMITTEE";

/**
 * PS2の「全てのバフ・デバフを解除」がカテゴリごとに分かれることの対照。茉莉花自身は
 * 攻撃力へ効くバフもデバフも配らないため、実効値の巻き戻しまで見える実 production の
 * 攻撃力補正を1件ずつ併せて読み込む。どちらも `timeLimit: BATTLE` にする —
 * `ACTION` 単位は保持者の行動で失効し得るため、解除されたことの証拠にならない。
 */
const CLEANSED_BUFF_ACTION_ID = "ACT_NOEL_RUMBLE_PS1_ATK_UP";
const CLEANSED_DEBUFF_ACTION_ID = "ACT_SHOUKA_SCHEMER_PS1_ATK_DOWN";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  "UNIT_NOEL_RUMBLE",
  "UNIT_SHOUKA_SCHEMER",
]);

const DISCIPLINE = "MARKER_MAO_COMMITTEE_DISCIPLINE";

/** HP割合が1体だけ高い敵陣。`HIGHEST_HP_RATIO` の判別用。 */
const ENEMY_WITH_HIGHEST_HP: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, state: { currentHp: 9000 } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** 「風紀」の所持数が異なる敵陣。最少の敵が選ばれることを見る。 */
const ENEMY_BY_DISCIPLINE_COUNT: readonly BoardUnitSpec[] = [
  {
    id: "enemy:front",
    position: { column: "CENTER", row: "FRONT" },
    markers: [{ markerId: DISCIPLINE, stackCount: 2 }],
  },
  {
    id: "enemy:left",
    position: { column: "LEFT", row: "FRONT" },
    markers: [{ markerId: DISCIPLINE, stackCount: 1 }],
  },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** PS1は「3回目のAS/EX使用」でだけ発動する。counterを2に置いて次の1回を3回目にする。 */
const PS1_COUNTER_AT_TWO = {
  subject: {
    state: {
      skillCounters: {
        [createSkillDefinitionId("SKL_MAO_COMMITTEE_PS1")]: {
          [createRuntimeCounterId("SKL_MAO_COMMITTEE_PS1_TRIGGER_COUNT")]: { value: 2, carry: 0 },
        },
      },
    },
  },
};

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_MAO_COMMITTEE_EX",
    intent:
      "最もHP割合が高い敵単体、および対象に隣接する敵に対して威力120.48でEN攻撃して、1行動の間与ダメージを15%減少させるデバフを付与し（重複可）、与えたダメージの20%分自身のHPを回復する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAO_COMMITTEE_EX" },
    board: { enemies: ENEMY_WITH_HIGHEST_HP },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAO_COMMITTEE_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAO_COMMITTEE_EX_DMG_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAO_COMMITTEE_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MAO_COMMITTEE_EX_DMG_DOWN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MAO_COMMITTEE_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_MAO_COMMITTEE_EX_DMG_DOWN", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_MAO_COMMITTEE_EX_HEAL", targets: ["ally:subject"] },
      ],
      // 1体あたり602（切り捨て）。回復は3体合計1806の20%＝361（切り捨て）で、
      // 最終ヒット分ではなくこのEffectSequence全体の合計を読む。
      hpDeltas: {
        "enemy:front": -602,
        "enemy:left": -602,
        "enemy:back": -602,
        "ally:subject": 361,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_MAO_COMMITTEE_EX_DMG_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_MAO_COMMITTEE_EX_DMG_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_MAO_COMMITTEE_EX_DMG_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAO_COMMITTEE_AS1",
    intent:
      "自身の現在HPの25%を消費し、敵横一列に消費分HP×225%のENダメージを与える攻撃をする。さらに自身を除く味方単体に自身の消費分HP×25%のシールドを付与する。シールドは1回攻撃を受けたら消滅する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAO_COMMITTEE_AS1" },
    board: { subject: { state: { currentHp: 8000 } } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAO_COMMITTEE_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAO_COMMITTEE_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MAO_COMMITTEE_AS1_SHIELD", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_MAO_COMMITTEE_AS1_HP_COST", targets: ["ally:subject"] },
      ],
      // 消費分は現在HP8000の25%＝2000。ダメージはその225%＝4500（現在HPの56.25%）で
      // 防御力を差し引かない（`SKILL_POWER`ではないため、R-DMG-01）。
      hpDeltas: {
        "enemy:front": -4500,
        "enemy:left": -4500,
        "ally:subject": -2000,
      },
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_MAO_COMMITTEE_AS1_SHIELD",
          magnitude: 500,
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAO_COMMITTEE_AS1",
    intent: "(不成立): 自身のHPが60%未満の場合、このスキルは発動しない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAO_COMMITTEE_AS1" },
    board: { subject: { state: { currentHp: 5999 } } },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_MAO_COMMITTEE_AS2",
    intent:
      "敵前後列に3行動の間、行動時に攻撃力×20%のENダメージを受けるデバフと「風紀」を1つ付与する。このスキルは所持している「風紀」の数が最も少ない敵を優先する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAO_COMMITTEE_AS2" },
    board: { enemies: ENEMY_BY_DISCIPLINE_COUNT },
    expected: {
      // 「風紀」0個の enemy:back が起点になり、同じ列（CENTER）の enemy:front も入る。
      actions: [
        { effectActionDefinitionId: "ACT_MAO_COMMITTEE_AS2_DMG_DEBUFF", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAO_COMMITTEE_AS2_MARKER", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAO_COMMITTEE_AS2_DMG_DEBUFF", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_MAO_COMMITTEE_AS2_MARKER", targets: ["enemy:back"] },
      ],
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_MAO_COMMITTEE_AS2_DMG_DEBUFF",
          magnitude: 200,
          timeLimit: { unit: "ACTION", count: 3 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_MAO_COMMITTEE_AS2_DMG_DEBUFF",
          magnitude: 200,
          timeLimit: { unit: "ACTION", count: 3 },
        },
      ],
      markers: [
        { unitId: "enemy:front", markerId: DISCIPLINE, stackCount: 3 },
        { unitId: "enemy:back", markerId: DISCIPLINE, stackCount: 1 },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAO_COMMITTEE_PS1",
    intent:
      "自身がアクティブスキルまたはEXスキルを3回使用する度に発動。アクティブスキルまたはEXスキルの対象となった敵単体に対して威力78でEN攻撃する。さらに自身を除く味方全体に対し、1行動の間与ダメージを12.5%増加させるバフを付与する(重複可)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MAO_COMMITTEE_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_MAO_COMMITTEE_AS2",
      }),
      triggeredBy: "ally:subject",
    },
    board: PS1_COUNTER_AT_TWO,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAO_COMMITTEE_PS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAO_COMMITTEE_PS1_DMG_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_MAO_COMMITTEE_PS1_DMG_UP", targets: ["ally:back"] },
      ],
      hpDeltas: { "enemy:front": -390 },
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_MAO_COMMITTEE_PS1_DMG_UP",
          magnitude: 0.125,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_MAO_COMMITTEE_PS1_DMG_UP",
          magnitude: 0.125,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAO_COMMITTEE_PS1",
    intent: "(不成立): 1回目・2回目の使用では発動しない（「3回使用する度に」に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MAO_COMMITTEE_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_MAO_COMMITTEE_AS2",
      }),
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_MAO_COMMITTEE_PS1",
    intent: "(不成立): 他の味方のAS使用では発動しない（「自身が」使用した場合に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MAO_COMMITTEE_PS1",
      trigger: skillUseCompleted({
        actor: "ally:front",
        targets: ["enemy:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:front",
    },
    board: PS1_COUNTER_AT_TWO,
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_MAO_COMMITTEE_PS2",
    intent:
      "ターン開始時に発動。自身に掛けられている全てのバフ・デバフを解除後、自身に対し、3スキルのステルスを付与する。さらに自身に対し、行動時に最大HPの7.5%を回復する効果を付与する。また被ダメージを最大50%減少させる効果を付与する(重複可)。この効果は付与時の自身のHPが多いほど高い効果を発揮する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MAO_COMMITTEE_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    // 解除対象を実 production 定義（EXの与ダメージ減少デバフ）で用意する。
    precedingActions: [
      { effectActionDefinitionId: "ACT_MAO_COMMITTEE_EX_DMG_DOWN", target: "SELF" },
    ],
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAO_COMMITTEE_PS2_CLEANSE", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MAO_COMMITTEE_PS2_STEALTH", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MAO_COMMITTEE_PS2_HEAL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MAO_COMMITTEE_PS2_DMG_DOWN", targets: ["ally:subject"] },
      ],
      effectsRemoved: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAO_COMMITTEE_EX_DMG_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAO_COMMITTEE_PS2_STEALTH",
          magnitude: 0,
          timeLimit: { unit: "SKILL_USE", count: 3 },
          statusKind: "STEALTH",
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAO_COMMITTEE_PS2_HEAL",
          magnitude: 750,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          // 上限50%の減少がHP割合50%で半分の-25%になる。
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAO_COMMITTEE_PS2_DMG_DOWN",
          magnitude: -0.25,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAO_COMMITTEE_PS2",
    intent: "(不成立): 自身以外の味方が生存していない場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MAO_COMMITTEE_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    board: { allies: [] },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_MAO_COMMITTEE_EX",
    intent: "同上: 敵が1体だけで隣接対象がいなくてもEXは発動する（発動不能ならEXゲージを全量失う）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAO_COMMITTEE_EX", actionType: "EX" },
    board: { enemies: [{ id: "enemy:front", position: { column: "CENTER", row: "FRONT" } }] },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_MAO_COMMITTEE_EX_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_MAO_COMMITTEE_EX_DMG_DOWN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_MAO_COMMITTEE_EX_HEAL",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "ally:subject": 120,
        "enemy:front": -602,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_MAO_COMMITTEE_EX_DMG_DOWN",
          magnitude: -0.15,
          timeLimit: {
            unit: "ACTION",
            count: 1,
          },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAO_COMMITTEE_AS1",
    intent: "同上: 自身以外の味方が居なくても、HPを支払って敵横一列への攻撃は成立する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAO_COMMITTEE_AS1" },
    board: { allies: [], subject: { state: { currentHp: 10000 } } },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_MAO_COMMITTEE_AS1_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_MAO_COMMITTEE_AS1_DAMAGE",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_MAO_COMMITTEE_AS1_HP_COST",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "ally:subject": -2500,
        "enemy:front": -5000,
        "enemy:left": -5000,
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
];

/** 敵役が撃つ最小の単体攻撃AS（実Catalogとは無関係）。 */
const ENEMY_ATTACK_SKILL_ID = "SKL_TEST_STEALTH_PROBE";
const ENEMY_ATTACK_ACTION_ID = "ACT_TEST_STEALTH_PROBE";

function enemyAttackAction(): EffectActionDefinition {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(ENEMY_ATTACK_ACTION_ID),
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: 1 },
      hitCount: 1,
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "GUARANTEED" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

function enemyAttackSkill(): SkillDefinition {
  const binding = createTargetBindingId("TGT_TEST_STEALTH_PROBE");
  return {
    skillDefinitionId: createSkillDefinitionId(ENEMY_ATTACK_SKILL_ID),
    skillType: "AS",
    cost: { resource: "AP", amount: 0 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [
        {
          targetBindingId: binding,
          selector: {
            kind: "SELECT",
            side: "ENEMY",
            count: 1,
            filters: [],
            order: ["DEFAULT"],
            includeDefeated: false,
          },
        },
      ],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: binding },
          actions: [
            { effectActionDefinitionId: createEffectActionDefinitionId(ENEMY_ATTACK_ACTION_ID) },
          ],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: true },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    metadata: { displayName: ENEMY_ATTACK_SKILL_ID, tags: [] },
  };
}

describe("production Catalog UNIT_MAO_COMMITTEE (【ポンコツいいんちょ】大賀真桜)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-MAO-COMMITTEE-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-MAO-COMMITTEE-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-MAO-COMMITTEE-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-MAO-COMMITTEE-004 [R-TGT-08] (R-TGT-08, Q-TGT-05): PS2が付けた実「ステルス」は敵の対象選択を他の味方へ逸らし、その1回で消費される", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: "ally:subject",
      battleId: "B_MAO_STEALTH",
    });
    const afterStealth = chain.fire(turnStarted({ turnNumber: 1 }), board.units);
    const stealthed = afterStealth.find((unit) => unit.battleUnitId === "ally:subject")!;
    expect(
      stealthed.appliedEffects.filter((effect) => effect.statusKind === "STEALTH"),
    ).toHaveLength(1);

    // 敵の単体攻撃を実対象選択（`SELECT`+`DEFAULT`）ごと通す。ステルスが無ければ
    // 定義順の先頭である ally:subject が選ばれる位置関係にしてある。
    const attackSkill = enemyAttackSkill();
    const attackAction = enemyAttackAction();
    const effectActions = new Map(board.definitions.effectActions);
    effectActions.set(attackAction.effectActionDefinitionId, attackAction);
    const definitions = definitionsWith(snapshot, {
      units: [...board.definitions.unitDefinitions.values()],
      skills: [attackSkill],
      overrides: { effectActions },
    });
    const attacker = afterStealth.find((unit) => unit.battleUnitId === "enemy:front")!;
    const recorder = new EventRecorder(createBattleId("B_MAO_STEALTH_ATTACK"));
    const attacked = resolveSkillUse(
      attacker,
      attackSkill,
      "AS",
      "AS",
      afterStealth,
      definitions,
      noMissNoCrit(),
      recorder,
      1,
      0,
      createActionId("B_MAO_STEALTH_ATTACK:action:1"),
      recorder.nextResolutionScopeId(),
    );

    const damaged = recorder
      .getEvents()
      .filter(
        (event): event is Extract<BattleDomainEvent, { eventType: "DamageApplied" }> =>
          event.eventType === "DamageApplied",
      )
      .map((event) => event.payload.targetUnitId);
    expect(damaged).not.toContain("ally:subject");
    expect(damaged).toEqual(["ally:front"]);

    // 逸らした1回でステルスは消費され、同じリンクグループの継続回復・被ダメージ減少も
    // 一緒に消える（「継続回復効果と被ダメージ減少効果は解除不能だがステルスが消滅すると
    // 同時に消滅する」）。
    const afterAttack = attacked.units.find((unit) => unit.battleUnitId === "ally:subject")!;
    expect(afterAttack.appliedEffects).toEqual([]);
  });

  it("IT-UNIT-MAO-COMMITTEE-005 [R-TGT-08] (R-ACTN-03, R-TGT-08): PS2の実「ステルス」は `statusKind: STEALTH`・`SKILL_USE(3)`・リンクグループを宣言どおり持ち、その `EffectApplied` の StateDelta だけからも独立Reducerが同じ効果を復元する", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: "ally:subject",
      battleId: "B_MAO_STEALTH_GRANT",
    });
    const after = chain.fire(turnStarted({ turnNumber: 1 }), board.units);

    const stealth = after
      .find((unit) => unit.battleUnitId === "ally:subject")!
      .appliedEffects.find(
        (effect) => effect.effectActionDefinitionId === "ACT_MAO_COMMITTEE_PS2_STEALTH",
      )!;
    expect(stealth).toMatchObject({ statusKind: "STEALTH", magnitude: 0 });
    expect(stealth.duration.definition).toMatchObject({
      timeLimit: { unit: "SKILL_USE", count: 3 },
      linkedEffectGroupId: "MAO_COMMITTEE_PS2_LINK",
    });
    expect(stealth.duration.timeLimitRemaining).toBe(3);

    const applied = chain.recorder
      .getEvents()
      .find(
        (event): event is Extract<BattleDomainEvent, { eventType: "EffectApplied" }> =>
          event.eventType === "EffectApplied" &&
          event.payload.effectActionDefinitionId === "ACT_MAO_COMMITTEE_PS2_STEALTH",
      )!;
    expect(applied.payload).toMatchObject({
      statusKind: "STEALTH",
      durationUnit: "SKILL_USE",
      initialRemaining: 3,
      linkedEffectGroupId: "MAO_COMMITTEE_PS2_LINK",
    });

    const reduced = applyStateDelta(
      initialSnapshotFor(board.units, { status: "READY" }),
      applied.stateDelta!,
    );
    expect(reduced.units[createBattleUnitId("ally:subject")]!.effects).toHaveLength(1);
    expect(reduced.units[createBattleUnitId("ally:subject")]!.effects![0]).toMatchObject({
      effectDefinitionId: "ACT_MAO_COMMITTEE_PS2_STEALTH",
      statusKind: "STEALTH",
      duration: { unit: "SKILL_USE", remaining: 3 },
    });
  });

  it("IT-UNIT-MAO-COMMITTEE-006 [R-ACT-02] (R-ACT-02): AS1の実 TARGET_STATE(HP_RATIO GTE 0.6) は行動選択層で評価され、HPが60%未満だとAS1が候補から外れて宣言順の次のAS2が選ばれる", () => {
    // 既定盤面のHP割合は50%で不成立。60%ちょうどは `GTE 0.6` に当たる（境界）。
    expect(selectedActiveSkill({ snapshot, unitDefinitionId: UNIT_DEFINITION_ID })).toBe(
      "SKL_MAO_COMMITTEE_AS2",
    );
    expect(
      selectedActiveSkill({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        board: { subject: { state: { currentHp: 6000 } } },
      }),
    ).toBe("SKL_MAO_COMMITTEE_AS1");
    expect(
      selectedActiveSkill({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        board: { subject: { state: { currentHp: 5999 } } },
      }),
    ).toBe("SKL_MAO_COMMITTEE_AS2");
  });

  it("IT-UNIT-MAO-COMMITTEE-007 [R-DMG-03] (R-DMG-03, R-DMG-04): PS2の実 被ダメージ補正は付与時のHP割合で焼き込まれ、以後の被弾で被ダメージ倍率へ合成される。攻撃側の `damageReductionIgnoreRate` はその負の補正だけを割合で無視する", () => {
    // `-001` のPS2行は付与時点の `magnitude`（HP50%で-0.25）までを持つが、その効果が
    // **別のスキル使用**である被弾でどう効くかは表の外にある。
    const grantAt = (currentHp: number): readonly BattleUnit[] => {
      const board = productionBoard(snapshot, UNIT_DEFINITION_ID, {
        subject: { state: { currentHp } },
      });
      return openPassiveChain({
        definitions: board.definitions,
        actorUnitId: "ally:subject",
        battleId: `B_MAO_DMG_MOD_${currentHp}`,
      }).fire(turnStarted({ turnNumber: 1 }), board.units);
    };
    const probe = (units: readonly BattleUnit[], damageReductionIgnoreRate: number) =>
      observeDamageProbe({
        units,
        attackerUnitId: "enemy:front",
        targetUnitId: "ally:subject",
        piercing: { damageReductionIgnoreRate },
      });

    // 付与時にHPが満タンなら上限の-50%。素通し500が250になる。
    const atFullHp = grantAt(10000);
    expect(
      atFullHp
        .find((unit) => unit.battleUnitId === "ally:subject")!
        .appliedEffects.find(
          (effect) => effect.effectActionDefinitionId === "ACT_MAO_COMMITTEE_PS2_DMG_DOWN",
        )!.damageModifier,
    ).toEqual({ direction: "INCOMING", damageType: null });
    expect(probe(atFullHp, 0).calculated).toEqual({
      outgoingDamageMultiplier: 1,
      incomingDamageMultiplier: 0.5,
      shieldIgnoreRate: 0,
      damageReductionIgnoreRate: 0,
      preTruncationDamage: 250,
      finalDamage: 250,
    });

    // 付与時のHPが半分なら逓減して-25%。同じ被弾が375になる（付与時点の1点で決まり、
    // 被弾時のHP割合では動かない）。
    expect(probe(grantAt(5000), 0).calculated.incomingDamageMultiplier).toBeCloseTo(0.75);

    // R-DMG-03: 攻撃側が無視するのは負の被ダメージ補正だけで、割合ぶん効きが薄れる。
    expect(probe(atFullHp, 0.5).calculated.incomingDamageMultiplier).toBeCloseTo(0.75);
    expect(probe(atFullHp, 1).calculated).toEqual({
      outgoingDamageMultiplier: 1,
      incomingDamageMultiplier: 1,
      shieldIgnoreRate: 0,
      damageReductionIgnoreRate: 1,
      preTruncationDamage: 500,
      finalDamage: 500,
    });
  });

  it("IT-UNIT-MAO-COMMITTEE-008 [R-EFF-02] (R-EFF-02): PS2の解除は `categories: [BUFF, DEBUFF]` の2カテゴリだけを取り、シールドは残る。解除が出す `EffectRemoved`／`CombatStatChanged` の公開差分だけからも実効値まで復元できる", () => {
    // `-001` のPS2行は解除対象をデバフ1件しか持たないため、2カテゴリのうち
    // `BUFF` 側が本当に取られているか・`SHIELD` が巻き込まれていないかは現れない。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const baseline = applyPrecedingActions(board, [
      { effectActionDefinitionId: CLEANSED_BUFF_ACTION_ID, target: "SELF" },
      { effectActionDefinitionId: CLEANSED_DEBUFF_ACTION_ID, target: "SELF" },
      { effectActionDefinitionId: "ACT_MAO_COMMITTEE_AS1_SHIELD", target: "SELF" },
    ]);
    const before = baseline.find((unit) => unit.battleUnitId === "ally:subject")!;
    expect(
      before.appliedEffects.map((effect) => [
        effect.effectActionDefinitionId,
        [...effect.categories],
      ]),
    ).toEqual([
      [CLEANSED_BUFF_ACTION_ID, ["BUFF"]],
      [CLEANSED_DEBUFF_ACTION_ID, ["DEBUFF"]],
      ["ACT_MAO_COMMITTEE_AS1_SHIELD", ["SHIELD"]],
    ]);
    // 攻撃力1000に+18%と-3.5%が合成された実効値。解除で1000へ戻るところまで見る。
    expect(before.combatStats.attack).toBe(1145);

    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: "ally:subject",
      battleId: "B_MAO_CLEANSE",
    });
    const initial = initialSnapshotFor(baseline, { include: ["effects"] });
    const eventsBefore = chain.recorder.getEvents().length;
    const after = chain.fire(turnStarted({ turnNumber: 1 }), baseline);

    const holder = after.find((unit) => unit.battleUnitId === "ally:subject")!;
    // バフもデバフも消え、シールドだけが解除の前から残っている。以降はPS2自身の付与。
    expect(holder.appliedEffects.map((effect) => effect.effectActionDefinitionId)).toEqual([
      "ACT_MAO_COMMITTEE_AS1_SHIELD",
      "ACT_MAO_COMMITTEE_PS2_STEALTH",
      "ACT_MAO_COMMITTEE_PS2_HEAL",
      "ACT_MAO_COMMITTEE_PS2_DMG_DOWN",
    ]);
    expect(holder.combatStats.attack).toBe(1000);

    // 解除は1インスタンスにつき `EffectRemoved` と実効値の `CombatStatChanged` を出す。
    const emitted = chain.recorder.getEvents().slice(eventsBefore);
    expect(
      emitted
        .filter(
          (event) => event.eventType === "EffectRemoved" || event.eventType === "CombatStatChanged",
        )
        .map((event) => event.eventType),
    ).toEqual(["EffectRemoved", "CombatStatChanged", "EffectRemoved", "CombatStatChanged"]);

    // 独立Reducer復元: 解除も付与も公開差分だけで同じ最終状態へ届く。
    expect(
      reduceStateDeltas(
        initial,
        emitted.flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta])),
      ),
    ).toEqual(initialSnapshotFor(after, { include: ["effects"] }));
  });
  it("IT-UNIT-MAO-COMMITTEE-009 [R-DOT-02] (R-DOT-02): AS2が配る固定継続ダメージは保持者自身の行動開始でENダメージとして発生し、炎上・毒と違って**シールドで受けられる**。シールドを削り切った分だけHPへ抜け、枯渇したシールドはその場で失効する", () => {
    // `-001` のAS2行は付与そのもの（付与時攻撃力×20%＝200のsnapshotと3行動）までを
    // 固定する。R-DOT-02の適用順（タイプありシールド → タイプなしシールド → HP）は
    // 保持者の以後の行動に属し、スキル使用1回の観測には載らない。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, {
      // 実 `ACT_MAO_COMMITTEE_AS1_SHIELD` は使用者の現在HP×6.25%。2回の発生で
      // ちょうど削り切れる300にするため、使用者のHPを4800に置く。
      subject: { state: { currentHp: 4800 } },
    });
    // 前提アクションは既定順の最も近い敵（enemy:front）だけへ入る。
    const debuffed = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_MAO_COMMITTEE_AS2_DMG_DEBUFF", target: "ENEMY" },
      { effectActionDefinitionId: "ACT_MAO_COMMITTEE_AS1_SHIELD", target: "ENEMY" },
    ]);

    const observed = observeContinuousDamage({
      units: debuffed,
      definitions: board.definitions,
      // 3行動のデバフに対し、保持者の行動開始を2回通す。
      actors: ["enemy:front", "enemy:front"],
      battleId: "B_MAO_FIXED_DOT",
    });

    expect(observed.steps).toEqual([
      {
        step: "ACTION_START(enemy:front)",
        ticks: [
          {
            unitId: "enemy:front",
            effectActionDefinitionId: "ACT_MAO_COMMITTEE_AS2_DMG_DEBUFF",
            // 炎上でも毒でもない固定継続ダメージ。
            continuousDamageKind: "FIXED",
            damageType: "EN",
            snapshotAttack: 1000,
            formulaResult: 200,
            // R-DOT-03の2倍は炎上だけ、R-DOT-04の上限は毒だけの規則。
            burnStackMultiplier: 1,
            cappedBySnapshotAttack: false,
            calculatedDamage: 200,
            // タイプなしシールド300が全量を受け、HPへは1も届かない。
            typedShieldAbsorbed: 0,
            untypedShieldAbsorbed: 200,
            subUnitAbsorbed: 0,
            discardedDamage: 0,
            hitPointDamage: 0,
          },
        ],
        hpDeltas: {},
      },
      {
        step: "ACTION_START(enemy:front)",
        ticks: [
          {
            unitId: "enemy:front",
            effectActionDefinitionId: "ACT_MAO_COMMITTEE_AS2_DMG_DEBUFF",
            continuousDamageKind: "FIXED",
            damageType: "EN",
            snapshotAttack: 1000,
            formulaResult: 200,
            burnStackMultiplier: 1,
            cappedBySnapshotAttack: false,
            calculatedDamage: 200,
            // 残り100を吸ってから、残余100がHPへ抜ける。
            typedShieldAbsorbed: 0,
            untypedShieldAbsorbed: 100,
            subUnitAbsorbed: 0,
            discardedDamage: 0,
            hitPointDamage: 100,
          },
        ],
        // R-SHD-01第3項: 残量0になったシールドインスタンスはその場で失効する。
        expired: ["ACT_MAO_COMMITTEE_AS1_SHIELD"],
        hpDeltas: { "enemy:front": -100 },
      },
    ]);

    // 公開差分だけを当て直した状態を、スナップショット全体で突き合わせる。
    // 吸収量・失効イベント・HP変化が合っていても、`ShieldConsumed` や
    // `EffectExpired` のStateDeltaが欠ければここで落ちる。
    expect(
      reduceStateDeltas(
        initialSnapshotFor(debuffed, { include: ["effects"] }),
        observed.recorder
          .getEvents()
          .flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta])),
      ),
    ).toEqual(initialSnapshotFor(observed.units, { include: ["effects"] }));
  });
});
