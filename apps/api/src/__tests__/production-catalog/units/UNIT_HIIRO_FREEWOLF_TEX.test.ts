import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import {
  BOARD_COMBAT_STATS,
  PRODUCTION_CATALOG_DIR,
  SUBJECT_ID,
  applyPrecedingActions,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardOverrides,
  type BoardUnitSpec,
  type PrecedingAction,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { hitPointReduced, realDamage } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_HIIRO_FREEWOLF_TEX`（破壊：榊野ヒイロ・戦術演習版）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 戦術演習の敵専用（`category: EXERCISE_ENEMY`、R-TEX-11）で、原文はゲーム内
 * スクリーンショットからの転記。プレイアブル版 `UNIT_HIIRO_FREEWOLF` との差分は
 * Lv200固定ステータスに加え、以下の3点:
 * - PS1「エマージェンシーエイド」の発動閾値が最大HP×15%→**0.75%**へ縮小されている
 *   （`UNIT_ROSIE_CAMPAIGN_TEX`・`UNIT_LYDIA_SUMMER_TEX`と同じHP割合系1/20の法則）。
 *   回復威力25・反撃威力101.4は据え置き。
 * - PS2「ファーストブランド+」は「烙印」付与と1戦闘1回制限（`RUNTIME_COUNTER`と
 *   `MEM_FATHERS_AND_MY_WISH`装備時の再使用）を持たず、毎ターン開始時に発動する。
 *   演習敵はメモリーを装備しないため、烙印とカウンタ再使用の機構が成立しない。
 * - AS1のデバフ解除がQ-TEX-12により自身を含む横一列へ向く（プレイアブル版は
 *   `includeBase: false`で自身を除くため、敵単騎の演習では対象が常に0件になる）。
 */

const UNIT_DEFINITION_ID = "UNIT_HIIRO_FREEWOLF_TEX";
const FIGHTING_SPIRIT = "MARKER_HIIRO_FREEWOLF_TEX_FIGHTING_SPIRIT";

/** AS1のREMOVE_EFFECTSの前提（DEBUFF分類の効果）を作るため、`UNIT_HIIRO_LONEWOLF`のSTUN定義を借りる。 */
const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  "UNIT_HIIRO_LONEWOLF",
]);

/** EXの1撃(1004ダメージ)で対象が落ちる残HP。「この攻撃で敵を倒した場合」の成立側を作る。 */
const ENEMY_FRONT_ALMOST_DEAD: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, state: { currentHp: 500 } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** AS1の「自身の横一列」を判別対象1体だけに絞る盤面（前列に自身以外1体だけ置く）。 */
const ONE_FRONT_ROW_ALLY: BoardOverrides = {
  allies: [{ id: "ally:front", position: { column: "LEFT", row: "FRONT" } }],
};

/** 前列の味方へ「気絶」（DEBUFF分類）を1つ持たせる前提アクション。 */
const ALLY_STUNNED: readonly PrecedingAction[] = [
  { effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_EX_STUN", target: "ALLY" },
];

/**
 * AS1が自身へ実際に付与する「闘志」1スタック＋バフ1組（ATK+4%・会心ダメージ+3%）を
 * そのまま前提アクションとして撃つ。連続使用時の累積が「使用回数×4%/3%」に一致し、
 * 上限8で頭打ちになることをこの単位で固定する。
 */
const ONE_AS1_SELF_GRANT: readonly PrecedingAction[] = [
  { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS1_MARKER", target: "SELF" },
  { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS1_ATK_UP", target: "SELF" },
  { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS1_CRIT_DMG_UP", target: "SELF" },
];

/** AS2の「闘志4つ以上」分岐を成立させる盤面。 */
const SUBJECT_WITH_FOUR_FIGHTING_SPIRIT: BoardOverrides = {
  subject: { markers: [{ markerId: FIGHTING_SPIRIT, stackCount: 4 }] },
};

/** PS1のガード（闘志所持）を満たす盤面。 */
const SUBJECT_WITH_ONE_FIGHTING_SPIRIT: BoardOverrides = {
  subject: { markers: [{ markerId: FIGHTING_SPIRIT, stackCount: 1 }] },
};

/** PS2の「現在HPが最も低い敵」を判別させる盤面（割合ではなく絶対値が最小）。 */
const ENEMIES_WITH_MIXED_CURRENT_HP: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, state: { currentHp: 3000 } },
  {
    id: "enemy:left",
    position: { column: "LEFT", row: "FRONT" },
    combatStats: { maximumHp: 20000 },
    state: { currentHp: 2000 },
  },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" }, state: { currentHp: 4000 } },
];

/** (SKL_ID, スクショ原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_EX",
    intent: "敵単体に威力200.8で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_EX_DAMAGE", targets: ["enemy:front"] },
      ],
      // (1000-500)×2.008=1004。
      hpDeltas: { "enemy:front": -1004 },
    },
  },
  {
    skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_EX",
    intent: "(分岐): この攻撃で敵を倒した場合、敵全体に威力110.44の追加攻撃を行う",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_EX" },
    board: { enemies: ENEMY_FRONT_ALMOST_DEAD },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_EX_DAMAGE", targets: ["enemy:front"] },
        {
          // 倒した当の敵は戦闘不能のため追加攻撃の対象から外れる。
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_EX_AOE_DAMAGE",
          targets: ["enemy:front"],
          resultKind: "SKIPPED",
        },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_EX_AOE_DAMAGE",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_EX_AOE_DAMAGE",
          targets: ["enemy:back"],
        },
      ],
      // enemy:frontは残HP500で即死。enemy:left/backは(1000-500)×1.1044=552。
      hpDeltas: { "enemy:front": -500, "enemy:left": -552, "enemy:back": -552 },
    },
  },
  {
    skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_AS1",
    intent:
      "敵単体に威力195で攻撃する（回避不可）。さらに自身の横一列の味方に付与されているデバフを3つ解除し、「闘志」を1つ付与する（最大8つ、1つにつき攻撃力4%・会心ダメージ3%増加、重複可）。さらに自身に1行動デバフ無効と次に受ける攻撃のダメージ15%減少を付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_AS1" },
    board: ONE_FRONT_ROW_ALLY,
    precedingActions: ALLY_STUNNED,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS1_DAMAGE", targets: ["enemy:front"] },
        {
          // Q-TEX-12: デバフ解除も自身を含む横一列へ向く。この盤面では自身が
          // デバフを持たないためSKIPPEDだが、対象束縛に自身が入っていること自体を
          // ここで固定する（プレイアブル版の`includeBase: false`のままだと演習の
          // 敵単騎では対象が常に0件になる）。
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS1_REMOVE_DEBUFF",
          targets: ["ally:subject"],
          resultKind: "SKIPPED",
        },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS1_REMOVE_DEBUFF",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS1_MARKER",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS1_ATK_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS1_CRIT_DMG_UP",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS1_MARKER", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS1_ATK_UP", targets: ["ally:front"] },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS1_CRIT_DMG_UP",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS1_DEBUFF_IMMUNITY",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS1_DMG_REDUCE",
          targets: ["ally:subject"],
        },
      ],
      // (1000-500)×1.95=975。
      hpDeltas: { "enemy:front": -975 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS1_ATK_UP",
          // 闘志は付与直後の1個。0.04×1=0.04（対象自身の保有数を読む）。
          magnitude: 0.04,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS1_CRIT_DMG_UP",
          magnitude: 0.03,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS1_DEBUFF_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS1_DMG_REDUCE",
          magnitude: -0.15,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS1_ATK_UP",
          magnitude: 0.04,
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS1_CRIT_DMG_UP",
          magnitude: 0.03,
        },
      ],
      effectsRemoved: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_EX_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
      ],
      markers: [
        { unitId: "ally:subject", markerId: FIGHTING_SPIRIT, stackCount: 1 },
        { unitId: "ally:front", markerId: FIGHTING_SPIRIT, stackCount: 1 },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -2 },
        // R-ACT-03: ASのEXゲージ増加は消費APと同量（AP2消費→EX_GAUGE+2）。
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_AS2",
    intent: "敵単体に威力109.2で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS2_DAMAGE", targets: ["enemy:front"] },
      ],
      // (1000-500)×1.092=546。
      hpDeltas: { "enemy:front": -546 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_AS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_AS2",
    intent:
      "(分岐): 自身が「闘志」を4つ以上所持していた場合、対象に追加で威力46.8の攻撃を行い、さらに敵前衛に対しても威力54.6で攻撃をする",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_AS2" },
    board: SUBJECT_WITH_FOUR_FIGHTING_SPIRIT,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS2_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS2_BONUS_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS2_FRONT_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS2_FRONT_DAMAGE",
          targets: ["enemy:left"],
        },
      ],
      // 通常546 + 追加(1000-500)×0.468=234 = 780。敵前衛(front/left)は各(1000-500)×0.546=273。
      hpDeltas: { "enemy:front": -1053, "enemy:left": -273 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_AS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_AS2",
    intent: "(不成立分岐): 闘志が4つ未満の場合、追加攻撃は行わない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_AS2" },
    board: SUBJECT_WITH_ONE_FIGHTING_SPIRIT,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS2_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -546 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_AS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_PS1",
    intent:
      "「闘志」状態の味方が敵からの攻撃1ヒットで、最大HP×0.75%以上のダメージを負った際に発動。対象の味方単体のHPを威力25で回復し、対象の「闘志」を1つ解除する。さらに攻撃してきた敵単体に対し威力101.4で反撃する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_PS1",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:subject",
        skillType: "AS",
        power: 3,
        event: "HitPointReduced",
      }),
    },
    board: SUBJECT_WITH_ONE_FIGHTING_SPIRIT,
    // 「闘志」1個につきATK/会心ダメージバフ1組が連動するため、AS1が付与するのと
    // 同じバフ1組を前提として持たせる。
    precedingActions: [
      { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS1_ATK_UP", target: "SELF" },
      { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS1_CRIT_DMG_UP", target: "SELF" },
    ],
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_PS1_HEAL", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_PS1_REMOVE_MARKER",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_PS1_REMOVE_ATK_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_PS1_REMOVE_CRIT_DMG_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_PS1_COUNTER_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      // 契機の被弾(1000-500)×3=1500は基準線へ繰り込み済み。前提のATK+4%込みの
      // 攻撃力1040×0.25=260で回復、反撃は(1000-500)×1.014=507。
      hpDeltas: { "ally:subject": 260, "enemy:front": -507 },
      markersRemoved: [{ unitId: "ally:subject", markerId: FIGHTING_SPIRIT, stackCount: 1 }],
      // 「闘志」を1個消費すると、連動するバフ1組(ATK+4%/会心ダメージ+3%)も1個ずつ解除される。
      effectsRemoved: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS1_ATK_UP",
          magnitude: 0.04,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_AS1_CRIT_DMG_UP",
          magnitude: 0.03,
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        // R-ACT-03: PSのEXゲージ増加は消費PPと同量。
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_PS1",
    intent:
      "(境界): プレイアブル版の15%には遠く届かない最大HP×0.75%ちょうど（10000×0.0075=75）のダメージでも発動する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_PS1",
      trigger: hitPointReduced({
        source: "enemy:front",
        target: "ally:subject",
        damage: 75,
        hpBefore: 5000,
      }),
    },
    board: SUBJECT_WITH_ONE_FIGHTING_SPIRIT,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_PS1_HEAL", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_PS1_REMOVE_MARKER",
          targets: ["ally:subject"],
        },
        {
          // 連動バフを前提に持たせていないため解除対象が無くSKIPPEDになる。
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_PS1_REMOVE_ATK_UP",
          targets: ["ally:subject"],
          resultKind: "SKIPPED",
        },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_PS1_REMOVE_CRIT_DMG_UP",
          targets: ["ally:subject"],
          resultKind: "SKIPPED",
        },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_PS1_COUNTER_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      // 連動バフを持たない素の攻撃力1000×0.25=250で回復、反撃は(1000-500)×1.014=507。
      hpDeltas: { "ally:subject": 250, "enemy:front": -507 },
      markersRemoved: [{ unitId: "ally:subject", markerId: FIGHTING_SPIRIT, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_PS1",
    intent:
      "(不成立): 「闘志」を所持していない場合、1ヒットで最大HP×0.75%以上のダメージを負っても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_PS1",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:subject",
        skillType: "AS",
        power: 3,
        event: "HitPointReduced",
      }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_PS1",
    intent: "(不成立): 1ヒットのダメージが最大HP×0.75%に届かない場合は発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_PS1",
      trigger: hitPointReduced({
        source: "enemy:front",
        target: "ally:subject",
        damage: 74,
        hpBefore: 5000,
      }),
    },
    board: SUBJECT_WITH_ONE_FIGHTING_SPIRIT,
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_PS2",
    intent:
      "ターン開始時に発動。最もHPが低い敵単体に威力159で先制攻撃し、与えたダメージの30%分のシールドを自身に付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_PS2",
      trigger: { eventType: "TurnStarted", category: "FACT", payload: { turnNumber: 1 } },
    },
    board: { enemies: ENEMIES_WITH_MIXED_CURRENT_HP },
    expected: {
      // 現在HP最小はenemy:left(2000、最大HPは20000で割合10%とenemy:frontの
      // 30%より低いが、判定は割合ではなく絶対値なので現在HP2000が最小)。
      actions: [
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_PS2_DAMAGE", targets: ["enemy:left"] },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_PS2_SHIELD",
          targets: ["ally:subject"],
        },
      ],
      // (1000-500)×1.59=795。シールドは795×0.3=238.5→238(切り捨て)。
      hpDeltas: { "enemy:left": -795 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_PS2_SHIELD",
          magnitude: 238,
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_PS2",
    intent:
      "(回数制限なし): プレイアブル版の1戦闘1回制限を持たないため、2ターン目以降のターン開始でも同じように発動する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_HIIRO_FREEWOLF_TEX_PS2",
      trigger: { eventType: "TurnStarted", category: "FACT", payload: { turnNumber: 2 } },
      turnNumber: 2,
    },
    board: { enemies: ENEMIES_WITH_MIXED_CURRENT_HP },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_PS2_DAMAGE", targets: ["enemy:left"] },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_PS2_SHIELD",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: { "enemy:left": -795 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_TEX_PS2_SHIELD",
          magnitude: 238,
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
];

describe("production Catalog UNIT_HIIRO_FREEWOLF_TEX (破壊：榊野ヒイロ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-HIIRO-FREEWOLF-TEX-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-HIIRO-FREEWOLF-TEX-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-HIIRO-FREEWOLF-TEX-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-HIIRO-FREEWOLF-TEX-004: repeated AS1 self-grants scale the ATK/CRITICAL_DAMAGE_BONUS total linearly with the current Fighting Spirit stack count, capping at 8 stacks", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);

    // 2回分の自己付与: 闘志2個 → ATK+8%・会心ダメージ+6%（4%/3%の固定バフが2個分積み上がるだけ）。
    const afterTwo = applyPrecedingActions(board, [...ONE_AS1_SELF_GRANT, ...ONE_AS1_SELF_GRANT]);
    const subjectAfterTwo = afterTwo.find((unit) => unit.battleUnitId === SUBJECT_ID)!;
    expect(
      subjectAfterTwo.markerStates.find((marker) => marker.markerId === FIGHTING_SPIRIT)
        ?.stackCount,
    ).toBe(2);
    expect(subjectAfterTwo.combatStats.attack).toBe(BOARD_COMBAT_STATS.attack * 1.08);
    expect(subjectAfterTwo.combatStats.criticalDamageBonus).toBeCloseTo(
      BOARD_COMBAT_STATS.criticalDamageBonus + 2 * 0.03,
      10,
    );

    // 8回分（闘志の上限）: ATK+32%・会心ダメージ+24%で頭打ちになる。
    const eightGrants = Array.from({ length: 8 }, () => ONE_AS1_SELF_GRANT).flat();
    const afterEight = applyPrecedingActions(board, eightGrants);
    const subjectAfterEight = afterEight.find((unit) => unit.battleUnitId === SUBJECT_ID)!;
    expect(
      subjectAfterEight.markerStates.find((marker) => marker.markerId === FIGHTING_SPIRIT)
        ?.stackCount,
    ).toBe(8);
    expect(subjectAfterEight.combatStats.attack).toBe(BOARD_COMBAT_STATS.attack * 1.32);
    expect(subjectAfterEight.combatStats.criticalDamageBonus).toBeCloseTo(
      BOARD_COMBAT_STATS.criticalDamageBonus + 8 * 0.03,
      10,
    );

    // 9回目以降は闘志・バフの双方が8で頭打ちのまま変化しない。
    const nineGrants = Array.from({ length: 9 }, () => ONE_AS1_SELF_GRANT).flat();
    const afterNine = applyPrecedingActions(board, nineGrants);
    const subjectAfterNine = afterNine.find((unit) => unit.battleUnitId === SUBJECT_ID)!;
    expect(
      subjectAfterNine.markerStates.find((marker) => marker.markerId === FIGHTING_SPIRIT)
        ?.stackCount,
    ).toBe(8);
    expect(subjectAfterNine.combatStats.attack).toBe(subjectAfterEight.combatStats.attack);
    expect(subjectAfterNine.combatStats.criticalDamageBonus).toBeCloseTo(
      subjectAfterEight.combatStats.criticalDamageBonus,
      10,
    );
  });
});
