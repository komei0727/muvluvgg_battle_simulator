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

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  "UNIT_NOEL_RUMBLE",
]);

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
        ...PS1_SELF_BUFF,
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
      ],
      // 1ヒット目116のあとPS1の攻撃力+2.5%が入り、残り9ヒットは122になる。
      hpDeltas: { "enemy:front": -1214 },
      effectsApplied: [
        PS1_ATK_UP_APPLIED,
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
        ...PS1_SELF_BUFF,
        {
          effectActionDefinitionId: "ACT_TARISA_TROUBLEMAKER_AS1_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_TARISA_TROUBLEMAKER_AS1_CRIT_PREVENTION",
          targets: ["enemy:front"],
        },
      ],
      // 1ヒット目148のあと攻撃力+2.5%が入り、残り6ヒットは155になる。
      hpDeltas: { "enemy:front": -1078 },
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
        ...PS1_SELF_BUFF,
        {
          effectActionDefinitionId: "ACT_TARISA_TROUBLEMAKER_AS2_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_TARISA_TROUBLEMAKER_AS2_ATK_DOWN",
          targets: ["enemy:front"],
        },
      ],
      // 1ヒット目273のあと攻撃力+2.5%が入り、残り2ヒットは286になる。
      hpDeltas: { "enemy:front": -845 },
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
        ...PS1_SELF_BUFF,
        {
          effectActionDefinitionId: "ACT_TARISA_TROUBLEMAKER_AS3_DAMAGE",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_TARISA_TROUBLEMAKER_AS3_HEAL", targets: ["ally:subject"] },
      ],
      // 単発なのでPS1の攻撃力上昇はこの攻撃には乗らない。954の35%＝333を回復する。
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

  it("IT-UNIT-TARISA-TROUBLEMAKER-008 (R-EFF-09 通知順序): PS自身のEffectSequenceから走る `REMOVE_MARKER` では、子の `EffectExpired` は親の `MarkerRemoved` より前に**発行**されるが、PS/Memory連鎖への**通知**はEffectAction 1件ぶんまとめて行われる", () => {
    // 発行順（子→親）はR-EFF-09の規定どおりで、この経路でも守られている。
    // 一方、通知の粒度は経路で分かれる。同期callback（`onFactEventForPassiveChain`）を
    // 持つAS/EX・チャージ解放・ダメージpipeline・付与者戦闘不能の各経路は1インスタンスの
    // 除去ごとに通知するが、PS自身のEffectSequence解決はそのcallbackを持たず、
    // `EFFECT_RESOLVED`（EffectAction 1件＋その事後イベント列）としてdriverへ渡す
    // ——効果解決数Guardを連鎖の深さから独立させるための意図的な契約
    // （`triggering/resolve-passive-chain.ts`）。
    // 実 `catalog/` で連動グループの親Markerを外す定義は
    // `ACT_TARISA_TROUBLEMAKER_PS1_REMOVE_MARKER` と `ACT_AOI_ELEGANT_PS2_CLEAR_KOUYOU`
    // の2件だけで、どちらもこのPS経路にしか現れない。したがって「子の失効を契機に
    // まだ親を所持している状態を観測できる」ことは実データでは成立しない。
    const observeWatcher = (watcher: SkillDefinition) => {
      const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
      const tarisaDefinitionId = createUnitDefinitionId(UNIT_DEFINITION_ID);
      const tarisaDefinition = board.definitions.unitDefinitions.get(tarisaDefinitionId)!;
      const definitions = {
        ...board.definitions,
        skillDefinitions: new Map(board.definitions.skillDefinitions).set(
          watcher.skillDefinitionId,
          watcher,
        ),
        unitDefinitions: new Map(board.definitions.unitDefinitions).set(tarisaDefinitionId, {
          ...tarisaDefinition,
          passiveSkillDefinitionIds: [
            ...tarisaDefinition.passiveSkillDefinitionIds,
            watcher.skillDefinitionId,
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
        battleId: `B_TARISA_NOTIFY_${String(watcher.skillDefinitionId)}`,
        damageResults: new Map(),
      });
      const struck = strikeForCondition(chain, baseline, 0.02, 10);
      const eventsBefore = chain.recorder.getEvents().length;
      chain.fireRecorded(struck.triggerEvent, struck.units);
      return chain.recorder.getEvents().slice(eventsBefore);
    };

    const unconditional = observeWatcher({
      ...markerWatcher,
      skillDefinitionId: createSkillDefinitionId("SKL_TEST_TARISA_EXPIRY_WATCHER"),
      activationCondition: { kind: "TRUE" },
    });
    const indexOf = (
      events: readonly BattleDomainEvent[],
      predicate: (event: BattleDomainEvent) => boolean,
    ) => events.findIndex(predicate);
    const childExpired = indexOf(
      unconditional,
      (event) =>
        event.eventType === "EffectExpired" &&
        (event.payload as { effectActionDefinitionId?: string }).effectActionDefinitionId ===
          PS1_ATK_UP,
    );
    const markerRemoved = indexOf(unconditional, (event) => event.eventType === "MarkerRemoved");
    const removalCompleted = indexOf(
      unconditional,
      (event) =>
        event.eventType === "EffectActionCompleted" &&
        (event.payload as { effectActionDefinitionId?: string }).effectActionDefinitionId ===
          "ACT_TARISA_TROUBLEMAKER_PS1_REMOVE_MARKER",
    );
    const watcherActivated = indexOf(
      unconditional,
      (event) =>
        event.eventType === "PassiveActivated" &&
        event.payload.skillDefinitionId === "SKL_TEST_TARISA_EXPIRY_WATCHER",
    );
    // 発行順は子→親。通知（＝候補解決）はその両方を含むEffectActionの完了後。
    expect(childExpired).toBeGreaterThanOrEqual(0);
    expect(markerRemoved).toBeGreaterThan(childExpired);
    expect(watcherActivated).toBeGreaterThan(removalCompleted);

    // そのため、親Markerの所持を発動条件にするPSはこの経路では発動しない。
    expect(
      observeWatcher(markerWatcher).filter(
        (event) =>
          event.eventType === "PassiveActivated" &&
          event.payload.skillDefinitionId === markerWatcher.skillDefinitionId,
      ),
    ).toEqual([]);
  });
});
