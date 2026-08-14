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
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  resetExecutedActionIds,
  type BoardOverrides,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { turnStarted, unitBeingAttacked } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_SHOUKA_BEACH_TEX`（【砂浜の策謀家】姜小花・戦術演習版）のユニット単位production結合
 * テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * このユニットは戦術演習の敵専用（`category: EXERCISE_ENEMY`、R-TEX-11）で、原文は
 * `raw/units/` のwiki転記ではなく**ゲーム内スクリーンショットからの転記**である。
 * `intent` はそのスクリーンショットの効果説明文で、転記が正しいかをレビューできる
 * 唯一の接点になる。プレイアブル版 `UNIT_SHOUKA_BEACH` との差分は、ステータスと
 * EXのリンク率25%→2.5%・AS1+のダメージリンク解除ステップの削除・AS2のシールド
 * 最大HP10%→0.5%／撃破時回復7.5%→0.38%・PS2+の味方全体ダメージリンクの削除である。
 *
 * 盤面は攻撃力1000・防御力500・現在HP5000/最大HP10000（`skill-behaviour.ts`）。
 */

const UNIT_DEFINITION_ID = "UNIT_SHOUKA_BEACH_TEX";
const SHOKI = "MARKER_SHOUKA_BEACH_TEX_SHOKI";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** AS1は「自身のHPが50%以上」だと発動しない。ちょうど50%を1だけ下回らせる。 */
const BELOW_HALF_HP = { subject: { state: { currentHp: 4999 } } };

/** 敵前列が1体も居ない盤面。AS2の暑気なし側デバフが空集合になる。 */
const BACK_ROW_ONLY_ENEMIES: BoardOverrides = {
  enemies: [{ id: "enemy:back", position: { column: "CENTER", row: "BACK" } }],
};

/** PS2は戦闘中1度しか発動しない。発動済みの状態をcounterで作る。 */
const PS2_ALREADY_ACTIVATED = {
  subject: {
    state: {
      skillCounters: {
        [createSkillDefinitionId("SKL_SHOUKA_BEACH_TEX_PS2")]: {
          [createRuntimeCounterId("SKL_SHOUKA_BEACH_TEX_PS2_ACTIVATIONS")]: { value: 1, carry: 0 },
        },
      },
    },
  },
};

/** (SKL_ID, スクリーンショット原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_EX",
    intent:
      "最もHP割合が高い敵単体に対し、対象の現在HP×35%のENダメージを与える攻撃を行う。この攻撃によるダメージは自身の攻撃力×75%を上限とする。加えて自身が1回行動を終えるまでの間自身と対象の間にリンクを付与し、自身が受けるダメージの2.5%を送り込む状態にする。さらに攻撃時点で自身にAPが残っていた場合、APを1消費して対象のAPを2削る",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_EX_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_EX_DAMAGE_LINK",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_EX_AP_COST", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_EX_AP_DRAIN", targets: ["enemy:front"] },
      ],
      // 現在HP5000の35%＝1750より、攻撃力1000の75%＝750の方が小さいため上限側が効く。
      hpDeltas: { "enemy:front": -750 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_EX_DAMAGE_LINK",
          magnitude: 0.025,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "enemy:front", resource: "AP", delta: -2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_EX",
    intent: "(上限に掛からない側): 対象の現在HP×35%が攻撃力×75%を下回る場合はHP割合側が効く",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_EX" },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 2000 },
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        // `HIGHEST_HP_RATIO` は満タンの enemy:left を選ぶ——ではなく、削れている
        // enemy:front を避けた結果として左前列が対象になる。
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_EX_DAMAGE", targets: ["enemy:left"] },
        {
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_EX_DAMAGE_LINK",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_EX_AP_COST", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_EX_AP_DRAIN", targets: ["enemy:left"] },
      ],
      hpDeltas: { "enemy:left": -750 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_EX_DAMAGE_LINK",
          magnitude: 0.025,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "enemy:left", resource: "AP", delta: -2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_EX",
    intent: "自身にAPが残っていなかった場合、2行動の間対象の攻撃力を25%低下させる（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_EX" },
    board: { subject: { state: { currentAp: 0 } } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_EX_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_EX_DAMAGE_LINK",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_EX_ATK_DOWN", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -750 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_EX_DAMAGE_LINK",
          magnitude: 0.025,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_EX_ATK_DOWN",
          magnitude: -0.25,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_AS1",
    intent: "自身の攻撃力を15%上昇させる。さらに自身に対し「暑気」を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_AS1" },
    board: BELOW_HALF_HP,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_AS1_ATK_UP", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_AS1_MARKER_SHOKI",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_AS1_ATK_UP",
          magnitude: 0.15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: SHOKI, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_AS1",
    intent: "(不成立): 自身のHPが50%以上の場合は発動しない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_AS1" },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_AS1",
    intent: "(不成立): 自身が「暑気」を所持している場合は発動しない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_AS1" },
    board: {
      subject: { state: { currentHp: 4999 }, markers: [{ markerId: SHOKI }] },
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_AS2",
    intent:
      "自身が「暑気」を所持していない場合、自身に対し1行動の間、最大HP×0.5%のシールドを付与する。さらに敵前列に対し1行動の間、与ダメージを5%減少させるデバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_AS2_SHIELD", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_AS2_FRONT_DMG_DOWN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_AS2_FRONT_DMG_DOWN",
          targets: ["enemy:left"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_AS2_SHIELD",
          // 最大HP10000の0.5%＝50（プレイアブル版の10%＝1000との差分点）。
          magnitude: 50,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_AS2_FRONT_DMG_DOWN",
          magnitude: -0.05,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_AS2_FRONT_DMG_DOWN",
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
    skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_AS2",
    intent:
      "(不成立・敵前列が不在): 前列デバフの束縛が空集合になるため、スキル自体が選択されない（R-TGT-01 #4）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_AS2" },
    board: BACK_ROW_ONLY_ENEMIES,
    // 演習では味方編成が前列を持たない構成もあり得る。暑気の有無に関わらず
    // `TGT_ENEMY_FRONT` は宣言されるため、前列不在では暑気所持側の攻撃も含めて
    // AS2そのものが行動候補から落ちる（プレイアブル版と同じ既存挙動）。
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_AS2",
    intent:
      "自身が「暑気」を所持している場合、敵単体に威力31.8で5ヒットEN攻撃し、与えたダメージの40%分自身のHPを回復する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_AS2" },
    board: { subject: { markers: [{ markerId: SHOKI }] } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_AS2_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_AS2_DRAIN_HEAL",
          targets: ["ally:subject"],
        },
      ],
      // (1000-500)×0.318=159を5ヒットで795。回復はその40%＝318。
      hpDeltas: { "enemy:front": -795, "ally:subject": 318 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_AS2",
    intent: "この攻撃によって敵を倒した場合、追加で最大HPの0.38%分自身のHPを回復する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_AS2" },
    board: {
      subject: { markers: [{ markerId: SHOKI }] },
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 100 },
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_AS2_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_AS2_DRAIN_HEAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_AS2_KILL_HEAL",
          targets: ["ally:subject"],
        },
      ],
      // 1ヒット目（159）が残HP100の enemy:front を倒し、超過59は破棄される（R-SHD-03）。
      // 吸収は破棄前の与ダメージ159×40%＝63で、撃破時の追加回復は最大HP10000の
      // 0.38%＝38（プレイアブル版の7.5%＝750との差分点）。合計101。
      hpDeltas: { "enemy:front": -100, "ally:subject": 101 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_PS1",
    intent:
      "自身がアクティブスキルで敵から攻撃される直前に発動。この行動内での自分の防御力を最高17%上昇させる。防御バフは自身のHPが多いほど高い効果を発揮する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_PS1",
      // `UnitBeingAttacked` は命中判定・ダメージ計算より**前**に発行される。
      // 契機イベントだけを渡して評価点を production と揃える。
      trigger: unitBeingAttacked({
        source: "enemy:front",
        target: "ally:subject",
        skillType: "AS",
      }),
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_PS1_DEF_UP", targets: ["ally:subject"] },
      ],
      // 被弾前の現在HP5000/最大HP10000＝50%。0〜0.17をHP割合で線形補間して0.085。
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_PS1_DEF_UP",
          magnitude: 0.085,
          timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_PS2",
    intent: "ターン開始時に発動。自分の最大HPを80%上昇させる（解除不可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_PS2_MAX_HP_UP",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_PS2_MAX_HP_UP",
          magnitude: 0.8,
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
    skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_PS2",
    intent: "(不成立): このスキルは戦闘中に1度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_PS2",
      trigger: turnStarted({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
    },
    board: PS2_ALREADY_ACTIVATED,
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_SHOUKA_BEACH_TEX (【砂浜の策謀家】姜小花・戦術演習版)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-SHOUKA-BEACH-TEX-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-SHOUKA-BEACH-TEX-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-SHOUKA-BEACH-TEX-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-SHOUKA-BEACH-TEX-004: AS1で得た「暑気」がAS2の腕を切り替える — 同じ盤面でAS1→AS2と続けると、シールド側ではなく攻撃側が走る", () => {
    // `-001` は暑気の有無を盤面の前提として与えるため、AS1が実際に配った暑気が
    // AS2の `BRANCH` を切り替えるところは見ていない。2スキル分の状態遷移は
    // `precedingActions` に本物のAS1を挟んで初めて固定できる。
    const observed = observeSkillUse({
      snapshot,
      unitDefinitionId: UNIT_DEFINITION_ID,
      use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_BEACH_TEX_AS2" },
      board: BELOW_HALF_HP,
      precedingActions: [
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_TEX_AS1_MARKER_SHOKI", target: "SELF" },
      ],
    });

    expect(observed.actions?.map((action) => action.effectActionDefinitionId)).toEqual([
      "ACT_SHOUKA_BEACH_TEX_AS2_DAMAGE",
      "ACT_SHOUKA_BEACH_TEX_AS2_DRAIN_HEAL",
    ]);
    // 暑気なし側のシールドと前列デバフはどちらも走らない。
    expect(observed.effectsApplied).toBeUndefined();
  });

  it("IT-UNIT-SHOUKA-BEACH-TEX-005: TEX版はダメージリンク解除（AS1）も味方全体へのダメージリンク（PS2）も持たない", () => {
    // 演習敵は単騎で、原文にもどちらの記載も無い。プレイアブル版から機械的に
    // 写すと到達不能なEffectActionが残るため、**存在しないこと**を閉包で固定する。
    const closure = [...unitEffectActionClosure(snapshot, UNIT_DEFINITION_ID)].sort();
    expect(closure).toEqual([
      "ACT_SHOUKA_BEACH_TEX_AS1_ATK_UP",
      "ACT_SHOUKA_BEACH_TEX_AS1_MARKER_SHOKI",
      "ACT_SHOUKA_BEACH_TEX_AS2_DAMAGE",
      "ACT_SHOUKA_BEACH_TEX_AS2_DRAIN_HEAL",
      "ACT_SHOUKA_BEACH_TEX_AS2_FRONT_DMG_DOWN",
      "ACT_SHOUKA_BEACH_TEX_AS2_KILL_HEAL",
      "ACT_SHOUKA_BEACH_TEX_AS2_SHIELD",
      "ACT_SHOUKA_BEACH_TEX_EX_AP_COST",
      "ACT_SHOUKA_BEACH_TEX_EX_AP_DRAIN",
      "ACT_SHOUKA_BEACH_TEX_EX_ATK_DOWN",
      "ACT_SHOUKA_BEACH_TEX_EX_DAMAGE",
      "ACT_SHOUKA_BEACH_TEX_EX_DAMAGE_LINK",
      "ACT_SHOUKA_BEACH_TEX_PS1_DEF_UP",
      "ACT_SHOUKA_BEACH_TEX_PS2_MAX_HP_UP",
    ]);
  });
});
