import { describe, expect, it } from "vitest";
import type { BattleDomainEvent } from "../../../domain/battle/events/domain-event.js";
import { applyStateDelta } from "../../../domain/battle/lifecycle/state-delta-reducer.js";
import { createBattleUnitId } from "../../../domain/shared/ids.js";
import {
  initialSnapshotFor,
  loadProductionSnapshot,
  unitFrom,
} from "../../../testing/fixtures/index.js";
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
  type BoardOverrides,
  type PrecedingAction,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { effectApplied, turnStarted } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_SIENA_DIVA`(【旋律を紡ぐ静謐のディーヴァ】シエナ・クラーク)のユニット単位
 * production結合テスト(`12_テスト戦略.md`「ユニット効果軸」)。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_SIENA_DIVA";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const RHYTHMICAL_MARKER = "MARKER_SIENA_RHYTHMICAL";

/** AS2の追加攻撃分岐が成立する前提（自身が「リズミカル」を保持している）。 */
const HOLDS_RHYTHMICAL: BoardOverrides = {
  subject: { markers: [{ markerId: RHYTHMICAL_MARKER, stackCount: 1 }] },
};

/** 1行動の気絶を持つ敵を実 production 定義（EX側の気絶）で作る。 */
const ENEMY_ALREADY_STUNNED: readonly PrecedingAction[] = [
  { effectActionDefinitionId: "ACT_SIENA_DIVA_EX_STUN", target: "ENEMY" },
];

/** PS1の契機（敵に状態異常が付与された）。 */
const STATUS_APPLIED_TO_FRONT_ENEMY = effectApplied({
  source: "ally:subject",
  target: "enemy:front",
  effectKind: "APPLY_STATUS",
  categories: ["STATUS"],
  statusKind: "STUN",
});

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_SIENA_DIVA_EX",
    intent: "敵単体に威力212で攻撃し、1行動の気絶を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SIENA_DIVA_EX" },
    expected: {
      // EX自身の気絶付与が「敵に状態異常が付与された際」を満たし、同じスキル使用の
      // 中でPS1が連鎖する。PS1の気絶がEX由来の1行動をそのまま2行動へ上書きするため、
      // 観測に残る気絶は `ACT_SIENA_DIVA_EX_STUN` の1件（残り2行動）になる。
      actions: [
        { effectActionDefinitionId: "ACT_SIENA_DIVA_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SIENA_DIVA_PS1_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SIENA_DIVA_PS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SIENA_DIVA_PS1_STUN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SIENA_DIVA_PS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_SIENA_DIVA_PS1_STUN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_SIENA_DIVA_EX_STUN", targets: ["enemy:front"] },
      ],
      // EX本体1060に、連鎖したPS1の攻撃力+10%込みの140が加わる。
      hpDeltas: { "enemy:front": -1200, "enemy:left": -140 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SIENA_DIVA_PS1_ATK_UP",
          magnitude: 0.1,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SIENA_DIVA_EX_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2 },
          statusKind: "STUN",
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_SIENA_DIVA_PS1_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SIENA_DIVA_PS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SIENA_DIVA_AS1",
    intent: "敵単体に威力132.6で攻撃し、次の攻撃での与ダメージを60%減少させる（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SIENA_DIVA_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SIENA_DIVA_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SIENA_DIVA_AS1_DMG_DOWN", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -663 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SIENA_DIVA_AS1_DMG_DOWN",
          magnitude: -0.6,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SIENA_DIVA_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SIENA_DIVA_AS2",
    intent: "敵単体に威力117で攻撃し、自身に対し1行動の「リズミカル」を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SIENA_DIVA_AS2" },
    expected: {
      // 「リズミカル」を持たないため追加攻撃の腕は選ばれない。
      actions: [
        { effectActionDefinitionId: "ACT_SIENA_DIVA_AS2_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_SIENA_DIVA_AS2_APPLY_RHYTHMICAL",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: { "enemy:front": -585 },
      markers: [{ unitId: "ally:subject", markerId: RHYTHMICAL_MARKER, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SIENA_DIVA_AS2",
    intent:
      "自身が「リズミカル」を所持している場合、追加で威力39の攻撃を行い、1行動の間与ダメージを30%減少させるデバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SIENA_DIVA_AS2" },
    board: HOLDS_RHYTHMICAL,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SIENA_DIVA_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SIENA_DIVA_AS2_DAMAGE_EXTRA", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SIENA_DIVA_AS2_DMG_DOWN", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_SIENA_DIVA_AS2_APPLY_RHYTHMICAL",
          targets: ["ally:subject"],
        },
      ],
      // 本体585 + 追加195。既に1つ持つ「リズミカル」は `REFRESH`/`max: 1` で増えない。
      hpDeltas: { "enemy:front": -780 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SIENA_DIVA_AS2_DMG_DOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SIENA_DIVA_PS1",
    intent:
      "敵に状態異常が付与された際に発動。自身の攻撃力を一時的に10%上昇させて（重複可）付与された敵単体を含む横一列に威力23.4で攻撃し、1行動の気絶を付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SIENA_DIVA_PS1",
      trigger: STATUS_APPLIED_TO_FRONT_ENEMY,
    },
    expected: {
      // 契機となった敵と同じ横一列（前列2体）が対象で、後列の enemy:back は入らない。
      actions: [
        { effectActionDefinitionId: "ACT_SIENA_DIVA_PS1_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SIENA_DIVA_PS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SIENA_DIVA_PS1_STUN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SIENA_DIVA_PS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_SIENA_DIVA_PS1_STUN", targets: ["enemy:left"] },
      ],
      // 攻撃力+10%（1100）が乗ってから撃つ。
      hpDeltas: { "enemy:front": -140, "enemy:left": -140 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SIENA_DIVA_PS1_ATK_UP",
          magnitude: 0.1,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SIENA_DIVA_PS1_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_SIENA_DIVA_PS1_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SIENA_DIVA_PS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SIENA_DIVA_PS1",
    intent: "(不成立): 状態異常でない効果（バフ）の付与では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SIENA_DIVA_PS1",
      trigger: effectApplied({
        source: "ally:subject",
        target: "enemy:front",
        effectKind: "APPLY_STAT_MOD",
        categories: ["BUFF"],
      }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_SIENA_DIVA_PS2",
    intent:
      "ターン開始時に発動。1ターンの間、前列の味方の会心率を15%上昇させ、敵前列の会心ダメージを50%減少させる。さらに後列の味方の会心率を15%上昇させ、敵後列の会心ダメージを50%減少させる",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SIENA_DIVA_PS2",
      trigger: turnStarted({ unit: "ally:subject", turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SIENA_DIVA_PS2_ALLY_CRIT_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SIENA_DIVA_PS2_ALLY_CRIT_UP", targets: ["ally:front"] },
        {
          effectActionDefinitionId: "ACT_SIENA_DIVA_PS2_ENEMY_CRITDMG_DOWN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_SIENA_DIVA_PS2_ENEMY_CRITDMG_DOWN",
          targets: ["enemy:left"],
        },
        { effectActionDefinitionId: "ACT_SIENA_DIVA_PS2_ALLY_CRIT_UP", targets: ["ally:back"] },
        {
          effectActionDefinitionId: "ACT_SIENA_DIVA_PS2_ENEMY_CRITDMG_DOWN",
          targets: ["enemy:back"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SIENA_DIVA_PS2_ALLY_CRIT_UP",
          magnitude: 0.15,
          timeLimit: { unit: "TURN", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_SIENA_DIVA_PS2_ALLY_CRIT_UP",
          magnitude: 0.15,
          timeLimit: { unit: "TURN", count: 1 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_SIENA_DIVA_PS2_ALLY_CRIT_UP",
          magnitude: 0.15,
          timeLimit: { unit: "TURN", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SIENA_DIVA_PS2_ENEMY_CRITDMG_DOWN",
          magnitude: -0.5,
          timeLimit: { unit: "TURN", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_SIENA_DIVA_PS2_ENEMY_CRITDMG_DOWN",
          magnitude: -0.5,
          timeLimit: { unit: "TURN", count: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_SIENA_DIVA_PS2_ENEMY_CRITDMG_DOWN",
          magnitude: -0.5,
          timeLimit: { unit: "TURN", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SIENA_DIVA_PS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SIENA_DIVA_PS2",
    intent: "(不成立): 契機は自身のターン開始であり、敵のターン開始では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SIENA_DIVA_PS2",
      trigger: turnStarted({ unit: "enemy:front", turnNumber: 1 }),
      triggeredBy: "enemy:front",
    },
    expected: { activated: false },
  },
];

/** PS1を実PS経路で1回発動させ、契機側の敵の気絶と発行イベントを返す。 */
function activatePs1(precedingActions: readonly PrecedingAction[]) {
  const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
  const baseline = applyPrecedingActions(board, precedingActions);
  const chain = openPassiveChain({
    definitions: board.definitions,
    actorUnitId: "ally:subject",
    battleId: "B_SIENA_REAPPLY",
  });
  const after = chain.fire(STATUS_APPLIED_TO_FRONT_ENEMY, baseline);
  const target = after.find((unit) => unit.battleUnitId === "enemy:front")!;
  return {
    baseline,
    events: chain.recorder.getEvents(),
    stuns: target.appliedEffects.filter((effect) => effect.statusKind === "STUN"),
  };
}

function stunDurationChanges(
  events: readonly BattleDomainEvent[],
): readonly Extract<BattleDomainEvent, { eventType: "StunDurationChanged" }>[] {
  return events.filter(
    (event): event is Extract<BattleDomainEvent, { eventType: "StunDurationChanged" }> =>
      event.eventType === "StunDurationChanged",
  );
}

describe("production Catalog UNIT_SIENA_DIVA (【旋律を紡ぐ静謐のディーヴァ】シエナ・クラーク)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-SIENA-DIVA-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-SIENA-DIVA-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-SIENA-DIVA-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-SIENA-DIVA-004 (R-EFF-12/R-STS-02): 「対象に1行動の気絶が付与されていた場合は、2行動の気絶に上書きする」— PS1の気絶は既存インスタンスの残り回数だけを2へ差し替え、`StunDurationChanged` として記録する", () => {
    // 既存の気絶は別スキル（EX）由来。原文は付与元を限定しないため、EX由来の
    // 1行動の気絶も上書きの契機になる。
    const { baseline, events, stuns } = activatePs1(ENEMY_ALREADY_STUNNED);

    expect(stuns).toHaveLength(1);
    expect(stuns[0]!.duration.timeLimitRemaining).toBe(2);
    expect(stuns[0]!.duration.definition).toMatchObject({
      timeLimit: { unit: "ACTION", count: 2 },
    });

    const changes = stunDurationChanges(events);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.payload).toMatchObject({
      battleUnitId: "enemy:front",
      remainingBefore: 1,
      remainingAfter: 2,
      reason: "REGRANT_EXTENDED",
    });

    // 独立Reducer復元: 差し替え後の残り回数2を公開差分だけから再構成できる。
    const restored = events
      .flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta]))
      .reduce(applyStateDelta, initialSnapshotFor(baseline, { include: ["effects", "markers"] }));
    expect(
      restored.units[createBattleUnitId("enemy:front")]!.effects!.find(
        (effect) => effect.statusKind === "STUN",
      ),
    ).toMatchObject({ duration: { unit: "ACTION", remaining: 2 } });
  });

  it("IT-UNIT-SIENA-DIVA-005 (R-EFF-12 boundary): 残り2行動の気絶は「1行動の気絶が付与されていた場合」に当たらず、さらなるPS1の気絶は残り回数を延ばさない", () => {
    // 1回目のPS1で1→2へ上書き済みの状態を、同じ前提を2件重ねて作る。
    const { events, stuns } = activatePs1([
      ...ENEMY_ALREADY_STUNNED,
      { effectActionDefinitionId: "ACT_SIENA_DIVA_PS1_STUN", target: "ENEMY" },
    ]);

    expect(stuns).toHaveLength(1);
    expect(stuns[0]!.duration.timeLimitRemaining).toBe(2);
    // 上書きが累積して延び続けることはない。
    expect(stunDurationChanges(events)).toEqual([]);
  });
});
