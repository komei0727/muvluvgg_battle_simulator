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
  type BoardUnitSpec,
  type PrecedingAction,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { hitPointReduced, realDamage } from "../../../testing/production-unit/trigger-events.js";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";

/**
 * `UNIT_HIIRO_FREEWOLF`（【疾走する自由の狐狼】榊野ヒイロ）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * `CHAR_HIIRO_SAKAKINO`の2バリアント目（`UNIT_HIIRO_LONEWOLF`「緋色の一匹狼」と
 * 同一キャラクター）。Issue #674で追加した`LOWEST_CURRENT_HP`ターゲット順序・
 * `APPLY_MARKER.decay`のproduction初使用であり、PS2の行が対象選択を検証する
 * （decayは`MEM_FATHERS_AND_MY_WISH`側の付与が対象のため、当ユニット自身の
 * `APPLY_MARKER`は宣言しない）。
 */

const UNIT_DEFINITION_ID = "UNIT_HIIRO_FREEWOLF";
const FIGHTING_SPIRIT = "MARKER_HIIRO_FREEWOLF_FIGHTING_SPIRIT";
const BRAND = "MARKER_HIIRO_FREEWOLF_BRAND";

/** ヒイロ自身の「烙印」付与を検証するため、`UNIT_HIIRO_LONEWOLF`のSTUN定義を借りてAS1のREMOVE_EFFECTSの前提を作る。 */
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

const PS2_SKILL_ID = createSkillDefinitionId("SKL_HIIRO_FREEWOLF_PS2");
const PS2_ACTIVATIONS_COUNTER_ID = createRuntimeCounterId("SKL_HIIRO_FREEWOLF_PS2_ACTIVATIONS");

/** PS2は「戦闘中1度しか発動できない」。カウンタを1に置いて2回目を作る。 */
const PS2_ALREADY_ACTIVATED: BoardOverrides = {
  subject: {
    state: {
      skillCounters: { [PS2_SKILL_ID]: { [PS2_ACTIVATIONS_COUNTER_ID]: { value: 1, carry: 0 } } },
    },
  },
};

/** (SKL_ID, raw原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_HIIRO_FREEWOLF_EX",
    intent: "敵単体に威力200.8で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_HIIRO_FREEWOLF_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_EX_DAMAGE", targets: ["enemy:front"] },
      ],
      // (1000-500)×2.008=1004。
      hpDeltas: { "enemy:front": -1004 },
    },
  },
  {
    skillDefinitionId: "SKL_HIIRO_FREEWOLF_EX",
    intent: "(分岐): この攻撃で敵を倒した場合、敵全体に威力110.44の追加攻撃を行う",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_HIIRO_FREEWOLF_EX" },
    board: { enemies: ENEMY_FRONT_ALMOST_DEAD },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_EX_DAMAGE", targets: ["enemy:front"] },
        {
          // 倒した当の敵は戦闘不能のため追加攻撃の対象から外れる。
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_EX_AOE_DAMAGE",
          targets: ["enemy:front"],
          resultKind: "SKIPPED",
        },
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_EX_AOE_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_EX_AOE_DAMAGE", targets: ["enemy:back"] },
      ],
      // enemy:frontは残HP500で即死。enemy:left/backは(1000-500)×1.1044=552。
      hpDeltas: { "enemy:front": -500, "enemy:left": -552, "enemy:back": -552 },
    },
  },
  {
    skillDefinitionId: "SKL_HIIRO_FREEWOLF_AS1",
    intent:
      "敵単体に威力195で攻撃する（回避不可）。さらに自身の横一列味方に付与されているデバフを3つ解除し、自身含む横一列の味方に「闘志」を1つ付与する（最大8つ、1つにつき攻撃力4%・会心ダメージ3%増加、重複可）。さらに自身に1行動デバフ無効と次に受ける攻撃のダメージ15%減少を付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_HIIRO_FREEWOLF_AS1" },
    board: ONE_FRONT_ROW_ALLY,
    precedingActions: ALLY_STUNNED,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_AS1_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_AS1_REMOVE_DEBUFF",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_AS1_MARKER",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_AS1_ATK_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_AS1_CRIT_DMG_UP",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_AS1_MARKER", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_AS1_ATK_UP", targets: ["ally:front"] },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_AS1_CRIT_DMG_UP",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_AS1_DEBUFF_IMMUNITY",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_AS1_DMG_REDUCE",
          targets: ["ally:subject"],
        },
      ],
      // (1000-500)×1.95=975。
      hpDeltas: { "enemy:front": -975 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_AS1_ATK_UP",
          // 闘志は付与直後の1個。0.04×1=0.04（対象自身の保有数を読む）。
          magnitude: 0.04,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_AS1_CRIT_DMG_UP",
          magnitude: 0.03,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_AS1_DEBUFF_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_AS1_DMG_REDUCE",
          magnitude: -0.15,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_AS1_ATK_UP",
          magnitude: 0.04,
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_AS1_CRIT_DMG_UP",
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
        { unitId: "ally:subject", skillDefinitionId: "SKL_HIIRO_FREEWOLF_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_HIIRO_FREEWOLF_AS2",
    intent: "敵単体に威力109.2で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_HIIRO_FREEWOLF_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_AS2_DAMAGE", targets: ["enemy:front"] },
      ],
      // (1000-500)×1.092=546。
      hpDeltas: { "enemy:front": -546 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_HIIRO_FREEWOLF_AS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_HIIRO_FREEWOLF_AS2",
    intent:
      "(分岐): 自身が「闘志」を4つ以上所持していた場合、対象に追加で威力46.8の攻撃を行い、さらに敵前衛に対しても威力54.6で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_HIIRO_FREEWOLF_AS2" },
    board: SUBJECT_WITH_FOUR_FIGHTING_SPIRIT,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_AS2_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_AS2_BONUS_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_AS2_FRONT_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_AS2_FRONT_DAMAGE",
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
        { unitId: "ally:subject", skillDefinitionId: "SKL_HIIRO_FREEWOLF_AS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_HIIRO_FREEWOLF_AS2",
    intent: "(不成立分岐): 闘志が4つ未満の場合、追加攻撃は行わない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_HIIRO_FREEWOLF_AS2" },
    board: SUBJECT_WITH_ONE_FIGHTING_SPIRIT,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_AS2_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -546 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_HIIRO_FREEWOLF_AS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_HIIRO_FREEWOLF_PS1",
    intent:
      "「闘志」状態の味方が敵から1ヒットで最大HP×15%以上のダメージを負った際に発動。対象のHPを威力25で回復し「闘志」を1つ解除する。さらに攻撃してきた敵単体に威力101.4で反撃する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_HIIRO_FREEWOLF_PS1",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:subject",
        skillType: "AS",
        power: 3,
        event: "HitPointReduced",
      }),
    },
    board: SUBJECT_WITH_ONE_FIGHTING_SPIRIT,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_PS1_HEAL", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_PS1_REMOVE_MARKER",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_PS1_COUNTER_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      // 契機の被弾(1000-500)×3=1500は基準線へ繰り込み済み。回復は自身の攻撃力1000×0.25=250、
      // 反撃は(1000-500)×1.014=507。
      hpDeltas: { "ally:subject": 250, "enemy:front": -507 },
      markersRemoved: [{ unitId: "ally:subject", markerId: FIGHTING_SPIRIT, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        // R-ACT-03: PSのEXゲージ増加は消費PPと同量。
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_HIIRO_FREEWOLF_PS1",
    intent:
      "(不成立): 「闘志」を所持していない場合、1ヒットで最大HP×15%以上のダメージを負っても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_HIIRO_FREEWOLF_PS1",
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
    skillDefinitionId: "SKL_HIIRO_FREEWOLF_PS1",
    intent: "(不成立): 1ヒットのダメージが最大HP×15%に届かない場合は発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_HIIRO_FREEWOLF_PS1",
      trigger: hitPointReduced({
        source: "enemy:front",
        target: "ally:subject",
        damage: 1499,
        hpBefore: 5000,
      }),
    },
    board: SUBJECT_WITH_ONE_FIGHTING_SPIRIT,
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_HIIRO_FREEWOLF_PS2",
    intent:
      "ターン開始時に発動。最もHPが低い敵単体に威力159で先制攻撃して「烙印」を付与し、与えたダメージの30%分のシールドを付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_HIIRO_FREEWOLF_PS2",
      trigger: { eventType: "TurnStarted", category: "FACT", payload: { turnNumber: 1 } },
    },
    board: { enemies: ENEMIES_WITH_MIXED_CURRENT_HP },
    expected: {
      // 現在HP最小はenemy:left(2000、最大HPは20000で割合10%とenemy:frontの
      // 30%より低いが、判定は割合ではなく絶対値なので現在HP2000が最小)。
      actions: [
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_PS2_DAMAGE", targets: ["enemy:left"] },
        {
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_PS2_MARKER_BRAND",
          targets: ["enemy:left"],
        },
        { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_PS2_SHIELD", targets: ["ally:subject"] },
      ],
      // (1000-500)×1.59=795。シールドは795×0.3=238.5→238(切り捨て)。
      hpDeltas: { "enemy:left": -795 },
      markers: [{ unitId: "enemy:left", markerId: BRAND, stackCount: 1 }],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_PS2_SHIELD",
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
    skillDefinitionId: "SKL_HIIRO_FREEWOLF_PS2",
    intent: "(不成立): 戦闘中に1度発動済みの場合、再度のターン開始では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_HIIRO_FREEWOLF_PS2",
      trigger: { eventType: "TurnStarted", category: "FACT", payload: { turnNumber: 2 } },
      turnNumber: 2,
    },
    board: PS2_ALREADY_ACTIVATED,
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_HIIRO_FREEWOLF (【疾走する自由の狐狼】榊野ヒイロ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-HIIRO-FREEWOLF-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-HIIRO-FREEWOLF-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-HIIRO-FREEWOLF-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
