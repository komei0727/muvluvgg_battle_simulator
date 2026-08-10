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
import {
  observeDamageProbe,
  observeLifecycleDamageProbe,
} from "../../../testing/production-unit/damage-probe.js";
import { openPassiveChain } from "../../../testing/production-unit/passive-activation.js";
import { observeActivationCounters } from "../../../testing/production-unit/runtime-counter.js";
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { turnStarted, unitDefeated } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_KOTOHA_REBEL`（【世界への反逆者】コトハ）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 *
 * 変化しなかった観測項目はキーごと落ちるため、`toEqual` の完全一致が
 * 「宣言した振る舞いが起きること」と「余計なことを起こさないこと」を同時に固定する。
 */

const UNIT_DEFINITION_ID = "UNIT_KOTOHA_REBEL";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_AS1",
    intent:
      "敵単体へ威力101.4で2ヒットし、対象を含む縦一列へ威力54.6で2ヒットずつ追加。自身へ「憤怒」を1つ付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KOTOHA_REBEL_AS1" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS1_DAMAGE1",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS1_DAMAGE2",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS1_DAMAGE2",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS1_MARKER",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1560,
        "enemy:back": -546,
      },
      markers: [
        {
          unitId: "ally:subject",
          markerId: "MARKER_FUNDO",
          stackCount: 1,
        },
      ],
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
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_KOTOHA_REBEL_AS1",
          remaining: 2,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_AS2",
    intent: "憤怒0個: 「1個以下」の腕へ進み、威力187.2で1ヒット攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KOTOHA_REBEL_AS2" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_ATK_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_DMG_1HIT",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1029,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_ATK_UP",
          magnitude: 0.05,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
      ],
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
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_AS2",
    intent: "憤怒1個: 同じく「1個以下」の腕",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KOTOHA_REBEL_AS2" },
    board: { subject: { markers: [{ markerId: "MARKER_FUNDO", stackCount: 1 }] } },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_ATK_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_DMG_1HIT",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1029,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_ATK_UP",
          magnitude: 0.05,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
      ],
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
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_AS2",
    intent: "憤怒2個: 威力124.8で2ヒット攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KOTOHA_REBEL_AS2" },
    board: { subject: { markers: [{ markerId: "MARKER_FUNDO", stackCount: 2 }] } },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_ATK_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_DMG_2HIT",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1372,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_ATK_UP",
          magnitude: 0.05,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
      ],
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
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_AS2",
    intent: "憤怒3個: 威力101.4で3ヒットし、1行動の間対象の与ダメージを10%減少させる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KOTOHA_REBEL_AS2" },
    board: { subject: { markers: [{ markerId: "MARKER_FUNDO", stackCount: 3 }] } },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_ATK_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_DMG_3HIT",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_TARGET_DMG_DOWN",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1671,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_ATK_UP",
          magnitude: 0.05,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_TARGET_DMG_DOWN",
          magnitude: -0.1,
          timeLimit: {
            unit: "ACTION",
            count: 1,
          },
        },
      ],
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
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_AS2",
    intent: "憤怒4個以上: 3ヒット版の与ダメージが50%増加する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KOTOHA_REBEL_AS2" },
    board: { subject: { markers: [{ markerId: "MARKER_FUNDO", stackCount: 4 }] } },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_ATK_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_DMG_3HIT_BOOSTED",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_TARGET_DMG_DOWN",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -2508,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_ATK_UP",
          magnitude: 0.05,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_TARGET_DMG_DOWN",
          magnitude: -0.1,
          timeLimit: {
            unit: "ACTION",
            count: 1,
          },
        },
      ],
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
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_PS1",
    intent: "味方が倒された際に発動する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KOTOHA_REBEL_PS1",
      trigger: unitDefeated({ unit: "ally:front", defeatedBy: "enemy:front" }),
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_PS1_ATK_UP",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_PS1_ATK_UP",
          magnitude: 0.1,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
      ],
      resources: [
        {
          unitId: "ally:subject",
          resource: "PP",
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
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_PS1",
    intent: "(不成立): 敵が倒れても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KOTOHA_REBEL_PS1",
      trigger: unitDefeated({ unit: "enemy:front", defeatedBy: "ally:subject" }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_PS2",
    intent: "ターン開始時に発動する（戦闘中1度だけ）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KOTOHA_REBEL_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_PS2_DEATH_SURVIVAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_PS2_DMG_UP",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_PS2_DEATH_SURVIVAL",
          magnitude: 0,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
          consumption: {
            kind: "LETHAL_DAMAGE",
            maxCount: 1,
          },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_PS2_DMG_UP",
          magnitude: 0.1,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
      ],
      resources: [
        {
          unitId: "ally:subject",
          resource: "PP",
          delta: -1,
        },
        {
          unitId: "ally:subject",
          resource: "EX_GAUGE",
          delta: 1,
        },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_KOTOHA_REBEL_PS2",
          remaining: 99,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_PS2",
    intent: "(不成立): 既に発動済みなら再発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KOTOHA_REBEL_PS2",
      trigger: turnStarted({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    board: {
      subject: {
        state: {
          skillCounters: {
            [createSkillDefinitionId("SKL_KOTOHA_REBEL_PS2")]: {
              [createRuntimeCounterId("SKL_KOTOHA_REBEL_PS2_ACTIVATIONS")]: { value: 1, carry: 0 },
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
    skillDefinitionId: "SKL_KOTOHA_REBEL_EX",
    intent: "自身のHPが満タンのときの腕",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KOTOHA_REBEL_EX" },
    board: { subject: { state: { currentHp: 10000 } } },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_EX_DAMAGE_PIERCE",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -2798,
      },
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_EX",
    intent: "自身のHPが半分（50%以上・満タン未満）のときの腕",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KOTOHA_REBEL_EX" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_EX_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -2332,
      },
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_EX",
    intent: "自身のHPが50%未満のときの腕",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KOTOHA_REBEL_EX" },
    board: { subject: { state: { currentHp: 3000 } } },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_EX_HEAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_EX_CONTINUOUS_HEAL",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "ally:subject": 3500,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_EX_CONTINUOUS_HEAL",
          magnitude: 0.135,
          timeLimit: {
            unit: "ACTION",
            count: 2,
          },
        },
      ],
    },
  },
];

describe("production Catalog UNIT_KOTOHA_REBEL (【世界への反逆者】コトハ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-KOTOHA-REBEL-001: $skillDefinitionId — $intent",
    ({ use, board, precedingActions, expected }) => {
      expect(
        observeSkillUse({
          snapshot,
          unitDefinitionId: UNIT_DEFINITION_ID,
          use,
          ...(board === undefined ? {} : { board }),
          ...(precedingActions === undefined ? {} : { precedingActions }),
        }),
      ).toEqual(expected);
    },
  );

  it("IT-UNIT-KOTOHA-REBEL-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-KOTOHA-REBEL-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
    // 全ID網羅監査（`UT-AUDIT-UNITCOV-001`）は「IDが文字列として書かれているか」しか
    // 見ないため、表に載っているだけで一度も実行されない定義を見逃す。実行された
    // 集合そのものを閉包と突き合わせる。表をこのテスト内で回し直すのは、
    // 収集器がモジュール全域の状態であり、テストファイル間の isolation 設定に
    // 結果を依存させないため。
    resetExecutedActionIds();
    for (const { use, board, precedingActions } of BEHAVIOURS) {
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use,
        ...(board === undefined ? {} : { board }),
        ...(precedingActions === undefined ? {} : { precedingActions }),
      });
    }
    expect(
      unexecutedEffectActionIds(
        unitEffectActionClosure(snapshot, UNIT_DEFINITION_ID),
        collectedExecutedActionIds(),
      ),
    ).toEqual([]);
  });

  it("IT-UNIT-KOTOHA-REBEL-004 (R-EFF-11): PS2 が宣言する発動回数counterは、自分自身の PassiveActivated でだけ増える。このユニットのものではないPSの発動では動かない", () => {
    // counterの増減は `-001` の振る舞い表の観測に載らない（表はスキル使用1回が
    // 起こしたことを見るもので、`RuntimeCounterChanged` は契機イベントから
    // `detectRuntimeCounterUpdates` が独立に起こす）。宣言は実 `catalog/` の
    // ユニット定義から導くため、counterを持つPSが増えれば行が増えて落ちる。
    expect(observeActivationCounters(snapshot, UNIT_DEFINITION_ID)).toEqual({
      declarations: [
        {
          skillDefinitionId: "SKL_KOTOHA_REBEL_PS2",
          counter: "SKL_KOTOHA_REBEL_PS2_ACTIVATIONS",
          scope: "SKILL_RUNTIME",
          amount: 1,
        },
      ],
      changesByActivatedSkill: {
        SKL_KOTOHA_REBEL_PS2: [
          {
            skillDefinitionId: "SKL_KOTOHA_REBEL_PS2",
            counter: "SKL_KOTOHA_REBEL_PS2_ACTIVATIONS",
            before: 0,
            after: 1,
            valueChanged: true,
          },
        ],
      },
      changesOnUnrelatedSkill: [],
    });
  });

  it("IT-UNIT-KOTOHA-REBEL-005 (R-DMG-04): PS2の実 与ダメージ補正が持つ `HP_RATIO_COMPARISON` 条件は付与時ではなくヒットごとに評価され、同じ `AppliedEffect` が相手のHP割合次第で効いたり効かなかったりする", () => {
    // `-001` のPS2行は付与時点の `magnitude`（+0.1）までを持つが、`damageModifier` の
    // `direction`／`condition` と、それが**別のスキル使用**である攻撃でどう効くかは
    // 表の外にある。同じ盤面・同じ1回の付与から2発撃ち分けて、差が相手のHP割合
    // だけで生まれることを固定する。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, {
      // 敵前列だけHP割合を下げる（自身は既定の50%）。
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 4000 },
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    });
    const granted = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: "ally:subject",
      battleId: "B_KOTOHA_DMG_UP",
    }).fire(turnStarted({ turnNumber: 1 }), board.units);

    expect(
      granted
        .find((unit) => unit.battleUnitId === "ally:subject")!
        .appliedEffects.find(
          (effect) => effect.effectActionDefinitionId === "ACT_KOTOHA_REBEL_PS2_DMG_UP",
        )!.damageModifier,
    ).toEqual({
      direction: "OUTGOING",
      damageType: null,
      condition: {
        kind: "HP_RATIO_COMPARISON",
        left: "OPPONENT",
        op: "LT",
        right: "EFFECT_OWNER",
      },
    });

    const against = (targetUnitId: string) =>
      observeDamageProbe({
        units: granted,
        attackerUnitId: "ally:subject",
        targetUnitId,
        battleId: `B_KOTOHA_DMG_UP_${targetUnitId}`,
      }).calculated;

    // 自身と互角のHP割合（50%）では `LT` が成立せず、素通しの500のまま。
    expect(against("enemy:left")).toEqual({
      outgoingDamageMultiplier: 1,
      incomingDamageMultiplier: 1,
      shieldIgnoreRate: 0,
      damageReductionIgnoreRate: 0,
      preTruncationDamage: 500,
      finalDamage: 500,
    });
    // HP割合が自身より低い敵（40%）に対してだけ+10%が乗る。
    expect(against("enemy:front")).toEqual({
      outgoingDamageMultiplier: 1.1,
      incomingDamageMultiplier: 1,
      shieldIgnoreRate: 0,
      damageReductionIgnoreRate: 0,
      preTruncationDamage: 550,
      finalDamage: 550,
    });
  });

  it("IT-UNIT-KOTOHA-REBEL-006 (R-INT-01 #5, R-EFF-07): PS2が張った致死耐えは、後の致死ヒットをHP1で止めて `UnitDefeated` を出させず、最大HPの65%を回復したうえで自インスタンスの `LETHAL_DAMAGE` を1消費して失効する", () => {
    // `-001` のPS2行は付与時点の `consumption` 宣言までしか持てない。「致死かどうか」は
    // HPへ適用する量が確定して初めて決まるため、成立とその後始末は必ず**別のスキル
    // 使用**である被弾側の1発で起きる。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const granted = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: "ally:subject",
      battleId: "B_KOTOHA_SURVIVAL",
    }).fire(turnStarted({ turnNumber: 1 }), board.units);

    // 消費・失効と `healAfterSurvival` は `lifecycle/` が注入するhookに委ねられており、
    // `applyDamageAction` 直呼びの観測では呼ばれない。
    const hit = observeLifecycleDamageProbe({
      definitions: board.definitions,
      units: granted,
      attackerUnitId: "enemy:front",
      targetUnitId: "ally:subject",
      // 攻撃力1000 - 防御力500 = 500 の12倍。現在HP5000を超える致死量にする。
      power: 12,
      battleId: "B_KOTOHA_SURVIVAL_HIT",
    });

    expect(hit.survived).toEqual([
      {
        effectActionDefinitionId: "ACT_KOTOHA_REBEL_PS2_DEATH_SURVIVAL",
        battleUnitId: "ally:subject",
        lethalDamage: 6000,
        hpBefore: 5000,
        survivalHp: 1,
      },
    ]);
    // R-INT-01 #5: `LethalDamageSurvived` と `UnitDefeated` は排他である。
    expect(hit.defeated).toEqual([]);
    // `healAfterSurvival`（最大HP10000の65% = 6500）をR-HEAL-01の手順で適用する。
    expect(hit.heals).toEqual([
      {
        effectActionDefinitionId: "ACT_KOTOHA_REBEL_PS2_DEATH_SURVIVAL",
        targetUnitId: "ally:subject",
        healAmount: 6500,
        hpBefore: 1,
        hpAfter: 6501,
      },
    ]);
    expect(hit.hpDeltas).toEqual({ "ally:subject": 1501 });
    // R-EFF-07: 耐えたインスタンス自身の `LETHAL_DAMAGE` を1消費して失効する。
    expect(
      hit.units
        .find((unit) => unit.battleUnitId === "ally:subject")!
        .appliedEffects.map((effect) => effect.effectActionDefinitionId),
    ).not.toContain("ACT_KOTOHA_REBEL_PS2_DEATH_SURVIVAL");
  });
});
