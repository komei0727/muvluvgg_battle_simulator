import { describe, expect, it } from "vitest";
import { EventRecorder } from "../../../domain/battle/events/event-recorder.js";
import { resolveSkillUse } from "../../../domain/battle/resolution/action-skill-use-resolver.js";
import { reduceStateDeltas } from "../../../domain/battle/events/state-delta-reducer.js";
import type { BattleUnit } from "../../../domain/battle/model/battle-unit.js";
import { createActionId } from "../../../domain/shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../../domain/shared/ids.js";
import {
  initialSnapshotFor,
  loadProductionSnapshot,
  skillFrom,
  unitFrom,
} from "../../../testing/fixtures/index.js";
import { createSkillDefinitionId } from "../../../domain/catalog/definitions/catalog-ids.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import { observeCumulativeThresholdCounter } from "../../../testing/production-unit/runtime-counter.js";
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardOverrides,
  type BoardUnitSpec,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import { realDamage, unitDefeated } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_CHIYURU_NEWYEAR`（【新春のメイズ研究者】月ヶ瀬ちゆる）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_CHIYURU_NEWYEAR";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const MOCHI = "MARKER_CHIYURU_NEWYEAR_MOCHI";
const AS1 = createSkillDefinitionId("SKL_CHIYURU_NEWYEAR_AS1");

/** 「除災招福」がクールタイム中である局面（リセットの効きはここでしか観測できない）。 */
const AS1_ON_COOLDOWN: BoardOverrides = {
  subject: { state: { cooldowns: { [AS1]: { unit: "TURN", remaining: 99 } } } },
};

/**
 * 攻撃後にちょうど5000へ落ちるHPを持つ敵配置。現在HP割合で決まる毒の効果量を
 * 丸めのない500にする。
 */
const ENEMIES_FALLING_TO_5000: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, state: { currentHp: 5636 } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, state: { currentHp: 5636 } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" }, state: { currentHp: 5636 } },
];

/** 累計で最大HP×40%（4000ダメージ）に達する一撃。 */
const CUMULATIVE_THRESHOLD_HIT = realDamage({
  from: "enemy:front",
  to: "ally:subject",
  skillType: "AS",
  power: 8,
});

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_CHIYURU_NEWYEAR_EX",
    intent:
      "敵全体に威力127.2で攻撃し、2行動の毒を付与する。さらにスキル「除災招福」のクールタイムをリセットして再び使用できるようにし、自身に「お餅」を1つ付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_NEWYEAR_EX" },
    board: { ...AS1_ON_COOLDOWN, enemies: ENEMIES_FALLING_TO_5000 },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_EX_POISON", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_EX_POISON", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_EX_POISON", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_EX_CD_RESET", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_EX_MOCHI", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "enemy:front": -636,
        "enemy:left": -636,
        "enemy:back": -636,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_EX_POISON",
          magnitude: 500,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_EX_POISON",
          magnitude: 500,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_EX_POISON",
          magnitude: 500,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: MOCHI, stackCount: 1 }],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_CHIYURU_NEWYEAR_AS1", remaining: 0 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_NEWYEAR_AS1",
    intent:
      "付与されている「お餅」1つにつき、自身の攻撃力を3%、防御力を6%上昇させる（重複可）（最大6つまで）。このバフは自身が次の行動を終えるまで継続する。加えて敵横一列に威力39で3ヒット攻撃し、与えたダメージの25%分自身のHPを回復する。さらに対象に対し、2行動の間HP回復を無効にするデバフを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_NEWYEAR_AS1" },
    board: { subject: { markers: [{ markerId: MOCHI, stackCount: 2 }] } },
    expected: {
      // 敵横一列＝基準敵と同じ行。既定盤面では敵前列の2体。
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_DEF_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_HEAL_BLOCK",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_HEAL_BLOCK", targets: ["enemy:left"] },
        {
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_HEAL_SELF",
          targets: ["ally:subject"],
        },
      ],
      // 攻撃力バフ後の1000×1.06から1ヒット218（(1060-500)×39%）×3ヒット。
      // 回復は与えた合計1308の25%。
      hpDeltas: {
        "ally:subject": 327,
        "enemy:front": -654,
        "enemy:left": -654,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_ATK_UP",
          magnitude: 0.06,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_TARGET" },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_DEF_UP",
          magnitude: 0.12,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_TARGET" },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_HEAL_BLOCK",
          magnitude: -1,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_HEAL_BLOCK",
          magnitude: -1,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_CHIYURU_NEWYEAR_AS1", remaining: 99 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_NEWYEAR_AS1",
    intent:
      "(境界): 「お餅」を1つも持たないとき、攻撃力・防御力の上昇は0になる（`MARKER_COUNT_SCALE`は所持数0で不成立）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_NEWYEAR_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_DEF_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_HEAL_BLOCK",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_HEAL_BLOCK", targets: ["enemy:left"] },
        {
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_HEAL_SELF",
          targets: ["ally:subject"],
        },
      ],
      // 上昇なしの1000から1ヒット195（(1000-500)×39%）×3ヒット。回復は合計1170の25%。
      hpDeltas: {
        "ally:subject": 292,
        "enemy:front": -585,
        "enemy:left": -585,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_ATK_UP",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_TARGET" },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_DEF_UP",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_TARGET" },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_HEAL_BLOCK",
          magnitude: -1,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_HEAL_BLOCK",
          magnitude: -1,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_CHIYURU_NEWYEAR_AS1", remaining: 99 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_NEWYEAR_AS1",
    intent: "(境界): 「お餅」6つで上昇率が頭打ちになる（最大6つまで＝攻撃力18%・防御力36%）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_NEWYEAR_AS1" },
    board: { subject: { markers: [{ markerId: MOCHI, stackCount: 6 }] } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_DEF_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_HEAL_BLOCK",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_HEAL_BLOCK", targets: ["enemy:left"] },
        {
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_HEAL_SELF",
          targets: ["ally:subject"],
        },
      ],
      // 攻撃力バフ後の1000×1.18から1ヒット265（(1180-500)×39%）×3ヒット。
      hpDeltas: {
        "ally:subject": 397,
        "enemy:front": -795,
        "enemy:left": -795,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_ATK_UP",
          magnitude: 0.18,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_TARGET" },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_DEF_UP",
          magnitude: 0.36,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_TARGET" },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_HEAL_BLOCK",
          magnitude: -1,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS1_HEAL_BLOCK",
          magnitude: -1,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_CHIYURU_NEWYEAR_AS1", remaining: 99 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_NEWYEAR_AS1",
    intent: "(不成立): このスキルは戦闘中に1度しか発動できない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_NEWYEAR_AS1" },
    board: AS1_ON_COOLDOWN,
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_NEWYEAR_AS2",
    intent: "敵単体に威力148.4で攻撃し、1行動の間攻撃力を5%低下させる（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_NEWYEAR_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS2_ATK_DOWN", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -742,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_AS2_ATK_DOWN",
          magnitude: -0.05,
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
    skillDefinitionId: "SKL_CHIYURU_NEWYEAR_PS1",
    intent:
      "敵または他の味方が倒された際に発動。自身のHPを最大HP×15%回復し、戦闘終了まで自身の最大HPを5%上昇させる（重複可）（解除不可）。さらにスキル「除災招福」のクールタイムをリセットして再び使用できるようにし、自身に「お餅」を1つ付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIYURU_NEWYEAR_PS1",
      trigger: unitDefeated({ unit: "enemy:left", defeatedBy: "ally:subject" }),
      triggeredBy: "ally:subject",
    },
    board: AS1_ON_COOLDOWN,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_PS1_HEAL", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_PS1_MAX_HP_UP",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_PS1_CD_RESET", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_PS1_MOCHI", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "ally:subject": 1500,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_PS1_MAX_HP_UP",
          magnitude: 0.05,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: MOCHI, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_CHIYURU_NEWYEAR_AS1", remaining: 0 },
        { unitId: "ally:subject", skillDefinitionId: "SKL_CHIYURU_NEWYEAR_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_NEWYEAR_PS2",
    intent:
      "累計で最大HP×40%のダメージを受けるたびに発動。自身に対し、最大HP×20%のシールドを付与する。シールドは2行動後に消滅する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIYURU_NEWYEAR_PS2",
      trigger: CUMULATIVE_THRESHOLD_HIT,
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_PS2_SHIELD", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_CHIYURU_NEWYEAR_PS2_SHIELD",
          magnitude: 2000,
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
    skillDefinitionId: "SKL_CHIYURU_NEWYEAR_PS2",
    intent: "(不成立): 累計が最大HP×40%に達していないダメージでは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIYURU_NEWYEAR_PS2",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:subject",
        skillType: "AS",
        power: 4,
      }),
    },
    expected: {
      activated: false,
    },
  },
];

describe("production Catalog UNIT_CHIYURU_NEWYEAR (【新春のメイズ研究者】月ヶ瀬ちゆる)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-CHIYURU-NEWYEAR-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-CHIYURU-NEWYEAR-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-CHIYURU-NEWYEAR-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-CHIYURU-NEWYEAR-004 (R-EFF-11): PS2 の累計ダメージ閾値counterは、閾値に届かない被弾では carry だけを動かし、実 catalog/ の trigger 条件がその RuntimeCounterChanged を valueChanged で弾く。ちょうど閾値・閾値2つぶんの被弾では公開値が動き、条件が成立する", () => {
    // `RuntimeCounterChanged` は carry だけが動いた被弾でも追跡のために発行される
    // （`14_Catalog定義スキーマ.md`「counterUpdates」）。条件側で判別できないと、
    // 閾値に達していない被弾のたびにPSが発動してしまう。
    expect(
      observeCumulativeThresholdCounter(snapshot, UNIT_DEFINITION_ID, "SKL_CHIYURU_NEWYEAR_PS2"),
    ).toEqual({
      declaration: {
        counter: "SKL_CHIYURU_NEWYEAR_PS2_THRESHOLD_COUNT",
        scope: "SKILL_RUNTIME",
        maxHpRatio: 0.4,
      },
      triggerEventType: "RuntimeCounterChanged",
      subThreshold: {
        changes: [
          {
            skillDefinitionId: "SKL_CHIYURU_NEWYEAR_PS2",
            counter: "SKL_CHIYURU_NEWYEAR_PS2_THRESHOLD_COUNT",
            before: 0,
            after: 0,
            valueChanged: false,
          },
        ],
        triggerMatched: false,
      },
      atThreshold: {
        changes: [
          {
            skillDefinitionId: "SKL_CHIYURU_NEWYEAR_PS2",
            counter: "SKL_CHIYURU_NEWYEAR_PS2_THRESHOLD_COUNT",
            before: 0,
            after: 1,
            valueChanged: true,
          },
        ],
        triggerMatched: true,
      },
      crossing: {
        changes: [
          {
            skillDefinitionId: "SKL_CHIYURU_NEWYEAR_PS2",
            counter: "SKL_CHIYURU_NEWYEAR_PS2_THRESHOLD_COUNT",
            before: 0,
            after: 2,
            valueChanged: true,
          },
        ],
        triggerMatched: true,
      },
    });
  });

  it("IT-UNIT-CHIYURU-NEWYEAR-005 (R-NUM-04): AS1の `MARKER_COUNT_SCALE`（`target: SKILL_SOURCE`）が評価した効果量は `AppliedEffect.magnitude` に留まらず実CombatStatへ届き、公開差分だけを当て直しても同じ効果量・同じ所持数へ復元できる", () => {
    // `-001` の各行は「所持数がいくつなら効果量がいくつか」（0・2・6）と、その
    // 効果量が乗った与ダメージまでを固定する。ここが引き受けるのは、評価結果が
    // **どこへ届いたか**の2点 — 実 `CombatStats` の再計算と、StateDelta だけを
    // 独立Reducerへ当てた復元である。どちらもスキル使用1回の観測の外にある。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, {
      subject: { markers: [{ markerId: MOCHI, stackCount: 4 }] },
    });
    // `SKL_CHIYURU_NEWYEAR_AS1` はクールタイム99ターンを持つため `cooldowns` まで
    // 射影に含める（`CooldownStarted` のStateDeltaがこれを復元する）。
    const snapshotOf = (units: readonly BattleUnit[]) =>
      initialSnapshotFor(units, { include: ["cooldowns", "effects", "markers"] });
    const initial = snapshotOf(board.units);
    const recorder = new EventRecorder(createBattleId("B_CHIYURU_MOCHI"));
    const result = resolveSkillUse(
      board.subject,
      skillFrom(snapshot, "SKL_CHIYURU_NEWYEAR_AS1"),
      "AS",
      "AS",
      board.units,
      board.definitions,
      new SequenceRandomSource(new Array<number>(32).fill(0.99)),
      recorder,
      1,
      1,
      createActionId("B_CHIYURU_MOCHI:action:1"),
      recorder.nextResolutionScopeId(),
    );

    // 「お餅」4つ＝攻撃力+12%・防御力+24%。R-NUM-02の整数化はダメージ側の責務で
    // CombatStat自体は丸めないため近似比較にする（`500 × 1.24` は倍精度で
    // 619.9999999999999になる）。
    const actor = result.units.find((unit) => unit.battleUnitId === "ally:subject")!;
    expect(actor.combatStats.attack).toBeCloseTo(1120, 10);
    expect(actor.combatStats.defense).toBeCloseTo(620, 10);

    const restored = reduceStateDeltas(
      initial,
      recorder
        .getEvents()
        .flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta])),
    );
    // 復元先は**スナップショット全体**で突き合わせる。個別のフィールドだけを見ると、
    // `CombatStatChanged` や `CooldownStarted` のStateDeltaが欠けても
    // 集約側の実測（上のCombatStat検証）が通ってしまい、公開差分の欠落を見逃す。
    expect(restored).toEqual(snapshotOf(result.units));

    // そのうえで、スケール済みの効果量と参照元の所持数が復元後も生きていることを
    // 名指しで残す（この`-005`が何を主張しているかを全体一致の中に埋もれさせない）。
    const restoredSubject = restored.units[createBattleUnitId("ally:subject")];
    expect(
      restoredSubject?.effects?.find(
        (effect) => effect.effectDefinitionId === "ACT_CHIYURU_NEWYEAR_AS1_ATK_UP",
      )?.magnitude,
    ).toBeCloseTo(0.12, 10);
    expect(
      restoredSubject?.effects?.find(
        (effect) => effect.effectDefinitionId === "ACT_CHIYURU_NEWYEAR_AS1_DEF_UP",
      )?.magnitude,
    ).toBeCloseTo(0.24, 10);
    // 参照元の所持数は攻撃では動かない（Formulaは読むだけで消費しない）。
    expect(restoredSubject?.markers?.find((marker) => marker.markerId === MOCHI)?.stackCount).toBe(
      4,
    );
  });
});
