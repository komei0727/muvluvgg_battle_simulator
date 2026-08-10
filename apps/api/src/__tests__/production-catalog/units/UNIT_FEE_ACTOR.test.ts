import { describe, expect, it } from "vitest";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import { observeLifecycleDamageProbe } from "../../../testing/production-unit/damage-probe.js";
import { observeActivationCounters } from "../../../testing/production-unit/runtime-counter.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import {
  PRODUCTION_CATALOG_DIR,
  applyPrecedingActions,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardOverrides,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  realDamage,
  skillUseStarting,
  turnStarted,
} from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_FEE_ACTOR`（【空っぽのアクター】フィー・ドレーゼ）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_FEE_ACTOR";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** PS1の分岐が読む `ATTRIBUTE` を、契機を作る味方側で作り分ける盤面。 */
const SHY_ALLY: BoardOverrides = {
  allies: [
    { id: "ally:front", position: { column: "LEFT", row: "FRONT" }, attribute: "SHY" },
    { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
  ],
};

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_FEE_ACTOR_EX",
    intent:
      "敵横一列に威力159でEN攻撃し、5行動分の炎上を付与する。炎上は攻撃力×30%の持続ダメージを与える",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_FEE_ACTOR_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_FEE_ACTOR_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_FEE_ACTOR_EX_BURN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_FEE_ACTOR_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_FEE_ACTOR_EX_BURN", targets: ["enemy:left"] },
      ],
      hpDeltas: {
        "enemy:front": -795,
        "enemy:left": -795,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_FEE_ACTOR_EX_BURN",
          magnitude: 300,
          timeLimit: { unit: "ACTION", count: 5 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_FEE_ACTOR_EX_BURN",
          magnitude: 300,
          timeLimit: { unit: "ACTION", count: 5 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_FEE_ACTOR_AS1",
    intent: "敵単体に威力142.2でEN攻撃し、APを1削る。あわせて隣接する2体に威力47.4でEN攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_FEE_ACTOR_AS1" },
    expected: {
      // PS1 の `sourceSelector: ALLY` は自分自身も味方として満たすため、フィー自身の
      // AS使用でもPS1が起き、追加ダメージがAS本体より先に入る。
      actions: [
        { effectActionDefinitionId: "ACT_FEE_ACTOR_PS1_DAMAGE_ADD", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_FEE_ACTOR_PS1_DAMAGE_ADD", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_FEE_ACTOR_PS1_DAMAGE_ADD", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_FEE_ACTOR_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_FEE_ACTOR_AS1_AP_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_FEE_ACTOR_AS1_DAMAGE_ADJACENT", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_FEE_ACTOR_AS1_DAMAGE_ADJACENT", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -851,
        "enemy:left": -377,
        "enemy:back": -377,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
        { unitId: "enemy:front", resource: "AP", delta: -1 },
      ],
      cooldowns: [{ unitId: "ally:subject", skillDefinitionId: "SKL_FEE_ACTOR_PS1", remaining: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_FEE_ACTOR_PS1",
    intent:
      "他の味方がアクティブスキルで攻撃する前に発動。味方単体の攻撃に威力28.08のENダメージを追加する。さらに対象の味方がシャイ属性の場合、一度だけ会心率を30%上昇させる(重複可)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FEE_ACTOR_PS1",
      trigger: skillUseStarting({
        actor: "ally:front",
        targets: ["enemy:back"],
        skillType: "AS",
      }),
      triggeredBy: "ally:front",
    },
    board: SHY_ALLY,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_FEE_ACTOR_PS1_DAMAGE_ADD", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_FEE_ACTOR_PS1_CRIT_UP", targets: ["ally:front"] },
      ],
      hpDeltas: {
        "enemy:back": -140,
      },
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_FEE_ACTOR_PS1_CRIT_UP",
          magnitude: 0.3,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [{ unitId: "ally:subject", skillDefinitionId: "SKL_FEE_ACTOR_PS1", remaining: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_FEE_ACTOR_PS1",
    intent: "(分岐): シャイ属性でない味方には会心率上昇が付かない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FEE_ACTOR_PS1",
      trigger: skillUseStarting({
        actor: "ally:front",
        targets: ["enemy:back"],
        skillType: "AS",
      }),
      triggeredBy: "ally:front",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_FEE_ACTOR_PS1_DAMAGE_ADD", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:back": -140,
      },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [{ unitId: "ally:subject", skillDefinitionId: "SKL_FEE_ACTOR_PS1", remaining: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_FEE_ACTOR_PS1",
    intent: "(不成立): 敵のアクティブスキル使用では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FEE_ACTOR_PS1",
      trigger: skillUseStarting({
        actor: "enemy:front",
        targets: ["ally:back"],
        skillType: "AS",
      }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_FEE_ACTOR_PS2",
    intent: "ターン開始時に発動。味方後列の攻撃力を15%上昇させ、敵前列の攻撃力を15%低下させる",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FEE_ACTOR_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_FEE_ACTOR_PS2_ATK_UP", targets: ["ally:back"] },
        { effectActionDefinitionId: "ACT_FEE_ACTOR_PS2_ATK_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_FEE_ACTOR_PS2_ATK_DOWN", targets: ["enemy:left"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_FEE_ACTOR_PS2_ATK_UP",
          magnitude: 0.15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_FEE_ACTOR_PS2_ATK_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_FEE_ACTOR_PS2_ATK_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_FEE_ACTOR_PS2",
    intent: "(不成立): このスキルは戦闘中に1度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FEE_ACTOR_PS2",
      trigger: turnStarted({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    board: {
      subject: {
        state: {
          skillCounters: {
            [createSkillDefinitionId("SKL_FEE_ACTOR_PS2")]: {
              [createRuntimeCounterId("SKL_FEE_ACTOR_PS2_ACTIVATIONS")]: { value: 1, carry: 0 },
            },
          },
        },
      },
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_FEE_ACTOR_PS3",
    intent:
      "後列の味方がアクティブスキルで攻撃された後に発動。味方後列の攻撃力を30%上昇させ、攻撃を行った敵単体の行動速度を100低下させる",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FEE_ACTOR_PS3",
      trigger: realDamage({ from: "enemy:front", to: "ally:back", skillType: "AS" }),
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_FEE_ACTOR_PS3_ATK_UP", targets: ["ally:back"] },
        { effectActionDefinitionId: "ACT_FEE_ACTOR_PS3_SPEED_DOWN", targets: ["enemy:front"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_FEE_ACTOR_PS3_ATK_UP",
          magnitude: 0.3,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_FEE_ACTOR_PS3_SPEED_DOWN",
          magnitude: -100,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [{ unitId: "ally:subject", skillDefinitionId: "SKL_FEE_ACTOR_PS3", remaining: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_FEE_ACTOR_PS3",
    intent: "(不成立): 前列の味方が攻撃されても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FEE_ACTOR_PS3",
      trigger: realDamage({ from: "enemy:front", to: "ally:front", skillType: "AS" }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_FEE_ACTOR_PS3",
    intent: "(不成立): パッシブスキルによるダメージでは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FEE_ACTOR_PS3",
      trigger: realDamage({ from: "enemy:front", to: "ally:back", skillType: "PS" }),
    },
    expected: {
      activated: false,
    },
  },
];

describe("production Catalog UNIT_FEE_ACTOR (【空っぽのアクター】フィー・ドレーゼ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-FEE-ACTOR-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-FEE-ACTOR-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-FEE-ACTOR-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-FEE-ACTOR-004 (R-EFF-11): PS2 が宣言する発動回数counterは、自分自身の PassiveActivated でだけ増える。このユニットのものではないPSの発動では動かない", () => {
    // counterの増減は `-001` の振る舞い表の観測に載らない（表はスキル使用1回が
    // 起こしたことを見るもので、`RuntimeCounterChanged` は契機イベントから
    // `detectRuntimeCounterUpdates` が独立に起こす）。宣言は実 `catalog/` の
    // ユニット定義から導くため、counterを持つPSが増えれば行が増えて落ちる。
    expect(observeActivationCounters(snapshot, UNIT_DEFINITION_ID)).toEqual({
      declarations: [
        {
          skillDefinitionId: "SKL_FEE_ACTOR_PS2",
          counter: "SKL_FEE_ACTOR_PS2_ACTIVATIONS",
          scope: "SKILL_RUNTIME",
          amount: 1,
        },
      ],
      changesByActivatedSkill: {
        SKL_FEE_ACTOR_PS2: [
          {
            skillDefinitionId: "SKL_FEE_ACTOR_PS2",
            counter: "SKL_FEE_ACTOR_PS2_ACTIVATIONS",
            before: 0,
            after: 1,
            valueChanged: true,
          },
        ],
      },
      changesOnUnrelatedSkill: [],
    });
  });

  it("IT-UNIT-FEE-ACTOR-005 (R-EFF-07): PS1の会心率上昇は「次に行う攻撃」で消費されるが、失効はその攻撃の解決後まで遅らせるため、**消費させた当の一撃自身が会心する**", () => {
    // 付与そのものと `consumption: { kind: NEXT_OUTGOING_ATTACK, maxCount: 1 }` の
    // 宣言は `-001` のPS1行が持つ。消費は**以後の別の攻撃**でしか起きないため、
    // 「いつ消費され、いつ失効し、その1発に効果が乗っているか」は表に現れない。
    //
    // 会心率は `RATIO` で基礎値に掛かるため基礎値を0.5へ置く。抽選値0.6は
    // 素の0.5では会心せず、上昇後の 0.5 × 1.3 = 0.65 でだけ会心する。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, {
      combatStats: { criticalRate: 0.5 },
    });
    const granted = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_FEE_ACTOR_PS1_CRIT_UP", target: "ALLY" },
    ]);
    const holder = granted.find((unit) => unit.battleUnitId === "ally:front")!;
    expect(holder.combatStats.criticalRate).toBeCloseTo(0.65);

    const probe = observeLifecycleDamageProbe({
      units: granted,
      definitions: board.definitions,
      attackerUnitId: "ally:front",
      targetUnitId: "enemy:front",
      critical: "NORMAL",
      random: new SequenceRandomSource(new Array<number>(8).fill(0.6)),
      battleId: "B_FEE_CONSUME",
    });

    // 攻撃力1000 - 防御力500 = 500 に会心倍率（R-CRT-02: 150% + 会心ダメージ50%）が乗る。
    expect(probe.hpDeltas).toEqual({ "enemy:front": -1000 });
    // 消費が0まで進み、その攻撃の解決後に失効する（`CONSUMPTION`）。
    expect(
      probe.recorder
        .getEvents()
        .filter((event) => event.eventType === "EffectConsumptionChanged")
        .map((event) => event.payload),
    ).toMatchObject([
      { battleUnitId: "ally:front", kind: "NEXT_OUTGOING_ATTACK", before: 1, after: 0 },
    ]);
    expect(
      probe.recorder
        .getEvents()
        .filter((event) => event.eventType === "EffectExpired")
        .map((event) => event.payload),
    ).toMatchObject([
      {
        battleUnitId: "ally:front",
        effectActionDefinitionId: "ACT_FEE_ACTOR_PS1_CRIT_UP",
        reason: "CONSUMPTION",
        cascaded: false,
      },
    ]);
    const after = probe.units.find((unit) => unit.battleUnitId === "ally:front")!;
    expect(after.appliedEffects).toEqual([]);
    expect(after.combatStats.criticalRate).toBeCloseTo(0.5);

    // 対照: 同じ抽選値でも上昇を持たない攻撃は会心しない（0.6 ≧ 0.5）。
    const withoutBuff = observeLifecycleDamageProbe({
      units: board.units,
      definitions: board.definitions,
      attackerUnitId: "ally:front",
      targetUnitId: "enemy:front",
      critical: "NORMAL",
      random: new SequenceRandomSource(new Array<number>(8).fill(0.6)),
      battleId: "B_FEE_NO_BUFF",
    });
    expect(withoutBuff.hpDeltas).toEqual({ "enemy:front": -500 });
  });
});
