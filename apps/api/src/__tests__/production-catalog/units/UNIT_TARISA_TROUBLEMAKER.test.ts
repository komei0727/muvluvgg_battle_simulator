import { describe, expect, it } from "vitest";
import { applyDamageAction } from "../../../domain/battle/combat/damage-application-service.js";
import type { BattleDomainEvent } from "../../../domain/battle/events/domain-event.js";
import type { BattleUnit } from "../../../domain/battle/model/battle-unit.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
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

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const FIGHTING_SPIRIT = "MARKER_TARISA_TROUBLEMAKER_FIGHTING_SPIRIT";
const PS1_ATK_UP = "ACT_TARISA_TROUBLEMAKER_PS1_ATK_UP";
const PS1_MARKER = "ACT_TARISA_TROUBLEMAKER_PS1_MARKER";
/** raw原文の上限。攻撃力バフ側もMarker「負けん気」と同じ14個で止まる。 */
const STACK_MAX = 14;

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
 * PS1の条件付きstepが読む `calculatedDamage` をちょうど10にする、自身からの
 * 実攻撃。契機イベントは合成せず実ダメージpipelineに出させる。
 */
function strikeForCondition(chain: PassiveChain, units: readonly BattleUnit[]) {
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
        // 攻撃力1000・防御力500の盤面で威力2%＝10ダメージ。
        formula: { kind: "SKILL_POWER", power: 0.02 },
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
  expect(triggerEvent.payload.calculatedDamage).toBe(10);
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
    const struck = strikeForCondition(chain, board.units);
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
});
