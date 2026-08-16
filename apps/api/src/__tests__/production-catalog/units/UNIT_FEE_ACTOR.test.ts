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
import { rideStandInAttack } from "../../../testing/production-unit/follow-up-ride.js";

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
      // REF（Issue #474）: PS1の`sourceSelector`は原文「**他の**味方」どおり
      // `OTHER_ALLY`へ修正済み — フィー自身のAS使用ではPS1は起きない。
      actions: [
        { effectActionDefinitionId: "ACT_FEE_ACTOR_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_FEE_ACTOR_AS1_AP_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_FEE_ACTOR_AS1_DAMAGE_ADJACENT", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_FEE_ACTOR_AS1_DAMAGE_ADJACENT", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -711,
        "enemy:left": -237,
        "enemy:back": -237,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "enemy:front", resource: "AP", delta: -1 },
      ],
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
        { effectActionDefinitionId: "ACT_FEE_ACTOR_PS1_FOLLOW_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_FEE_ACTOR_PS1_CRIT_UP", targets: ["ally:front"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_FEE_ACTOR_PS1_FOLLOW_UP",
          magnitude: 0,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
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
        { effectActionDefinitionId: "ACT_FEE_ACTOR_PS1_FOLLOW_UP", targets: ["ally:front"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_FEE_ACTOR_PS1_FOLLOW_UP",
          magnitude: 0,
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
  {
    skillDefinitionId: "SKL_FEE_ACTOR_AS1",
    intent: "同上: 敵が1体だけで隣接対象がいなくても、その1体へは通常どおり発動する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_FEE_ACTOR_AS1" },
    board: { enemies: [{ id: "enemy:front", position: { column: "CENTER", row: "FRONT" } }] },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_FEE_ACTOR_AS1_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_FEE_ACTOR_AS1_AP_DOWN",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -711,
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
        {
          unitId: "enemy:front",
          resource: "AP",
          delta: -1,
        },
      ],
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
    // 会心率はパーセントポイント加算（R-STA-01）。基礎値を0.5へ置くと、抽選値0.6は
    // 素の0.5では会心せず、上昇後の 0.5 + 0.3 = 0.8 でだけ会心する。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, {
      combatStats: { criticalRate: 0.5 },
    });
    const granted = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_FEE_ACTOR_PS1_CRIT_UP", target: "ALLY" },
    ]);
    const holder = granted.find((unit) => unit.battleUnitId === "ally:front")!;
    expect(holder.combatStats.criticalRate).toBeCloseTo(0.8);

    const probe = observeLifecycleDamageProbe({
      units: granted,
      definitions: board.definitions,
      attackerUnitId: "ally:front",
      targetUnitId: "enemy:front",
      critical: "NORMAL",
      random: new SequenceRandomSource(new Array<number>(8).fill(0.6)),
      battleId: "B_FEE_CONSUME",
    });

    // 攻撃力1000 - 防御力500 = 500 に会心倍率（R-CRT-02: 100% + 会心ダメージ50%）が乗る。
    expect(probe.hpDeltas).toEqual({ "enemy:front": -750 });
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

  it("IT-UNIT-FEE-ACTOR-006 (R-FUP-01): 他の味方が実ASで攻撃するとPS1がそのSkillUseStartingで発動して追撃バフを付与し、当該攻撃の後に威力28.08のEN追撃が味方のステータスで入り、バフはその1回で失効する", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    // 付与→捕捉→相乗りの全周を1本の実AS使用で観測する — 合成ASの`SkillUseStarting`で
    // フィーのPS1（OTHER_ALLY）が実際に発動し、その場で付与されたバフが同じ攻撃に
    // 相乗りする。
    const { units, recorder } = rideStandInAttack({
      attackerUnitId: "ally:front",
      units: board.units,
      definitions: board.definitions,
      battleId: "B_FEE_PS1_RIDE",
    });
    expect(
      recorder
        .getEvents()
        .filter((event) => event.eventType === "PassiveResolved")
        .map((event) => (event.payload as { skillDefinitionId?: string }).skillDefinitionId),
    ).toEqual(["SKL_FEE_ACTOR_PS1"]);

    // AS本体: (1000 - 500) x 1.0 = 500。追撃: (1000 - 500) x 0.2808 = 140（非会心継承・EN）。
    const attacked = units.filter(
      (unit) => unit.side === "ENEMY" && unit.currentHp < unit.combatStats.maximumHp / 2,
    );
    expect(attacked).toHaveLength(1);
    expect(attacked[0]!.currentHp).toBe(5000 - 500 - 140);
    const followUpDamage = recorder
      .getEvents()
      .filter(
        (event) =>
          event.eventType === "DamageCalculated" &&
          (event.payload as { effectActionDefinitionId?: string }).effectActionDefinitionId ===
            "ACT_FEE_ACTOR_PS1_FOLLOW_UP",
      );
    expect(followUpDamage).toHaveLength(1);
    expect(followUpDamage[0]?.payload).toMatchObject({
      attackerAttack: 1000,
      criticalMultiplier: 1,
      finalDamage: 140,
      damageType: "EN",
    });
    // バフは「次の攻撃1回」で消費・失効している。
    const holderAfter = units.find((unit) => unit.battleUnitId === "ally:front")!;
    expect(holderAfter.appliedEffects.some((effect) => effect.isFollowUpAttack)).toBe(false);
  });
});
