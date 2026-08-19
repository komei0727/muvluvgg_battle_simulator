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
import { observeEffectExpiry } from "../../../testing/production-unit/effect-expiry.js";
import { observeLifecycleDamageProbe } from "../../../testing/production-unit/damage-probe.js";
import { observeCriticalCounterCycle } from "../../../testing/production-unit/runtime-counter.js";
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

/**
 * `UNIT_MAO_SUMMER_TEX`（【真夏の風紀委員長】大賀真桜・戦術演習版）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * このユニットは戦術演習の敵専用（`category: EXERCISE_ENEMY`、R-TEX-11）で、原文は
 * `raw/units/` のwiki転記ではなく**ゲーム内スクリーンショットからの転記**である。
 * `intent` はそのスクリーンショットの効果説明文で、転記が正しいかをレビューできる
 * 唯一の接点になる。プレイアブル版 `UNIT_MAO_SUMMER` との差分は、ステータスと
 * AS1の追加攻撃（閾値 HP30%→1.5%・ダメージ22.5%→1.125%・消費15%→0.75%）・
 * AS2の表記「大参事」→「大惨事」・PS2+の軽減（HP比例スケール→固定40%）と
 * 軽減／与ダメバフの解除不可化の3点である。
 *
 * 盤面は攻撃力1000・防御力500・現在HP5000/最大HP10000（`skill-behaviour.ts`）。
 * `SKILL_POWER` のダメージは `(1000 - 500) × power` の切り捨て、`CURRENT_HP_RATIO`
 * のダメージは防御力を差し引かない（R-DMG-01）。
 */

const UNIT_DEFINITION_ID = "UNIT_MAO_SUMMER_TEX";
const KAIHOUKAN = "MARKER_MAO_SUMMER_TEX_KAIHOUKAN";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** 「解放感」を所持している側の腕を引くための前提盤面。 */
const HOLDING_KAIHOUKAN = { subject: { markers: [{ markerId: KAIHOUKAN }] } };

/** PS1は「2回会心する度に」発動する。counterを1に置いて次の1回を2回目にする。 */
const PS1_COUNTER_AT_ONE = {
  subject: {
    state: {
      skillCounters: {
        [createSkillDefinitionId("SKL_MAO_SUMMER_TEX_PS1")]: {
          [createRuntimeCounterId("SKL_MAO_SUMMER_TEX_PS1_TRIGGER_COUNT")]: { value: 1, carry: 0 },
        },
      },
    },
  },
};

/** PS2は戦闘中1度しか発動しない。発動済みの状態をcounterで作る。 */
const PS2_ALREADY_ACTIVATED = {
  subject: {
    state: {
      skillCounters: {
        [createSkillDefinitionId("SKL_MAO_SUMMER_TEX_PS2")]: {
          [createRuntimeCounterId("SKL_MAO_SUMMER_TEX_PS2_ACTIVATIONS")]: { value: 1, carry: 0 },
        },
      },
    },
  },
};

/** (SKL_ID, スクリーンショット原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_MAO_SUMMER_TEX_EX",
    intent:
      "自身に対し、2行動の「解放感」を付与する。「解放感」の効果期間中、自身の攻撃力が15%・与ダメージが10%上昇する（重複可）が、同時に自身が得られるEXゲージが-100%される状態になる。さらに自身に対し、2行動の間5ヒットまで致死ダメージをHP1で耐えるバフを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAO_SUMMER_TEX_EX" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_EX_MARKER_KAIHOUKAN",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_EX_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_EX_DMG_UP", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_EX_EX_GAIN_DOWN",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_EX_DEATH_SURVIVAL",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_EX_ATK_UP",
          magnitude: 0.15,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_EX_DMG_UP",
          magnitude: 0.1,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_EX_EX_GAIN_DOWN",
          magnitude: -1,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_EX_DEATH_SURVIVAL",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2 },
          consumption: { kind: "LETHAL_DAMAGE", maxCount: 5 },
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: KAIHOUKAN, stackCount: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_MAO_SUMMER_TEX_AS1",
    intent:
      "敵横一列に威力106でEN攻撃する。攻撃時点で自身のHPが1.5%以上だった場合、自身の現在HPの0.75%を消費し、消費分HP×150%のENダメージを与える攻撃を追加で行う",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAO_SUMMER_TEX_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_AS1_HP_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_AS1_HP_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_AS1_HP_COST", targets: ["ally:subject"] },
      ],
      // 本体は(1000-500)×1.06=530。追撃は現在HP5000の1.125%＝56.25→56で、
      // 消費（0.75%＝37.5）×150%と等価になるようダメージを先・コストを後に並べてある。
      hpDeltas: {
        "enemy:front": -586,
        "enemy:left": -586,
        "ally:subject": -38,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MAO_SUMMER_TEX_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAO_SUMMER_TEX_AS1",
    intent: "自身が「解放感」を所持していた場合、威力は116.6に変化する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAO_SUMMER_TEX_AS1" },
    board: HOLDING_KAIHOUKAN,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_AS1_DAMAGE_BOOSTED",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_AS1_DAMAGE_BOOSTED",
          targets: ["enemy:left"],
        },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_AS1_HP_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_AS1_HP_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_AS1_HP_COST", targets: ["ally:subject"] },
      ],
      // 本体は(1000-500)×1.166=583。追撃分56は威力の変化を受けない。
      hpDeltas: {
        "enemy:front": -639,
        "enemy:left": -639,
        "ally:subject": -38,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MAO_SUMMER_TEX_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAO_SUMMER_TEX_AS1",
    intent: "(HP1.5%未満): 追加攻撃とHP消費のどちらも行わず、本体の横一列攻撃だけを行う",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAO_SUMMER_TEX_AS1" },
    // 閾値がプレイアブル版の20分の1になったため、非成立側は最大HP10000の1.5%
    // （150）を1だけ下回る現在HPでしか作れない。
    board: { subject: { state: { currentHp: 149 } } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_AS1_DAMAGE", targets: ["enemy:left"] },
      ],
      hpDeltas: { "enemy:front": -530, "enemy:left": -530 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MAO_SUMMER_TEX_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAO_SUMMER_TEX_AS2",
    intent: "敵3体に威力127.2でEN攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAO_SUMMER_TEX_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_AS2_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_AS2_DAMAGE", targets: ["enemy:back"] },
      ],
      hpDeltas: { "enemy:front": -636, "enemy:left": -636, "enemy:back": -636 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAO_SUMMER_TEX_AS2",
    intent: "自身が「解放感」を所持していた場合、さらに1行動の気絶を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAO_SUMMER_TEX_AS2" },
    board: HOLDING_KAIHOUKAN,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_AS2_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_AS2_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_AS2_STUN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_AS2_STUN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_AS2_STUN", targets: ["enemy:back"] },
      ],
      hpDeltas: { "enemy:front": -636, "enemy:left": -636, "enemy:back": -636 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_AS2_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_AS2_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_AS2_STUN",
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
    skillDefinitionId: "SKL_MAO_SUMMER_TEX_PS1",
    intent:
      "自身の攻撃が2回会心攻撃になるたびに発動。自身が「解放感」を所持していない場合、自身のEXゲージを1加算する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MAO_SUMMER_TEX_PS1",
      trigger: criticalCheckResolved({
        source: "ally:subject",
        target: "enemy:front",
        result: true,
      }),
      triggeredBy: "ally:subject",
    },
    board: PS1_COUNTER_AT_ONE,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_PS1_EX_GAIN", targets: ["ally:subject"] },
      ],
      // PS使用のPP消費で+1（R-ACT-03）、スキル自身のEX加算で+1。
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAO_SUMMER_TEX_PS1",
    intent:
      "自身が「解放感」を所持している場合、自身の会心率を2.5%（重複可）、会心ダメージを8.75%上昇させる（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MAO_SUMMER_TEX_PS1",
      trigger: criticalCheckResolved({
        source: "ally:subject",
        target: "enemy:front",
        result: true,
      }),
      triggeredBy: "ally:subject",
    },
    board: {
      subject: { ...HOLDING_KAIHOUKAN.subject, ...PS1_COUNTER_AT_ONE.subject },
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_PS1_CRIT_RATE_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_PS1_CRIT_DAMAGE_UP",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_PS1_CRIT_RATE_UP",
          magnitude: 0.025,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_PS1_CRIT_DAMAGE_UP",
          magnitude: 0.0875,
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
    skillDefinitionId: "SKL_MAO_SUMMER_TEX_PS1",
    intent: "(不成立): 1回目の会心では発動しない（「2回会心攻撃になるたびに」に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MAO_SUMMER_TEX_PS1",
      trigger: criticalCheckResolved({
        source: "ally:subject",
        target: "enemy:front",
        result: true,
      }),
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_MAO_SUMMER_TEX_PS2",
    intent:
      "ターン開始時に発動。現在HPの30%を消費し、自身に対し被ダメージを40%減少させる効果を付与する（重複可・解除不可）。さらに自身に対し、自身よりHP割合の高い敵に対する攻撃の与ダメージが10%増加するバフを付与する（重複可・解除不可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MAO_SUMMER_TEX_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_PS2_HP_COST", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_PS2_DMG_DOWN", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_PS2_DMG_UP", targets: ["ally:subject"] },
      ],
      // 現在HP5000の30%＝1500を消費する。軽減率は消費後のHPを見ない固定値
      // （プレイアブル版のHP比例スケールとの差分点）。
      hpDeltas: { "ally:subject": -1500 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_PS2_DMG_DOWN",
          magnitude: -0.4,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_PS2_DMG_UP",
          magnitude: 0.1,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAO_SUMMER_TEX_PS2",
    intent: "(不成立): このスキルは戦闘中に1度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MAO_SUMMER_TEX_PS2",
      trigger: turnStarted({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
    },
    board: PS2_ALREADY_ACTIVATED,
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_MAO_SUMMER_TEX (【真夏の風紀委員長】大賀真桜・戦術演習版)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-MAO-SUMMER-TEX-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-MAO-SUMMER-TEX-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-MAO-SUMMER-TEX-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-MAO-SUMMER-TEX-004 (R-EFF-09): EXの「解放感」マーカーはPARENTで、攻撃力・与ダメージ・EX獲得の3バフはマーカーが先に切れると巻き添えで失効する", () => {
    // `-001` のEX行は付与そのもの（4件とも2行動）までを固定する。同じ期間なので、
    // EXの1回だけを見ていると4件が揃って `TIME_LIMIT` で落ち、連動が無くても
    // 同じ結果になる。親が**子より先に**切れる状況を作って初めて区別できるため、
    // マーカーを1行動ぶん先に進めてから子3件を付け直す。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const marked = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_EX_MARKER_KAIHOUKAN", target: "SELF" },
    ]);
    const aged = observeEffectExpiry({
      units: marked,
      definitions: board.definitions,
      steps: [{ kind: "ACTION_END", actor: "ally:subject" }],
    });
    const granted = applyPrecedingActions({ ...board, units: aged.units }, [
      { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_EX_ATK_UP", target: "SELF" },
      { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_EX_DMG_UP", target: "SELF" },
      { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_EX_EX_GAIN_DOWN", target: "SELF" },
    ]);
    // 攻撃力15%上昇が乗った状態（1000 → 1150）。
    expect(granted.find((unit) => unit.battleUnitId === "ally:subject")!.combatStats.attack).toBe(
      1150,
    );

    const cascaded = observeEffectExpiry({
      units: granted,
      definitions: board.definitions,
      steps: [{ kind: "ACTION_END", actor: "ally:subject" }],
      watch: [{ unitId: "ally:subject", stat: "attack" }],
    });

    // 子3件はまだ1行動を残しているが、親（マーカー）の時間切れに巻き添えで落ちる。
    expect(cascaded.steps.at(-1)).toEqual({
      step: "ACTION_END(ally:subject)",
      remaining: {},
      expired: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_EX_ATK_UP",
          reason: "LINKED_GROUP_CASCADE",
          cascaded: true,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_EX_DMG_UP",
          reason: "LINKED_GROUP_CASCADE",
          cascaded: true,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_EX_EX_GAIN_DOWN",
          reason: "LINKED_GROUP_CASCADE",
          cascaded: true,
        },
      ],
      // 攻撃力15%上昇（1150）が巻き戻る。
      stats: { "ally:subject/attack": 1000 },
    });
    // 親自身も同じ行動終了で消えている（`MarkerState` は `appliedEffects` とは
    // 別に持たれるため、上の `expired`／`remaining` には現れない）。
    const after = cascaded.units.find((unit) => unit.battleUnitId === "ally:subject")!;
    expect(after.markerStates).toEqual([]);
    expect(after.appliedEffects).toEqual([]);
  });

  it("IT-UNIT-MAO-SUMMER-TEX-005 (R-INT-01): EXの致死耐えは5ヒットまでHP1で耐え、6ヒット目は耐えない", () => {
    // `-001` のEX行は `consumption {LETHAL_DAMAGE, maxCount: 5}` の宣言までを
    // 固定する。宣言だけでは「何回耐えるか」は実致死ダメージを通してしか現れない。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    let units = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_EX_DEATH_SURVIVAL", target: "SELF" },
    ]);

    const lethal = (current: readonly (typeof units)[number][]) =>
      observeLifecycleDamageProbe({
        definitions: board.definitions,
        units: current,
        attackerUnitId: "enemy:front",
        targetUnitId: "ally:subject",
        // (1000-500)×40＝20000 は最大HP10000を超える確実な致死。
        power: 40,
        battleId: "B_MAO_TEX_SURVIVAL",
      });

    const survivedHp: number[] = [];
    for (let hit = 0; hit < 5; hit += 1) {
      const observed = lethal(units);
      units = observed.units;
      survivedHp.push(units.find((unit) => unit.battleUnitId === "ally:subject")!.currentHp);
      // 耐えるたびにHPは1へ戻るので、次のヒットも致死になる。
      units = units.map((unit) =>
        unit.battleUnitId === "ally:subject" ? { ...unit, currentHp: 5000 } : unit,
      );
    }
    expect(survivedHp).toEqual([1, 1, 1, 1, 1]);

    // 6ヒット目は残数が尽きているため耐えない。
    const sixth = lethal(units);
    expect(sixth.units.find((unit) => unit.battleUnitId === "ally:subject")!.currentHp).toBe(0);
  });

  it("IT-UNIT-MAO-SUMMER-TEX-006 (R-DMG-05): PS2+の軽減は付与時のHPに依らず常に40%で、`dispellable: false` によりバフ解除でも落ちない", () => {
    // プレイアブル版はHP比例スケール（`HP_RATIO_SCALE` + `CLAMP`）だったため、
    // 別のHPで観測すると軽減率が変わった。TEX版の `CONSTANT -0.4` はそこが
    // 差分点なので、HPを変えて**変わらないこと**を見る。
    const magnitudeAt = (currentHp: number): number | undefined =>
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use: {
          kind: "PASSIVE",
          skillDefinitionId: "SKL_MAO_SUMMER_TEX_PS2",
          trigger: turnStarted({ turnNumber: 1 }),
          triggeredBy: "ally:subject",
        },
        board: { subject: { state: { currentHp } } },
      }).effectsApplied?.find(
        (effect) => effect.effectActionDefinitionId === "ACT_MAO_SUMMER_TEX_PS2_DMG_DOWN",
      )?.magnitude;

    expect(magnitudeAt(10000)).toBe(-0.4);
    expect(magnitudeAt(5000)).toBe(-0.4);
    expect(magnitudeAt(1000)).toBe(-0.4);

    // 「解除不可」は付与後の解除系がこの2件を落とさないこととして現れる。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const granted = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_PS2_DMG_DOWN", target: "SELF" },
      { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_PS2_DMG_UP", target: "SELF" },
    ]);
    expect(
      granted
        .find((unit) => unit.battleUnitId === "ally:subject")!
        .appliedEffects.map((effect) => ({
          effectActionDefinitionId: effect.effectActionDefinitionId,
          dispellable: effect.duration.definition.dispellable,
        })),
    ).toEqual([
      { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_PS2_DMG_DOWN", dispellable: false },
      { effectActionDefinitionId: "ACT_MAO_SUMMER_TEX_PS2_DMG_UP", dispellable: false },
    ]);
  });

  it("IT-UNIT-MAO-SUMMER-TEX-007 (R-EFF-11 RESET, Issue #554): PS1の会心カウンタは、2到達がそのスキル最後の会心でなくても発動し、発動時に0へ戻る。到達後の余剰会心は次回へ繰り越さない", () => {
    // 実挙動: 会心が1ヒット出るたびに加算 → N到達で発動を予約 → スキルの全効果処理
    // 完了後にカウンタを0へ戻す → PSを実行。AS2は敵3体を1回ずつ殴るため、全会心なら
    // 2到達は2体目（＝そのスキル最後の会心ではない）になる。
    const cycle = observeCriticalCounterCycle({
      snapshot,
      unitDefinitionId: UNIT_DEFINITION_ID,
      passiveSkillDefinitionId: "SKL_MAO_SUMMER_TEX_PS1",
      counter: "SKL_MAO_SUMMER_TEX_PS1_TRIGGER_COUNT",
      uses: [
        { skillDefinitionId: "SKL_MAO_SUMMER_TEX_AS2" },
        { skillDefinitionId: "SKL_MAO_SUMMER_TEX_AS2" },
      ],
    });

    expect(cycle).toEqual([
      // 3会心（カウンタ1,2,3）で発動は1回だけ（R-PS-07）。3会心目の余剰は繰り越さず
      // カウンタは0へ戻る（旧`modulo`モデルなら3が残り、次は1会心で発動していた）。
      { criticalHits: 3, activations: 1, counterAfter: 0 },
      { criticalHits: 3, activations: 1, counterAfter: 0 },
    ]);
  });
});
