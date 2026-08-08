import { describe, expect, it } from "vitest";
import {
  initialSnapshotFor,
  loadProductionSnapshot,
  unitFrom,
} from "../../../testing/fixtures/index.js";
import type { BattleDomainEvent } from "../../../domain/battle/events/domain-event.js";
import { reduceStateDeltas } from "../../../domain/battle/lifecycle/state-delta-reducer.js";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import { recoverTurnResources } from "../../../domain/battle/model/battle-unit.js";
import { openPassiveChain } from "../../../testing/production-unit/passive-activation.js";
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardOverrides,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  hitPointReduced,
  realDamage,
  turnStarted,
} from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_FLUTE_VAMPIRE`（【＃激カワ吸血鬼配信者♪】フルート・メルヴィル）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_FLUTE_VAMPIRE";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const KYOKUGEN = "MARKER_KYOKUGEN";

/** 「極限」状態の自身。 */
const IN_KYOKUGEN: BoardOverrides = { subject: { markers: [{ markerId: KYOKUGEN }] } };

/** 最大HPの10%以下まで削る一撃（4000ダメージで5000→1000）。 */
const HP_TO_TEN_PERCENT = realDamage({
  from: "enemy:front",
  to: "ally:subject",
  skillType: "AS",
  power: 8,
  event: "HitPointReduced",
});

/** そのPSが戦闘中に1度発動済みである局面。 */
function alreadyActivated(skillDefinitionId: string): BoardOverrides {
  return {
    subject: {
      state: {
        skillCounters: {
          [createSkillDefinitionId(skillDefinitionId)]: {
            [createRuntimeCounterId(`${skillDefinitionId}_ACTIVATIONS`)]: { value: 1, carry: 0 },
          },
        },
      },
    },
  };
}

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_FLUTE_VAMPIRE_EX",
    intent:
      "自身に最も近い敵前後列に威力101.4で攻撃する。攻撃後に最も近い位置にいる敵単体が生存していた場合、敵単体に威力46.8でもう一度攻撃する。更に与えたダメージの60%分自身のHPを回復する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_FLUTE_VAMPIRE_EX" },
    expected: {
      // 最も近い敵は敵前列で、その前後列＝CENTER列。回復は与えた合計1248の60%。
      actions: [
        {
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_EX_DAMAGE_COLUMN",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_EX_DAMAGE_COLUMN", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_EX_DAMAGE_FOLLOWUP",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_EX_SELF_HEAL", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "ally:subject": 748,
        "enemy:front": -741,
        "enemy:back": -507,
      },
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_VAMPIRE_EX",
    intent: "(分岐): 最も近い位置にいる敵単体が生存していなければ、もう一度の攻撃は行わない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_FLUTE_VAMPIRE_EX" },
    // 1発目でちょうど倒れるHPにして、追撃の腕が選ばれないことを見る。
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 507 },
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_EX_DAMAGE_COLUMN",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_EX_DAMAGE_COLUMN", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_EX_SELF_HEAL", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "ally:subject": 608,
        "enemy:front": -507,
        "enemy:back": -507,
      },
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_VAMPIRE_AS1",
    intent: "敵単体に威力85.8で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_FLUTE_VAMPIRE_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_AS1_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -429,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_VAMPIRE_AS1",
    intent: "自身が「極限」状態の場合、このスキルの発動時に自身の現在HPの25%を消費する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_FLUTE_VAMPIRE_AS1" },
    board: IN_KYOKUGEN,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_AS1_HP_COST", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "ally:subject": -1250,
        "enemy:front": -429,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_VAMPIRE_PS1",
    intent:
      "自身のHPが10%以下になった際に発動。自身のHPを最大HPの100%回復、さらに最大APを1増やし、自身を解除不可の「極限」状態にする。さらに自身に対し、2行動の間与ダメージを25%上昇させるバフを付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FLUTE_VAMPIRE_PS1",
      trigger: HP_TO_TEN_PERCENT,
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_PS1_HEAL_FULL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_PS1_MARKER", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_PS1_DMG_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_PS1_MAX_AP_UP", targets: ["ally:subject"] },
      ],
      // 1000から満タンの10000へ（超過分は捨てる）。
      hpDeltas: {
        "ally:subject": 9000,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_PS1_DMG_UP",
          magnitude: 0.25,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_PS1_MAX_AP_UP",
          magnitude: 1,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: KYOKUGEN, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_VAMPIRE_PS1",
    intent: "(不成立): HPが10%より多く残っている場合は発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FLUTE_VAMPIRE_PS1",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:subject",
        skillType: "AS",
        power: 4,
        event: "HitPointReduced",
      }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_VAMPIRE_PS1",
    intent: "(不成立): このスキルは戦闘中に1度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FLUTE_VAMPIRE_PS1",
      trigger: HP_TO_TEN_PERCENT,
    },
    board: alreadyActivated("SKL_FLUTE_VAMPIRE_PS1"),
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_VAMPIRE_PS2",
    intent:
      "自身がアクティブスキルで攻撃された後に発動。攻撃してきた敵単体に対し威力84.8で反撃し、攻撃を1ヒットだけ回避するバフを自身に付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FLUTE_VAMPIRE_PS2",
      trigger: realDamage({ from: "enemy:left", to: "ally:subject", skillType: "AS" }),
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_PS2_COUNTER", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_PS2_EVASION", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "enemy:left": -424,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_PS2_EVASION",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
          statusKind: "HIT_EVASION",
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_FLUTE_VAMPIRE_PS2", remaining: 3 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_VAMPIRE_PS2",
    intent: "(不成立): 自身が「極限」状態の場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FLUTE_VAMPIRE_PS2",
      trigger: realDamage({ from: "enemy:left", to: "ally:subject", skillType: "AS" }),
    },
    board: IN_KYOKUGEN,
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_VAMPIRE_PS3",
    intent:
      "ターン開始時に発動。最も遠い位置にいる敵単体に対し、次に受ける攻撃の被ダメージが20%増加するデバフを付与する（重複可）。さらに自身に対し、致死ダメージをHP1で耐えるバフを付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FLUTE_VAMPIRE_PS3",
      trigger: turnStarted({ unit: "ally:subject", turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_PS3_DEBUFF", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_PS3_DEATH_SURVIVAL",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_PS3_DEATH_SURVIVAL",
          magnitude: 0,
          timeLimit: { unit: "BATTLE", count: 1 },
          consumption: { kind: "LETHAL_DAMAGE", maxCount: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_FLUTE_VAMPIRE_PS3_DEBUFF",
          magnitude: 0.2,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_VAMPIRE_PS3",
    intent: "(不成立): このスキルは戦闘中に1度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FLUTE_VAMPIRE_PS3",
      trigger: turnStarted({ unit: "ally:subject", turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    board: alreadyActivated("SKL_FLUTE_VAMPIRE_PS3"),
    expected: {
      activated: false,
    },
  },
];

describe("production Catalog UNIT_FLUTE_VAMPIRE (【＃激カワ吸血鬼配信者♪】フルート・メルヴィル)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-FLUTE-VAMPIRE-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-FLUTE-VAMPIRE-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-FLUTE-VAMPIRE-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-FLUTE-VAMPIRE-004 (SUM_DAMAGE_DEALT): SKL_FLUTE_VAMPIRE_EX の自己回復は列攻撃と条件付き追撃の合計に対する60%で、追撃分だけの60%ではない", () => {
    const observed = observeSkillUse({
      snapshot,
      unitDefinitionId: UNIT_DEFINITION_ID,
      use: { kind: "ACTIVE", skillDefinitionId: "SKL_FLUTE_VAMPIRE_EX" },
    });
    const heal = observed.hpDeltas!["ally:subject"]!;
    const columnDamage = -observed.hpDeltas!["enemy:back"]!;
    const baseDamage = -observed.hpDeltas!["enemy:front"]!;
    const followUp = baseDamage - columnDamage;

    expect(heal).toBe(Math.floor((columnDamage * 2 + followUp) * 0.6));
    // 回帰ガード: 最後の1件（追撃）だけを見る近似ならこの半分にも届かない。
    expect(heal).toBeGreaterThan(followUp * 0.6);
  });

  it("IT-UNIT-FLUTE-VAMPIRE-005 (R-ACTN-03, MODIFY_RESOURCE_CAPACITY): SKL_FLUTE_VAMPIRE_PS1 は最大APだけを1上げ、現在APと不変の基準値は動かさない。上がった上限は次のターンのリソース回復が実際に満たす", () => {
    // 発動条件（HPが最大の10%以下）を満たし、APを使い切った局面から始める。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, {
      subject: { state: { currentHp: 1000, currentAp: 0 } },
    });
    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: "enemy:front",
      battleId: "B_FLUTE_CAPACITY",
    });
    // 発動直前の実状態と、そこから先に記録されたStateDeltaだけを突き合わせる。
    const initial = initialSnapshotFor(board.units, { include: ["effects", "markers"] });
    const eventsBefore = chain.recorder.getEvents().length;
    const after = chain.fire(
      hitPointReduced({
        source: "enemy:front",
        target: "ally:subject",
        damage: 4000,
        hpBefore: 5000,
      }),
      board.units,
    );

    const subject = after.find((unit) => unit.battleUnitId === "ally:subject")!;
    expect(subject.maximumAp).toBe(board.subject.maximumAp + 1);
    // 不変の基準は動かない — 失効時にここへ戻せることが再合成方式の前提。
    expect(subject.baseMaximumAp).toBe(board.subject.baseMaximumAp);
    // R-ACT-04: 上限が上がっただけでは現在値は追随しない。
    expect(subject.currentAp).toBe(0);
    // 上限がどこにも効かない「記録だけの値」になっていないことの証拠。
    expect(recoverTurnResources(subject).currentAp).toBe(board.subject.maximumAp + 1);

    // 集約のlive stateだけでは、イベントもStateDeltaも出ていない実装を通してしまう。
    const emitted = chain.recorder.getEvents().slice(eventsBefore);
    const capacityChanged = emitted.filter(
      (event): event is Extract<BattleDomainEvent, { eventType: "ResourceCapacityChanged" }> =>
        event.eventType === "ResourceCapacityChanged",
    );
    expect(capacityChanged).toHaveLength(1);
    expect(capacityChanged[0]!.payload).toMatchObject({
      battleUnitId: "ally:subject",
      resource: "AP",
      before: board.subject.maximumAp,
      after: board.subject.maximumAp + 1,
      reason: "EFFECT_APPLIED",
    });
    expect(capacityChanged[0]!.stateDelta?.units?.[subject.battleUnitId]?.maximumAp).toEqual({
      before: board.subject.maximumAp,
      after: board.subject.maximumAp + 1,
    });

    // 公開差分だけを独立Reducerへ流しても同じ上限・現在値へ復元できる。
    const restored = reduceStateDeltas(
      initial,
      emitted.flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta])),
    );
    expect(restored.units[subject.battleUnitId]!.maximumAp).toBe(subject.maximumAp);
    expect(restored.units[subject.battleUnitId]!.ap).toBe(subject.currentAp);
    expect(restored.units[subject.battleUnitId]!.hp).toBe(subject.currentHp);
  });
});
