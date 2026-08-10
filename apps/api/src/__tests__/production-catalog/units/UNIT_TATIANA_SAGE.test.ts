import { describe, expect, it } from "vitest";
import type { BattleDomainEvent } from "../../../domain/battle/events/domain-event.js";
import { EventRecorder } from "../../../domain/battle/events/event-recorder.js";
import { resolveSkillUse } from "../../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { reduceStateDeltas } from "../../../domain/battle/lifecycle/state-delta-reducer.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../../domain/catalog/definitions/skill-definition.js";
import type { BattleDefinitions } from "../../../domain/battle/model/battle-definitions.js";
import type { EffectActionDefinition } from "../../../domain/catalog/definitions/effect-action-definition.js";
import type { BattleUnit } from "../../../domain/battle/model/battle-unit.js";
import { createActionId } from "../../../domain/shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../../domain/shared/ids.js";
import {
  initialSnapshotFor,
  loadProductionSnapshot,
  noMissNoCrit,
  skillFrom,
  unitFrom,
} from "../../../testing/fixtures/index.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import { observeDamageProbe } from "../../../testing/production-unit/damage-probe.js";
import { observeCumulativeThresholdCounter } from "../../../testing/production-unit/runtime-counter.js";
import {
  PRODUCTION_CATALOG_DIR,
  applyPrecedingActions,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  selectedActiveSkill,
  type BoardOverrides,
  type BoardUnitSpec,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { realDamage } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_TATIANA_SAGE`(【理解深き老成の智者】タチアナ・ドロズドヴァ)のユニット単位
 * production結合テスト(`12_テスト戦略.md`「ユニット効果軸」)。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_TATIANA_SAGE";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const OMEN = "MARKER_TATIANA_SAGE_OMEN";
const PRUDENCE = "MARKER_TATIANA_SAGE_PRUDENCE";
const EX_DEBUFF = "ACT_TATIANA_SAGE_EX_DEBUFF";

/** 「凶兆」の所持数を敵ごとに作り分ける。EXの対象別振り分けを判別するため。 */
function enemiesWithOmen(stacks: readonly [number, number, number]): readonly BoardUnitSpec[] {
  const positions = [
    { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } as const },
    { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } as const },
    { id: "enemy:back", position: { column: "CENTER", row: "BACK" } as const },
  ];
  return positions.map((entry, index) => ({
    ...entry,
    ...(stacks[index] === 0 ? {} : { markers: [{ markerId: OMEN, stackCount: stacks[index]! }] }),
  }));
}

/** 0個（Marker無し）・2個（しきい値一致）・3個（超過）を同じ解決へ混ぜる盤面。 */
const MIXED_OMEN: BoardOverrides = { enemies: enemiesWithOmen([0, 2, 3]) };

/** 分岐のしきい値（4つ以上）へ、このスキルの付与1つで到達する前提。 */
const PRIMARY_HAS_THREE_OMEN: BoardOverrides = { enemies: enemiesWithOmen([3, 0, 0]) };

/** 「深慮」を所持している前提。AS2とPS1はどちらも発動しなくなる。 */
const HOLDS_PRUDENCE: BoardOverrides = {
  subject: { markers: [{ markerId: PRUDENCE, stackCount: 1 }] },
};

/** PS1の契機。累計で最大HP×20%（2000）を超える被弾でカウンタが動く。 */
const HEAVY_HIT = realDamage({
  from: "enemy:front",
  to: "ally:subject",
  skillType: "AS",
  power: 5,
});

const PS1_SHIELD_APPLIED = {
  unitId: "ally:subject",
  effectActionDefinitionId: "ACT_TATIANA_SAGE_PS1_SHIELD",
  // 最大HP10000 × 12.5%。
  magnitude: 1250,
  consumption: { kind: "INCOMING_HIT", maxCount: 1 },
} as const;

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_TATIANA_SAGE_EX",
    intent:
      "敵全体に威力169.6でEN攻撃する。攻撃時に対象が「凶兆」を2つ以上所持していた場合、さらに対象の次の攻撃での与ダメージを100％減少させるデバフを付与する。対象が「凶兆」を2つ所持していなかった場合、「凶兆」を1つ付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_TATIANA_SAGE_EX" },
    board: MIXED_OMEN,
    expected: {
      // 攻撃は無条件で全対象へ。デバフはしきい値以上の2体、「凶兆」付与は未満の1体。
      actions: [
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: EX_DEBUFF, targets: ["enemy:left"] },
        { effectActionDefinitionId: EX_DEBUFF, targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_EX_MARK", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -848, "enemy:left": -848, "enemy:back": -848 },
      effectsApplied: [
        {
          unitId: "enemy:left",
          effectActionDefinitionId: EX_DEBUFF,
          magnitude: -1,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: EX_DEBUFF,
          magnitude: -1,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      markers: [{ unitId: "enemy:front", markerId: OMEN, stackCount: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_TATIANA_SAGE_AS1",
    intent:
      "攻撃力が最も高い敵単体に威力93.6で攻撃し、1行動の幻惑を付与する。…さらに対象に「凶兆」を1つと、1行動の攻撃力×10％の継続ENダメージを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_TATIANA_SAGE_AS1" },
    expected: {
      // 「凶兆」が4つに届かないため追加攻撃の腕は選ばれない。
      actions: [
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_AS1_DAZZLE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_AS1_MARK", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_AS1_DOT", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -468 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_TATIANA_SAGE_AS1_DAZZLE",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "DAMAGE_TO_HEAL",
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_TATIANA_SAGE_AS1_DOT",
          magnitude: 100,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      markers: [{ unitId: "enemy:front", markerId: OMEN, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_TATIANA_SAGE_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_TATIANA_SAGE_AS1",
    intent:
      "このスキルの発動により対象の所持する「凶兆」が4つ以上になった場合、さらに威力100で追加EN攻撃を行い、対象が所持している「凶兆」を全て解除する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_TATIANA_SAGE_AS1" },
    board: PRIMARY_HAS_THREE_OMEN,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_AS1_DAZZLE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_AS1_MARK", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_AS1_DOT", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_AS1_FOLLOWUP", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_AS1_CLEAR_OMEN", targets: ["enemy:front"] },
      ],
      // 本体468に追加攻撃500。
      hpDeltas: { "enemy:front": -968 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_TATIANA_SAGE_AS1_DAZZLE",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "DAMAGE_TO_HEAL",
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_TATIANA_SAGE_AS1_DOT",
          magnitude: 100,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      // 3つ + このスキルの1つ = 4つが、保持ごと無くなる。
      markersRemoved: [{ unitId: "enemy:front", markerId: OMEN, stackCount: 3 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_TATIANA_SAGE_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_TATIANA_SAGE_AS2",
    intent:
      "敵単体に威力46.8で3ヒットEN攻撃し、1行動の間対象の会心率を20％、会心ダメージを50％低下させる。さらに対象に「凶兆」を1つと、1行動の攻撃力×10％の継続ENダメージを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_TATIANA_SAGE_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_AS2_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_TATIANA_SAGE_AS2_CRIT_RATE_DOWN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_TATIANA_SAGE_AS2_CRIT_DMG_DOWN",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_AS2_MARK", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_AS2_DOT", targets: ["enemy:front"] },
      ],
      // 1ヒット234の3ヒット。
      hpDeltas: { "enemy:front": -702 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_TATIANA_SAGE_AS2_CRIT_RATE_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_TATIANA_SAGE_AS2_CRIT_DMG_DOWN",
          magnitude: -0.5,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_TATIANA_SAGE_AS2_DOT",
          magnitude: 100,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      markers: [{ unitId: "enemy:front", markerId: OMEN, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_TATIANA_SAGE_AS2", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_TATIANA_SAGE_AS2",
    intent:
      "このスキルの発動により対象の所持する「凶兆」が4つ以上になった場合、さらに威力100で追加EN攻撃を行い、対象が所持している「凶兆」を全て解除する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_TATIANA_SAGE_AS2" },
    board: PRIMARY_HAS_THREE_OMEN,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_AS2_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_TATIANA_SAGE_AS2_CRIT_RATE_DOWN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_TATIANA_SAGE_AS2_CRIT_DMG_DOWN",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_AS2_MARK", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_AS2_DOT", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_AS2_FOLLOWUP", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_AS2_CLEAR_OMEN", targets: ["enemy:front"] },
      ],
      // 本体702に追加攻撃500。
      hpDeltas: { "enemy:front": -1202 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_TATIANA_SAGE_AS2_CRIT_RATE_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_TATIANA_SAGE_AS2_CRIT_DMG_DOWN",
          magnitude: -0.5,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_TATIANA_SAGE_AS2_DOT",
          magnitude: 100,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      markersRemoved: [{ unitId: "enemy:front", markerId: OMEN, stackCount: 3 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_TATIANA_SAGE_AS2", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_TATIANA_SAGE_AS2",
    intent: "(不成立): 自身が「深慮」を所持していた場合、このスキルは発動しない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_TATIANA_SAGE_AS2" },
    board: HOLDS_PRUDENCE,
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_TATIANA_SAGE_AS3",
    intent: "敵単体に威力190.8でEN攻撃し、「凶兆」を1つ付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_TATIANA_SAGE_AS3" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_AS3_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_AS3_MARK", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -954 },
      markers: [{ unitId: "enemy:front", markerId: OMEN, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_TATIANA_SAGE_PS1",
    intent:
      "累計で最大HP×20％のダメージを受けた際に発動。自身に対し、最大HP×12.5％のシールドを付与する。シールドは1ヒット攻撃を受けると消滅する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_TATIANA_SAGE_PS1",
      trigger: HEAVY_HIT,
    },
    expected: {
      // 被弾後も 2500/10000 で20%を下回らないため、EX加算以降の腕は選ばれない。
      actions: [
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_PS1_SHIELD", targets: ["ally:subject"] },
      ],
      effectsApplied: [PS1_SHIELD_APPLIED],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_TATIANA_SAGE_PS1",
    intent:
      "さらに自身のHPが20％未満だった場合、自身のEXゲージを5加算し、さらに致死ダメージを1度だけ耐えてHPを最大HP×25％回復するバフと、「深慮」（解除不可）を付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_TATIANA_SAGE_PS1",
      trigger: HEAVY_HIT,
    },
    // 契機の被弾（2500）で 1500/10000 ＝ 15% へ落ち、閾値を下回る。
    board: { subject: { state: { currentHp: 4000 } } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_PS1_SHIELD", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_PS1_EX_UP", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_TATIANA_SAGE_PS1_DEATH_SURVIVAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_TATIANA_SAGE_PS1_PRUDENCE_MARK",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        PS1_SHIELD_APPLIED,
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_TATIANA_SAGE_PS1_DEATH_SURVIVAL",
          magnitude: 0,
          timeLimit: { unit: "BATTLE", count: 1 },
          consumption: { kind: "LETHAL_DAMAGE", maxCount: 1 },
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: PRUDENCE, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        // PS発動によるEX獲得（消費PP分の1）と、`ACT_..._PS1_EX_UP` の加算5。
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 6 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_TATIANA_SAGE_PS1",
    intent: "(不成立): 自身が「深慮」を所持していた場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_TATIANA_SAGE_PS1",
      trigger: HEAVY_HIT,
    },
    board: HOLDS_PRUDENCE,
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_TATIANA_SAGE_PS1",
    intent: "(不成立): 累計被ダメージが最大HP×20％に届かない被弾では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_TATIANA_SAGE_PS1",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:subject",
        skillType: "AS",
        power: 1,
      }),
    },
    expected: { activated: false },
  },
];

const EX_ATTACK_ACTION_ID = "ACT_TEST_TATIANA_NEXT_ATTACK";

/** デバフ保持者が撃つ「次の攻撃」。`OUTGOING`／`damageType: null` なので種別は問わない。 */
function nextAttackAction(): Extract<EffectActionDefinition, { kind: "DAMAGE" }> {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(EX_ATTACK_ACTION_ID),
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

const NEXT_ATTACK_SKILL_ID = "SKL_TEST_TATIANA_NEXT_ATTACK";

/** 「次の攻撃」を実スキル使用として撃つための最小のAS（消費点の評価まで通す）。 */
function nextAttackSkill(): SkillDefinition {
  const binding = createTargetBindingId("TGT_TEST_TATIANA_NEXT");
  return {
    skillDefinitionId: createSkillDefinitionId(NEXT_ATTACK_SKILL_ID),
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
            { effectActionDefinitionId: createEffectActionDefinitionId(EX_ATTACK_ACTION_ID) },
          ],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    metadata: { displayName: NEXT_ATTACK_SKILL_ID, tags: [] },
  };
}

/** EXを混在盤面で1回使い、盤面と発行イベントを返す。 */
function fireEx() {
  const board = productionBoard(snapshot, UNIT_DEFINITION_ID, MIXED_OMEN);
  const definitions: BattleDefinitions = {
    ...board.definitions,
    effectActions: new Map(board.definitions.effectActions).set(
      createEffectActionDefinitionId(EX_ATTACK_ACTION_ID),
      nextAttackAction(),
    ),
    skillDefinitions: new Map(board.definitions.skillDefinitions).set(
      createSkillDefinitionId(NEXT_ATTACK_SKILL_ID),
      nextAttackSkill(),
    ),
  };
  const recorder = new EventRecorder(createBattleId("B_TATIANA_EX"));
  const result = resolveSkillUse(
    board.subject,
    skillFrom(snapshot, "SKL_TATIANA_SAGE_EX"),
    "EX",
    "EX",
    board.units,
    definitions,
    noMissNoCrit(256),
    recorder,
    1,
    0,
    createActionId("B_TATIANA_EX:action:1"),
    recorder.nextResolutionScopeId(),
  );
  return { board, definitions, recorder, units: result.units, emitted: recorder.getEvents() };
}

function unitOf(units: readonly BattleUnit[], battleUnitId: string): BattleUnit {
  return units.find((unit) => unit.battleUnitId === battleUnitId)!;
}

/** `attacker` が「次の攻撃」を撃つ。実スキル使用を通すため消費点まで評価される。 */
function strike(
  fired: ReturnType<typeof fireEx>,
  units: readonly BattleUnit[],
  attacker: string,
  actionNumber: number,
) {
  const { recorder, definitions } = fired;
  const before = recorder.getEvents().length;
  const result = resolveSkillUse(
    unitOf(units, attacker),
    definitions.skillDefinitions.get(createSkillDefinitionId(NEXT_ATTACK_SKILL_ID))!,
    "AS",
    "AS",
    units,
    definitions,
    noMissNoCrit(256),
    recorder,
    1,
    1,
    createActionId(`B_TATIANA_EX:action:${actionNumber}`),
    recorder.nextResolutionScopeId(),
  );
  return { units: result.units, emitted: recorder.getEvents().slice(before) };
}

describe("production Catalog UNIT_TATIANA_SAGE (【理解深き老成の智者】タチアナ・ドロズドヴァ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-TATIANA-SAGE-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-TATIANA-SAGE-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-TATIANA-SAGE-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-TATIANA-SAGE-004: EXの対象別振り分けは1つの解決スコープ・1つの因果木に収まり、StateDeltaを伴うイベントだけが stateVersion を1進める", () => {
    const { emitted, board } = fireEx();

    const root = emitted[0]!;
    expect(root.parentEventId).toBeUndefined();
    for (const event of emitted) {
      expect(event.resolutionScopeId).toBe(root.resolutionScopeId);
      expect(event.rootEventId).toBe(root.eventId);
      if (event !== root) {
        expect(event.parentEventId).toBeDefined();
      }
    }

    let expectedVersion = root.stateVersionBefore;
    for (const event of emitted) {
      expect(event.stateVersionBefore).toBe(expectedVersion);
      expectedVersion = event.stateDelta === undefined ? expectedVersion : expectedVersion + 1;
      expect(event.stateVersionAfter).toBe(expectedVersion);
    }

    // 対象別の付与はそれぞれ独立したイベントとして残る。
    const debuffed = emitted
      .filter(
        (event) =>
          event.eventType === "EffectApplied" &&
          event.payload.effectActionDefinitionId === EX_DEBUFF,
      )
      .map((event) => (event.payload as { targetUnitId: string }).targetUnitId);
    expect(debuffed.sort()).toEqual(["enemy:back", "enemy:left"]);
    expect(
      emitted
        .filter(
          (event) => event.eventType === "MarkerApplied" || event.eventType === "MarkerUpdated",
        )
        .map((event) => (event.payload as { targetUnitId: string }).targetUnitId),
    ).toEqual(["enemy:front"]);
    expect(board.units).toHaveLength(6);
  });

  it("IT-UNIT-TATIANA-SAGE-005 (R-EFF-07/R-DMG-02): 「次の攻撃での与ダメージを100％減少」は与ダメージ倍率を0まで落とし、その攻撃で消費されて失効する。デバフを持たない対象は影響を受けない", () => {
    const fired = fireEx();
    const undebuffed = "enemy:front";
    const debuffed = "enemy:left";

    // 対照: デバフを持たない対象の同一攻撃は通常どおりHPを削る。
    const control = strike(fired, fired.units, undebuffed, 2);
    const controlDamage = (
      control.emitted.find((event) => event.eventType === "DamageApplied")!.payload as {
        hitPointDamage: number;
      }
    ).hitPointDamage;
    expect(controlDamage).toBeGreaterThan(0);

    // 丸め前ダメージは0だが、最終ダメージはR-DMG-02 #3「1未満の場合も1とする」で
    // 1へ引き上げられる — `APPLY_DAMAGE_MOD` はこの上書きを宣言していない。
    const nullified = strike(fired, control.units, debuffed, 3);
    expect(
      nullified.emitted.find((event) => event.eventType === "DamageCalculated")!.payload,
    ).toMatchObject({ outgoingDamageMultiplier: 0, preTruncationDamage: 0 });
    expect(
      (
        nullified.emitted.find((event) => event.eventType === "DamageApplied")!.payload as {
          hitPointDamage: number;
        }
      ).hitPointDamage,
    ).toBe(1);

    // `NEXT_OUTGOING_ATTACK` はその攻撃で消費され、次の攻撃は通常ダメージへ戻る。
    expect(
      unitOf(nullified.units, debuffed).appliedEffects.filter(
        (effect) => effect.effectActionDefinitionId === EX_DEBUFF,
      ),
    ).toHaveLength(0);
    const restored = strike(fired, nullified.units, debuffed, 4);
    expect(
      (
        restored.emitted.find((event) => event.eventType === "DamageApplied")!.payload as {
          hitPointDamage: number;
        }
      ).hitPointDamage,
    ).toBe(controlDamage);
  });

  it("IT-UNIT-TATIANA-SAGE-006: EXの混在解決は、公開差分だけを素の盤面へ当て直すだけで同じ状態へ復元できる", () => {
    const { board, units, emitted } = fireEx();
    const snapshotOf = (state: readonly BattleUnit[]) =>
      initialSnapshotFor(state, { include: ["effects", "markers"] });

    const restored = reduceStateDeltas(
      snapshotOf(board.units),
      emitted.flatMap((event: BattleDomainEvent) =>
        event.stateDelta === undefined ? [] : [event.stateDelta],
      ),
    );
    expect(restored).toEqual(snapshotOf(units));
    expect(
      restored.units[createBattleUnitId("enemy:left")]!.effects!.filter(
        (effect) => effect.effectDefinitionId === EX_DEBUFF,
      ),
    ).toHaveLength(1);
    expect(
      restored.units[createBattleUnitId("enemy:front")]!.markers!.find(
        (marker) => marker.markerId === OMEN,
      )?.stackCount,
    ).toBe(1);
  });

  it("IT-UNIT-TATIANA-SAGE-007 (R-ACT-02): AS2の実 NOT(TARGET_HAS_MARKER「深慮」) は行動選択層で評価され、「深慮」を持つとAS2が候補から外れて宣言順の次のAS3が選ばれる", () => {
    // 宣言順の先頭はAS1なので、AS2の発動条件が選択に効く局面はAS1が使えないとき。
    // クールタイム中（R-ACT-02の別条件）にして、その次のASから評価させる。
    const AS1_COOLING: BoardOverrides = {
      subject: {
        state: {
          cooldowns: {
            [createSkillDefinitionId("SKL_TATIANA_SAGE_AS1")]: { unit: "TURN", remaining: 1 },
          },
        },
      },
    };
    expect(selectedActiveSkill({ snapshot, unitDefinitionId: UNIT_DEFINITION_ID })).toBe(
      "SKL_TATIANA_SAGE_AS1",
    );
    expect(
      selectedActiveSkill({ snapshot, unitDefinitionId: UNIT_DEFINITION_ID, board: AS1_COOLING }),
    ).toBe("SKL_TATIANA_SAGE_AS2");

    expect(
      selectedActiveSkill({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        board: { ...AS1_COOLING, subject: { ...AS1_COOLING.subject, ...HOLDS_PRUDENCE.subject } },
      }),
    ).toBe("SKL_TATIANA_SAGE_AS3");
  });

  it("IT-UNIT-TATIANA-SAGE-008 (BOUNDARY, R-SKL-06): EXの対象別条件 `TARGET_HAS_MARKER(「凶兆」GTE 2)` としきい値未満の補集合は、同じ1回の使用の中で0個・1個・2個・3個の対象を取り違えずに振り分ける", () => {
    expect(
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use: { kind: "ACTIVE", skillDefinitionId: "SKL_TATIANA_SAGE_EX" },
        board: {
          enemies: [
            { id: "enemy:none", position: { column: "CENTER", row: "FRONT" } },
            {
              id: "enemy:below",
              position: { column: "LEFT", row: "FRONT" },
              markers: [{ markerId: OMEN, stackCount: 1 }],
            },
            {
              id: "enemy:at",
              position: { column: "CENTER", row: "BACK" },
              markers: [{ markerId: OMEN, stackCount: 2 }],
            },
            {
              id: "enemy:above",
              position: { column: "LEFT", row: "BACK" },
              markers: [{ markerId: OMEN, stackCount: 3 }],
            },
          ],
        },
      }),
    ).toEqual({
      // 攻撃は敵全体へ無条件。デバフはしきい値以上の2体、「凶兆」付与は未満の2体で、
      // 1個所持（しきい値未満）が付与側へ落ちることがこの行の境界。
      actions: [
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_EX_DAMAGE", targets: ["enemy:none"] },
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_EX_DAMAGE", targets: ["enemy:below"] },
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_EX_DAMAGE", targets: ["enemy:at"] },
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_EX_DAMAGE", targets: ["enemy:above"] },
        { effectActionDefinitionId: EX_DEBUFF, targets: ["enemy:at"] },
        { effectActionDefinitionId: EX_DEBUFF, targets: ["enemy:above"] },
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_EX_MARK", targets: ["enemy:none"] },
        { effectActionDefinitionId: "ACT_TATIANA_SAGE_EX_MARK", targets: ["enemy:below"] },
      ],
      hpDeltas: {
        "enemy:none": -848,
        "enemy:below": -848,
        "enemy:at": -848,
        "enemy:above": -848,
      },
      effectsApplied: [
        {
          unitId: "enemy:at",
          effectActionDefinitionId: EX_DEBUFF,
          magnitude: -1,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "enemy:above",
          effectActionDefinitionId: EX_DEBUFF,
          magnitude: -1,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      markers: [
        { unitId: "enemy:none", markerId: OMEN, stackCount: 1 },
        { unitId: "enemy:below", markerId: OMEN, stackCount: 2 },
      ],
    });
  });

  it("IT-UNIT-TATIANA-SAGE-009 (R-EFF-11): PS1 の累計ダメージ閾値counterは、閾値に届かない被弾では carry だけを動かし、実 catalog/ の trigger 条件がその RuntimeCounterChanged を valueChanged で弾く。ちょうど閾値・閾値2つぶんの被弾では公開値が動き、条件が成立する", () => {
    // `RuntimeCounterChanged` は carry だけが動いた被弾でも追跡のために発行される
    // （`14_Catalog定義スキーマ.md`「counterUpdates」）。条件側で判別できないと、
    // 閾値に達していない被弾のたびにPSが発動してしまう。
    expect(
      observeCumulativeThresholdCounter(snapshot, UNIT_DEFINITION_ID, "SKL_TATIANA_SAGE_PS1"),
    ).toEqual({
      declaration: {
        counter: "SKL_TATIANA_SAGE_PS1_THRESHOLD_COUNT",
        scope: "SKILL_RUNTIME",
        maxHpRatio: 0.2,
      },
      triggerEventType: "RuntimeCounterChanged",
      subThreshold: {
        changes: [
          {
            skillDefinitionId: "SKL_TATIANA_SAGE_PS1",
            counter: "SKL_TATIANA_SAGE_PS1_THRESHOLD_COUNT",
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
            skillDefinitionId: "SKL_TATIANA_SAGE_PS1",
            counter: "SKL_TATIANA_SAGE_PS1_THRESHOLD_COUNT",
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
            skillDefinitionId: "SKL_TATIANA_SAGE_PS1",
            counter: "SKL_TATIANA_SAGE_PS1_THRESHOLD_COUNT",
            before: 0,
            after: 2,
            valueChanged: true,
          },
        ],
        triggerMatched: true,
      },
    });
  });

  it("IT-UNIT-TATIANA-SAGE-010 (R-DTH-01): AS1が付けた幻惑は、以後その敵が放つ攻撃を production の `healRate: 0.7` でタチアナへの回復へ変換する。HP変化のStateDeltaはこのイベントだけが持つ", () => {
    // 付与とその効果が働く攻撃は別のスキル使用であり、`-001` の振る舞い表は
    // 前者しか表せない。`statusKind: DAMAGE_TO_HEAL` までは `-001` が持つが、
    // `healRate` と「ダメージが一切入らず回復になる」ことは持てない。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const dazzled = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_TATIANA_SAGE_AS1_DAZZLE", target: "ENEMY" },
    ]);
    expect(
      unitOf(dazzled, "enemy:front").appliedEffects.find(
        (effect) => effect.effectActionDefinitionId === "ACT_TATIANA_SAGE_AS1_DAZZLE",
      )!.statusDetails?.damageToHeal,
    ).toEqual({ healRate: 0.7 });

    const hit = observeDamageProbe({
      units: dazzled,
      attackerUnitId: "enemy:front",
      targetUnitId: "ally:subject",
      battleId: "B_TATIANA_DAZZLE_HIT",
    });

    // 攻撃力1000 - 防御力500 = 500 のダメージが floor(500 x 0.7) = 350 の回復になる。
    expect(hit.convertedToHeal).toEqual([
      {
        effectActionDefinitionId: "ACT_TEST_DAMAGE_PROBE",
        targetUnitId: "ally:subject",
        calculatedDamage: 500,
        healRate: 0.7,
        healAmount: 350,
        appliedHeal: 350,
        hpBefore: 5000,
        hpAfter: 5350,
      },
    ]);
    // ダメージとしては1も適用されない（`DamageApplied` が一度も出ない）。
    expect(hit.applications).toEqual([]);
    expect(hit.hpDeltas).toEqual({ "ally:subject": 350 });

    // HP変化のStateDeltaは `DamageConvertedToHeal` だけが持ち、開始前スナップショットへ
    // それを当て直すだけで同じHPへ復元できる。
    const converted = hit.recorder
      .getEvents()
      .find((event) => event.eventType === "DamageConvertedToHeal")!;
    expect(
      reduceStateDeltas(initialSnapshotFor(dazzled), [converted.stateDelta!]).units[
        createBattleUnitId("ally:subject")
      ]!.hp,
    ).toBe(5350);
  });
});
