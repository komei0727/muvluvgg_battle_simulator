import { describe, expect, it } from "vitest";
import type { BattleDomainEvent } from "../../../domain/battle/events/domain-event.js";
import { EventRecorder } from "../../../domain/battle/events/event-recorder.js";
import { resolveSkillUse } from "../../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { reduceStateDeltas } from "../../../domain/battle/lifecycle/state-delta-reducer.js";
import { createActionId } from "../../../domain/shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../../domain/shared/ids.js";
import {
  initialSnapshotFor,
  loadProductionSnapshot,
  skillFrom,
  unitFrom,
} from "../../../testing/fixtures/index.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardUnitSpec,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import { realDamage, turnCompleting } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_FEE_BATH`（【自己に揺れる白湯気】フィー・ドレーゼ）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_FEE_BATH";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const FLUSH = "MARKER_FEE_BATH_FLUSH";

/** 既定の敵配置に、指定した1体だけ「ほてり」を持たせる。 */
function enemiesWithFlush(
  target: "enemy:front" | "enemy:left" | "enemy:back",
  stackCount: number,
): readonly BoardUnitSpec[] {
  return (
    [
      { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
      { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
      { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
    ] as const
  ).map((enemy) =>
    enemy.id === target ? { ...enemy, markers: [{ markerId: FLUSH, stackCount }] } : enemy,
  );
}

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_FEE_BATH_EX",
    intent: "敵単体に威力171.6で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_FEE_BATH_EX" },
    expected: {
      // 「ほてり」を誰も持たないため、優先順位は既定順に落ちる。
      actions: [{ effectActionDefinitionId: "ACT_FEE_BATH_EX_DAMAGE", targets: ["enemy:front"] }],
      hpDeltas: {
        "enemy:front": -858,
      },
    },
  },
  {
    skillDefinitionId: "SKL_FEE_BATH_EX",
    intent:
      "最も「ほてり」を多く持っている敵を優先し、対象が「ほてり」を4つ以上持っていた場合、さらに対象に1行動分の気絶を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_FEE_BATH_EX" },
    board: { enemies: enemiesWithFlush("enemy:left", 4) },
    expected: {
      // 既定順では敵前列が先だが、「ほてり」4つを持つ enemy:left が対象になる。
      // 4つ以上7つ未満なので、ダメージは増加しない側の腕が選ばれる。
      actions: [
        { effectActionDefinitionId: "ACT_FEE_BATH_EX_STUN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_FEE_BATH_EX_DAMAGE", targets: ["enemy:left"] },
      ],
      hpDeltas: {
        "enemy:left": -858,
      },
      effectsApplied: [
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_FEE_BATH_EX_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_FEE_BATH_EX",
    intent:
      "対象が「ほてり」を7つ以上持っていた場合、さらにこの攻撃によるダメージは75%増加し、攻撃後、対象が所持していた「ほてり」を全て解除する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_FEE_BATH_EX" },
    board: { enemies: enemiesWithFlush("enemy:back", 7) },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_FEE_BATH_EX_STUN", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_FEE_BATH_EX_DAMAGE_BOOSTED", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_FEE_BATH_EX_CLEAR_FLUSH", targets: ["enemy:back"] },
      ],
      // 171.6%の75%増＝300.3%。
      hpDeltas: {
        "enemy:back": -1501,
      },
      effectsApplied: [
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_FEE_BATH_EX_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
      ],
      // 「ほてり」は保持ごと無くなる（段数が減るのではない）。
      markersRemoved: [{ unitId: "enemy:back", markerId: FLUSH, stackCount: 7 }],
    },
  },
  {
    skillDefinitionId: "SKL_FEE_BATH_AS1",
    intent: "自身から最も遠い位置にいる敵単体に威力95.4で3ヒット攻撃し、「ほてり」を2つ付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_FEE_BATH_AS1" },
    expected: {
      // 最も遠いのは敵後列。1ヒット477×3ヒット。
      actions: [
        { effectActionDefinitionId: "ACT_FEE_BATH_AS1_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_FEE_BATH_AS1_MARKER", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_FEE_BATH_AS1_MARKER", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:back": -1431,
      },
      markers: [{ unitId: "enemy:back", markerId: FLUSH, stackCount: 2 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [{ unitId: "ally:subject", skillDefinitionId: "SKL_FEE_BATH_AS1", remaining: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_FEE_BATH_AS2",
    intent: "敵単体に威力46.8で3ヒット攻撃し、「ほてり」を1つ付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_FEE_BATH_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_FEE_BATH_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_FEE_BATH_AS2_MARKER", targets: ["enemy:front"] },
      ],
      // 1ヒット234×3ヒット。「ほてり」を持たない相手なので増加はしない。
      hpDeltas: {
        "enemy:front": -702,
      },
      markers: [{ unitId: "enemy:front", markerId: FLUSH, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_FEE_BATH_AS2",
    intent: "この攻撃で会心攻撃が発生した場合、「ほてり」を1つ追加で付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_FEE_BATH_AS2" },
    board: { combatStats: { criticalRate: 1 } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_FEE_BATH_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_FEE_BATH_AS2_MARKER", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_FEE_BATH_AS2_MARKER_CRIT", targets: ["enemy:front"] },
      ],
      // 会心倍率は1.5＋会心ダメージ0.5＝2.0倍。1ヒット468×3ヒット。
      hpDeltas: {
        "enemy:front": -1404,
      },
      markers: [{ unitId: "enemy:front", markerId: FLUSH, stackCount: 2 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_FEE_BATH_AS2",
    intent:
      "この攻撃によるダメージは、対象が付与されている「ほてり」1つにつき20%増加する（最大）5つまで",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_FEE_BATH_AS2" },
    board: { enemies: enemiesWithFlush("enemy:front", 3) },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_FEE_BATH_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_FEE_BATH_AS2_MARKER", targets: ["enemy:front"] },
      ],
      // 3つ分＝60%増。1ヒット374（234×1.6の切り捨て）×3ヒット。
      hpDeltas: {
        "enemy:front": -1122,
      },
      markers: [{ unitId: "enemy:front", markerId: FLUSH, stackCount: 4 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_FEE_BATH_AS2",
    intent:
      "(境界): 「ほてり」1つにつき20%増加する（最大5つまで）— 7つ持っていても増加は5つぶん（＋100%）で頭打ちになる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_FEE_BATH_AS2" },
    board: { enemies: enemiesWithFlush("enemy:front", 7) },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_FEE_BATH_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_FEE_BATH_AS2_MARKER", targets: ["enemy:front"] },
      ],
      // 5つ分＝100%増で頭打ち。1ヒット468（234×2.0）×3ヒット。3ヒットとも、この
      // スキル自身の `ACT_FEE_BATH_AS2_MARKER` が後段で1つ足す前の7つを読む。
      hpDeltas: {
        "enemy:front": -1404,
      },
      // 「ほてり」自身は `stack.max: null` なので8つまで増える（上限はFormula側だけが持つ）。
      markers: [{ unitId: "enemy:front", markerId: FLUSH, stackCount: 8 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_FEE_BATH_PS1",
    intent:
      "自身がアクティブスキルで攻撃された後に発動。攻撃してきた敵単体の攻撃力を1行動の間25%低下させる（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FEE_BATH_PS1",
      trigger: realDamage({ from: "enemy:left", to: "ally:subject", skillType: "AS" }),
    },
    expected: {
      // 既定の対象選択ではなく「攻撃してきた敵」へ向かう。
      actions: [{ effectActionDefinitionId: "ACT_FEE_BATH_PS1_ATK_DOWN", targets: ["enemy:left"] }],
      effectsApplied: [
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_FEE_BATH_PS1_ATK_DOWN",
          magnitude: -0.25,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [{ unitId: "ally:subject", skillDefinitionId: "SKL_FEE_BATH_PS1", remaining: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_FEE_BATH_PS1",
    intent: "(不成立): EXスキルで攻撃されても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FEE_BATH_PS1",
      trigger: realDamage({ from: "enemy:left", to: "ally:subject", skillType: "EX" }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_FEE_BATH_PS2",
    intent:
      "ターン終了時に発動。最も残りHPが少ない敵単体に「ほてり」を1つ付与し、対象が次の攻撃で受けるダメージを25%増加させるデバフを付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FEE_BATH_PS2",
      trigger: turnCompleting({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    board: {
      enemies: [
        { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
        {
          id: "enemy:left",
          position: { column: "LEFT", row: "FRONT" },
          state: { currentHp: 2000 },
        },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      // 既定順では敵前列が先だが、最も残りHPが少ない enemy:left が対象になる。
      actions: [
        { effectActionDefinitionId: "ACT_FEE_BATH_PS2_MARKER", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_FEE_BATH_PS2_DEBUFF", targets: ["enemy:left"] },
      ],
      effectsApplied: [
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_FEE_BATH_PS2_DEBUFF",
          magnitude: 0.25,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
      markers: [{ unitId: "enemy:left", markerId: FLUSH, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
];

describe("production Catalog UNIT_FEE_BATH (【自己に揺れる白湯気】フィー・ドレーゼ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-FEE-BATH-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-FEE-BATH-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-FEE-BATH-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-FEE-BATH-004 (R-DMG-01/R-NUM-04): AS2の3ヒットはいずれも、このスキル自身の `APPLY_MARKER` が1つ足す前の「ほてり」を同じ倍率として読む。倍率はR-DMG-01のAction内追加ダメージ倍率として `DamageCalculated` に載り、解決全体は1つの根と単調な `stateVersion` に閉じる", () => {
    // `-001` の行は「所持数がいくつなら合計いくら減るか」までを固定する。ここが
    // 引き受けるのは (1) 倍率そのものが `DamageCalculated` の集計欄へ載ること、
    // (2) 3ヒットが**同じ**所持数を読むこと（後段の付与を読み込んで段階的に
    // 増えないこと）、(3) 因果木・`stateVersion`・独立Reducer復元で、いずれも
    // hpDeltas の合計値だけからは区別できない。
    const useAgainst = (stackCount: number) => {
      const board = productionBoard(snapshot, UNIT_DEFINITION_ID, {
        enemies: enemiesWithFlush("enemy:front", stackCount),
      });
      const recorder = new EventRecorder(createBattleId("B_FEE_FLUSH"));
      const result = resolveSkillUse(
        board.subject,
        skillFrom(snapshot, "SKL_FEE_BATH_AS2"),
        "AS",
        "AS",
        board.units,
        board.definitions,
        new SequenceRandomSource(new Array<number>(32).fill(0.99)),
        recorder,
        1,
        1,
        createActionId("B_FEE_FLUSH:action:1"),
        recorder.nextResolutionScopeId(),
      );
      return { board, recorder, result, events: recorder.getEvents() };
    };
    const multipliersOf = (events: readonly BattleDomainEvent[]): readonly number[] =>
      events
        .filter(
          (event): event is Extract<BattleDomainEvent, { eventType: "DamageCalculated" }> =>
            event.eventType === "DamageCalculated",
        )
        .map((event) => event.payload.actionDamageMultiplier);

    // 上限（5つ相当＝+100%）に届かない2つでは 1 + 0.2×2。3ヒットとも同じ値になる。
    const belowCap = useAgainst(2);
    expect(multipliersOf(belowCap.events)).toEqual([1.4, 1.4, 1.4]);
    // 7つは `0.2 × 7 = 1.4` がFormulaの `max: 1.0` で頭打ちになる側の境界。
    const aboveCap = useAgainst(7);
    expect(multipliersOf(aboveCap.events)).toEqual([2, 2, 2]);
    expect(aboveCap.events.filter((event) => event.eventType === "DamageApplied")).toHaveLength(3);

    // 同じ解決スコープ・同じ根の因果木に属する。
    const root = belowCap.events[0]!;
    expect(root.parentEventId).toBeUndefined();
    for (const event of belowCap.events) {
      expect(event.resolutionScopeId).toBe(root.resolutionScopeId);
      expect(event.rootEventId).toBe(root.eventId);
      if (event !== root) {
        expect(event.parentEventId).toBeDefined();
      }
    }

    // `stateVersion` はStateDeltaを伴うイベントでだけ1増える。
    let expectedVersion = root.stateVersionBefore;
    for (const event of belowCap.events) {
      expect(event.stateVersionBefore).toBe(expectedVersion);
      expectedVersion = event.stateDelta === undefined ? expectedVersion : expectedVersion + 1;
      expect(event.stateVersionAfter).toBe(expectedVersion);
    }

    // 公開差分だけを当て直しても、増加後の所持数（7 + 1）とHPへ復元できる。
    const restored = reduceStateDeltas(
      initialSnapshotFor(aboveCap.board.units, { include: ["effects", "markers"] }),
      aboveCap.events.flatMap((event) =>
        event.stateDelta === undefined ? [] : [event.stateDelta],
      ),
    );
    expect(
      restored.units[createBattleUnitId("enemy:front")]?.markers?.find(
        (marker) => marker.markerId === FLUSH,
      )?.stackCount,
    ).toBe(8);
    for (const unit of aboveCap.result.units) {
      expect(restored.units[unit.battleUnitId]!.hp).toBe(unit.currentHp);
    }
  });
});
