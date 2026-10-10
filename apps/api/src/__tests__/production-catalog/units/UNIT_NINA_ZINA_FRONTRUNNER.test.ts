import { describe, expect, it } from "vitest";
import { findMarkersRemovedOnSourceDefeat } from "../../../domain/battle/resolution/marker-source-defeat-service.js";
import { removeMarkers } from "../../../domain/battle/effects/marker-removal-service.js";
import { collectLinkedGroupCascade } from "../../../domain/battle/model/linked-effect-group.js";
import type { BattleUnit } from "../../../domain/battle/model/battle-unit.js";
import {
  createEffectInstanceId,
  createMarkerInstanceId,
} from "../../../domain/shared/event-ids.js";
import { createBattleUnitId } from "../../../domain/shared/ids.js";
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
import {
  rideStandInAttack,
  useStandInNonAttackSkill,
} from "../../../testing/production-unit/follow-up-ride.js";

/**
 * `UNIT_NINA_ZINA_FRONTRUNNER`（【双翼のフロントランナー】ニーナ／ジーナ・ミーシナ）の
 * ユニット単位production結合テスト（`12_テスト戦略.md`「ユニット効果軸」、Issue #736）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 *
 * 「刻痕」は寿命の違う2つのマーカーで表す — AS2の刻痕（`_SCAR`、付与者撃破まで）と
 * PS2の1行動の刻痕（`_SCAR_TEMP`）。所持数を問う3か所（AS1のヒット数・AS2の優先順と
 * 4つ以上の判定）はどちらも`markerIds`で両者を合算する。
 */

const UNIT_DEFINITION_ID = "UNIT_NINA_ZINA_FRONTRUNNER";
const SCAR = "MARKER_NINA_ZINA_FRONTRUNNER_SCAR";
const SCAR_TEMP = "MARKER_NINA_ZINA_FRONTRUNNER_SCAR_TEMP";

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

/** 自身を後列へ置く盤面（PS1の味方への付与・PS2の発動が「前列のときだけ」になる）。 */
const SUBJECT_IN_BACK_ROW: BoardOverrides = {
  subject: { position: { column: "RIGHT", row: "BACK" } },
};

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_EX",
    intent:
      "敵全体に威力212で攻撃し、自身が1回行動を終えるまでの間、攻撃力を20％低下させる。さらに自身が2回行動を終えるまでの間、新たに向けられる攻撃力バフを無効にするデバフを付与する。各デバフは自身が倒れると解除される。加えて自身のHPが50％以上だった場合、自身のAPを1加算する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_EX" },
    // HP 5000/10000 = ちょうど50%（以上を満たす）。AP加算が上限で消えないよう2から始める。
    board: { subject: { state: { currentAp: 2 } } },
    expected: {
      // (攻撃力1000 − 防御力500) × 2.12 = 1060
      actions: [
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_DAMAGE",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_DAMAGE",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_DEBUFF_MARKER",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_DOWN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_BUFF_SEAL",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_DEBUFF_MARKER",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_DOWN",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_BUFF_SEAL",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_DEBUFF_MARKER",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_DOWN",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_BUFF_SEAL",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_AP_UP",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: { "enemy:front": -1060, "enemy:left": -1060, "enemy:back": -1060 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_BUFF_SEAL",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_BUFF_SEAL",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_BUFF_SEAL",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
      ],
      markers: [
        {
          unitId: "enemy:front",
          markerId: "MARKER_NINA_ZINA_FRONTRUNNER_EX_DEBUFF",
          stackCount: 1,
        },
        {
          unitId: "enemy:left",
          markerId: "MARKER_NINA_ZINA_FRONTRUNNER_EX_DEBUFF",
          stackCount: 1,
        },
        {
          unitId: "enemy:back",
          markerId: "MARKER_NINA_ZINA_FRONTRUNNER_EX_DEBUFF",
          stackCount: 1,
        },
      ],
      resources: [{ unitId: "ally:subject", resource: "AP", delta: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_EX",
    intent: "(分岐): 自身のHPが50％未満ならAPを加算しない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_EX" },
    board: { subject: { state: { currentAp: 2, currentHp: 4999 } } },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_DAMAGE",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_DAMAGE",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_DEBUFF_MARKER",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_DOWN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_BUFF_SEAL",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_DEBUFF_MARKER",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_DOWN",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_BUFF_SEAL",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_DEBUFF_MARKER",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_DOWN",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_BUFF_SEAL",
          targets: ["enemy:back"],
        },
      ],
      hpDeltas: { "enemy:front": -1060, "enemy:left": -1060, "enemy:back": -1060 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_BUFF_SEAL",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_BUFF_SEAL",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_BUFF_SEAL",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
      ],
      markers: [
        {
          unitId: "enemy:front",
          markerId: "MARKER_NINA_ZINA_FRONTRUNNER_EX_DEBUFF",
          stackCount: 1,
        },
        {
          unitId: "enemy:left",
          markerId: "MARKER_NINA_ZINA_FRONTRUNNER_EX_DEBUFF",
          stackCount: 1,
        },
        {
          unitId: "enemy:back",
          markerId: "MARKER_NINA_ZINA_FRONTRUNNER_EX_DEBUFF",
          stackCount: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_AS1",
    intent:
      "敵単体に威力70.2で1ヒット攻撃する。この攻撃は対象に付与されている「刻痕」1つにつき1ヒット追加される（9つまで）。さらに自身のHPが50％以下だった場合、自身に対し2行動の間、効果付与時の不足HPの25％を継続回復する効果を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_AS1" },
    board: SCARRED_FRONT_ENEMY,
    expected: {
      // 刻痕は合算3つ → 1 + 3 = 4ヒット。1ヒット (1000 − 500) × 0.702 = 351 → 計1404。
      // 継続回復の回復量は付与時の不足HP 5000 × 25% = 1250 で固定される。
      actions: [
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_AS1_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_AS1_REGEN",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: { "enemy:front": -1404 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_AS1_REGEN",
          magnitude: 1250,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_AS1",
          remaining: 2,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_AS1",
    intent: "(分岐): 追加ヒットは刻痕9つ分で頭打ちになり、HPが50％を超えていれば継続回復は付かない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_AS1" },
    board: {
      subject: { state: { currentHp: 5001 } },
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
      // 1 + min(12, 9) = 10ヒット × 351 = 3510。
      actions: [
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_AS1_DAMAGE",
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
          skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_AS1",
          remaining: 2,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_AS2",
    intent:
      "「刻痕」が最も少ない敵を優先して敵横一列に威力169.6で攻撃し、「刻痕」を1つ付与する。「刻痕」は1つにつき攻撃力を8％、与ダメージを5％減少させる（重複可）。対象が「刻痕」を4つ以上所持している場合、新たに付与しない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_AS2" },
    board: SCAR_RANKED_ENEMIES,
    expected: {
      // (1000 − 500) × 1.696 = 848。前列左は合算4つ（PS2の刻痕も数える）のため付与されない。
      actions: [
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_AS2_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_AS2_DAMAGE",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_SCAR_MARKER",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_SCAR_ATK_DOWN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_SCAR_DMG_DOWN",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: { "enemy:front": -848, "enemy:left": -848 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_SCAR_ATK_DOWN",
          magnitude: -0.08,
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_SCAR_DMG_DOWN",
          magnitude: -0.05,
        },
      ],
      markers: [{ unitId: "enemy:front", markerId: SCAR, stackCount: 2 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_AS2",
    intent: "(優先): 刻痕の最も少ない敵が後列にいれば、既定順の前列ではなく後列の横一列を狙う",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_AS2" },
    board: BACK_ENEMY_FEWEST_SCARS,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_AS2_DAMAGE",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_SCAR_MARKER",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_SCAR_ATK_DOWN",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_SCAR_DMG_DOWN",
          targets: ["enemy:back"],
        },
      ],
      hpDeltas: { "enemy:back": -848 },
      effectsApplied: [
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_SCAR_ATK_DOWN",
          magnitude: -0.08,
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_SCAR_DMG_DOWN",
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
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_PS1",
    intent:
      "自身のHPが50％以下になった際に発動。自身に対し、自身が1回行動を終えるまでの間、向けられるデバフを無効にする効果と、1ヒットまで受けるダメージを無効にする効果を付与する。さらに自身が前列に編成されている場合、自身と同じ横一列の他の味方に対しても同様の効果を付与する。デバフ無効効果は自身が倒れると解除される",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_PS1",
      // HP 6000 → 4000（最大HP 10000の60% → 40%）。
      trigger: hitPointReduced({
        source: "enemy:front",
        target: "ally:subject",
        damage: 2000,
        hpBefore: 6000,
      }),
    },
    expected: {
      // 前列（自身と同じ横一列）の他の味方は ally:front だけ。後列の ally:back は対象外。
      actions: [
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_PS1_DEBUFF_IMMUNITY_SELF",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_PS1_DAMAGE_IMMUNITY",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_PS1_GUARD_MARKER",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_PS1_DEBUFF_IMMUNITY_ALLY",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_PS1_DAMAGE_IMMUNITY",
          targets: ["ally:front"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_PS1_DEBUFF_IMMUNITY_SELF",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_PS1_DAMAGE_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
          statusKind: "DAMAGE_IMMUNITY",
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_PS1_DEBUFF_IMMUNITY_ALLY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_PS1_DAMAGE_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
          statusKind: "DAMAGE_IMMUNITY",
        },
      ],
      markers: [
        { unitId: "ally:front", markerId: "MARKER_NINA_ZINA_FRONTRUNNER_PS1_GUARD", stackCount: 1 },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_PS1",
    intent:
      "(条件): 既に50％以下のまま受けたダメージでは発動しない（50％を上から下へ跨いだ時だけ）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_PS1",
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
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_PS1",
    intent: "(分岐): 自身が前列に編成されていなければ、他の味方には付与しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_PS1",
      trigger: hitPointReduced({
        source: "enemy:front",
        target: "ally:subject",
        damage: 2000,
        hpBefore: 6000,
      }),
    },
    board: SUBJECT_IN_BACK_ROW,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_PS1_DEBUFF_IMMUNITY_SELF",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_PS1_DAMAGE_IMMUNITY",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_PS1_DEBUFF_IMMUNITY_SELF",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_PS1_DAMAGE_IMMUNITY",
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
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_PS2",
    intent:
      "（同時発動制限）自身と同じ横一列の他の味方がアクティブスキルで攻撃する前に発動。当該攻撃に威力53のダメージと、1行動の「刻痕」を追加する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_PS2",
      trigger: skillUseStarting({ actor: "ally:front", targets: ["enemy:front"], skillType: "AS" }),
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_PS2_FOLLOW_UP",
          targets: ["ally:front"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_PS2_FOLLOW_UP",
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
          skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_PS2",
          remaining: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_PS2",
    intent: "(条件): 攻撃する味方が自身と同じ横一列（前列）にいなければ発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_PS2",
      trigger: skillUseStarting({ actor: "ally:back", targets: ["enemy:front"], skillType: "AS" }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_PS2",
    intent: "自身が前列に編成されていない場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_PS2",
      trigger: skillUseStarting({ actor: "ally:front", targets: ["enemy:front"], skillType: "AS" }),
    },
    board: SUBJECT_IN_BACK_ROW,
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_PS2",
    intent:
      "(不成立): 味方が攻撃を含まないアクティブスキル（自己バフ・回復だけ等）を使う前には発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NINA_ZINA_FRONTRUNNER_PS2",
      trigger: skillUseStarting({
        actor: "ally:front",
        targets: ["enemy:front"],
        skillType: "AS",
        isAttack: false,
      }),
      triggeredBy: "ally:front",
    },

    expected: { activated: false },
  },
];

describe("production Catalog UNIT_NINA_ZINA_FRONTRUNNER (【双翼のフロントランナー】ニーナ／ジーナ・ミーシナ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-NINA-ZINA-FRONTRUNNER-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-NINA-ZINA-FRONTRUNNER-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-NINA-ZINA-FRONTRUNNER-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
        // R-FUP-01: PS2の1行動の刻痕は追撃バフ（`ACT_NINA_ZINA_FRONTRUNNER_PS2_FOLLOW_UP`の
        // `onHitEffects`）が味方の攻撃に相乗りしたときだけ実行される。表は「スキル使用1回」
        // 単位のためPS発動（バフ付与）までしか表せず、実行は`-004`が保持者の実AS経路で検証する。
        [
          "ACT_NINA_ZINA_FRONTRUNNER_SCAR_TEMP_MARKER",
          "ACT_NINA_ZINA_FRONTRUNNER_SCAR_TEMP_ATK_DOWN",
          "ACT_NINA_ZINA_FRONTRUNNER_SCAR_TEMP_DMG_DOWN",
        ],
      ),
    ).toEqual([]);
  });

  /** PS2の追撃バフを保持した前列の味方に実ASを使わせ、1行動の刻痕が付いた盤面を返す。 */
  function rideScarTemp(battleId: string) {
    // 自身は後列へ置く。前列のままだと、保持者（前列の味方）の実ASがそれ自体でPS2の
    // 契機になり2本目のバフが付与される — 前提アクションはPS発動を経由しないため
    // PS2のクールタイムが立っておらず、実戦闘では起きない二重の相乗りになる。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, SUBJECT_IN_BACK_ROW);
    const withRider = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_PS2_FOLLOW_UP", target: "ALLY" },
    ]);
    const holder = withRider.find((unit) =>
      unit.appliedEffects.some((effect) => effect.isFollowUpAttack === true),
    );
    const { units } = rideStandInAttack({
      attackerUnitId: holder!.battleUnitId,
      units: withRider,
      definitions: board.definitions,
      battleId,
    });
    const scarred = units.find((unit) =>
      unit.markerStates.some((marker) => marker.markerId === SCAR_TEMP),
    )!;
    return { board, holder: holder!, units, scarred };
  }

  const SCAR_TEMP_DEBUFFS = [
    "ACT_NINA_ZINA_FRONTRUNNER_SCAR_TEMP_ATK_DOWN",
    "ACT_NINA_ZINA_FRONTRUNNER_SCAR_TEMP_DMG_DOWN",
  ];

  const scarTempDebuffsOf = (unit: BattleUnit) =>
    unit.appliedEffects.filter((effect) =>
      SCAR_TEMP_DEBUFFS.includes(effect.effectActionDefinitionId),
    );

  it("IT-UNIT-NINA-ZINA-FRONTRUNNER-004 [R-FUP-01]: PS2の追撃バフを保持した味方が実ASで攻撃すると、威力53の追撃が味方のステータスで入り、ヒットした敵へ1行動の刻痕（攻撃力-8%・与ダメージ-5%）が付与され、刻痕の付与者はニーナになる", () => {
    const { board, holder, units } = rideScarTemp("B_NINA_ZINA_PS2_RIDE");
    expect(holder).toBeDefined();

    // AS本体: (1000 − 500) × 1.0 = 500。追撃: (1000 − 500) × 0.53 = 265（非会心継承）。
    const attacked = units.filter(
      (unit) => unit.side === "ENEMY" && unit.currentHp < unit.combatStats.maximumHp / 2,
    );
    expect(attacked).toHaveLength(1);
    const enemyAfter = attacked[0]!;
    expect(enemyAfter.currentHp).toBe(5000 - 500 - 265);

    const scarTemp = enemyAfter.markerStates.find((marker) => marker.markerId === SCAR_TEMP);
    expect(scarTemp).toMatchObject({
      stackCount: 1,
      sourceUnitId: board.subject.battleUnitId,
    });
    expect(scarTemp?.duration.definition).toMatchObject({
      timeLimit: { unit: "ACTION", count: 1 },
      removeOnSourceDefeated: true,
    });
    const magnitudes = Object.fromEntries(
      enemyAfter.appliedEffects.map((effect) => [
        effect.effectActionDefinitionId,
        effect.magnitude,
      ]),
    );
    expect(magnitudes).toMatchObject({
      ACT_NINA_ZINA_FRONTRUNNER_SCAR_TEMP_ATK_DOWN: -0.08,
      ACT_NINA_ZINA_FRONTRUNNER_SCAR_TEMP_DMG_DOWN: -0.05,
    });
    // 攻撃力は原基準値1000から8%低下する。
    expect(enemyAfter.combatStats.attack).toBe(920);
    // バフは「次の攻撃1回」で消費・失効している。
    const holderAfter = units.find((unit) => unit.battleUnitId === holder.battleUnitId)!;
    expect(holderAfter.appliedEffects.some((effect) => effect.isFollowUpAttack)).toBe(false);
  });

  it("IT-UNIT-NINA-ZINA-FRONTRUNNER-005 [R-EFF-09, R-EFF-10]: ニーナが倒れて1行動の刻痕が消えると、紐づく攻撃力・与ダメージの低下も同時に消える", () => {
    const { board, units, scarred } = rideScarTemp("B_NINA_ZINA_SCAR_TEMP_DEFEAT");
    expect(scarTempDebuffsOf(scarred)).toHaveLength(2);

    const { recorder, rootEventId } = seedRecorder("B_NINA_ZINA_SCAR_TEMP_DEFEAT_REMOVE");
    const removed = removeMarkers(
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
    );

    const after = removed.units.find((unit) => unit.battleUnitId === scarred.battleUnitId)!;
    expect(after.markerStates.some((marker) => marker.markerId === SCAR_TEMP)).toBe(false);
    expect(scarTempDebuffsOf(after)).toEqual([]);
    expect(after.combatStats.attack).toBe(1000);
  });

  it("IT-UNIT-NINA-ZINA-FRONTRUNNER-006 [R-EFF-09]: ある敵の1行動の刻痕が消えても、他の敵が持つ刻痕の低下は連動して消えない（連動は保持ユニット内に閉じる）", () => {
    const { units, scarred } = rideScarTemp("B_NINA_ZINA_SCAR_TEMP_SCOPE");
    // 同じ定義の刻痕一式（マーカー＋低下2件）を別の敵にも持たせる。
    const otherId = units.find(
      (unit) => unit.side === "ENEMY" && unit.battleUnitId !== scarred.battleUnitId,
    )!.battleUnitId;
    const other: BattleUnit = {
      ...units.find((unit) => unit.battleUnitId === otherId)!,
      markerStates: scarred.markerStates
        .filter((marker) => marker.markerId === SCAR_TEMP)
        .map((marker) => ({
          ...marker,
          markerInstanceId: createMarkerInstanceId(`${marker.markerInstanceId}:other`),
          targetUnitId: createBattleUnitId(otherId),
        })),
      appliedEffects: scarTempDebuffsOf(scarred).map((effect) => ({
        ...effect,
        effectInstanceId: createEffectInstanceId(`${effect.effectInstanceId}:other`),
        targetUnitId: createBattleUnitId(otherId),
      })),
    };
    const board = units.map((unit) => (unit.battleUnitId === otherId ? other : unit));
    const seedMarker = scarred.markerStates.find((marker) => marker.markerId === SCAR_TEMP)!;

    const cascade = collectLinkedGroupCascade(board, {
      effectInstanceIds: new Set(),
      markerInstanceIds: new Set([seedMarker.markerInstanceId]),
    });

    expect([...cascade.effectInstanceIds].sort()).toEqual(
      scarTempDebuffsOf(scarred)
        .map((effect) => effect.effectInstanceId)
        .sort(),
    );
    expect([...cascade.markerInstanceIds]).toEqual([seedMarker.markerInstanceId]);
  });

  const EX_DEBUFFS = [
    "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_DOWN",
    "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_BUFF_SEAL",
  ];

  /** EXのデバフ一式（目印＋攻撃力低下＋攻撃力バフ無効）を、ニーナが敵1体へ付与した盤面。 */
  function exDebuffedEnemy() {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const units = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_DEBUFF_MARKER", target: "ENEMY" },
      { effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_DOWN", target: "ENEMY" },
      { effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_BUFF_SEAL", target: "ENEMY" },
    ]);
    const debuffed = units.find((unit) =>
      unit.markerStates.some(
        (marker) => marker.markerId === "MARKER_NINA_ZINA_FRONTRUNNER_EX_DEBUFF",
      ),
    )!;
    return { board, units, debuffed };
  }

  const exDebuffsOf = (unit: BattleUnit) =>
    unit.appliedEffects.filter((effect) => EX_DEBUFFS.includes(effect.effectActionDefinitionId));

  it("IT-UNIT-NINA-ZINA-FRONTRUNNER-007 [R-EFF-09, R-EFF-10]: EXで敵に付与したデバフ（攻撃力低下・攻撃力バフ無効）は、付与者のニーナが倒れると解除される", () => {
    const { board, units, debuffed } = exDebuffedEnemy();
    expect(debuffed.side).toBe("ENEMY");
    expect(exDebuffsOf(debuffed)).toHaveLength(2);
    // 攻撃力は原基準値1000から20%低下する。
    expect(debuffed.combatStats.attack).toBe(800);

    const { recorder, rootEventId } = seedRecorder("B_NINA_ZINA_EX_DEFEAT");
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

  it("IT-UNIT-NINA-ZINA-FRONTRUNNER-010 [R-EFF-04]: EXで敵に付与したデバフの期間は、保持者の敵ではなく付与者のニーナの行動で減る（攻撃力低下は1回、攻撃力バフ無効は2回）", () => {
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
          [`${holder}/ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_DOWN`]: 1,
          [`${holder}/ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_BUFF_SEAL`]: 2,
        },
        markers: { [`${holder}/MARKER_NINA_ZINA_FRONTRUNNER_EX_DEBUFF`]: 1 },
      },
      {
        step: "ACTION_END(ally:subject)",
        remaining: { [`${holder}/ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_BUFF_SEAL`]: 1 },
        expired: [
          {
            unitId: holder,
            effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_DOWN",
            reason: "TIME_LIMIT",
            cascaded: false,
          },
        ],
        stats: { [`${holder}/attack`]: 1000 },
        markers: { [`${holder}/MARKER_NINA_ZINA_FRONTRUNNER_EX_DEBUFF`]: 1 },
      },
      {
        step: `ACTION_END(${holder})`,
        remaining: { [`${holder}/ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_BUFF_SEAL`]: 1 },
        markers: { [`${holder}/MARKER_NINA_ZINA_FRONTRUNNER_EX_DEBUFF`]: 1 },
      },
      {
        step: "ACTION_END(ally:subject)",
        remaining: {},
        expired: [
          {
            unitId: holder,
            effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_BUFF_SEAL",
            reason: "TIME_LIMIT",
            cascaded: false,
          },
        ],
        markers: {},
      },
    ]);
  });

  it("IT-UNIT-NINA-ZINA-FRONTRUNNER-008 [R-EFF-09]: PS1で味方に付けたデバフ無効の連動は保持ユニット内に閉じ、別の味方が持つ同じガードを巻き込まない", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const units = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_PS1_GUARD_MARKER", target: "ALLY" },
      {
        effectActionDefinitionId: "ACT_NINA_ZINA_FRONTRUNNER_PS1_DEBUFF_IMMUNITY_ALLY",
        target: "ALLY",
      },
    ]);
    const guarded = units.find((unit) =>
      unit.markerStates.some(
        (marker) => marker.markerId === "MARKER_NINA_ZINA_FRONTRUNNER_PS1_GUARD",
      ),
    )!;
    const guardEffects = guarded.appliedEffects.filter(
      (effect) =>
        effect.effectActionDefinitionId === "ACT_NINA_ZINA_FRONTRUNNER_PS1_DEBUFF_IMMUNITY_ALLY",
    );
    expect(guardEffects).toHaveLength(1);
    // 同じ定義のガード一式を別の味方にも持たせる（ニーナが2体いる盤面の再現）。
    const otherId = units.find(
      (unit) =>
        unit.side === "ALLY" &&
        unit.battleUnitId !== guarded.battleUnitId &&
        unit.battleUnitId !== board.subject.battleUnitId,
    )!.battleUnitId;
    const withOther = units.map((unit) =>
      unit.battleUnitId !== otherId
        ? unit
        : {
            ...unit,
            markerStates: guarded.markerStates.map((marker) => ({
              ...marker,
              markerInstanceId: createMarkerInstanceId(`${marker.markerInstanceId}:other`),
              targetUnitId: createBattleUnitId(otherId),
            })),
            appliedEffects: guardEffects.map((effect) => ({
              ...effect,
              effectInstanceId: createEffectInstanceId(`${effect.effectInstanceId}:other`),
              targetUnitId: createBattleUnitId(otherId),
            })),
          },
    );
    const seedMarker = guarded.markerStates[0]!;

    const cascade = collectLinkedGroupCascade(withOther, {
      effectInstanceIds: new Set(),
      markerInstanceIds: new Set([seedMarker.markerInstanceId]),
    });

    expect([...cascade.effectInstanceIds]).toEqual(
      guardEffects.map((effect) => effect.effectInstanceId),
    );
    expect([...cascade.markerInstanceIds]).toEqual([seedMarker.markerInstanceId]);
  });
  it("IT-UNIT-NINA-ZINA-FRONTRUNNER-009 [R-ATM-02]: 同じ横一列の味方が敵を対象に取っても、攻撃を含まないASではPS2は発動せず（PP・クールタイムも変化しない）、攻撃を含むASでは発動する", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const ps2Activations = (events: ReturnType<typeof rideStandInAttack>["recorder"]) =>
      events
        .getEvents()
        .filter(
          (event) =>
            event.eventType === "PassiveActivated" &&
            event.payload.skillDefinitionId === "SKL_NINA_ZINA_FRONTRUNNER_PS2",
        );
    const subjectOf = (units: readonly BattleUnit[]) =>
      units.find((unit) => unit.battleUnitId === board.subject.battleUnitId)!;
    const options = {
      attackerUnitId: "ally:front",
      units: board.units,
      definitions: board.definitions,
    };

    const nonAttack = useStandInNonAttackSkill({
      ...options,
      battleId: "B_NINA_ZINA_PS2_NON_ATTACK",
    });
    expect(ps2Activations(nonAttack.recorder)).toEqual([]);
    expect(subjectOf(nonAttack.units).currentPp).toBe(board.subject.currentPp);
    expect(subjectOf(nonAttack.units).cooldowns).toEqual(board.subject.cooldowns);

    const attack = rideStandInAttack({ ...options, battleId: "B_NINA_ZINA_PS2_ATTACK" });
    expect(ps2Activations(attack.recorder)).toHaveLength(1);
    expect(subjectOf(attack.units).currentPp).toBe(board.subject.currentPp - 1);
  });
});
