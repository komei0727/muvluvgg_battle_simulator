import { describe, expect, it } from "vitest";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
import { computeCombatStats } from "../../../domain/battle/effects/combat-stat-recalculation-service.js";
import { resolveAttributeMultiplier } from "../../../domain/battle/combat/attribute-affinity-policy.js";
import { createPercentage } from "../../../domain/shared/percentage.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import {
  PRODUCTION_CATALOG_DIR,
  applyPrecedingActions,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardOverrides,
  type BoardUnitSpec,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  realEffectApplication,
  skillUseCompleted,
  turnStarted,
} from "../../../testing/production-unit/trigger-events.js";
import { observeEffectExpiry } from "../../../testing/production-unit/effect-expiry.js";
import {
  activatedPassiveSkillIds,
  openPassiveChain,
} from "../../../testing/production-unit/passive-activation.js";

/**
 * `UNIT_INIA_CRYSKA`（【スカーレット・ツイン】イーニァ＆クリスカ）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」、Issue #763）。
 *
 * 盤面は攻撃力1000・防御力500・属性相性ボーナス0で、相手役は全員アグレッシブ属性。
 * PS1の契機となる気絶は、実Catalogの気絶付与（`ACT_OLGA_NADYA_BOND_EX_STUN`）を実
 * resolverへ通して作る — 味方が本当に気絶を保持していないと、デバフ全解除の腕が
 * 何も解除しない。
 */

const UNIT_DEFINITION_ID = "UNIT_INIA_CRYSKA";
const STUN_SOURCE_UNIT_ID = "UNIT_OLGA_NADYA_BOND";
const STUN_ACTION = "ACT_OLGA_NADYA_BOND_EX_STUN";
const FREEZE_SOURCE_UNIT_ID = "UNIT_MIRIAM_MAGE";
const FREEZE_ACTION = "ACT_MIRIAM_MAGE_EX_FREEZE";
/** 状態異常（STATUS）だが気絶・凍結ではない付与。PS1の条件が「状態異常全般」に緩んでいないかを見る。 */
const POISON_SOURCE_UNIT_ID = "UNIT_CHIYURU_MAZE";
const POISON_ACTION = "ACT_CHIYURU_MAZE_AS1_POISON";
const PRAVKA = "MARKER_INIA_CRYSKA_PRAVKA";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  STUN_SOURCE_UNIT_ID,
  FREEZE_SOURCE_UNIT_ID,
  POISON_SOURCE_UNIT_ID,
]);

/** 先行するDAMAGEの会心判定を 0.99 で外し、`RANDOM_BRANCH` の抽選値を置く列。 */
function rolls(...draws: readonly number[]): () => SequenceRandomSource {
  return () => new SequenceRandomSource([...draws, ...new Array<number>(64).fill(0.99)]);
}

/** PS1: 敵3体への1ヒットずつの会心判定（3回）のあとに腕の抽選が来る。 */
const PS1_CLEANSE = rolls(0.99, 0.99, 0.99, 0.1);
const PS1_SHIELD = rolls(0.99, 0.99, 0.99, 0.9);

const PS1_DAMAGE_ACTIONS = ["enemy:front", "enemy:left", "enemy:back"].map((id) => ({
  effectActionDefinitionId: "ACT_INIA_CRYSKA_PS1_DAMAGE",
  targets: [id],
}));
/** 威力35.1: (1000 - 500) × 0.351 = 175.5 → 175。 */
const PS1_HP_DELTAS = { "enemy:front": -175, "enemy:left": -175, "enemy:back": -175 };
const PS1_RESOURCES = [
  { unitId: "ally:subject", resource: "PP", delta: -2 },
  { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
] as const;
const PS1_COOLDOWN = [
  { unitId: "ally:subject", skillDefinitionId: "SKL_INIA_CRYSKA_PS1", remaining: 2 },
] as const;

type SubjectOverrides = NonNullable<BoardOverrides["subject"]>;

/** PS2は「アクティブスキル3回目の使用」でだけ発動する。counterを2に置いて次を3回目にする。 */
function ps2CounterAtTwo(subject: SubjectOverrides = {}): SubjectOverrides {
  return {
    ...subject,
    state: {
      ...subject.state,
      skillCounters: {
        [createSkillDefinitionId("SKL_INIA_CRYSKA_PS2")]: {
          [createRuntimeCounterId("SKL_INIA_CRYSKA_PS2_AS_USES")]: { value: 2, carry: 0 },
        },
      },
    },
  };
}

const PS2_TRIGGER = {
  kind: "PASSIVE",
  skillDefinitionId: "SKL_INIA_CRYSKA_PS2",
  trigger: skillUseCompleted({
    actor: "ally:subject",
    targets: ["enemy:front"],
    skillType: "AS",
    skillDefinitionId: "SKL_INIA_CRYSKA_AS1",
  }),
  triggeredBy: "ally:subject",
} as const;

/** 自身＝シャイ（サブ: スマート）。 */
const SHY_SMART_SUBJECT: SubjectOverrides = {
  attribute: "SHY",
  state: { subAttribute: "SMART" },
};

/** PS5: 最も遠い敵（右後列）の属性で発動可否が決まる盤面。手前の敵は常にキュート。 */
function farthestEnemyIs(attribute: "CUTE" | "AGGRESSIVE" | "CLEVER"): readonly BoardUnitSpec[] {
  return [
    { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, attribute: "CUTE" },
    { id: "enemy:far", position: { column: "RIGHT", row: "BACK" }, attribute },
  ];
}

const PS3_ACTIVATED = {
  actions: [
    { effectActionDefinitionId: "ACT_INIA_CRYSKA_PS3_AFFINITY_UP", targets: ["ally:subject"] },
    { effectActionDefinitionId: "ACT_INIA_CRYSKA_PS3_AFFINITY_UP", targets: ["ally:front"] },
    { effectActionDefinitionId: "ACT_INIA_CRYSKA_PS3_AFFINITY_UP", targets: ["ally:back"] },
    { effectActionDefinitionId: "ACT_INIA_CRYSKA_PS3_AFFINITY_DOWN", targets: ["enemy:front"] },
    { effectActionDefinitionId: "ACT_INIA_CRYSKA_PS3_VULNERABLE", targets: ["enemy:front"] },
    { effectActionDefinitionId: "ACT_INIA_CRYSKA_PS3_AFFINITY_DOWN", targets: ["enemy:far"] },
    { effectActionDefinitionId: "ACT_INIA_CRYSKA_PS3_VULNERABLE", targets: ["enemy:far"] },
  ],
  effectsApplied: [
    ...["ally:subject", "ally:front", "ally:back"].map((unitId) => ({
      unitId,
      effectActionDefinitionId: "ACT_INIA_CRYSKA_PS3_AFFINITY_UP",
      magnitude: 0.15,
      timeLimit: { unit: "BATTLE", count: 1 },
    })),
    ...["enemy:front", "enemy:far"].flatMap((unitId) => [
      {
        unitId,
        effectActionDefinitionId: "ACT_INIA_CRYSKA_PS3_AFFINITY_DOWN",
        magnitude: -0.075,
        timeLimit: { unit: "BATTLE", count: 1 },
      },
      {
        unitId,
        effectActionDefinitionId: "ACT_INIA_CRYSKA_PS3_VULNERABLE",
        magnitude: 0.1,
        consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
      },
    ]),
  ],
  resources: [
    { unitId: "ally:subject", resource: "PP", delta: -1 },
    { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
  ],
} as const;

const PS3_USE = {
  kind: "PASSIVE",
  skillDefinitionId: "SKL_INIA_CRYSKA_PS3",
  trigger: turnStarted({ turnNumber: 1 }),
} as const;

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_INIA_CRYSKA_EX",
    intent:
      "敵全体に威力117で攻撃し、自身に2行動の間「プラーフカ」を付与する。「プラーフカ」は攻撃時に攻撃力×12.5%のダメージを追加する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_INIA_CRYSKA_EX", actionType: "EX" },
    expected: {
      actions: [
        ...["enemy:front", "enemy:left", "enemy:back"].map((id) => ({
          effectActionDefinitionId: "ACT_INIA_CRYSKA_EX_DAMAGE",
          targets: [id],
        })),
        // 付け直し用の解除。プラーフカを持っていない初回は解除対象が無い。
        {
          effectActionDefinitionId: "ACT_INIA_CRYSKA_EX_REMOVE_PRAVKA",
          targets: ["ally:subject"],
          resultKind: "SKIPPED",
        },
        { effectActionDefinitionId: "ACT_INIA_CRYSKA_EX_PRAVKA", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_INIA_CRYSKA_EX_PRAVKA_BONUS_DAMAGE",
          targets: ["ally:subject"],
        },
      ],
      // (1000 - 500) × 1.17 = 585
      hpDeltas: { "enemy:front": -585, "enemy:left": -585, "enemy:back": -585 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_INIA_CRYSKA_EX_PRAVKA_BONUS_DAMAGE",
          // 攻撃力 1000 × 12.5%
          magnitude: 125,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: PRAVKA, stackCount: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_INIA_CRYSKA_EX",
    intent:
      "(プラーフカ中の再使用): 付け直しても攻撃時追加ダメージは1件のまま重ならない（攻撃自体には既存のプラーフカが乗る）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_INIA_CRYSKA_EX", actionType: "EX" },
    precedingActions: [
      { effectActionDefinitionId: "ACT_INIA_CRYSKA_EX_PRAVKA", target: "SELF" },
      { effectActionDefinitionId: "ACT_INIA_CRYSKA_EX_PRAVKA_BONUS_DAMAGE", target: "SELF" },
    ],
    expected: {
      actions: [
        ...["enemy:front", "enemy:left", "enemy:back"].map((id) => ({
          effectActionDefinitionId: "ACT_INIA_CRYSKA_EX_DAMAGE",
          targets: [id],
        })),
        {
          effectActionDefinitionId: "ACT_INIA_CRYSKA_EX_REMOVE_PRAVKA",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_INIA_CRYSKA_EX_PRAVKA", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_INIA_CRYSKA_EX_PRAVKA_BONUS_DAMAGE",
          targets: ["ally:subject"],
        },
      ],
      // 585 + 既存プラーフカの追加ダメージ 125（R-DMG-06、防御力で減衰しない）。
      hpDeltas: { "enemy:front": -710, "enemy:left": -710, "enemy:back": -710 },
      // 解除した1件と付け直した1件が同一内容のため、効果・Markerの差分は残らない
      // （観測は多重集合の差分で、2件に増えていれば effectsApplied に現れる）。
    },
  },
  {
    skillDefinitionId: "SKL_INIA_CRYSKA_AS1",
    intent:
      "最も近い位置にいる敵単体、および対象に隣接する敵に対して威力84.8で攻撃する（プラーフカ状態でなければデバフは付かない）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_INIA_CRYSKA_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_INIA_CRYSKA_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_INIA_CRYSKA_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_INIA_CRYSKA_AS1_DAMAGE", targets: ["enemy:back"] },
      ],
      // (1000 - 500) × 0.848 = 424
      hpDeltas: { "enemy:front": -424, "enemy:left": -424, "enemy:back": -424 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_INIA_CRYSKA_AS1",
    intent:
      "(プラーフカ状態): 「プラーフカ」状態の場合、対象全てに対し次の攻撃での被ダメージを25%増加させるデバフを付与する(重複可)",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_INIA_CRYSKA_AS1" },
    board: { subject: { markers: [{ markerId: PRAVKA }] } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_INIA_CRYSKA_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_INIA_CRYSKA_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_INIA_CRYSKA_AS1_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_INIA_CRYSKA_AS1_VULNERABLE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_INIA_CRYSKA_AS1_VULNERABLE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_INIA_CRYSKA_AS1_VULNERABLE", targets: ["enemy:back"] },
      ],
      hpDeltas: { "enemy:front": -424, "enemy:left": -424, "enemy:back": -424 },
      effectsApplied: ["enemy:front", "enemy:left", "enemy:back"].map((unitId) => ({
        unitId,
        effectActionDefinitionId: "ACT_INIA_CRYSKA_AS1_VULNERABLE",
        magnitude: 0.25,
        consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
      })),
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_INIA_CRYSKA_PS1",
    intent:
      "他の味方が気絶または凍結を付与された際に発動。敵全体に威力35.1で攻撃する。さらに気絶または凍結を受けた味方単体に対し、同確率で下記のいずれかの効果を発動する。·デバフを全て解除する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_INIA_CRYSKA_PS1",
      trigger: realEffectApplication({
        effectActionDefinitionId: STUN_ACTION,
        from: "enemy:front",
        to: "ally:front",
      }),
    },
    random: PS1_CLEANSE,
    expected: {
      actions: [
        ...PS1_DAMAGE_ACTIONS,
        { effectActionDefinitionId: "ACT_INIA_CRYSKA_PS1_CLEANSE", targets: ["ally:front"] },
      ],
      hpDeltas: PS1_HP_DELTAS,
      // 契機の気絶そのものもデバフとして解除される。
      effectsRemoved: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: STUN_ACTION,
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
      ],
      resources: PS1_RESOURCES,
      cooldowns: PS1_COOLDOWN,
    },
  },
  {
    skillDefinitionId: "SKL_INIA_CRYSKA_PS1",
    intent: "(シールドの腕): ·最大HP×30%のシールドを付与する。シールドは1回攻撃を受けると消滅する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_INIA_CRYSKA_PS1",
      trigger: realEffectApplication({
        effectActionDefinitionId: STUN_ACTION,
        from: "enemy:front",
        to: "ally:front",
      }),
    },
    random: PS1_SHIELD,
    expected: {
      actions: [
        ...PS1_DAMAGE_ACTIONS,
        { effectActionDefinitionId: "ACT_INIA_CRYSKA_PS1_SHIELD", targets: ["ally:front"] },
      ],
      hpDeltas: PS1_HP_DELTAS,
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_INIA_CRYSKA_PS1_SHIELD",
          // イーニァ＆クリスカ自身の最大HP 10000 × 30%
          magnitude: 3000,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
      resources: PS1_RESOURCES,
      cooldowns: PS1_COOLDOWN,
    },
  },
  {
    skillDefinitionId: "SKL_INIA_CRYSKA_PS1",
    intent: "(凍結): 他の味方が凍結を付与された際にも発動し、解除の腕は凍結自体を外す",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_INIA_CRYSKA_PS1",
      trigger: realEffectApplication({
        effectActionDefinitionId: FREEZE_ACTION,
        from: "enemy:front",
        to: "ally:front",
      }),
    },
    random: PS1_CLEANSE,
    expected: {
      actions: [
        ...PS1_DAMAGE_ACTIONS,
        { effectActionDefinitionId: "ACT_INIA_CRYSKA_PS1_CLEANSE", targets: ["ally:front"] },
      ],
      hpDeltas: PS1_HP_DELTAS,
      effectsRemoved: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: FREEZE_ACTION,
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "FREEZE",
        },
      ],
      resources: PS1_RESOURCES,
      cooldowns: PS1_COOLDOWN,
    },
  },
  {
    skillDefinitionId: "SKL_INIA_CRYSKA_PS1",
    intent: "(不成立: 他の状態異常): 気絶・凍結以外の状態異常（毒）の付与では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_INIA_CRYSKA_PS1",
      trigger: realEffectApplication({
        effectActionDefinitionId: POISON_ACTION,
        from: "enemy:front",
        to: "ally:front",
      }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_INIA_CRYSKA_PS1",
    intent: "(不成立: 自身): 自身への気絶では発動しない（「他の味方」）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_INIA_CRYSKA_PS1",
      trigger: realEffectApplication({
        effectActionDefinitionId: STUN_ACTION,
        from: "enemy:front",
        to: "ally:subject",
      }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_INIA_CRYSKA_PS1",
    intent: "(不成立: 生存数): 生存している味方が3体未満の場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_INIA_CRYSKA_PS1",
      trigger: realEffectApplication({
        effectActionDefinitionId: STUN_ACTION,
        from: "enemy:front",
        to: "ally:front",
      }),
    },
    board: { allies: [{ id: "ally:front", position: { column: "LEFT", row: "FRONT" } }] },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_INIA_CRYSKA_PS2",
    intent: "アクティブスキルを3回使用するたびに発動。敵単体に威力54.6で攻撃する",
    use: PS2_TRIGGER,
    board: { subject: ps2CounterAtTwo() },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_INIA_CRYSKA_PS2_DAMAGE", targets: ["enemy:front"] },
      ],
      // (1000 - 500) × 0.546 = 273。盤面は全員アグレッシブで有利属性にならない。
      hpDeltas: { "enemy:front": -273 },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_INIA_CRYSKA_PS2",
    intent:
      "(有利属性): 自身が対象に対して有利属性だった場合、さらに威力31.2で追加攻撃する（サブ属性スマートはアグレッシブに有利）",
    use: PS2_TRIGGER,
    board: { subject: ps2CounterAtTwo(SHY_SMART_SUBJECT) },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_INIA_CRYSKA_PS2_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_INIA_CRYSKA_PS2_ADVANTAGE_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      // 273 + (1000 - 500) × 0.312 = 273 + 156。盤面のサブ属性相性ボーナスは0。
      hpDeltas: { "enemy:front": -429 },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_INIA_CRYSKA_PS2",
    intent:
      "(有利属性でない): 対象のサブ属性だけがキュートでも、メイン属性で判定するため追加攻撃しない",
    use: PS2_TRIGGER,
    board: {
      subject: ps2CounterAtTwo(SHY_SMART_SUBJECT),
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          attribute: "SHY",
          state: { subAttribute: "CUTE" },
        },
      ],
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_INIA_CRYSKA_PS2_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -273 },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_INIA_CRYSKA_PS2",
    intent: "(不成立): 1回目・2回目のアクティブスキル使用では発動しない",
    use: PS2_TRIGGER,
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_INIA_CRYSKA_PS3",
    intent:
      "ターン開始時に発動。最も遠い敵を対象とし、対象がキュート属性だった場合、味方全体の有利属性ダメージを15%上昇させ、敵全体の有利属性ダメージを7.5%減少させる。さらに敵全体の次の攻撃での被ダメージを10%増加させる(重複可)",
    use: PS3_USE,
    board: { enemies: farthestEnemyIs("CUTE") },
    expected: PS3_ACTIVATED,
  },
  {
    skillDefinitionId: "SKL_INIA_CRYSKA_PS3",
    intent: "(アグレッシブ): 最も遠い敵がアグレッシブ属性でも発動する",
    use: PS3_USE,
    board: { enemies: farthestEnemyIs("AGGRESSIVE") },
    expected: PS3_ACTIVATED,
  },
  {
    skillDefinitionId: "SKL_INIA_CRYSKA_PS3",
    intent:
      "(不成立): 最も遠い敵がアグレッシブまたはキュート属性ではない場合、このスキルは発動しない（手前の敵がキュートでも見ない）",
    use: PS3_USE,
    board: { enemies: farthestEnemyIs("CLEVER") },
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_INIA_CRYSKA (【スカーレット・ツイン】イーニァ＆クリスカ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-INIA-CRYSKA-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-INIA-CRYSKA-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-INIA-CRYSKA-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
        [],
      ),
    ).toEqual([]);
  });

  it("IT-UNIT-INIA-CRYSKA-004 [R-EFF-04, R-EFF-09]: プラーフカと攻撃時追加ダメージは自身の2行動で同時に失効する", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const granted = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_INIA_CRYSKA_EX_PRAVKA", target: "SELF" },
      { effectActionDefinitionId: "ACT_INIA_CRYSKA_EX_PRAVKA_BONUS_DAMAGE", target: "SELF" },
    ]);
    const steps = observeEffectExpiry({
      units: granted,
      definitions: board.definitions,
      steps: [
        { kind: "ACTION_END", actor: "ally:subject" },
        { kind: "ACTION_END", actor: "ally:subject" },
      ],
      watchMarkers: ["ally:subject"],
    }).steps;
    expect(steps[0]?.remaining).toEqual({
      "ally:subject/ACT_INIA_CRYSKA_EX_PRAVKA_BONUS_DAMAGE": 1,
    });
    expect(steps[0]?.markers).toEqual({ [`ally:subject/${PRAVKA}`]: 1 });
    expect(steps[1]?.remaining).toEqual({});
    expect(steps[1]?.markers).toEqual({});
  });

  it("IT-UNIT-INIA-CRYSKA-005 [R-ATR-02, R-STA-01]: PS3の後、属性相性ボーナス25%のユニットの有利時倍率は味方140%・敵117.5%になる", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, {
      enemies: farthestEnemyIs("CUTE"),
      combatStats: { affinityBonus: createPercentage(0.25) },
    });
    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: "ally:subject",
      battleId: "B_INIA_CRYSKA_PS3",
    });
    const units = chain.fire(turnStarted({ turnNumber: 1 }), board.units);
    expect(activatedPassiveSkillIds(chain)).toEqual(["SKL_INIA_CRYSKA_PS3"]);
    const multiplierOf = (id: string) => {
      const unit = units.find((u) => u.battleUnitId === id)!;
      const stats = computeCombatStats(unit, board.definitions.effectActions).combatStats;
      // メイン属性で有利な組（シャイ→キュート）での倍率。
      return resolveAttributeMultiplier(
        "SHY",
        "CUTE",
        createPercentage(stats.affinityBonus),
        undefined,
        createPercentage(stats.subAffinityBonus),
      );
    };
    expect(multiplierOf("ally:front")).toBeCloseTo(1.4, 10);
    expect(multiplierOf("enemy:front")).toBeCloseTo(1.175, 10);
  });
});
