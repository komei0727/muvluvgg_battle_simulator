import { describe, expect, it } from "vitest";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
import type { BattleUnit } from "../../../domain/battle/model/battle-unit.js";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import { observeLifecycleDamageProbe } from "../../../testing/production-unit/damage-probe.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import {
  observeActivationCounters,
  observeCriticalCounterCycle,
} from "../../../testing/production-unit/runtime-counter.js";
import {
  PRODUCTION_CATALOG_DIR,
  applyPrecedingActions,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  criticalCheckResolved,
  turnStarted,
} from "../../../testing/production-unit/trigger-events.js";
import { observeHitPointRatioCritical } from "../../../testing/production-unit/hit-point-ratio-critical-probe.js";

/**
 * `UNIT_LAYLA_ENTREPRENEUR`（【戦うアントレプレナー】レイラ・ジェンキンス）のユニット単位production結合テスト
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

const UNIT_DEFINITION_ID = "UNIT_LAYLA_ENTREPRENEUR";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/**
 * R-HIT-05の必中付与は**どの単一定義にも帰属しない** — 貫通する側（このユニットが
 * 配る `GUARANTEED_HIT`）と貫通される側（回避効果）が別ユニットにあるため、回避
 * 定義の供給元だけをsnapshotへ併読する。どちらの定義も未改変のまま使う。
 */
const WITH_EVASION_SOURCE = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  "UNIT_FLUTE_VAMPIRE",
]);

const PS1_GUARANTEED_HIT = "ACT_LAYLA_ENTREPRENEUR_PS1_GUARANTEED_HIT";
const HIT_EVASION = "ACT_FLUTE_VAMPIRE_PS2_EVASION";

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_AS1",
    intent: "敵前後列へ威力187.2で攻撃し、自身の会心率+30%。対象が物理タイプなら追撃はしない側の腕",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_AS1" },
    board: {
      enemies: [
        { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, unitType: "ENERGY" },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, unitType: "ENERGY" },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" }, unitType: "ENERGY" },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_AS1_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_AS1_DAMAGE",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_AS1_CRIT_UP",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "enemy:front": -936,
        "enemy:back": -936,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_AS1_CRIT_UP",
          magnitude: 0.3,
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
          delta: -2,
        },
        {
          unitId: "ally:subject",
          resource: "EX_GAUGE",
          delta: 2,
        },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_AS1",
          remaining: 2,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_AS1",
    intent: "同上: 対象が物理タイプの場合、威力78でもう1回攻撃を行う",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_AS1" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_AS1_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_AS1_DAMAGE",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_AS1_CRIT_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_AS1_DAMAGE_EXTRA",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1326,
        "enemy:back": -936,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_AS1_CRIT_UP",
          magnitude: 0.3,
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
          delta: -2,
        },
        {
          unitId: "ally:subject",
          resource: "EX_GAUGE",
          delta: 2,
        },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_AS1",
          remaining: 2,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_AS2",
    intent: "敵単体へ威力42.4で4ヒット攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_AS2" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_AS2_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -848,
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
  {
    skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_PS1",
    intent: "ターン開始時、自身の会心率+20%と4スキル分の必中バフを付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_PS1",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_PS1_CRIT_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_PS1_GUARANTEED_HIT",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_PS1_CRIT_UP",
          magnitude: 0.2,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_PS1_GUARANTEED_HIT",
          magnitude: 0,
          timeLimit: {
            unit: "SKILL_USE",
            count: 4,
          },
          statusKind: "GUARANTEED_HIT",
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
    skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_PS1",
    intent: "(不成立): このスキルは戦闘中に1度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_PS1",
      trigger: turnStarted({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    board: {
      subject: {
        state: {
          skillCounters: {
            [createSkillDefinitionId("SKL_LAYLA_ENTREPRENEUR_PS1")]: {
              [createRuntimeCounterId("SKL_LAYLA_ENTREPRENEUR_PS1_ACTIVATIONS")]: {
                value: 1,
                carry: 0,
              },
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
    skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_PS2",
    intent: "自身の攻撃が4回会心になるたびに発動し、敵単体へ威力159と最大HP×20%のダメージを与える",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_PS2",
      trigger: criticalCheckResolved({
        source: "ally:subject",
        target: "enemy:front",
        result: true,
      }),
      triggeredBy: "ally:subject",
    },
    board: {
      subject: {
        state: {
          skillCounters: {
            [createSkillDefinitionId("SKL_LAYLA_ENTREPRENEUR_PS2")]: {
              [createRuntimeCounterId("SKL_LAYLA_ENTREPRENEUR_PS2_TRIGGER_COUNT")]: {
                value: 3,
                carry: 0,
              },
            },
          },
        },
      },
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_PS2_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_PS2_DAMAGE_MAXHP",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -2795,
      },
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
    skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_PS2",
    intent: "(不成立): 会心にならなかった攻撃では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_PS2",
      trigger: criticalCheckResolved({
        source: "ally:subject",
        target: "enemy:front",
        result: false,
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_EX",
    intent: "敵横一列へ威力18.72で12ヒット攻撃し、自身へ次の被攻撃を1度無効にする効果を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_EX" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_EX_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_EX_DAMAGE",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_EX_IMMUNITY",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1116,
        "enemy:left": -1116,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LAYLA_ENTREPRENEUR_EX_IMMUNITY",
          magnitude: 0,
          consumption: {
            kind: "NEXT_INCOMING_ATTACK",
            maxCount: 1,
          },
          statusKind: "DAMAGE_IMMUNITY",
        },
      ],
    },
  },
];

describe("production Catalog UNIT_LAYLA_ENTREPRENEUR (【戦うアントレプレナー】レイラ・ジェンキンス)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-LAYLA-ENTREPRENEUR-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-LAYLA-ENTREPRENEUR-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-LAYLA-ENTREPRENEUR-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-LAYLA-ENTREPRENEUR-004 (R-EFF-11): PS1 が宣言する発動回数counterは、自分自身の PassiveActivated でだけ増える。このユニットのものではないPSの発動では動かない", () => {
    // counterの増減は `-001` の振る舞い表の観測に載らない（表はスキル使用1回が
    // 起こしたことを見るもので、`RuntimeCounterChanged` は契機イベントから
    // `detectRuntimeCounterUpdates` が独立に起こす）。宣言は実 `catalog/` の
    // ユニット定義から導くため、counterを持つPSが増えれば行が増えて落ちる。
    expect(observeActivationCounters(snapshot, UNIT_DEFINITION_ID)).toEqual({
      declarations: [
        {
          skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_PS1",
          counter: "SKL_LAYLA_ENTREPRENEUR_PS1_ACTIVATIONS",
          scope: "SKILL_RUNTIME",
          amount: 1,
        },
      ],
      changesByActivatedSkill: {
        SKL_LAYLA_ENTREPRENEUR_PS1: [
          {
            skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_PS1",
            counter: "SKL_LAYLA_ENTREPRENEUR_PS1_ACTIVATIONS",
            before: 0,
            after: 1,
            valueChanged: true,
          },
        ],
      },
      changesOnUnrelatedSkill: [],
    });
  });

  it("IT-UNIT-LAYLA-ENTREPRENEUR-005 [R-HIT-05] (R-HIT-05): PS1が配る実 ACT_LAYLA_ENTREPRENEUR_PS1_GUARANTEED_HIT を保持する攻撃側は、実 ACT_FLUTE_VAMPIRE_PS2_EVASION を貫通して2ヒットとも当てる。回避を抜いた対照と、必中を抜いた対照の両方を並べる", () => {
    // `-001` のPS1行は付与そのもの（`magnitude: 0`・`SKILL_USE(4)`・`GUARANTEED_HIT`）
    // までを固定する。必中が効くのは**保持者の以後の攻撃**＝別のスキル使用であり、
    // さらにこの機構は**どの単一定義にも帰属しない**（貫通される回避効果は別ユニット）。
    // `12_テスト戦略.md`「`IT-CAP-*` の retire 基準」3に従い、回避効果側
    // （`IT-UNIT-FLUTE-VAMPIRE-009`）と同じ観測をここへ複製する（重複を受け入れる）。
    const board = productionBoard(WITH_EVASION_SOURCE, UNIT_DEFINITION_ID);
    const strike = (units: readonly BattleUnit[], battleId: string) =>
      observeLifecycleDamageProbe({
        definitions: board.definitions,
        units,
        attackerUnitId: "ally:subject",
        targetUnitId: "enemy:front",
        hitCount: 2,
        accuracy: "NORMAL",
        battleId,
      });

    const guaranteed = strike(
      applyPrecedingActions(board, [
        { effectActionDefinitionId: PS1_GUARANTEED_HIT, target: "SELF" },
        { effectActionDefinitionId: HIT_EVASION, target: "ENEMY" },
      ]),
      "B_LAYLA_GUARANTEED_HIT",
    );
    expect(guaranteed.hits).toEqual([
      { hitIndex: 1, result: "CONFIRMED" },
      { hitIndex: 2, result: "CONFIRMED" },
    ]);
    // 攻撃力1000 - 防御力500 = 500 の2ヒットぶんが届く。
    expect(guaranteed.hpDeltas).toEqual({ "enemy:front": -1000 });
    // 回避が一度も成立していないため、被ヒット消費も進まない。
    expect(guaranteed.consumptions).toEqual([]);

    // 必中を抜いた対照。同じ回避効果が1ヒット目を止める（＝前提の回避効果が
    // 有効であり、貫通の原因が必中バフだけであることが読める）。
    const withoutGuaranteedHit = strike(
      applyPrecedingActions(board, [{ effectActionDefinitionId: HIT_EVASION, target: "ENEMY" }]),
      "B_LAYLA_EVADED",
    );
    expect(withoutGuaranteedHit.hits).toEqual([
      { hitIndex: 1, result: "EVADED", evadedBy: HIT_EVASION },
      { hitIndex: 2, result: "CONFIRMED" },
    ]);
    expect(withoutGuaranteedHit.hpDeltas).toEqual({ "enemy:front": -500 });
  });

  it("IT-UNIT-LAYLA-ENTREPRENEUR-007 [R-EFF-11] (R-EFF-11 RESET, Issue #554): PS2の会心カウンタは、N到達がそのスキル最後の会心でなくても発動し、発動時に0へ戻る。到達後の余剰会心は次回へ繰り越さず、PS2自身の会心だけが0起点で乗る", () => {
    // 実挙動: 会心が1ヒット出るたびに加算 → N到達で発動を予約 → スキルの全効果処理
    // 完了後にカウンタを0へ戻す → PSを実行（この攻撃の会心は0起点で加算される）。
    // `modulo` ゲートでは表せない — 1回の効果処理中に周期を通り越すため、到達後の
    // 余剰がそのまま次回へ繰り越されてしまう。
    const cycle = observeCriticalCounterCycle({
      snapshot,
      unitDefinitionId: UNIT_DEFINITION_ID,
      passiveSkillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_PS2",
      counter: "SKL_LAYLA_ENTREPRENEUR_PS2_TRIGGER_COUNT",
      // カウンタ2から4ヒットASを撃つと、4到達は2ヒット目（＝最後の会心ではない）。
      initialCounter: 2,
      uses: [
        { skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_AS2" },
        { skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_AS1" },
      ],
    });

    expect(cycle).toEqual([
      // AS2の4会心（カウンタ3,4,5,6）＋ PS2自身の会心1。発動は1回だけ（R-PS-07）で、
      // 発動後のカウンタは0へ戻る。PS2自身の会心は`PassiveActivated`後のPS連鎖内部で
      // 発行されるため、`SKILL_RUNTIME`のcounterUpdatesには届かない（連鎖内部へ
      // 届くのは`AppliedEffect`／`EffectSequence`スコープだけ）。
      { criticalHits: 5, activations: 1, counterAfter: 0 },
      // 次の発動には改めて4会心が要る。AS1の2会心（カウンタ1,2）では届かない —
      // 余剰を繰り越す旧`modulo`モデルなら6→7,8で4の倍数に達して発動していた。
      { criticalHits: 2, activations: 0, counterAfter: 2 },
    ]);
  });

  it("IT-UNIT-LAYLA-ENTREPRENEUR-008 [R-EFF-11] (R-EFF-11 RESET, Issue #554): 12ヒットのEXで全ヒット会心しても、PS2の発動は1回だけで、余剰の会心は破棄される", () => {
    const cycle = observeCriticalCounterCycle({
      snapshot,
      unitDefinitionId: UNIT_DEFINITION_ID,
      passiveSkillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_PS2",
      counter: "SKL_LAYLA_ENTREPRENEUR_PS2_TRIGGER_COUNT",
      uses: [{ skillDefinitionId: "SKL_LAYLA_ENTREPRENEUR_EX" }],
    });

    expect(cycle).toEqual([
      // 敵横一列2体×12ヒット＝24会心。4到達は4ヒット目で、その後20会心が続いても
      // 発動は1回（R-PS-07）。余剰20会心は繰り越さずカウンタは0へ戻る。
      { criticalHits: 25, activations: 1, counterAfter: 0 },
    ]);
  });

  it("IT-UNIT-LAYLA-ENTREPRENEUR-006 [R-CRT-04] (R-CRT-04): PS2の「自身の最大HP×20%のダメージを与える攻撃」は会心判定を行わない — 同じPS2の威力159側は従来どおり会心する", () => {
    const probe = (effectActionDefinitionId: string, skillDefinitionId: string) =>
      observeHitPointRatioCritical({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        effectActionDefinitionId,
        skillDefinitionId,
        attackerHoldsCriticalGuarantee: false,
        battleId: `B_LAYLA_CRT04_${effectActionDefinitionId}`,
      });

    // 会心率100%の盤面。結末を分けるのはCatalogの `critical.mode` 宣言だけである。
    const ruled = probe("ACT_LAYLA_ENTREPRENEUR_PS2_DAMAGE_MAXHP", "SKL_LAYLA_ENTREPRENEUR_PS2");
    const control = probe("ACT_LAYLA_ENTREPRENEUR_PS2_DAMAGE", "SKL_LAYLA_ENTREPRENEUR_PS2");

    expect(ruled.criticalMode).toBe("PREVENTED");
    expect(ruled.isCritical).toBe(false);
    expect(ruled.criticalMultiplier).toBe(1);
    expect(control.criticalMode).toBe("NORMAL");
    expect(control.isCritical).toBe(true);
    expect(control.criticalMultiplier).toBeGreaterThan(1);
    // 会心判定を行った側だけが抽選を1本多く消費する。
    expect(control.randomDraws - ruled.randomDraws).toBe(1);
  });
});
