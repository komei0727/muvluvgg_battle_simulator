import { describe, expect, it } from "vitest";
import { applyDamageAction } from "../../../domain/battle/combat/damage-application-service.js";
import type { BattleDomainEvent } from "../../../domain/battle/events/domain-event.js";
import type { BattleUnit } from "../../../domain/battle/model/battle-unit.js";
import {
  createEffectActionDefinitionId,
  createMarkerId,
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../../domain/catalog/definitions/skill-definition.js";
import { createBattleUnitId } from "../../../domain/shared/ids.js";
import {
  effectActionFrom,
  initialSnapshotFor,
  loadProductionSnapshot,
  noMissNoCrit,
  reconstruct,
  seedRecorder,
  unitFrom,
} from "../../../testing/fixtures/index.js";
import {
  openPassiveChain,
  type PassiveChain,
} from "../../../testing/production-unit/passive-activation.js";
import { observeDamageProbe } from "../../../testing/production-unit/damage-probe.js";
import {
  observeClassificationTrigger,
  observeEffectImmunity,
} from "../../../testing/production-unit/effect-application.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
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
  type PrecedingAction,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { realDamage } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_TARISA_TROUBLEMAKER`(【天真爛漫トラブルメーカー】タリサ・マナンダル)の
 * ユニット単位production結合テスト(`12_テスト戦略.md`「ユニット効果軸」)。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 *
 * PS1「徹底的にやってやろうじゃん！」は自身の攻撃のたびに発動するため、**攻撃を
 * 伴う全スキルの行にPS1の連鎖が載る**。多段攻撃では1ヒット目の `DamageApplied` で
 * 攻撃力+2.5%が入り、2ヒット目以降のダメージがその分だけ上がる。
 */

const UNIT_DEFINITION_ID = "UNIT_TARISA_TROUBLEMAKER";

/**
 * 「攻撃力バフは解除不可」の対照に使う、バフを全解除する実 production 定義。
 * タリサ自身は解除を持たないため、1ユニットだけ併せて読み込む。
 */
const DISPEL_BUFFS_ACTION_ID = "ACT_NOEL_RUMBLE_PS2_REMOVE_BUFF";

/**
 * 「会心不可はデバフである」の対照に使う、デバフを全解除する実 production 定義。
 * 解除の当たり外れは分類そのものを問う唯一の振る舞いなので、バフ解除と対にして
 * 両側を通す。
 */
const DISPEL_DEBUFFS_ACTION_ID = "ACT_MEIYA_FATED_PS1_REMOVE_DEBUFF";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  "UNIT_NOEL_RUMBLE",
  "UNIT_MEIYA_FATED",
]);

const AS1_CRIT_PREVENTION = "ACT_TARISA_TROUBLEMAKER_AS1_CRIT_PREVENTION";
const EX_DEBUFF_IMMUNITY = "ACT_TARISA_TROUBLEMAKER_EX_IMMUNITY";

const FIGHTING_SPIRIT = "MARKER_TARISA_TROUBLEMAKER_FIGHTING_SPIRIT";
const PS1_ATK_UP = "ACT_TARISA_TROUBLEMAKER_PS1_ATK_UP";
const PS1_MARKER = "ACT_TARISA_TROUBLEMAKER_PS1_MARKER";
const PS1_LINK = "TARISA_TROUBLEMAKER_PS1_LINK";
/** 連動グループ外の実定義。カスケードに巻き込まれない可視効果として使う。 */
const WATCHER_EFFECT_ID = "ACT_TARISA_TROUBLEMAKER_EX_ATK_UP";
/** raw原文の上限。攻撃力バフ側もMarker「負けん気」と同じ14個で止まる。 */
const STACK_MAX = 14;

function durationOf(effectActionDefinitionId: string): unknown {
  return (
    effectActionFrom(snapshot, effectActionDefinitionId) as { payload: { duration: unknown } }
  ).payload.duration;
}

/**
 * カスケードで巻き込まれた子の `EffectExpired` を契機にし、その時点で親Markerを
 * 所持しているかを `TARGET_HAS_MARKER` で判定するPS。通知がインスタンス単位でなく
 * バッチだと、親Markerが既に除去された状態を観測して発動しない。
 */
const markerWatcher: SkillDefinition = {
  skillDefinitionId: createSkillDefinitionId("SKL_TEST_TARISA_MARKER_WATCHER"),
  skillType: "PS",
  cost: { resource: "PP", amount: 1 },
  activationCondition: {
    kind: "TARGET_HAS_MARKER",
    target: { kind: "SELF" },
    markerId: createMarkerId(FIGHTING_SPIRIT),
  },
  triggers: [
    {
      eventType: "EffectExpired",
      category: "FACT",
      sourceSelector: "SELF",
      targetSelector: "SELF",
      condition: { kind: "TRUE" },
    },
  ],
  counterUpdates: [],
  resolution: {
    kind: "IMMEDIATE",
    targetBindings: [],
    steps: [
      {
        kind: "ACTION",
        stepCondition: { kind: "TRUE" },
        targetCondition: { kind: "TRUE" },
        target: { kind: "SELF" },
        actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(WATCHER_EFFECT_ID) }],
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
  metadata: { displayName: "SKL_TEST_TARISA_MARKER_WATCHER", tags: [] },
};

/** PS1が連鎖して自身へ入る、1回分の「負けん気」と攻撃力バフ。 */
const PS1_SELF_BUFF = [
  { effectActionDefinitionId: PS1_MARKER, targets: ["ally:subject"] },
  { effectActionDefinitionId: PS1_ATK_UP, targets: ["ally:subject"] },
] as const;

const PS1_ATK_UP_APPLIED = {
  unitId: "ally:subject",
  effectActionDefinitionId: PS1_ATK_UP,
  magnitude: 0.025,
  timeLimit: { unit: "BATTLE", count: 1 },
} as const;

const PS1_FIRST_STACK = {
  unitId: "ally:subject",
  markerId: FIGHTING_SPIRIT,
  stackCount: 1,
} as const;

/** 既に「負けん気」を5つ持つ前提。`REMOVE_MARKER` の `count: 3` が観測できる。 */
const HOLDS_FIVE_SPIRIT: BoardOverrides = {
  subject: { markers: [{ markerId: FIGHTING_SPIRIT, stackCount: 5 }] },
};

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_TARISA_TROUBLEMAKER_EX",
    intent:
      "敵単体に威力23.32で10ヒット攻撃し、1行動の間攻撃力を35%低下させる。さらに自身の攻撃力を1行動の間10%上昇させ（重複可）、1行動の間、向けられるデバフを無効にするバフを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_TARISA_TROUBLEMAKER_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_TARISA_TROUBLEMAKER_EX_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_TARISA_TROUBLEMAKER_EX_ATK_DOWN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_TARISA_TROUBLEMAKER_EX_ATK_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_TARISA_TROUBLEMAKER_EX_IMMUNITY",
          targets: ["ally:subject"],
        },
        ...PS1_SELF_BUFF,
      ],
      // R-ATM-01: PS1の攻撃力+2.5%はEXの効果処理完了後に入るため、10ヒットすべてが116。
      hpDeltas: { "enemy:front": -1160 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_TARISA_TROUBLEMAKER_EX_ATK_UP",
          magnitude: 0.1,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_TARISA_TROUBLEMAKER_EX_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        PS1_ATK_UP_APPLIED,
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_TARISA_TROUBLEMAKER_EX_ATK_DOWN",
          magnitude: -0.35,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      markers: [PS1_FIRST_STACK],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_TARISA_TROUBLEMAKER_AS1",
    intent: "敵単体に威力29.68で7ヒット攻撃し、1行動の間会心不可のデバフを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_TARISA_TROUBLEMAKER_AS1" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_TARISA_TROUBLEMAKER_AS1_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_TARISA_TROUBLEMAKER_AS1_CRIT_PREVENTION",
          targets: ["enemy:front"],
        },
        ...PS1_SELF_BUFF,
      ],
      // R-ATM-01: PS1の攻撃力+2.5%はAS1の効果処理完了後に入るため、7ヒットすべてが148。
      hpDeltas: { "enemy:front": -1036 },
      effectsApplied: [
        PS1_ATK_UP_APPLIED,
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_TARISA_TROUBLEMAKER_AS1_CRIT_PREVENTION",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "CRITICAL_PREVENTION",
        },
      ],
      markers: [PS1_FIRST_STACK],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_TARISA_TROUBLEMAKER_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_TARISA_TROUBLEMAKER_AS2",
    intent: "敵単体に威力54.6で3ヒット攻撃し、1行動の間攻撃力を15%低下させる（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_TARISA_TROUBLEMAKER_AS2" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_TARISA_TROUBLEMAKER_AS2_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_TARISA_TROUBLEMAKER_AS2_ATK_DOWN",
          targets: ["enemy:front"],
        },
        ...PS1_SELF_BUFF,
      ],
      // R-ATM-01: PS1の攻撃力+2.5%はAS2の効果処理完了後に入るため、3ヒットすべてが273。
      hpDeltas: { "enemy:front": -819 },
      effectsApplied: [
        PS1_ATK_UP_APPLIED,
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_TARISA_TROUBLEMAKER_AS2_ATK_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      markers: [PS1_FIRST_STACK],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_TARISA_TROUBLEMAKER_AS2", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_TARISA_TROUBLEMAKER_AS3",
    intent: "敵単体に威力190.8で攻撃し、与えたダメージの35%分自身のHPを回復する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_TARISA_TROUBLEMAKER_AS3" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_TARISA_TROUBLEMAKER_AS3_DAMAGE",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_TARISA_TROUBLEMAKER_AS3_HEAL", targets: ["ally:subject"] },
        ...PS1_SELF_BUFF,
      ],
      // PS1の攻撃力上昇はこの攻撃には乗らない（R-ATM-01で効果処理の後）。954の35%＝333を回復する。
      hpDeltas: { "enemy:front": -954, "ally:subject": 333 },
      effectsApplied: [PS1_ATK_UP_APPLIED],
      markers: [PS1_FIRST_STACK],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_TARISA_TROUBLEMAKER_PS1",
    intent:
      "自身が敵に攻撃するたびに発動。自身に「負けん気」を1つ付与し、攻撃力を2.5%上昇させる（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_TARISA_TROUBLEMAKER_PS1",
      trigger: realDamage({ from: "ally:subject", to: "enemy:front", skillType: "AS" }),
    },
    board: HOLDS_FIVE_SPIRIT,
    expected: {
      // 与えたダメージが10を超えるため解除の条件付きstepは走らない。
      actions: [...PS1_SELF_BUFF],
      effectsApplied: [PS1_ATK_UP_APPLIED],
      markers: [{ unitId: "ally:subject", markerId: FIGHTING_SPIRIT, stackCount: 6 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_TARISA_TROUBLEMAKER_PS1",
    intent:
      "「負けん気」は自身が攻撃スキルを使用した際、そのスキルによって与えることのできたダメージが10以下だった場合、3つ解除される",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_TARISA_TROUBLEMAKER_PS1",
      // 攻撃力1000・防御力500の盤面で威力2%＝ちょうど10ダメージ。
      trigger: realDamage({
        from: "ally:subject",
        to: "enemy:front",
        skillType: "AS",
        power: 0.02,
      }),
    },
    board: HOLDS_FIVE_SPIRIT,
    expected: {
      actions: [
        ...PS1_SELF_BUFF,
        {
          effectActionDefinitionId: "ACT_TARISA_TROUBLEMAKER_PS1_REMOVE_MARKER",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [PS1_ATK_UP_APPLIED],
      // 5 + 1 - 3 = 3。
      markers: [{ unitId: "ally:subject", markerId: FIGHTING_SPIRIT, stackCount: 3 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_TARISA_TROUBLEMAKER_PS1",
    intent: "(不成立): 敵から自身への攻撃では発動しない（契機は自身が敵に与えた攻撃に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_TARISA_TROUBLEMAKER_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "AS" }),
    },
    expected: { activated: false },
  },
];

/** 同じ実 production 定義（PS1の攻撃力バフ）を `count` 回、自身へ適用する。 */
function grantAtkUp(count: number): readonly PrecedingAction[] {
  return Array.from({ length: count }, () => ({
    effectActionDefinitionId: PS1_ATK_UP,
    target: "SELF" as const,
  }));
}

const PROBE_ACTION_ID = "ACT_TEST_TARISA_TEN_DAMAGE";

/**
 * PS1の条件付きstep（`calculatedDamage <= 10`）を成立させる、自身からの実攻撃。
 * 契機イベントは合成せず実ダメージpipelineに出させる。威力を引数に取るのは、
 * 前提として攻撃力バフを積むと同じ威力でも与ダメージが10を超えてしまうため。
 */
function strikeForCondition(
  chain: PassiveChain,
  units: readonly BattleUnit[],
  power: number,
  expectedDamage: number,
) {
  const attacker = units.find((unit) => unit.battleUnitId === "ally:subject")!;
  const struck = applyDamageAction(
    attacker,
    [
      {
        targetUnitId: createBattleUnitId("enemy:front"),
        effectActionDefinitionId: createEffectActionDefinitionId(PROBE_ACTION_ID),
        hitIndex: 1,
      },
    ],
    {
      kind: "DAMAGE",
      effectActionDefinitionId: createEffectActionDefinitionId(PROBE_ACTION_ID),
      metadata: { tags: [] },
      payload: {
        damageType: "PHYSICAL",
        formula: { kind: "SKILL_POWER", power },
        hitCount: 1,
        critical: { mode: "PREVENTED" },
        accuracy: { mode: "GUARANTEED" },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
        damageModifiers: [],
        link: { enabled: false },
      },
    },
    units,
    noMissNoCrit(),
    {
      recorder: chain.recorder,
      turnNumber: 1,
      cycleNumber: 1,
      actionId: chain.actionId,
      skillUseId: chain.recorder.nextSkillUseId(),
      resolutionScopeId: chain.resolutionScopeId,
      rootEventId: chain.rootEventId,
      parentEventId: chain.rootEventId,
      skillDefinitionId: createSkillDefinitionId("SKL_TEST_TARISA_PROBE"),
      skillType: "AS",
      damageResults: new Map(),
    },
  );
  const triggerEvent = chain.eventsOfType("DamageApplied").at(-1)!;
  expect(triggerEvent.payload.calculatedDamage).toBe(expectedDamage);
  return { units: struck.units, triggerEvent };
}

function atkUpsOf(units: readonly BattleUnit[]): readonly BattleUnit["appliedEffects"][number][] {
  const subject = units.find((unit) => unit.battleUnitId === "ally:subject")!;
  return subject.appliedEffects.filter((effect) => effect.effectActionDefinitionId === PS1_ATK_UP);
}

describe("production Catalog UNIT_TARISA_TROUBLEMAKER (【天真爛漫トラブルメーカー】タリサ・マナンダル)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-TARISA-TROUBLEMAKER-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-TARISA-TROUBLEMAKER-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-TARISA-TROUBLEMAKER-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-TARISA-TROUBLEMAKER-004 (R-EFF-05): 「負けん気」は最大14個まで — 攻撃力バフ側も同じ上限を宣言し、15回目の付与はインスタンスを増やさず `SKIPPED` で終わる", () => {
    const atkUp = effectActionFrom(snapshot, PS1_ATK_UP);
    const marker = effectActionFrom(snapshot, PS1_MARKER);
    expect(atkUp.kind).toBe("APPLY_STAT_MOD");
    expect(marker.kind).toBe("APPLY_MARKER");
    if (atkUp.kind !== "APPLY_STAT_MOD" || marker.kind !== "APPLY_MARKER") {
      return;
    }
    // raw原文は上限をMarker側にだけ書くが、攻撃力バフはMarkerと1対1で付与される
    // ため、同じ上限を持たなければ原文どおりにならない。
    expect(atkUp.payload.stacking).toEqual({ mode: "STACKABLE", max: STACK_MAX });
    expect(marker.payload.stack).toEqual({ policy: "ADD", max: STACK_MAX });

    // 14回と15回をそれぞれ素の盤面から積み上げ、上限に達した状態と、そこへもう1回
    // 付与した状態を比べる（`applyPrecedingActions` は毎回 `board.units` から始まる）。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const recorder = seedRecorder("B_TARISA_STACK");
    const capped = applyPrecedingActions(board, grantAtkUp(STACK_MAX), { recorder });
    expect(atkUpsOf(capped)).toHaveLength(STACK_MAX);
    const cappedAttack = capped.find((unit) => unit.battleUnitId === "ally:subject")!.combatStats
      .attack;
    expect(cappedAttack).toBeCloseTo(1000 * (1 + 0.025 * STACK_MAX), 9);

    const eventsBeforeLast = recorder.recorder.getEvents().length;
    const overflowed = applyPrecedingActions(board, grantAtkUp(STACK_MAX + 1), { recorder });
    const emitted = recorder.recorder
      .getEvents()
      .slice(eventsBeforeLast)
      .filter(
        (event): event is Extract<BattleDomainEvent, { eventType: "EffectActionCompleted" }> =>
          event.eventType === "EffectActionCompleted",
      );

    expect(atkUpsOf(overflowed)).toHaveLength(STACK_MAX);
    expect(emitted.at(-1)!.payload).toMatchObject({
      effectActionDefinitionId: PS1_ATK_UP,
      resultKind: "SKIPPED",
    });
    expect(
      overflowed.find((unit) => unit.battleUnitId === "ally:subject")!.combatStats.attack,
    ).toBe(cappedAttack);
  });

  it("IT-UNIT-TARISA-TROUBLEMAKER-006 (R-SKL-06): 条件付きstepは契機イベントのpayload（`calculatedDamage`）で分かれ、無条件stepと同じ1回の発動の中で解決される。公開差分だけからも同じ段数へ復元できる", () => {
    // `-001` の表は「どちらの腕が走ったか」を見る。ここは同じ発動の中で
    // `MarkerUpdated` が2回（無条件の+1と条件付きの-3）出ることと、その公開差分
    // だけで最終段数が再構成できることを見る。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, HOLDS_FIVE_SPIRIT);
    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: "ally:subject",
      battleId: "B_TARISA_PAYLOAD",
      damageResults: new Map(),
    });
    // 攻撃力1000・防御力500の盤面で威力2%＝ちょうど10ダメージ（条件は `LTE 10`）。
    const struck = strikeForCondition(chain, board.units, 0.02, 10);
    const after = chain.fireRecorded(struck.triggerEvent, struck.units);

    const markerUpdates = chain.recorder
      .getEvents()
      .filter(
        (event): event is Extract<BattleDomainEvent, { eventType: "MarkerUpdated" }> =>
          event.eventType === "MarkerUpdated" && event.payload.markerId === FIGHTING_SPIRIT,
      )
      .map((event) => [event.payload.stackBefore, event.payload.stackAfter]);
    expect(markerUpdates).toEqual([
      [5, 6],
      [6, 3],
    ]);

    // recorderには契機を作った攻撃の差分も載るため、素の盤面から当て直す。
    const restored = reconstruct(
      initialSnapshotFor(board.units, { include: ["effects", "markers"] }),
      chain.recorder,
    );
    expect(
      restored.units[createBattleUnitId("ally:subject")]!.markers!.find(
        (marker) => marker.markerId === FIGHTING_SPIRIT,
      )?.stackCount,
    ).toBe(3);
    expect(
      after
        .find((unit) => unit.battleUnitId === "ally:subject")!
        .markerStates.find((marker) => marker.markerId === FIGHTING_SPIRIT)?.stackCount,
    ).toBe(3);
  });

  it("IT-UNIT-TARISA-TROUBLEMAKER-005 (R-EFF-05): 上限で頭打ちになった攻撃力バフは、公開差分だけからも14インスタンスとして復元できる", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const recorder = seedRecorder("B_TARISA_STACK_DELTA");
    const units = applyPrecedingActions(board, grantAtkUp(STACK_MAX + 1), { recorder });

    const restored = reconstruct(
      initialSnapshotFor(board.units, { include: ["effects", "markers"] }),
      recorder.recorder,
    );
    const subject = restored.units[createBattleUnitId("ally:subject")]!;
    expect(subject.effects).toHaveLength(STACK_MAX);
    expect(subject.effects!.every((effect) => effect.effectDefinitionId === PS1_ATK_UP)).toBe(true);
    expect(subject.combatStats.attack).toBe(
      units.find((unit) => unit.battleUnitId === "ally:subject")!.combatStats.attack,
    );
  });

  it("IT-UNIT-TARISA-TROUBLEMAKER-007 (R-EFF-09第1項): 攻撃力バフは `REMOVE_EFFECTS` では解除できないが、親の「負けん気」が実 `REMOVE_MARKER` で無くなると同時に全インスタンスが失効する。公開差分だけからも同じ状態へ復元できる", () => {
    // raw原文「攻撃力バフは解除不可だが、「負けん気」が解除されると同時に解除される」。
    // 定義は `dispellable: false` と `linkedEffectGroupId` の両方を宣言しており、
    // 「解除できない」と「連動して消える」は両立する（R-EFF-09）。
    expect(durationOf(PS1_MARKER)).toMatchObject({
      linkedEffectGroupId: PS1_LINK,
      linkedEffectGroupRole: "PARENT",
    });
    expect(durationOf(PS1_ATK_UP)).toMatchObject({
      linkedEffectGroupId: PS1_LINK,
      linkedEffectGroupRole: "CHILD",
      dispellable: false,
    });

    // 前提は実 production 定義で作る。盤面の `markers` は `linkedEffectGroupId` を
    // 持たない素のMarkerになるため、カスケードの前提にはできない。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const baseline = applyPrecedingActions(board, [
      { effectActionDefinitionId: PS1_MARKER, target: "SELF" },
      { effectActionDefinitionId: PS1_ATK_UP, target: "SELF" },
      { effectActionDefinitionId: PS1_MARKER, target: "SELF" },
      { effectActionDefinitionId: PS1_ATK_UP, target: "SELF" },
      // 「解除不可」側: バフを全解除する実 production 定義を通しても1件も落ちない。
      { effectActionDefinitionId: DISPEL_BUFFS_ACTION_ID, target: "SELF" },
    ]);
    const before = baseline.find((unit) => unit.battleUnitId === "ally:subject")!;
    expect(atkUpsOf(baseline)).toHaveLength(2);
    expect(before.markerStates.map((marker) => marker.stackCount)).toEqual([2]);
    expect(before.combatStats.attack).toBeCloseTo(1000 * (1 + 0.025 * 2), 9);

    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: "ally:subject",
      battleId: "B_TARISA_CASCADE",
      damageResults: new Map(),
    });
    // 攻撃力が+5%されているため、威力1%で 550 × 1% ＝ 5ダメージ（条件は `LTE 10`）。
    const struck = strikeForCondition(chain, baseline, 0.01, 5);
    const eventsBefore = chain.recorder.getEvents().length;
    const after = chain.fireRecorded(struck.triggerEvent, struck.units);

    // 発動で「負けん気」は2→3になり、`REMOVE_MARKER` の `count: 3` が保持ごと消す。
    // 巻き込まれるのは前提の2件＋この発動が付けた1件。
    const holder = after.find((unit) => unit.battleUnitId === "ally:subject")!;
    expect(holder.markerStates).toEqual([]);
    expect(holder.appliedEffects).toEqual([]);
    expect(holder.combatStats.attack).toBe(1000);

    const cascade = chain.recorder
      .getEvents()
      .slice(eventsBefore)
      .filter(
        (event) => event.eventType === "EffectExpired" || event.eventType === "MarkerRemoved",
      );
    // R-EFF-09「同時失効では、子効果を先に失効させ、最後に親効果を失効させる」。
    expect(cascade.map((event) => event.eventType)).toEqual([
      "EffectExpired",
      "EffectExpired",
      "EffectExpired",
      "MarkerRemoved",
    ]);
    for (const expired of cascade.slice(0, 3)) {
      expect(expired.payload).toMatchObject({
        effectActionDefinitionId: PS1_ATK_UP,
        reason: "LINKED_GROUP_CASCADE",
        linkedEffectGroupId: PS1_LINK,
        cascaded: true,
      });
    }
    expect(cascade[3]!.payload).toMatchObject({
      markerId: FIGHTING_SPIRIT,
      reason: "REMOVED",
      linkedEffectGroupId: PS1_LINK,
      cascaded: false,
    });

    const restored = reconstruct(
      initialSnapshotFor(baseline, { include: ["effects", "markers"] }),
      chain.recorder,
    );
    const subject = restored.units[createBattleUnitId("ally:subject")]!;
    expect(subject.effects ?? []).toHaveLength(0);
    expect(subject.markers ?? []).toHaveLength(0);
    expect(subject.combatStats.attack).toBe(1000);
  });

  it("IT-UNIT-TARISA-TROUBLEMAKER-008 (R-EFF-09 通知順序 / R-ATM-01 再確認): カスケードで巻き込まれた子の `EffectExpired` は親の「負けん気」を所持している状態でPS/Memoryへ届き、そこで検出された候補は保留中に親Markerが消えるためR-PS-04で破棄される", () => {
    // R-EFF-09「各インスタンスの失効イベントは、次のインスタンスへ進む前にPS/Memoryの
    // 即時連鎖へ渡す」。この規約は**評価経路を問わない** — 実 `catalog/` で連動グループの
    // 親Markerを外す2定義（`ACT_TARISA_TROUBLEMAKER_PS1_REMOVE_MARKER`・
    // `ACT_AOI_ELEGANT_PS2_CLEAR_KOUYOU`）はどちらもPS自身のEffectSequenceからしか
    // 走らないため、この経路で粒度が崩れると実データでは規約が一度も守られない。
    // まとめて通知していると、このPSは親Markerが既に消えた状態を観測して発動しない。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const tarisaDefinitionId = createUnitDefinitionId(UNIT_DEFINITION_ID);
    const tarisaDefinition = board.definitions.unitDefinitions.get(tarisaDefinitionId)!;
    const definitions = {
      ...board.definitions,
      skillDefinitions: new Map(board.definitions.skillDefinitions).set(
        markerWatcher.skillDefinitionId,
        markerWatcher,
      ),
      unitDefinitions: new Map(board.definitions.unitDefinitions).set(tarisaDefinitionId, {
        ...tarisaDefinition,
        passiveSkillDefinitionIds: [
          ...tarisaDefinition.passiveSkillDefinitionIds,
          markerWatcher.skillDefinitionId,
        ],
      }),
    };

    // 「負けん気」2段だけを前提に置く。発動で3段目とその攻撃力バフ1件が入り、
    // `count: 3` の解除でそのバフ1件だけがカスケードで失効する。
    const baseline = applyPrecedingActions({ ...board, definitions }, [
      { effectActionDefinitionId: PS1_MARKER, target: "SELF" },
      { effectActionDefinitionId: PS1_MARKER, target: "SELF" },
    ]);
    const chain = openPassiveChain({
      definitions,
      actorUnitId: "ally:subject",
      battleId: "B_TARISA_CASCADE_NOTIFY",
      damageResults: new Map(),
    });
    const struck = strikeForCondition(chain, baseline, 0.02, 10);
    const eventsBefore = chain.recorder.getEvents().length;
    const after = chain.fireRecorded(struck.triggerEvent, struck.units);

    const emitted = chain.recorder.getEvents().slice(eventsBefore);
    const indexOf = (predicate: (event: BattleDomainEvent) => boolean) =>
      emitted.findIndex(predicate);
    const childExpired = indexOf(
      (event) =>
        event.eventType === "EffectExpired" &&
        (event.payload as { effectActionDefinitionId?: string }).effectActionDefinitionId ===
          PS1_ATK_UP,
    );
    const watcherActivated = indexOf(
      (event) =>
        event.eventType === "PassiveActivated" &&
        event.payload.skillDefinitionId === markerWatcher.skillDefinitionId,
    );
    const markerRemoved = indexOf((event) => event.eventType === "MarkerRemoved");

    // 本命その1（R-EFF-09の検出粒度）: 子の失効は親Markerの除去より前に発行され、
    // その時点でPS/Memoryの候補検出へ渡る。まとめて通知していると逆順になる。
    expect(childExpired).toBeGreaterThanOrEqual(0);
    expect(markerRemoved).toBeGreaterThan(childExpired);
    // 本命その2（R-ATM-01の再確認）: 効果処理中に検出された候補の発動は、PS1の効果
    // 処理が完了した後になる。その時点で親Markerは既に除去済みのため、
    // `activationCondition: TARGET_HAS_MARKER` を見るR-PS-04の発動直前確認が
    // この候補を破棄する。
    expect(watcherActivated).toBe(-1);
    // 破棄されたので、watcher の効果は付かない。
    expect(
      after
        .find((unit) => unit.battleUnitId === "ally:subject")!
        .appliedEffects.map((effect) => effect.effectActionDefinitionId),
    ).toEqual([]);
  });

  it("IT-UNIT-TARISA-TROUBLEMAKER-009 (R-CRT-03 #1): AS1が配る実「会心不可」は保持者自身の攻撃だけを会心させない — 同じデバフを防御側が持っていても、攻撃側の会心は止まらない", () => {
    // `-001` のAS1行は付与そのもの（`magnitude: 0`・1行動・`CRITICAL_PREVENTION`）
    // までを固定する。会心不可が効くのは**保持者の以後の攻撃**＝別のスキル使用で、
    // 「保持者側にしか働かない」という向きはそこにしか現れない。
    // 会心率100%の盤面。会心不可を保持していない限り必ず会心する。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, {
      combatStats: { criticalRate: 1 },
    });
    const strike = (units: readonly BattleUnit[], random: SequenceRandomSource, battleId: string) =>
      observeDamageProbe({
        units,
        attackerUnitId: "ally:subject",
        targetUnitId: "enemy:front",
        critical: "NORMAL",
        random,
        battleId,
      });

    // 保持者が攻撃側: 実効モードが `PREVENTED` へ倒れ、抽選そのものを行わない。
    const onAttacker = new SequenceRandomSource([]);
    const prevented = strike(
      applyPrecedingActions(board, [
        { effectActionDefinitionId: AS1_CRIT_PREVENTION, target: "SELF" },
      ]),
      onAttacker,
      "B_TARISA_CRIT_ON_ATTACKER",
    );
    onAttacker.assertFullyConsumed();
    expect(prevented.criticals).toEqual([
      { mode: "PREVENTED", baseCriticalRate: 1, effectiveCriticalRate: 1, result: false },
    ]);
    // 攻撃力1000 - 防御力500 = 500、会心倍率は掛からない。
    expect(prevented.hpDeltas).toEqual({ "enemy:front": -500 });

    // 保持者が防御側（＝実 production の付与先）: 実効モードは `NORMAL` のままで
    // 抽選を1つ消費し、会心率100%どおり会心する。
    const onDefender = new SequenceRandomSource([0.999999]);
    const critical = strike(
      applyPrecedingActions(board, [
        { effectActionDefinitionId: AS1_CRIT_PREVENTION, target: "ENEMY" },
      ]),
      onDefender,
      "B_TARISA_CRIT_ON_DEFENDER",
    );
    onDefender.assertFullyConsumed();
    expect(critical.criticals).toEqual([
      { mode: "NORMAL", baseCriticalRate: 1, effectiveCriticalRate: 1, result: true },
    ]);
    expect(critical.hpDeltas).toEqual({ "enemy:front": -750 });
  });

  it("IT-UNIT-TARISA-TROUBLEMAKER-010 (R-EFF-02/R-EFF-03): AS1が配る実「会心不可」はデバフであって定義済み状態異常ではない — 実 resolver の分類が `DEBUFF` だけで、デバフ解除で消え、バフ解除では残り、EXが配る実デバフ免疫が付与そのものを弾く。公開差分だけからも同じ状態へ復元できる", () => {
    // `-001` の観測は分類欄（`categories`）を持たないため、`APPLY_STATUS` 由来でも
    // `STATUS` を受け取らないこと（R-STS-01の総称照会に載らないこと）は表から読めない。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    expect(
      observeClassificationTrigger({
        definitions: board.definitions,
        units: board.units,
        effectActionDefinitionId: AS1_CRIT_PREVENTION,
        from: "ally:subject",
        to: "enemy:front",
        battleId: "B_TARISA_CRIT_CLASSIFY",
      }),
    ).toEqual({
      classification: {
        effectKind: "APPLY_STATUS",
        categories: ["DEBUFF"],
        statusKind: "CRITICAL_PREVENTION",
      },
      activated: [],
    });

    const afterCleanse = (cleanseEffectActionDefinitionId: string): readonly string[] =>
      applyPrecedingActions(board, [
        { effectActionDefinitionId: AS1_CRIT_PREVENTION, target: "ENEMY" },
        { effectActionDefinitionId: cleanseEffectActionDefinitionId, target: "ENEMY" },
      ])
        .find((unit) => unit.battleUnitId === "enemy:front")!
        .appliedEffects.map((effect) => String(effect.effectActionDefinitionId));
    expect(afterCleanse(DISPEL_DEBUFFS_ACTION_ID)).toEqual([]);
    expect(afterCleanse(DISPEL_BUFFS_ACTION_ID)).toEqual([AS1_CRIT_PREVENTION]);

    // EXが配る実デバフ免疫は付与そのものを拒否する。同じ行動で配られたバフは通る —
    // ここが無いと「何でも弾く免疫」と区別がつかない。
    const guarded = applyPrecedingActions(board, [
      { effectActionDefinitionId: EX_DEBUFF_IMMUNITY, target: "SELF" },
    ]);
    const {
      applied: immuneApplied,
      rejected,
      immunity,
    } = observeEffectImmunity({
      definitions: board.definitions,
      units: guarded,
      holder: "ally:subject",
      from: "enemy:front",
      effectActionDefinitionIds: [AS1_CRIT_PREVENTION, WATCHER_EFFECT_ID],
      immunityEffectActionDefinitionId: EX_DEBUFF_IMMUNITY,
      battleId: "B_TARISA_CRIT_IMMUNITY",
    });
    expect({ applied: immuneApplied, rejected, immunity }).toEqual({
      applied: [WATCHER_EFFECT_ID],
      rejected: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: AS1_CRIT_PREVENTION,
          reason: "IMMUNITY",
          statusKind: "CRITICAL_PREVENTION",
          blockedBy: EX_DEBUFF_IMMUNITY,
        },
      ],
      immunity: { categories: ["DEBUFF"], blockedCount: 1, maxBlocks: null },
    });

    // 開始前スナップショットへ公開差分だけを当てた結果を、**スナップショット全体**で
    // 突き合わせる。
    const recorder = seedRecorder("B_TARISA_CRIT_DELTA");
    const applied = applyPrecedingActions(
      board,
      [{ effectActionDefinitionId: AS1_CRIT_PREVENTION, target: "ENEMY" }],
      { recorder },
    );
    expect(
      reconstruct(initialSnapshotFor(board.units, { include: ["effects"] }), recorder.recorder),
    ).toEqual(initialSnapshotFor(applied, { include: ["effects"] }));
  });
});
