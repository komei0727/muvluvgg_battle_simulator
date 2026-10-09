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
  resetExecutedActionIds,
  type BoardOverrides,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  realDamage,
  skillUseCompleted,
  unitBeingAttacked,
} from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_OLGA_NADYA_BOND_TEX`（破壊：オルガ＆ナージャ・戦術演習版）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 戦術演習の敵専用（`category: EXERCISE_ENEMY`、R-TEX-11）で、原文はゲーム内
 * スクリーンショットからの転記。プレイアブル版 `UNIT_OLGA_NADYA_BOND` との差分は
 * Lv200固定ステータスに加えPS1「ストレラ+」の3点だけで、EX・AS1・AS2・PS2は威力・
 * 倍率・閾値ともに完全一致する（HP割合系1/20縮小は本ユニットには現れない —
 * シールドは攻撃力基準で、HP10%/40%は区間補間の閾値であり効果量ではない）。
 *
 * PS1の差分:
 * - 契機が「他の味方が」(`sourceSelector: "OTHER_ALLY"`)から「自身が」へ。Q-TEX-12に
 *   従い`"ALLY"`（自身を含む味方）へ変える。演習の敵陣営は単騎（Q-TEX-01）のため、
 *   `OTHER_ALLY`のままでは契機を出せる者が存在せずPS1が永久に発動しない。
 * - 攻撃した側の属性分岐（キュートまたはアグレッシブ）が撤廃され、常にPP回復と
 *   攻撃力35%上昇が付く。
 * - 活性化条件（自身のHP40%以上・AP2以上）が撤廃され、HP・APを問わず発動する。
 *
 * PS1の「回復したPPは削除される」の前提には`STUN`ではなく`FEE_ACTOR`の炎上
 * （`ACT_FEE_ACTOR_EX_BURN`）を借りる。STUNは対象自身の行動能力を止めるため、
 * 検証対象自身をSTUNさせるとPS自体が発動しなくなる。
 */

const UNIT_DEFINITION_ID = "UNIT_OLGA_NADYA_BOND_TEX";
const BURN_SOURCE_UNIT_ID = "UNIT_FEE_ACTOR";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  BURN_SOURCE_UNIT_ID,
]);

/** EXの「最もHPの多い敵」判定と「隣接する敵」を区別できる3体配置。 */
const EX_TARGETING_BOARD: BoardOverrides = {
  enemies: [
    { id: "enemy:high", position: { column: "CENTER", row: "FRONT" }, state: { currentHp: 8000 } },
    {
      id: "enemy:adjacent",
      position: { column: "LEFT", row: "FRONT" },
      state: { currentHp: 2000 },
    },
    { id: "enemy:far", position: { column: "RIGHT", row: "BACK" }, state: { currentHp: 5000 } },
  ],
};

/**
 * プレイアブル版の属性分岐が不成立になる攻撃者（シャイ属性）。TEX版では分岐自体が
 * 無いため、この盤面でもPP回復・攻撃力上昇が付くことが分岐撤廃の回帰ガードになる。
 */
const NON_MATCHING_ALLY: BoardOverrides = {
  allies: [
    { id: "ally:front", position: { column: "LEFT", row: "FRONT" }, attribute: "SHY" },
    { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
  ],
};

/** PS2の分岐が読む攻撃者の `ATTRIBUTE` を不成立側にする盤面。 */
const SHY_ATTACKER: BoardOverrides = {
  enemies: [{ id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, attribute: "SHY" }],
};

/**
 * Issue #687（R-ATR-04）: PS2の分岐が読む攻撃してくる敵の`ATTRIBUTE`を、メイン属性は
 * 不成立側（AGGRESSIVE）のまま、サブ属性だけSHYへ一致させる盤面。
 */
const SUB_ATTRIBUTE_MATCHING_ATTACKER: BoardOverrides = {
  enemies: [
    {
      id: "enemy:front",
      position: { column: "CENTER", row: "FRONT" },
      state: { subAttribute: "SHY" },
    },
  ],
};

/** (SKL_ID, スクショ原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_EX",
    intent:
      "最もHPの多い敵を対象として敵単体に威力234でEN攻撃し、1行動の気絶を付与する。また対象に隣接する敵に威力187.2でEN攻撃を行う。さらに自身が1回行動を終えるまでの間、対象全ての防御力を30%低下させる（重複可）。防御デバフは自身が倒れると解除される",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_EX" },
    board: EX_TARGETING_BOARD,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_EX_DAMAGE_MAIN",
          targets: ["enemy:high"],
        },
        { effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_EX_STUN", targets: ["enemy:high"] },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_EX_DEF_DOWN_MARKER",
          targets: ["enemy:high"],
        },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_EX_DEF_DOWN",
          targets: ["enemy:high"],
        },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_EX_DAMAGE_ADJACENT",
          targets: ["enemy:adjacent"],
        },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_EX_DEF_DOWN_MARKER",
          targets: ["enemy:adjacent"],
        },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_EX_DEF_DOWN",
          targets: ["enemy:adjacent"],
        },
      ],
      hpDeltas: {
        "enemy:high": -1170,
        "enemy:adjacent": -936,
      },
      effectsApplied: [
        {
          unitId: "enemy:high",
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_EX_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
        {
          unitId: "enemy:high",
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_EX_DEF_DOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:adjacent",
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_EX_DEF_DOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
      ],
      markers: [
        {
          unitId: "enemy:high",
          markerId: "MARKER_OLGA_NADYA_BOND_TEX_EX_DEF_DOWN",
          stackCount: 1,
        },
        {
          unitId: "enemy:adjacent",
          markerId: "MARKER_OLGA_NADYA_BOND_TEX_EX_DEF_DOWN",
          stackCount: 1,
        },
      ],
      // EXゲージは既定0から始まり消費コスト10を賄えないため、実際のリソース増減は
      // 発生しない（EXスキル自体の使用はAP/PP消費起因のEXゲージ加算対象外）。
    },
  },
  {
    skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_EX",
    intent: "(分岐): 隣接する敵がいなくても最もHPの多い敵単体へは通常どおり発動する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_EX" },
    board: {
      enemies: [
        {
          id: "enemy:only",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 8000 },
        },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_EX_DAMAGE_MAIN",
          targets: ["enemy:only"],
        },
        { effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_EX_STUN", targets: ["enemy:only"] },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_EX_DEF_DOWN_MARKER",
          targets: ["enemy:only"],
        },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_EX_DEF_DOWN",
          targets: ["enemy:only"],
        },
      ],
      hpDeltas: { "enemy:only": -1170 },
      effectsApplied: [
        {
          unitId: "enemy:only",
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_EX_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
        {
          unitId: "enemy:only",
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_EX_DEF_DOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
      ],
      markers: [
        {
          unitId: "enemy:only",
          markerId: "MARKER_OLGA_NADYA_BOND_TEX_EX_DEF_DOWN",
          stackCount: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_AS1",
    intent:
      "自身に攻撃力×50%のシールドを付与し、HPを威力50で回復する。シールド値は自身のHPが多いほど増加し（+20%まで）、HP10%時点を最小値とし、HP40%時点で最高値となる。回復量は自身のHPが少ないほど増加し（+30%まで）、HP40%時点を最小値とし、HP10%時点で最高値となる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_AS1" },
    board: { subject: { state: { currentHp: 2500 } } },
    expected: {
      // HP比率0.25は[0.1, 0.4]区間の中点 -> シールド・回復ともスケール半分。
      // シールド: 攻撃力1000×50%×(1+0.2×0.5)=550。回復: 攻撃力1000×50%×(1+0.3×0.5)=575。
      actions: [
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_AS1_SHIELD",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_AS1_HEAL",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: { "ally:subject": 575 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_AS1_SHIELD",
          magnitude: 550,
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_AS1",
    intent: "自身のHPが40%以上の場合、このスキルは発動しない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_AS1" },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_AS2",
    intent:
      "敵単体に威力190.8でEN攻撃する。自身のHPが40%以上の場合、このスキル中のみ自身の攻撃力を20%、与ダメージを5%増加させてから攻撃する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_AS2" },
    expected: {
      // (攻撃力1000×1.2 − 防御力500) × 1.908 × (1+0.05) = 700×1.908×1.05 ≒ 1402
      actions: [
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_AS2_ATK_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_AS2_DMG_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_AS2_DAMAGE",
          targets: ["enemy:front"],
        },
        // PS1の契機が「自身が」になったため、AS2の命中がそのままPS1へ連鎖する
        // （プレイアブル版は`OTHER_ALLY`限定でこの連鎖が起きない）。
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS1_PP_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS1_ATK_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS1_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      // AS2本体1402 + PS1追撃(攻撃力1000×1.35 − 500)×0.78=663 = 2065。
      hpDeltas: { "enemy:front": -2065 },
      // ATK_UP/DMG_UPはNEXT_OUTGOING_ATTACK消費のため、直後のDAMAGEステップ自身で
      // 消費・失効し、この観測窓の終了時点では既に保持していない
      // （= 効果が「このスキル中のみ」で終わっている証跡）。
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        // AS2のAP1消費分+1と、PS1のPP1消費分+1（PPは回復+1で相殺され正味0）。
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_AS2",
    intent: "(分岐): 自身のHPが40%未満の場合、攻撃力・与ダメージ上昇は付かない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_AS2" },
    board: { subject: { state: { currentHp: 3000 } } },
    expected: {
      // (攻撃力1000 − 防御力500) × 1.908 ≒ 954
      actions: [
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_AS2_DAMAGE",
          targets: ["enemy:front"],
        },
        // HP30%でもPS1は活性化条件を持たないため連鎖する。
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS1_PP_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS1_ATK_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS1_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      // AS2本体954 + PS1追撃663 = 1617。
      hpDeltas: { "enemy:front": -1617 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_PS1",
    intent:
      "自身がアクティブスキルで攻撃した後に発動。自身のPPを1回復し、このスキル中のみ自身の攻撃力を35%上昇させてから（重複可）、攻撃した敵単体に威力78でEN追撃する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_PS1",
      // 契機は自身のAS命中。`SkillUseCompleted`ではなく`DamageApplied`を見るため、
      // 実ダメージパイプラインを通す`realDamage`で契機を作る。
      trigger: realDamage({ from: "ally:subject", to: "enemy:front", skillType: "AS" }),
    },
    expected: {
      // (攻撃力1000×1.35 − 防御力500) × 0.78 = 850×0.78 = 663。
      // PPは +1（復元）− 1（発動コスト）で正味0のため resources に現れない。
      actions: [
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS1_PP_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS1_ATK_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS1_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: { "enemy:front": -663 },
      resources: [{ unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_PS1",
    intent:
      "(属性分岐の撤廃): 攻撃した側がキュート属性でもアグレッシブ属性でもない場合でも、PP回復・攻撃力上昇が付く",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_PS1",
      trigger: realDamage({ from: "ally:front", to: "enemy:front", skillType: "AS" }),
    },
    board: NON_MATCHING_ALLY,
    expected: {
      // プレイアブル版は属性不成立でバフが付かず390になる。TEX版は分岐が無いため663。
      actions: [
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS1_PP_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS1_ATK_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS1_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: { "enemy:front": -663 },
      resources: [{ unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_PS1",
    intent: "ただし自身が状態異常の場合、回復したPPは削除される",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_PS1",
      trigger: realDamage({ from: "ally:subject", to: "enemy:front", skillType: "AS" }),
    },
    precedingActions: [{ effectActionDefinitionId: "ACT_FEE_ACTOR_EX_BURN", target: "SELF" }],
    expected: {
      // PP_UP(+1)は実行されるがPP_DOWN(-1)で打ち消され、正味は発動コストの-1だけになる。
      actions: [
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS1_PP_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS1_ATK_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS1_PP_DOWN",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS1_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: { "enemy:front": -663 },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_PS1",
    intent:
      "(活性化条件の撤廃): プレイアブル版が持つ「自身のAPが2未満の場合は発動しない」を持たないため、AP1でも発動する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_PS1",
      trigger: realDamage({ from: "ally:subject", to: "enemy:front", skillType: "AS" }),
    },
    board: { subject: { state: { currentAp: 1 } } },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS1_PP_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS1_ATK_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS1_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: { "enemy:front": -663 },
      resources: [{ unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_PS1",
    intent:
      "(活性化条件の撤廃): プレイアブル版が持つ「自身のHPが40%未満の場合は発動しない」を持たないため、HP30%でも発動する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_PS1",
      trigger: realDamage({ from: "ally:subject", to: "enemy:front", skillType: "AS" }),
    },
    board: { subject: { state: { currentHp: 3000 } } },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS1_PP_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS1_ATK_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS1_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: { "enemy:front": -663 },
      resources: [{ unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_PS1",
    intent:
      "(回帰・PR #685レビュー[P1]): 敵を対象にしたAS使用であっても、実際にダメージを与えていなければ発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_PS1",
      // `SkillUseCompleted`はDAMAGEステップを持たないASでも発行される。triggerは
      // `DamageApplied`のみを見るため、このイベントは型自体が一致せず発動しない。
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
      }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_PS1",
    intent: "(不成立): 敵のアクティブスキル使用では発動しない（味方陣営限定）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:back", skillType: "AS" }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_PS2",
    intent: "自身が攻撃される直前に発動。敵の攻撃を30%ガードする",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_PS2",
      trigger: unitBeingAttacked({
        source: "enemy:front",
        target: "ally:subject",
        skillType: "AS",
      }),
    },
    // `enemy:front` は盤面既定でAGGRESSIVE属性のため、シャイ/スマート不成立側になる。
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS2_GUARD_30",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS2_GUARD_30",
          magnitude: -0.3,
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_PS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_PS2",
    intent: "攻撃してくる敵がシャイ属性またはスマート属性の場合、ガード率は75%になる",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_PS2",
      trigger: unitBeingAttacked({
        source: "enemy:front",
        target: "ally:subject",
        skillType: "AS",
      }),
    },
    board: SHY_ATTACKER,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS2_GUARD_75",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS2_GUARD_75",
          magnitude: -0.75,
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_PS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_PS2",
    intent:
      "(Issue #687, R-ATR-04回帰): 攻撃してくる敵のメイン属性が不一致でも、サブ属性がシャイ属性またはスマート属性と一致すればガード率は75%になる",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_PS2",
      trigger: unitBeingAttacked({
        source: "enemy:front",
        target: "ally:subject",
        skillType: "AS",
      }),
    },
    board: SUB_ATTRIBUTE_MATCHING_ATTACKER,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS2_GUARD_75",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_NADYA_BOND_TEX_PS2_GUARD_75",
          magnitude: -0.75,
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_OLGA_NADYA_BOND_TEX_PS2", remaining: 1 },
      ],
    },
  },
];

describe("production Catalog UNIT_OLGA_NADYA_BOND_TEX (破壊：オルガ＆ナージャ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-OLGA-NADYA-BOND-TEX-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-OLGA-NADYA-BOND-TEX-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-OLGA-NADYA-BOND-TEX-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
});
