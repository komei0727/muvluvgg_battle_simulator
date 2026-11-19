import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
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
  type BoardOverrides,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  passiveResolved,
  realDamage,
  skillUseCompleted,
} from "../../../testing/production-unit/trigger-events.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import { resolveSkillUse } from "../../../domain/battle/resolution/action-skill-use-resolver.js";
import { EventRecorder } from "../../../domain/battle/events/event-recorder.js";
import { createSkillDefinitionId } from "../../../domain/catalog/definitions/catalog-ids.js";
import { createActionId } from "../../../domain/shared/event-ids.js";
import { createBattleId } from "../../../domain/shared/ids.js";

/**
 * `UNIT_ROSIE_ARTIST`（【空想造形アーティスト】ロージー・ヒューズ）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_ROSIE_ARTIST";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** PS2の `UNIT_TYPE` 別適用を作り分ける盤面（既定のスタンドインは物理タイプ）。 */
const ENERGY_TYPE_ALLY: BoardOverrides = {
  allies: [
    { id: "ally:front", position: { column: "LEFT", row: "FRONT" }, unitType: "ENERGY" },
    { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
  ],
};

/**
 * 敵を満タンで置く盤面。既定のHP半分では自分の攻撃だけでHP割合が50%を割り、
 * PS1（「敵のHPが50%以下になった際」）とそれが誘発するPS3の連鎖が毎行混ざって
 * 「そのスキルが何をしたか」が読めなくなる。連鎖自体はPS1・PS3の行で検証する。
 */
const FULL_HEALTH_ENEMIES: BoardOverrides = {
  enemies: [
    {
      id: "enemy:front",
      position: { column: "CENTER", row: "FRONT" },
      state: { currentHp: 10000 },
    },
    { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, state: { currentHp: 10000 } },
    { id: "enemy:back", position: { column: "CENTER", row: "BACK" }, state: { currentHp: 10000 } },
  ],
};

/** 会心判定を必ず当たり側へ倒す抽選列。 */
function critical(): SequenceRandomSource {
  return new SequenceRandomSource(new Array<number>(64).fill(0));
}

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_EX",
    intent:
      "敵全体に威力93.6で攻撃する。生存中の敵の数が多いほどダメージが増加する（+100%まで）。さらに自身に一度だけ被ダメージを75%減少させる効果を付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ROSIE_ARTIST_EX" },
    board: FULL_HEALTH_ENEMIES,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DMG_DOWN", targets: ["ally:subject"] },
      ],
      // 468 に、倍率1＋min(生存敵数3／戦闘開始時の敵数3, 1)＝2 が乗る。
      hpDeltas: {
        "enemy:front": -936,
        "enemy:left": -936,
        "enemy:back": -936,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DMG_DOWN",
          magnitude: -0.75,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_EX",
    intent:
      "(境界): 同じ攻撃の途中で敵を撃破すると生存敵数を数え直す — 最初の敵を撃破した後の2体は倍率1＋2/3で各780",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ROSIE_ARTIST_EX" },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 936 },
        },
        {
          id: "enemy:left",
          position: { column: "LEFT", row: "FRONT" },
          state: { currentHp: 10000 },
        },
        {
          id: "enemy:back",
          position: { column: "CENTER", row: "BACK" },
          state: { currentHp: 10000 },
        },
      ],
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DMG_DOWN", targets: ["ally:subject"] },
        // 撃破でPS1（敵撃破時の与ダメージ上昇）が連鎖する。
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS1_DMG_UP", targets: ["ally:subject"] },
      ],
      // 468×(1＋2/3)は浮動小数で779.999…となり、R-NUM-02の切り捨てで779になる。
      hpDeltas: {
        "enemy:front": -936,
        "enemy:left": -779,
        "enemy:back": -779,
      },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DMG_DOWN",
          magnitude: -0.75,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS1_DMG_UP",
          magnitude: 0.5,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_ROSIE_ARTIST_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_EX",
    intent:
      "(境界): 基準は戦闘開始時の敵数 — 開始時から敵が1体だけなら、その1体の生存で上限の倍率2になる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ROSIE_ARTIST_EX" },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 10000 },
        },
      ],
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DMG_DOWN", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "enemy:front": -936,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DMG_DOWN",
          magnitude: -0.75,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_EX",
    intent:
      "(境界): 戦闘開始時の6体のうち1体が既に倒れていれば、生存5体で倍率1＋5/6（468×11/6＝858）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ROSIE_ARTIST_EX" },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 10000 },
        },
        {
          id: "enemy:left",
          position: { column: "LEFT", row: "FRONT" },
          state: { currentHp: 10000 },
        },
        { id: "enemy:right", position: { column: "RIGHT", row: "FRONT" }, state: { currentHp: 0 } },
        {
          id: "enemy:back",
          position: { column: "CENTER", row: "BACK" },
          state: { currentHp: 10000 },
        },
        {
          id: "enemy:backleft",
          position: { column: "LEFT", row: "BACK" },
          state: { currentHp: 10000 },
        },
        {
          id: "enemy:backright",
          position: { column: "RIGHT", row: "BACK" },
          state: { currentHp: 10000 },
        },
      ],
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DAMAGE", targets: ["enemy:backleft"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DAMAGE", targets: ["enemy:backright"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DMG_DOWN", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "enemy:front": -858,
        "enemy:left": -858,
        "enemy:back": -858,
        "enemy:backleft": -858,
        "enemy:backright": -858,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DMG_DOWN",
          magnitude: -0.75,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_AS1",
    intent: "敵横一列に威力117で攻撃する（会心なし: 追撃の腕へ進まない）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ROSIE_ARTIST_AS1" },
    board: FULL_HEALTH_ENEMIES,
    expected: {
      // PS2（「自身がアクティブスキルで攻撃した後に発動」）はAS完了そのものを契機に
      // 持つため、AS 1回の観測には必ずPS2の連鎖が含まれる。
      actions: [
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DAMAGE", targets: ["enemy:left"] },
        {
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          targets: ["ally:back"],
        },
        // PS3は「自身以外の味方のPSを自身が受けたとき」だけ発動するため、自身のPS2の
        // 解決からは連鎖しない（SR-130）。
      ],
      hpDeltas: {
        "enemy:front": -585,
        "enemy:left": -585,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          magnitude: 0.6,
          timeLimit: { unit: "ACTION", count: 5 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          magnitude: 0.6,
          timeLimit: { unit: "ACTION", count: 5 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          magnitude: 0.6,
          timeLimit: { unit: "ACTION", count: 5 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_ROSIE_ARTIST_PS2", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_AS1",
    intent:
      "会心攻撃が発生した場合、敵横一列に対して追加で威力39の攻撃を行い、自身の次の攻撃の与ダメージが25%増加するバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ROSIE_ARTIST_AS1" },
    board: { ...ENERGY_TYPE_ALLY, ...FULL_HEALTH_ENEMIES, combatStats: { criticalRate: 1 } },
    random: critical,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DAMAGE_CRIT", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DAMAGE_CRIT", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DMG_UP", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          targets: ["ally:back"],
        },
      ],
      // 会心2ヒット 877 + 292（会心倍率1.5）。自身のPS2からPS3は連鎖しないため、
      // `ACT_ROSIE_ARTIST_AS1_DMG_UP`（次の攻撃+25%）は消費されずに残る。
      hpDeltas: {
        "enemy:front": -1169,
        "enemy:left": -1169,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DMG_UP",
          magnitude: 0.25,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          magnitude: 0.6,
          timeLimit: { unit: "ACTION", count: 5 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP",
          magnitude: 0.3,
          timeLimit: { unit: "ACTION", count: 5 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          magnitude: 0.6,
          timeLimit: { unit: "ACTION", count: 5 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_ROSIE_ARTIST_PS2", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_PS1",
    intent:
      "敵のHPが50%以下になった際に発動。自身の次の攻撃の与ダメージが50%増加するバフを付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_ARTIST_PS1",
      trigger: realDamage({ from: "ally:front", to: "enemy:front", skillType: "AS" }),
      triggeredBy: "ally:front",
    },
    expected: {
      // 自身のPS1の解決ではPS3が連鎖しないため（SR-038）、付けた与ダメージ増加バフ
      // （次の攻撃1回）は消費されずに残る。
      actions: [
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS1_DMG_UP", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS1_DMG_UP",
          magnitude: 0.5,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_ROSIE_ARTIST_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_PS1",
    intent: "(不成立): 敵のHPが50%より多く残っていれば発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_ARTIST_PS1",
      trigger: realDamage({ from: "ally:front", to: "enemy:front", skillType: "AS" }),
      triggeredBy: "ally:front",
    },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 10000 },
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_PS2",
    intent:
      "自身がアクティブスキルで攻撃した後に発動。味方全体にHP回復量を5行動の間30%上昇させるバフを付与する（重複可）。物理タイプの味方の場合、バフ効果が2倍になる",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_ARTIST_PS2",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:subject",
    },
    board: ENERGY_TYPE_ALLY,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP", targets: ["ally:front"] },
        {
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          targets: ["ally:back"],
        },
        // 自身のPS2の解決からPS3は連鎖しない（SR-130）。
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          magnitude: 0.6,
          timeLimit: { unit: "ACTION", count: 5 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP",
          magnitude: 0.3,
          timeLimit: { unit: "ACTION", count: 5 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          magnitude: 0.6,
          timeLimit: { unit: "ACTION", count: 5 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_ROSIE_ARTIST_PS2", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_PS2",
    intent: "(不成立): EXスキルの完了では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_ARTIST_PS2",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "EX",
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_PS3",
    intent:
      "自身が他の味方からパッシブスキルを受けた後に発動。自身に最も近い敵単体に威力43.75で1回攻撃し、自身のEXゲージを1加算する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_ARTIST_PS3",
      // 他の味方の味方全体PSは、本人もそのPSを受けている。
      trigger: passiveResolved({
        actor: "ally:front",
        skillDefinitionId: "SKL_ROSIE_ARTIST_PS2",
        receivedBy: ["ally:subject", "ally:front", "ally:back"],
      }),
      triggeredBy: "ally:front",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS3_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS3_EX_UP", targets: ["ally:subject"] },
        // 追撃で敵前列がHP50%以下になり、PS3の効果処理完了後にPS1が発動する（R-ATM-01）。
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS1_DMG_UP", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "enemy:front": -218,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS1_DMG_UP",
          magnitude: 0.5,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 3 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_ROSIE_ARTIST_PS3", remaining: 1 },
        { unitId: "ally:subject", skillDefinitionId: "SKL_ROSIE_ARTIST_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_PS3",
    intent: "(不成立): 自身のPS1（自身への付与）の解決では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_ARTIST_PS3",
      trigger: passiveResolved({
        actor: "ally:subject",
        skillDefinitionId: "SKL_ROSIE_ARTIST_PS1",
        receivedBy: ["ally:subject"],
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_PS3",
    intent: "(不成立): 自身のPS2（自身を含む味方全体への付与）の解決でも、自身のPSなので発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_ARTIST_PS3",
      trigger: passiveResolved({
        actor: "ally:subject",
        skillDefinitionId: "SKL_ROSIE_ARTIST_PS2",
        receivedBy: ["ally:subject", "ally:front", "ally:back"],
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_PS3",
    intent: "(不成立): 他の味方の自己バフPSは自身が受けていないので発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_ARTIST_PS3",
      trigger: passiveResolved({
        actor: "ally:front",
        skillDefinitionId: "SKL_ROSIE_ARTIST_PS1",
        receivedBy: ["ally:front"],
      }),
      triggeredBy: "ally:front",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_PS3",
    intent: "(不成立): 他の味方のPSが自身以外の対象だけへ向かった場合は発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_ARTIST_PS3",
      trigger: passiveResolved({
        actor: "ally:front",
        skillDefinitionId: "SKL_ROSIE_ARTIST_PS2",
        receivedBy: ["ally:front", "ally:back"],
      }),
      triggeredBy: "ally:front",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_PS3",
    intent: "(不成立): 敵のパッシブスキル解決では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_ARTIST_PS3",
      trigger: passiveResolved({
        actor: "enemy:front",
        skillDefinitionId: "SKL_ROSIE_ARTIST_PS2",
      }),
    },
    expected: {
      activated: false,
    },
  },
];

describe("production Catalog UNIT_ROSIE_ARTIST (【空想造形アーティスト】ロージー・ヒューズ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-ROSIE-ARTIST-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-ROSIE-ARTIST-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-ROSIE-ARTIST-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-ROSIE-ARTIST-004 [R-SKL-08] (R-SKL-08): AS1の会心分岐が読む `LAST_RESULT.criticalHitCount` は直前のACTION step全体のスコープを持つ — 横一列2体のうち1体だけが会心した回でも、追撃は2体ともへ入る", () => {
    // `-001` の会心行は会心率を0/1へ倒して表を決定的にするため、step内の全ヒットが
    // 揃って会心するか揃って非会心かのどちらかにしかならず、「最後に処理した対象1体が
    // 会心したか」との違いが差として現れない。会心率を0.5に置き、抽選列で1発目だけを
    // 非会心・2発目だけを会心へ倒すと、この2つの読み方が初めて分かれる。
    const partialCritical = () =>
      new SequenceRandomSource([0.99, 0, ...new Array<number>(62).fill(0.99)]);

    expect(
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use: { kind: "ACTIVE", skillDefinitionId: "SKL_ROSIE_ARTIST_AS1" },
        board: { ...FULL_HEALTH_ENEMIES, combatStats: { criticalRate: 0.5 } },
        random: partialCritical(),
      }),
    ).toEqual({
      actions: [
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DAMAGE", targets: ["enemy:left"] },
        // 会心したのは enemy:left の1発だけだが、追撃は横一列の2体ともへ入る。
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DAMAGE_CRIT", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DAMAGE_CRIT", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DMG_UP", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          targets: ["ally:back"],
        },
      ],
      // enemy:front は非会心の585 + 追撃195。enemy:left は会心の877（会心倍率1.5）+ 追撃195。
      // 自身のPS2からPS3は連鎖しないため、`ACT_ROSIE_ARTIST_AS1_DMG_UP`は残る。
      hpDeltas: {
        "enemy:front": -780,
        "enemy:left": -1072,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DMG_UP",
          magnitude: 0.25,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          magnitude: 0.6,
          timeLimit: { unit: "ACTION", count: 5 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          magnitude: 0.6,
          timeLimit: { unit: "ACTION", count: 5 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          magnitude: 0.6,
          timeLimit: { unit: "ACTION", count: 5 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_ROSIE_ARTIST_PS2", remaining: 2 },
      ],
    });

    // 対照: 会心率は同じ0.5のまま、どのヒットも会心しない抽選列では分岐が閉じたままで
    // 追撃も与ダメージバフも一切現れない（差は会心が出たか出ないかだけである）。
    const noCritical = observeSkillUse({
      snapshot,
      unitDefinitionId: UNIT_DEFINITION_ID,
      use: { kind: "ACTIVE", skillDefinitionId: "SKL_ROSIE_ARTIST_AS1" },
      board: { ...FULL_HEALTH_ENEMIES, combatStats: { criticalRate: 0.5 } },
      random: new SequenceRandomSource(new Array<number>(64).fill(0.99)),
    });
    expect(noCritical.actions?.map((action) => action.effectActionDefinitionId)).not.toContain(
      "ACT_ROSIE_ARTIST_AS1_DAMAGE_CRIT",
    );
    expect(noCritical.hpDeltas).toEqual({ "enemy:front": -585, "enemy:left": -585 });
  });

  it("IT-UNIT-ROSIE-ARTIST-005 [R-PS-01, R-PS-04]: 実際のPS2解決でも、それを受けた他の味方ロージーのPS3だけが発動し、PS2を使った本人のPS3は発動しない（SR-038・SR-048・SR-130）", () => {
    // 前列左の味方も同じロージーにし、本人のAS1→PS2（味方全体）を実経路で解決させる。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, {
      ...FULL_HEALTH_ENEMIES,
      allies: [
        {
          id: "ally:front",
          position: { column: "LEFT", row: "FRONT" },
          unitDefinitionId: UNIT_DEFINITION_ID,
        },
        { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
      ],
    });
    const recorder = new EventRecorder(createBattleId("B_ROSIE_RECEIVED"));
    resolveSkillUse(
      board.subject,
      board.definitions.skillDefinitions.get(createSkillDefinitionId("SKL_ROSIE_ARTIST_AS1"))!,
      "AS",
      "AS",
      board.units,
      board.definitions,
      new SequenceRandomSource(new Array<number>(64).fill(0.99)),
      recorder,
      1,
      0,
      createActionId("B_ROSIE_RECEIVED:action:1"),
      recorder.nextResolutionScopeId(),
    );

    const activations = recorder
      .getEvents()
      .flatMap((event) =>
        event.eventType === "PassiveActivated"
          ? [`${event.payload.actorUnitId}:${event.payload.skillDefinitionId}`]
          : [],
      );
    expect(activations).toEqual([
      "ally:subject:SKL_ROSIE_ARTIST_PS2",
      "ally:front:SKL_ROSIE_ARTIST_PS3",
    ]);
  });
});
