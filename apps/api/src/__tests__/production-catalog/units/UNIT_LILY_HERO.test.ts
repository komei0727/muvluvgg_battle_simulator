import { describe, expect, it } from "vitest";
import type { BattleDomainEvent } from "../../../domain/battle/events/domain-event.js";
import {
  initialSnapshotFor,
  loadProductionSnapshot,
  reconstruct,
  seedRecorder,
  unitFrom,
} from "../../../testing/fixtures/index.js";
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
  selectedActiveSkill,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { turnCompleting, unitDefeated } from "../../../testing/production-unit/trigger-events.js";
import { observeHitPointRatioCritical } from "../../../testing/production-unit/hit-point-ratio-critical-probe.js";

/**
 * `UNIT_LILY_HERO`（【正義のヒーロー】リリー・ラヴォア）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_LILY_HERO";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_LILY_HERO_EX",
    intent:
      "敵単体に威力312で攻撃し、自身の失ったHP30%を回復する。さらに1行動の間、自身の行動速度を150上昇させる。また、自身の与ダメージを50%上昇させるバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LILY_HERO_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LILY_HERO_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LILY_HERO_EX_HEAL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LILY_HERO_EX_SPEED_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LILY_HERO_EX_DAMAGE_UP", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "ally:subject": 1500,
        "enemy:front": -1560,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LILY_HERO_EX_SPEED_UP",
          magnitude: 150,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LILY_HERO_EX_DAMAGE_UP",
          magnitude: 0.5,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LILY_HERO_AS1",
    intent:
      "自身の最大HP10%を消費し、自身に最も近い位置にいる敵単体および対象に隣接する敵に対し消費HP×319.8%のダメージを与える攻撃、および威力78の攻撃を行う",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LILY_HERO_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LILY_HERO_AS1_HP_COST", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LILY_HERO_AS1_DAMAGE_HPCOST", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LILY_HERO_AS1_DAMAGE_FIXED", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LILY_HERO_AS1_DAMAGE_HPCOST", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_LILY_HERO_AS1_DAMAGE_FIXED", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_LILY_HERO_AS1_DAMAGE_HPCOST", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_LILY_HERO_AS1_DAMAGE_FIXED", targets: ["enemy:back"] },
      ],
      // 消費HP分の一撃（最大HP10000 × 31.98% を切り捨てた3197）と、威力78の一撃390。
      hpDeltas: {
        "ally:subject": -1000,
        "enemy:front": -3587,
        "enemy:left": -3587,
        "enemy:back": -3587,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LILY_HERO_AS1",
    intent: "(不成立): 自身のHPが20%未満の場合、このスキルは発動しない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LILY_HERO_AS1" },
    board: { subject: { state: { currentHp: 1500 } } },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_LILY_HERO_AS2",
    intent: "敵単体に威力156で攻撃し、1行動の間対象の行動速度を90低下させ、1行動の気絶を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LILY_HERO_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LILY_HERO_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LILY_HERO_AS2_SPEED_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LILY_HERO_AS2_STUN", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -780,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_LILY_HERO_AS2_SPEED_DOWN",
          magnitude: -90,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_LILY_HERO_AS2_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LILY_HERO_PS1",
    intent:
      "自身が敵を倒した際に発動。2行動の間、自身が受ける攻撃のダメージを50%減少させる効果を付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LILY_HERO_PS1",
      trigger: unitDefeated({ unit: "enemy:front", defeatedBy: "ally:subject" }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_LILY_HERO_PS1_DAMAGE_REDUCTION",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LILY_HERO_PS1_DAMAGE_REDUCTION",
          magnitude: -0.5,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LILY_HERO_PS1",
    intent: "(不成立): 味方が倒れても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LILY_HERO_PS1",
      trigger: unitDefeated({ unit: "ally:front", defeatedBy: "enemy:front" }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_LILY_HERO_PS2",
    intent: "ターン終了時に発動。自身の失ったHPの50%を回復する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LILY_HERO_PS2",
      trigger: turnCompleting({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [{ effectActionDefinitionId: "ACT_LILY_HERO_PS2_HEAL", targets: ["ally:subject"] }],
      hpDeltas: {
        "ally:subject": 2500,
      },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LILY_HERO_AS1",
    intent: "同上: 敵が1体だけで隣接対象がいなくても、HPを支払って最も近い1体へ発動する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LILY_HERO_AS1" },
    board: { enemies: [{ id: "enemy:front", position: { column: "CENTER", row: "FRONT" } }] },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_LILY_HERO_AS1_HP_COST",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_LILY_HERO_AS1_DAMAGE_HPCOST",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_LILY_HERO_AS1_DAMAGE_FIXED",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "ally:subject": -1000,
        "enemy:front": -3587,
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

describe("production Catalog UNIT_LILY_HERO (【正義のヒーロー】リリー・ラヴォア)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-LILY-HERO-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-LILY-HERO-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-LILY-HERO-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-LILY-HERO-004 [R-ACT-02] (R-ACT-02): AS1の実 NOT(TARGET_STATE HP_RATIO LT 0.2) は行動選択層で評価され、HP20%未満ではAS1が候補から外れて宣言順の次のAS2が選ばれる", () => {
    // 既定盤面のHP割合は50%。
    expect(selectedActiveSkill({ snapshot, unitDefinitionId: UNIT_DEFINITION_ID })).toBe(
      "SKL_LILY_HERO_AS1",
    );

    // 20%ちょうどは `LT 0.2` に当たらないため、まだAS1が選ばれる（境界）。
    expect(
      selectedActiveSkill({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        board: { subject: { state: { currentHp: 2000 } } },
      }),
    ).toBe("SKL_LILY_HERO_AS1");

    expect(
      selectedActiveSkill({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        board: { subject: { state: { currentHp: 1999 } } },
      }),
    ).toBe("SKL_LILY_HERO_AS2");
  });

  it("IT-UNIT-LILY-HERO-005 [R-ACTN-02] (R-ACTN-02): AS1のHP支払いは公開差分を持つ `ResourceChanged` として現れ、開始前スナップショットへそれだけを当て直すと同じHPへ復元できる。残HPが支払い額に満たない場合は `bounds.min: 0` で0止まりになり、負のHPにはならない", () => {
    // `-001` のAS1行は支払い額そのもの（最大HP10000の10%＝1000。現在HP5000基準では
    // ないこと）を `hpDeltas` で固定する。ここが引き受けるのはその外側の2点 —
    // 支払いが「イベントに出ない副作用」になっていないことと、`bounds.min` の境界で
    // ある。境界側はAS1の発動条件（HP20%未満では発動しない）より下のHPでしか
    // 起こせないため、スキル使用ではなく実 `MODIFY_RESOURCE` 定義を直接通す。
    const payFrom = (currentHp: number, battleId: string) => {
      const board = productionBoard(snapshot, UNIT_DEFINITION_ID, {
        subject: { state: { currentHp } },
      });
      const seeded = seedRecorder(battleId);
      const after = applyPrecedingActions(
        board,
        [{ effectActionDefinitionId: "ACT_LILY_HERO_AS1_HP_COST", target: "SELF" }],
        { recorder: seeded },
      );
      const paid = seeded.recorder
        .getEvents()
        .filter(
          (event): event is Extract<BattleDomainEvent, { eventType: "ResourceChanged" }> =>
            event.eventType === "ResourceChanged" &&
            event.payload.resource === "HP" &&
            event.payload.battleUnitId === "ally:subject",
        )
        .map((event) => ({
          reason: event.payload.reason,
          before: event.payload.before,
          after: event.payload.after,
          delta: event.payload.delta,
        }));
      return { board, after, paid, recorder: seeded.recorder };
    };

    // 既定盤面（現在HP5000・最大HP10000）。`MAX_HP_RATIO` なので支払いは1000。
    const full = payFrom(5000, "B_LILY_HP_COST");
    expect(full.paid).toEqual([
      { reason: "EFFECT_ACTION", before: 5000, after: 4000, delta: -1000 },
    ]);
    // 公開差分だけを当て直した状態を、スナップショット全体で突き合わせる。HPだけを
    // 名指しで比べると、支払いに伴う他の差分が欠けていても通ってしまう。
    expect(reconstruct(initialSnapshotFor(full.board.units), full.recorder)).toEqual(
      initialSnapshotFor(full.after),
    );

    // 支払い額（1000）より残HPが少ない状態。`bounds.min: 0` が下限で打ち止める。
    const floored = payFrom(400, "B_LILY_HP_COST_FLOOR");
    expect(floored.paid).toEqual([{ reason: "EFFECT_ACTION", before: 400, after: 0, delta: -400 }]);
    expect(reconstruct(initialSnapshotFor(floored.board.units), floored.recorder)).toEqual(
      initialSnapshotFor(floored.after),
    );
  });

  it("IT-UNIT-LILY-HERO-006 [R-CRT-04] (R-CRT-04): AS1の「消費HP×319.8%のダメージ」は会心判定を行う — 消費した資源へ威力倍率を掛ける攻撃であり、同じ最大HP割合Formulaでもレイラの「最大HP×20%分」とは逆の宣言になる", () => {
    const probe = (effectActionDefinitionId: string, skillDefinitionId: string) =>
      observeHitPointRatioCritical({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        effectActionDefinitionId,
        skillDefinitionId,
        attackerHoldsCriticalGuarantee: false,
        battleId: `B_LILY_HERO_CRT04_${effectActionDefinitionId}`,
      });

    // 会心率100%の盤面。結末を分けるのはCatalogの `critical.mode` 宣言だけである。
    const ruled = probe("ACT_LILY_HERO_AS1_DAMAGE_HPCOST", "SKL_LILY_HERO_AS1");
    const control = probe("ACT_LILY_HERO_AS1_DAMAGE_FIXED", "SKL_LILY_HERO_AS1");

    // 規則の族には入るが、宣言は `NORMAL`。威力ベースの対照とまったく同じ結末になる。
    expect(ruled.criticalMode).toBe("NORMAL");
    expect(ruled.isCritical).toBe(true);
    expect(ruled.criticalMultiplier).toBeGreaterThan(1);
    expect(control.criticalMode).toBe("NORMAL");
    expect(control.isCritical).toBe(true);
    expect(ruled.randomDraws).toBe(control.randomDraws);
  });
});
