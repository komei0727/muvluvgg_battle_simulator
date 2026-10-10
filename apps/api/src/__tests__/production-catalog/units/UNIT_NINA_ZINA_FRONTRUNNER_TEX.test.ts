import { describe, expect, it } from "vitest";
import { findMarkersRemovedOnSourceDefeat } from "../../../domain/battle/resolution/marker-source-defeat-service.js";
import { removeMarkers } from "../../../domain/battle/effects/marker-removal-service.js";
import type { BattleUnit } from "../../../domain/battle/model/battle-unit.js";
import { observeEffectExpiry } from "../../../testing/production-unit/effect-expiry.js";
import { loadProductionSnapshot, seedRecorder, unitFrom } from "../../../testing/fixtures/index.js";
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
  type BoardOverrides,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  hitPointReduced,
  skillUseStarting,
} from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_NINA_ZINA_FRONTRUNNER_TEX`（破壊：ニーナ／ジーナ・ミーシナ・戦術演習版）の
 * ユニット単位production結合テスト（`12_テスト戦略.md`「ユニット効果軸」、Issue #749）。
 *
 * 戦術演習の敵専用（`category: EXERCISE_ENEMY`、R-TEX-11）で、原文はゲーム内
 * スクリーンショットからの転記。プレイアブル版 `UNIT_NINA_ZINA_FRONTRUNNER` との差分は
 * Lv200固定ステータスに加えて3点だけで、EX・AS2は威力・倍率ともに完全一致する。
 *
 * - AS1「断罪の時だ！」: HP50%以下時の継続回復が不足HPの25%→**1.25%**。被ダメージ・
 *   回復量を最大HP比で測る値はTEX版で1/20になる（`UNIT_HIIRO_FREEWOLF_TEX` PS1の
 *   15%→0.75%と同じ法則。自身の残HP割合のゲート50%は据え置き）
 * - PS1「終幕にはまだ早い！」: 同じ横一列の他の味方へも同効果を配る第2段落が消滅し、
 *   自身への2効果だけになる（演習の敵陣営は単騎のため配る相手が居ない。Q-TEX-01/12）
 * - PS2「我が雄姿を見よ！+」: 契機が「同じ横一列の**他の味方**がアクティブスキルで
 *   攻撃する前」から「**自身が**アクティブスキルで攻撃する前」へ（Q-TEX-12）。追撃の
 *   威力53・1行動の「刻痕」・前列ゲート・同時発動制限・クールタイム1行動は据え置き
 *
 * 契機が自身へ寄った結果、**自身のASが自身のPSを呼ぶ連鎖**が新たに発生する。AS1・AS2の
 * 行はいずれもPS2の発動（PP-1・クールタイム1・追撃の相乗り）を込みで観測する。EXは
 * `skillType EQ AS` で弾かれるため連鎖しない。
 *
 * 「刻痕」は寿命の違う2つのマーカーで表す — AS2の刻痕（`_SCAR`、付与者撃破まで）と
 * PS2の1行動の刻痕（`_SCAR_TEMP`）。所持数を問う3か所（AS1のヒット数・AS2の優先順と
 * 4つ以上の判定）はどちらも`markerIds`で両者を合算する。
 *
 * 盤面は攻撃力1000・防御力500・現在HP5000/最大HP10000（`skill-behaviour.ts`）。
 */

const UNIT_DEFINITION_ID = "UNIT_NINA_ZINA_FRONTRUNNER_TEX";
const SCAR = "MARKER_NINA_ZINA_FRONTRUNNER_TEX_SCAR";
const SCAR_TEMP = "MARKER_NINA_ZINA_FRONTRUNNER_TEX_SCAR_TEMP";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** AS1: 前列中央の敵が刻痕を合算3つ（AS2の2つ＋PS2の1つ）持つ盤面。 */
const SCARRED_FRONT_ENEMY: BoardOverrides = {
  enemies: [
    {
      id: "enemy:front",
      position: { column: "CENTER", row: "FRONT" },
      markers: [
        { markerId: SCAR, stackCount: 2 },
        { markerId: SCAR_TEMP, stackCount: 1 },
      ],
    },
    { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
    { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
  ],
};

/**
 * AS2: 刻痕の合算は前列中央1・前列左4（AS2の3＋PS2の1）・後列2。最も少ない前列中央が
 * 基点になり、同じ横一列（前列）の2体が攻撃対象になる。前列左は合算4つのため刻痕は
 * 新たに付与しない。
 */
const SCAR_RANKED_ENEMIES: BoardOverrides = {
  enemies: [
    {
      id: "enemy:front",
      position: { column: "CENTER", row: "FRONT" },
      markers: [{ markerId: SCAR, stackCount: 1 }],
    },
    {
      id: "enemy:left",
      position: { column: "LEFT", row: "FRONT" },
      markers: [
        { markerId: SCAR, stackCount: 3 },
        { markerId: SCAR_TEMP, stackCount: 1 },
      ],
    },
    {
      id: "enemy:back",
      position: { column: "CENTER", row: "BACK" },
      markers: [{ markerId: SCAR, stackCount: 2 }],
    },
  ],
};

/** AS2: 刻痕を持たない後列の敵が最も少なく、既定順で先頭の前列ではなく後列を狙う盤面。 */
const BACK_ENEMY_FEWEST_SCARS: BoardOverrides = {
  enemies: [
    {
      id: "enemy:front",
      position: { column: "CENTER", row: "FRONT" },
      markers: [{ markerId: SCAR, stackCount: 1 }],
    },
    {
      id: "enemy:left",
      position: { column: "LEFT", row: "FRONT" },
      markers: [{ markerId: SCAR_TEMP, stackCount: 1 }],
    },
    { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
  ],
};

/** 自身を後列へ置く盤面（PS2が「自身が前列のときだけ」発動することの不成立側）。 */
const SUBJECT_IN_BACK_ROW: BoardOverrides = {
  subject: { position: { column: "RIGHT", row: "BACK" } },
};

/**
 * PS2の追撃が命中した相手へ付く1行動の刻痕の低下2件（`onHitEffects`）。追撃は
 * EffectSequenceのステップではないため`actions`には現れず、結果だけが観測に載る。
 */
const scarTempEffects = (unitId: string) => [
  {
    unitId,
    effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_SCAR_TEMP_ATK_DOWN",
    magnitude: -0.08,
    timeLimit: { unit: "ACTION", count: 1 },
  },
  {
    unitId,
    effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_SCAR_TEMP_DMG_DOWN",
    magnitude: -0.05,
    timeLimit: { unit: "ACTION", count: 1 },
  },
];

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_EX",
    intent:
      "敵全体に威力212で攻撃し、自身が1回行動を終えるまでの間、攻撃力を20％低下させる。さらに自身が2回行動を終えるまでの間、新たに向けられる攻撃力バフを無効にするデバフを付与する。各デバフは自身が倒れると解除される。加えて自身のHPが50％以上だった場合、自身のAPを1加算する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_EX" },
    // HP 5000/10000 = ちょうど50%（以上を満たす）。AP加算が上限で消えないよう2から始める。
    board: { subject: { state: { currentAp: 2 } } },
    expected: {
      // (攻撃力1000 − 防御力500) × 2.12 = 1060。EXは`skillType EQ AS`で弾かれPS2を呼ばない。
      actions: [
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_DAMAGE",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_DAMAGE",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_DEBUFF_MARKER",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_DOWN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_BUFF_SEAL",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_DEBUFF_MARKER",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_DOWN",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_BUFF_SEAL",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_DEBUFF_MARKER",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_DOWN",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_BUFF_SEAL",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_AP_UP",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: { "enemy:front": -1060, "enemy:left": -1060, "enemy:back": -1060 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_BUFF_SEAL",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_BUFF_SEAL",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_BUFF_SEAL",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
      ],
      markers: [
        {
          unitId: "enemy:front",
          markerId: "MARKER_NINA_ZINA_FRONTRUNNER_TEX_EX_DEBUFF",
          stackCount: 1,
        },
        {
          unitId: "enemy:left",
          markerId: "MARKER_NINA_ZINA_FRONTRUNNER_TEX_EX_DEBUFF",
          stackCount: 1,
        },
        {
          unitId: "enemy:back",
          markerId: "MARKER_NINA_ZINA_FRONTRUNNER_TEX_EX_DEBUFF",
          stackCount: 1,
        },
      ],
      resources: [{ unitId: "ally:subject", resource: "AP", delta: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_EX",
    intent: "(分岐): 自身のHPが50％未満ならAPを加算しない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_EX" },
    board: { subject: { state: { currentAp: 2, currentHp: 4999 } } },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_DAMAGE",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_DAMAGE",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_DEBUFF_MARKER",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_DOWN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_BUFF_SEAL",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_DEBUFF_MARKER",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_DOWN",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_BUFF_SEAL",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_DEBUFF_MARKER",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_DOWN",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_BUFF_SEAL",
          targets: ["enemy:back"],
        },
      ],
      hpDeltas: { "enemy:front": -1060, "enemy:left": -1060, "enemy:back": -1060 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_BUFF_SEAL",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_BUFF_SEAL",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_BUFF_SEAL",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
      ],
      markers: [
        {
          unitId: "enemy:front",
          markerId: "MARKER_NINA_ZINA_FRONTRUNNER_TEX_EX_DEBUFF",
          stackCount: 1,
        },
        {
          unitId: "enemy:left",
          markerId: "MARKER_NINA_ZINA_FRONTRUNNER_TEX_EX_DEBUFF",
          stackCount: 1,
        },
        {
          unitId: "enemy:back",
          markerId: "MARKER_NINA_ZINA_FRONTRUNNER_TEX_EX_DEBUFF",
          stackCount: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_AS1",
    intent:
      "敵単体に威力70.2で1ヒット攻撃する。この攻撃は対象に付与されている「刻痕」1つにつき1ヒット追加される（9つまで）。さらに自身のHPが50％以下だった場合、自身に対し2行動の間、効果付与時の不足HPの1.25％を継続回復する効果を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_AS1" },
    board: SCARRED_FRONT_ENEMY,
    expected: {
      // PS2が自身のASの直前に発動し、威力53の追撃が相乗りする。
      // 本体: 刻痕は合算3つ → 1 + 3 = 4ヒット。1ヒット (1000 − 500) × 0.702 = 351 → 計1404。
      // 追撃: (1000 − 500) × 0.53 = 265。継続回復は付与時の不足HP 5000 × 1.25% = 62。
      actions: [
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_PS2_FOLLOW_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_AS1_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_AS1_REGEN",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: { "enemy:front": -1669 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_AS1_REGEN",
          magnitude: 62.5,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        ...scarTempEffects("enemy:front"),
      ],
      // 追加ヒットを数えるのは本体の解決時点なので、追撃が置いていく1行動の刻痕
      // （1 → 2段）は同じ攻撃のヒット数へは反映されない。
      markers: [{ unitId: "enemy:front", markerId: SCAR_TEMP, stackCount: 2 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_PS2",
          remaining: 1,
        },
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_AS1",
          remaining: 2,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_AS1",
    intent: "(分岐): 追加ヒットは刻痕9つ分で頭打ちになり、HPが50％を超えていれば継続回復は付かない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_AS1" },
    board: {
      subject: { position: { column: "RIGHT", row: "BACK" }, state: { currentHp: 5001 } },
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          markers: [{ markerId: SCAR, stackCount: 12 }],
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      // 自身を後列へ置いてPS2の相乗りを外し、本体のヒット数だけを見る。
      // 1 + min(12, 9) = 10ヒット × 351 = 3510。
      actions: [
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_AS1_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: { "enemy:front": -3510 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_AS1",
          remaining: 2,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_AS2",
    intent:
      "「刻痕」が最も少ない敵を優先して敵横一列に威力169.6で攻撃し、「刻痕」を1つ付与する。「刻痕」は1つにつき攻撃力を8％、与ダメージを5％減少させる（重複可）。対象が「刻痕」を4つ以上所持している場合、新たに付与しない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_AS2" },
    board: SCAR_RANKED_ENEMIES,
    expected: {
      // (1000 − 500) × 1.696 = 848 に、PS2の追撃 (1000 − 500) × 0.53 = 265 が横一列の
      // 2体それぞれへ乗って1113。AS2の刻痕は前列左が合算4つ（PS2の刻痕も数える）の
      // ため付与されない。一方で追撃が配る1行動の刻痕は原文に4つ以上の除外が無く、
      // 前列左にも乗る（プレイアブル版と同じ非対称）。
      actions: [
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_PS2_FOLLOW_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_AS2_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_AS2_DAMAGE",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_SCAR_MARKER",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_SCAR_ATK_DOWN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_SCAR_DMG_DOWN",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: { "enemy:front": -1113, "enemy:left": -1113 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_SCAR_ATK_DOWN",
          magnitude: -0.08,
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_SCAR_DMG_DOWN",
          magnitude: -0.05,
        },
        ...scarTempEffects("enemy:front"),
        ...scarTempEffects("enemy:left"),
      ],
      markers: [
        { unitId: "enemy:front", markerId: SCAR, stackCount: 2 },
        { unitId: "enemy:front", markerId: SCAR_TEMP, stackCount: 1 },
        { unitId: "enemy:left", markerId: SCAR_TEMP, stackCount: 2 },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_PS2",
          remaining: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_AS2",
    intent: "(優先): 刻痕の最も少ない敵が後列にいれば、既定順の前列ではなく後列の横一列を狙う",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_AS2" },
    // 自身を後列へ置いてPS2の相乗りを外し、対象順だけを見る。
    board: { ...BACK_ENEMY_FEWEST_SCARS, ...SUBJECT_IN_BACK_ROW },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_AS2_DAMAGE",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_SCAR_MARKER",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_SCAR_ATK_DOWN",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_SCAR_DMG_DOWN",
          targets: ["enemy:back"],
        },
      ],
      hpDeltas: { "enemy:back": -848 },
      effectsApplied: [
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_SCAR_ATK_DOWN",
          magnitude: -0.08,
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_SCAR_DMG_DOWN",
          magnitude: -0.05,
        },
      ],
      markers: [{ unitId: "enemy:back", markerId: SCAR, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_PS1",
    intent:
      "自身のHPが50％以下になった際に発動。自身に対し、自身が1回行動を終えるまでの間、向けられるデバフを無効にする効果と、自身が1回行動を終えるまでの間1ヒットまで受けるダメージを無効にする効果を付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_PS1",
      // HP 6000 → 4000（最大HP 10000の60% → 40%）。
      trigger: hitPointReduced({
        source: "enemy:front",
        target: "ally:subject",
        damage: 2000,
        hpBefore: 6000,
      }),
    },
    expected: {
      // 演習の敵陣営は単騎（Q-TEX-01）のため、プレイアブル版にあった同列の味方への
      // 付与は無い。
      actions: [
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_PS1_DEBUFF_IMMUNITY_SELF",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_PS1_DAMAGE_IMMUNITY",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_PS1_DEBUFF_IMMUNITY_SELF",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_PS1_DAMAGE_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
          statusKind: "DAMAGE_IMMUNITY",
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_PS1",
    intent:
      "(条件): 既に50％以下のまま受けたダメージでは発動しない（50％を上から下へ跨いだ時だけ）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_PS1",
      trigger: hitPointReduced({
        source: "enemy:front",
        target: "ally:subject",
        damage: 1000,
        hpBefore: 5000,
      }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_PS2",
    intent:
      "（同時発動制限）自身がアクティブスキルで攻撃する前に発動。当該攻撃に威力53のダメージと、1行動の「刻痕」を追加する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_PS2",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
      }),
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_PS2_FOLLOW_UP",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_PS2_FOLLOW_UP",
          magnitude: 0,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_PS2",
          remaining: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_PS2",
    intent: "(条件): 他の味方がアクティブスキルで攻撃する前には発動しない（契機は自身の攻撃だけ）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_PS2",
      trigger: skillUseStarting({ actor: "ally:front", targets: ["enemy:front"], skillType: "AS" }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_PS2",
    intent: "自身が前列に編成されていない場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_PS2",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
      }),
    },
    board: SUBJECT_IN_BACK_ROW,
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_PS2",
    intent:
      "(不成立): 攻撃を含まないアクティブスキル（自己バフ・回復だけ等）を使う前には発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_PS2",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        isAttack: false,
      }),
    },
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_NINA_ZINA_FRONTRUNNER_TEX (破壊：ニーナ／ジーナ・ミーシナ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-NINA-ZINA-FRONTRUNNER-TEX-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-NINA-ZINA-FRONTRUNNER-TEX-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-NINA-ZINA-FRONTRUNNER-TEX-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
        // 追撃の`onHitEffects`が配るMarkerは`MarkerApplied`だけを発行し、収集器が見る
        // `EffectActionCompleted`／`EffectApplied`のどちらも持たない。付与自体は
        // AS1・AS2の行の`markers`（1行動の刻痕が1段増える）が示している。
        ["ACT_NINA_ZINA_FRONTRUNNER_TEX_SCAR_TEMP_MARKER"],
      ),
    ).toEqual([]);
  });

  it("IT-UNIT-NINA-ZINA-FRONTRUNNER-TEX-004 [R-ATM-02, R-FUP-01]: 自身のASが自身のPS2を呼び、追撃バフはその場で始まる当該攻撃に乗って消費される（PP・クールタイムは1回分）", () => {
    const observed = observeSkillUse({
      snapshot,
      unitDefinitionId: UNIT_DEFINITION_ID,
      use: { kind: "ACTIVE", skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_AS2" },
    });

    // 追撃バフの付与（PS2）が、当該攻撃のダメージより先に観測される。
    const order = observed.actions!.map((action) => action.effectActionDefinitionId);
    expect(order.indexOf("ACT_NINA_ZINA_FRONTRUNNER_TEX_PS2_FOLLOW_UP")).toBeLessThan(
      order.indexOf("ACT_NINA_ZINA_FRONTRUNNER_TEX_AS2_DAMAGE"),
    );
    // 本体848 + 追撃265。追撃が「次の攻撃」ではなく当該攻撃へ乗ったことの証拠。
    expect(observed.hpDeltas!["enemy:front"]).toBe(-1113);
    // 追撃自体は`SkillUseStarting`を発行しないため、PS2は1回しか発動しない。
    expect(order.filter((id) => id === "ACT_NINA_ZINA_FRONTRUNNER_TEX_PS2_FOLLOW_UP")).toHaveLength(
      1,
    );
    expect(observed.resources).toContainEqual({
      unitId: "ally:subject",
      resource: "PP",
      delta: -1,
    });
    expect(observed.cooldowns).toContainEqual({
      unitId: "ally:subject",
      skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_TEX_PS2",
      remaining: 1,
    });
  });

  it("IT-UNIT-NINA-ZINA-FRONTRUNNER-TEX-005 [R-EFF-09, R-EFF-10]: ニーナが倒れると刻痕（AS2の恒久・PS2の1行動）と紐づく攻撃力・与ダメージの低下が同時に消える", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const units = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_SCAR_MARKER", target: "ENEMY" },
      { effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_SCAR_ATK_DOWN", target: "ENEMY" },
      { effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_SCAR_DMG_DOWN", target: "ENEMY" },
      {
        effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_SCAR_TEMP_MARKER",
        target: "ENEMY",
      },
      {
        effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_SCAR_TEMP_ATK_DOWN",
        target: "ENEMY",
      },
      {
        effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_SCAR_TEMP_DMG_DOWN",
        target: "ENEMY",
      },
    ]);
    const scarredId = units.find((unit) =>
      unit.markerStates.some((marker) => marker.markerId === SCAR),
    )!.battleUnitId;
    const scarredBefore = units.find((unit) => unit.battleUnitId === scarredId)!;
    expect(scarredBefore.markerStates).toHaveLength(2);
    expect(scarredBefore.appliedEffects).toHaveLength(4);
    // 攻撃力は原基準値1000から2つ分の刻痕で16%低下する。
    expect(scarredBefore.combatStats.attack).toBe(840);

    const { recorder, rootEventId } = seedRecorder("B_NINA_ZINA_TEX_SCAR_DEFEAT");
    const after = removeMarkers(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      units,
      findMarkersRemovedOnSourceDefeat(units, {
        eventType: "UnitDefeated",
        payload: { unitId: board.subject.battleUnitId },
      }),
      board.definitions.effectActions,
      rootEventId,
    ).units.find((unit) => unit.battleUnitId === scarredId)!;

    expect(after.markerStates).toEqual([]);
    expect(after.appliedEffects).toEqual([]);
    expect(after.combatStats.attack).toBe(1000);
  });

  const EX_DEBUFFS = [
    "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_DOWN",
    "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_BUFF_SEAL",
  ];

  /** EXのデバフ一式（目印＋攻撃力低下＋攻撃力バフ無効）を、ニーナが敵1体へ付与した盤面。 */
  function exDebuffedEnemy() {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const units = applyPrecedingActions(board, [
      {
        effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_DEBUFF_MARKER",
        target: "ENEMY",
      },
      { effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_DOWN", target: "ENEMY" },
      {
        effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_BUFF_SEAL",
        target: "ENEMY",
      },
    ]);
    const debuffed = units.find((unit) =>
      unit.markerStates.some(
        (marker) => marker.markerId === "MARKER_NINA_ZINA_FRONTRUNNER_TEX_EX_DEBUFF",
      ),
    )!;
    return { board, units, debuffed };
  }

  const exDebuffsOf = (unit: BattleUnit) =>
    unit.appliedEffects.filter((effect) => EX_DEBUFFS.includes(effect.effectActionDefinitionId));

  it("IT-UNIT-NINA-ZINA-FRONTRUNNER-TEX-006 [R-EFF-09, R-EFF-10]: EXで敵に付与したデバフ（攻撃力低下・攻撃力バフ無効）は、付与者のニーナが倒れると解除される", () => {
    const { board, units, debuffed } = exDebuffedEnemy();
    expect(debuffed.side).toBe("ENEMY");
    expect(exDebuffsOf(debuffed)).toHaveLength(2);
    // 攻撃力は原基準値1000から20%低下する。
    expect(debuffed.combatStats.attack).toBe(800);

    const { recorder, rootEventId } = seedRecorder("B_NINA_ZINA_TEX_EX_DEFEAT");
    const after = removeMarkers(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      units,
      findMarkersRemovedOnSourceDefeat(units, {
        eventType: "UnitDefeated",
        payload: { unitId: board.subject.battleUnitId },
      }),
      board.definitions.effectActions,
      rootEventId,
    ).units.find((unit) => unit.battleUnitId === debuffed.battleUnitId)!;

    expect(exDebuffsOf(after)).toEqual([]);
    expect(after.markerStates).toEqual([]);
    expect(after.combatStats.attack).toBe(1000);
  });

  it("IT-UNIT-NINA-ZINA-FRONTRUNNER-TEX-007 [R-EFF-04]: EXで敵に付与したデバフの期間は、保持者の敵ではなく付与者のニーナの行動で減る（攻撃力低下は1回、攻撃力バフ無効は2回）", () => {
    const { board, units, debuffed } = exDebuffedEnemy();
    const holder = debuffed.battleUnitId;

    expect(
      observeEffectExpiry({
        units,
        definitions: board.definitions,
        steps: [
          { kind: "ACTION_END", actor: holder },
          { kind: "ACTION_END", actor: "ally:subject" },
          { kind: "ACTION_END", actor: holder },
          { kind: "ACTION_END", actor: "ally:subject" },
        ],
        watch: [{ unitId: holder, stat: "attack" }],
        watchMarkers: [holder],
      }).steps,
    ).toEqual([
      // 保持者自身の行動終了では減らない（既定の `EFFECT_TARGET` ならここで攻撃力低下が失効する）。
      {
        step: `ACTION_END(${holder})`,
        remaining: {
          [`${holder}/ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_DOWN`]: 1,
          [`${holder}/ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_BUFF_SEAL`]: 2,
        },
        markers: { [`${holder}/MARKER_NINA_ZINA_FRONTRUNNER_TEX_EX_DEBUFF`]: 1 },
      },
      {
        step: "ACTION_END(ally:subject)",
        remaining: { [`${holder}/ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_BUFF_SEAL`]: 1 },
        expired: [
          {
            unitId: holder,
            effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_DOWN",
            reason: "TIME_LIMIT",
            cascaded: false,
          },
        ],
        stats: { [`${holder}/attack`]: 1000 },
        markers: { [`${holder}/MARKER_NINA_ZINA_FRONTRUNNER_TEX_EX_DEBUFF`]: 1 },
      },
      {
        step: `ACTION_END(${holder})`,
        remaining: { [`${holder}/ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_BUFF_SEAL`]: 1 },
        markers: { [`${holder}/MARKER_NINA_ZINA_FRONTRUNNER_TEX_EX_DEBUFF`]: 1 },
      },
      {
        step: "ACTION_END(ally:subject)",
        remaining: {},
        expired: [
          {
            unitId: holder,
            effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_TEX_EX_ATK_BUFF_SEAL",
            reason: "TIME_LIMIT",
            cascaded: false,
          },
        ],
        markers: {},
      },
    ]);
  });
});
