import { describe, expect, it } from "vitest";
import {
  initialSnapshotFor,
  loadProductionSnapshot,
  unitFrom,
} from "../../../testing/fixtures/index.js";
import { reduceStateDeltas } from "../../../domain/battle/lifecycle/state-delta-reducer.js";
import { createSkillDefinitionId } from "../../../domain/catalog/definitions/catalog-ids.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import { openPassiveChain } from "../../../testing/production-unit/passive-activation.js";
import {
  PRODUCTION_CATALOG_DIR,
  applyPrecedingActions,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardUnitSpec,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  realDamage,
  turnStarted,
  unitDefeated,
} from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_AOI_ELEGANT`（【優雅なる規律の花】生駒葵）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_AOI_ELEGANT";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const UKIASHI = "MARKER_AOI_ELEGANT_UKIASHI";
const KOUYOU = "MARKER_AOI_ELEGANT_KOUYOU";

/** 会心率デバフの効きを観測するための基礎会心率（既定盤面は0で差が出ない）。 */
const BASE_CRITICAL_RATE = 0.5;

/** 既定の敵配置に、指定した1体だけMarkerを持たせる。 */
function enemiesWith(
  target: "enemy:front" | "enemy:left" | "enemy:back",
  markers: readonly { readonly markerId: string; readonly stackCount?: number }[],
): readonly BoardUnitSpec[] {
  return (
    [
      { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
      { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
      { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
    ] as const
  ).map((enemy) => (enemy.id === target ? { ...enemy, markers } : enemy));
}

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_AOI_ELEGANT_EX",
    intent:
      "敵前後列に威力180.2で攻撃する。さらにスキル「優雅な足取り」のクールタイムをリセットして再び使用できるようにする",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_AOI_ELEGANT_EX" },
    // リセットの効きは、PS1が実際にクールタイム中である局面でしか観測できない。
    board: {
      subject: {
        state: {
          cooldowns: {
            [createSkillDefinitionId("SKL_AOI_ELEGANT_PS1")]: { unit: "TURN", remaining: 99 },
          },
        },
      },
    },
    expected: {
      // 「浮足」を誰も持たないため基準敵は既定順の敵前列で、その前後列＝CENTER列。
      actions: [
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_EX_CD_RESET", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "enemy:front": -901,
        "enemy:back": -901,
      },
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_AOI_ELEGANT_PS1", remaining: 0 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_AOI_ELEGANT_EX",
    intent:
      "所持している「浮足」の数が最も多い敵を優先し、対象が「浮足」を所持している場合、2行動の間攻撃力を15%低下させる（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_AOI_ELEGANT_EX" },
    board: { enemies: enemiesWith("enemy:left", [{ markerId: UKIASHI }]) },
    expected: {
      // 既定順では enemy:front が先だが、「浮足」1つを持つ enemy:left が基準になる。
      // その前後列はLEFT列で、後列に敵が居ないため対象は1体。
      actions: [
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_EX_ATK_DOWN", targets: ["enemy:left"] },
        // リセットはPS1がクールタイム中でなければ何も動かさない（no-op）。
        {
          effectActionDefinitionId: "ACT_AOI_ELEGANT_EX_CD_RESET",
          targets: ["ally:subject"],
          resultKind: "SKIPPED",
        },
      ],
      hpDeltas: {
        "enemy:left": -901,
      },
      effectsApplied: [
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_AOI_ELEGANT_EX_ATK_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_AOI_ELEGANT_AS1",
    intent: "最も残りHPが多い敵単体に威力140.4で攻撃し、「浮足」を1つ付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_AOI_ELEGANT_AS1" },
    // 既定盤面は全員半減HPで同率のため、後列だけ満タンにして「最も残りHPが多い敵」を作る。
    board: {
      enemies: [
        { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        {
          id: "enemy:back",
          position: { column: "CENTER", row: "BACK" },
          state: { currentHp: 9000 },
        },
      ],
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_AS1_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_AS1_MARKER_UKIASHI", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:back": -702,
      },
      markers: [{ unitId: "enemy:back", markerId: UKIASHI, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_AOI_ELEGANT_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_AOI_ELEGANT_AS1",
    intent:
      "この攻撃によって付与された「浮足」が3つ以上になった場合、「浮足」を全て解除して「高揚」を1つ付与する。「高揚」は1つにつき対象の会心率を25%低下させ（重複可）、行動時に攻撃力×37.5%のダメージを受けるデバフを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_AOI_ELEGANT_AS1" },
    board: { enemies: enemiesWith("enemy:front", [{ markerId: UKIASHI, stackCount: 2 }]) },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_AS1_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_AOI_ELEGANT_AS1_MARKER_UKIASHI",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_AS1_CLEAR_UKIASHI", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_AS1_MARKER_KOUYOU", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_AOI_ELEGANT_AS1_KOUYOU_CRIT_DOWN",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_AS1_KOUYOU_DOT", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -702,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_AOI_ELEGANT_AS1_KOUYOU_CRIT_DOWN",
          magnitude: -0.25,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_AOI_ELEGANT_AS1_KOUYOU_DOT",
          magnitude: 375,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      markers: [{ unitId: "enemy:front", markerId: KOUYOU, stackCount: 1 }],
      // 3つ目まで増えた「浮足」は保持ごと無くなる（段数が減るのではない）。
      markersRemoved: [{ unitId: "enemy:front", markerId: UKIASHI, stackCount: 2 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_AOI_ELEGANT_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_AOI_ELEGANT_AS2",
    intent:
      "自身から最も遠い位置にいる敵単体、および対象に隣接する2体に対し威力84.8で攻撃し、自身が2回行動を終えるまでの間「浮足」を1つ付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_AOI_ELEGANT_AS2" },
    expected: {
      // 最も遠いのは敵後列。隣接（上下左右）は同じCENTER列の敵前列だけ。
      // 「浮足」を持たない相手なので追加ダメージの腕は選ばれない。
      actions: [
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_AS2_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_AS2_MARKER", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_AS2_MARKER", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -424,
        "enemy:back": -424,
      },
      markers: [
        { unitId: "enemy:front", markerId: UKIASHI, stackCount: 1 },
        { unitId: "enemy:back", markerId: UKIASHI, stackCount: 1 },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_AOI_ELEGANT_AS2",
    intent:
      "対象が「浮足」を所持している場合、追加で対象の現在HP×20%のダメージを与える。このダメージは自身の攻撃力×50%を上限とする",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_AOI_ELEGANT_AS2" },
    board: { enemies: enemiesWith("enemy:back", [{ markerId: UKIASHI }]) },
    expected: {
      // この使用より前から「浮足」を持っていた相手にだけ追加ダメージが乗る。
      actions: [
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_AS2_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_AS2_BONUS_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_AS2_MARKER", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_AS2_MARKER", targets: ["enemy:front"] },
      ],
      // 現在HP5000×20%＝1000は攻撃力1000×50%＝500で頭打ちになる。
      hpDeltas: {
        "enemy:front": -424,
        "enemy:back": -924,
      },
      markers: [
        { unitId: "enemy:front", markerId: UKIASHI, stackCount: 1 },
        { unitId: "enemy:back", markerId: UKIASHI, stackCount: 2 },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_AOI_ELEGANT_PS1",
    intent:
      "自身がアクティブスキルで攻撃された後に発動。攻撃してきた敵単体に威力179.4で反撃し、2行動の間対象の攻撃力を35%低下させる",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_AOI_ELEGANT_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "AS" }),
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_PS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_PS1_ATK_DOWN", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -897,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_AOI_ELEGANT_PS1_ATK_DOWN",
          magnitude: -0.35,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_AOI_ELEGANT_PS1", remaining: 99 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_AOI_ELEGANT_PS1",
    intent: "(不成立): EXスキルで攻撃されても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_AOI_ELEGANT_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "EX" }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_AOI_ELEGANT_PS2",
    intent:
      "ターン開始時に発動。敵単体の会心率を7.5%、会心ダメージを25%低下させ、「浮足」を1つ付与する。さらに自身に対し、「浮足」を所持している敵から受ける攻撃の被ダメージを40%減少させる効果を付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_AOI_ELEGANT_PS2",
      trigger: turnStarted({ unit: "ally:subject", turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_AOI_ELEGANT_PS2_CRIT_RATE_DOWN",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_PS2_CRIT_DMG_DOWN", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_AOI_ELEGANT_PS2_MARKER_UKIASHI",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_AOI_ELEGANT_PS2_SELF_DAMAGE_MOD",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_AOI_ELEGANT_PS2_SELF_DAMAGE_MOD",
          magnitude: -0.4,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_AOI_ELEGANT_PS2_CRIT_RATE_DOWN",
          magnitude: -0.075,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_AOI_ELEGANT_PS2_CRIT_DMG_DOWN",
          magnitude: -0.25,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      markers: [{ unitId: "enemy:front", markerId: UKIASHI, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_AOI_ELEGANT_PS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_AOI_ELEGANT_PS2",
    intent: "また「高揚」を2つ以上所持している敵がいた場合、対象から「高揚」を全て解除する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_AOI_ELEGANT_PS2",
      trigger: turnStarted({ unit: "ally:subject", turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    board: { enemies: enemiesWith("enemy:left", [{ markerId: KOUYOU, stackCount: 2 }]) },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_AOI_ELEGANT_PS2_CRIT_RATE_DOWN",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_PS2_CRIT_DMG_DOWN", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_AOI_ELEGANT_PS2_MARKER_UKIASHI",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_AOI_ELEGANT_PS2_SELF_DAMAGE_MOD",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_AOI_ELEGANT_PS2_CLEAR_KOUYOU", targets: ["enemy:left"] },
      ],
      // 「高揚」は保持ごと無くなる（段数が減るのではない）。
      markersRemoved: [{ unitId: "enemy:left", markerId: KOUYOU, stackCount: 2 }],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_AOI_ELEGANT_PS2_SELF_DAMAGE_MOD",
          magnitude: -0.4,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_AOI_ELEGANT_PS2_CRIT_RATE_DOWN",
          magnitude: -0.075,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_AOI_ELEGANT_PS2_CRIT_DMG_DOWN",
          magnitude: -0.25,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      markers: [{ unitId: "enemy:front", markerId: UKIASHI, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_AOI_ELEGANT_PS2", remaining: 1 },
      ],
    },
  },
];

describe("production Catalog UNIT_AOI_ELEGANT (【優雅なる規律の花】生駒葵)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-AOI-ELEGANT-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-AOI-ELEGANT-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-AOI-ELEGANT-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-AOI-ELEGANT-004 (R-EFF-10/R-EFF-09): 「高揚」は付与者が倒れると同時に解除され、会心率デバフと継続ダメージも連動して失効する", () => {
    // 会心率デバフが実効値へ効いたことを見るため、基礎会心率を0以外へ置く。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, {
      combatStats: { criticalRate: BASE_CRITICAL_RATE },
    });
    // 「高揚」とその子効果は実 production 定義で作る（1回のスキル使用では、
    // 付与と付与者の戦闘不能を同じ観測へ載せられない）。
    const granted = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_AOI_ELEGANT_AS1_MARKER_KOUYOU", target: "ENEMY" },
      { effectActionDefinitionId: "ACT_AOI_ELEGANT_AS1_KOUYOU_CRIT_DOWN", target: "ENEMY" },
      { effectActionDefinitionId: "ACT_AOI_ELEGANT_AS1_KOUYOU_DOT", target: "ENEMY" },
    ]);
    const holderBefore = granted.find((unit) => unit.battleUnitId === "enemy:front")!;
    expect(holderBefore.markerStates.map((marker) => marker.markerId)).toEqual([KOUYOU]);
    expect(holderBefore.appliedEffects.map((effect) => effect.effectActionDefinitionId)).toEqual([
      "ACT_AOI_ELEGANT_AS1_KOUYOU_CRIT_DOWN",
      "ACT_AOI_ELEGANT_AS1_KOUYOU_DOT",
    ]);
    expect(holderBefore.combatStats.criticalRate).toBeCloseTo(BASE_CRITICAL_RATE * (1 - 0.25), 9);

    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: "enemy:front",
      battleId: "B_AOI_KOUYOU",
    });
    const defeated = granted.map((unit) =>
      unit.battleUnitId === "ally:subject" ? { ...unit, currentHp: 0 } : unit,
    );
    // 解除の公開差分だけで復元できることを見るため、解除直前の状態を基準線にする。
    const initial = initialSnapshotFor(defeated, { include: ["effects", "markers"] });
    const eventsBefore = chain.recorder.getEvents().length;
    const after = chain.fire(
      unitDefeated({ unit: "ally:subject", defeatedBy: "enemy:front" }),
      defeated,
    );

    const holder = after.find((unit) => unit.battleUnitId === "enemy:front")!;
    expect(holder.markerStates).toEqual([]);
    expect(holder.appliedEffects).toEqual([]);
    // 派生ステータスが古いまま残っていないこと — 子効果の失効が再計算まで通る。
    expect(holder.combatStats.criticalRate).toBe(BASE_CRITICAL_RATE);
    // R-EFF-09「同時失効では、子効果を先に失効させ、最後に親効果を失効させる」。
    const emitted = chain.recorder.getEvents().slice(eventsBefore);
    const removals = emitted.filter(
      (event) => event.eventType === "EffectExpired" || event.eventType === "MarkerRemoved",
    );
    expect(removals.map((event) => event.eventType)).toEqual([
      "EffectExpired",
      "EffectExpired",
      "MarkerRemoved",
    ]);
    expect(removals.at(-1)!.payload).toMatchObject({
      markerId: KOUYOU,
      reason: "SOURCE_DEFEATED",
    });

    // 解除分のStateDeltaだけを独立Reducerへ流しても、「高揚」も子効果も残らない。
    const restored = reduceStateDeltas(
      initial,
      emitted.flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta])),
    ).units[holder.battleUnitId]!;
    expect(restored.effects ?? []).toHaveLength(0);
    expect(restored.markers ?? []).toHaveLength(0);
    expect(restored).toEqual(
      initialSnapshotFor([holder], { include: ["effects", "markers"] }).units[holder.battleUnitId],
    );
  });
});
