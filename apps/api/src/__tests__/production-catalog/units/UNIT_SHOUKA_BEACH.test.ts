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
import { observeLifecycleDamageProbe } from "../../../testing/production-unit/damage-probe.js";
import { openPassiveChain } from "../../../testing/production-unit/passive-activation.js";
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { turnStarted, unitBeingAttacked } from "../../../testing/production-unit/trigger-events.js";
import { observeHitPointRatioCritical } from "../../../testing/production-unit/hit-point-ratio-critical-probe.js";

/**
 * `UNIT_SHOUKA_BEACH`（【砂浜の策謀家】姜小花）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 既存キャラクターの夏バリアントで、`characterId` は `UNIT_SHOUKA_SCHEMER` と同じ
 * `CHAR_SHOUKA_KYOU` を共有する。EXコストは9で、`extraGaugeMaximum` もこれに揃う。
 *
 * 注目点は3つ。
 *
 * 1. EXのダメージは「対象の現在HP×35%」と「自身の攻撃力×75%」の小さい方（`MIN`）で、
 *    さらに残AP有無で腕が変わる（AP消費+対象AP削り／対象の攻撃力低下）。
 * 2. AS1は `activationCondition` が2つの否定条件のANDで、HP50%以上でも「暑気」
 *    所持でも発動しない。解除対象はEX由来のダメージリンク1件で、`SPECIFIC_EFFECT`
 *    としてID指定する（PS2が味方へ配るリンクは小花自身が保持しないため対象外）。
 * 3. AS2は「暑気」の有無で全く別の効果になる。所持側はさらに撃破の有無で分岐する。
 *
 * 盤面は攻撃力1000・防御力500・現在HP5000/最大HP10000（`skill-behaviour.ts`）。
 */

const UNIT_DEFINITION_ID = "UNIT_SHOUKA_BEACH";
const SHOKI = "MARKER_SHOUKA_BEACH_SHOKI";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** AS1は「自身のHPが50%以上」だと発動しない。ちょうど50%を1だけ下回らせる。 */
const BELOW_HALF_HP = { subject: { state: { currentHp: 4999 } } };

/** PS2は戦闘中1度しか発動しない。発動済みの状態をcounterで作る。 */
const PS2_ALREADY_ACTIVATED = {
  subject: {
    state: {
      skillCounters: {
        [createSkillDefinitionId("SKL_SHOUKA_BEACH_PS2")]: {
          [createRuntimeCounterId("SKL_SHOUKA_BEACH_PS2_ACTIVATIONS")]: { value: 1, carry: 0 },
        },
      },
    },
  },
};

/** (SKL_ID, raw原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_SHOUKA_BEACH_EX",
    intent:
      "最もHP割合が高い敵単体に対し、対象の現在HP×35％のENダメージを与える攻撃を行う。この攻撃によるダメージは自身の攻撃力×75％を上限とする。加えて自身が1回行動を終えるまでの間自身と対象の間にリンクを付与し、自身が受けるダメージの25％を送り込む状態にする。さらに攻撃時点で自身にAPが残っていた場合、APを1消費して対象のAPを2削る",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_BEACH_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_EX_DAMAGE_LINK", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_EX_AP_COST", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_EX_AP_DRAIN", targets: ["enemy:front"] },
      ],
      // 現在HP5000の35%＝1750より、攻撃力1000の75%＝750の方が小さいため上限側が効く。
      hpDeltas: { "enemy:front": -750 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_EX_DAMAGE_LINK",
          magnitude: 0.25,
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
    skillDefinitionId: "SKL_SHOUKA_BEACH_EX",
    intent: "自身にAPが残っていなかった場合、2行動の間対象の攻撃力を25％低下させる（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_BEACH_EX" },
    board: { subject: { state: { currentAp: 0 } } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_EX_DAMAGE_LINK", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_EX_ATK_DOWN", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -750 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_EX_DAMAGE_LINK",
          magnitude: 0.25,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_EX_ATK_DOWN",
          magnitude: -0.25,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHOUKA_BEACH_AS1",
    intent:
      "自身に付与されているダメージリンクバフを全て解除し、自身の攻撃力を15％上昇させる。さらに自身に対し「暑気」を付与する（解除不可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_BEACH_AS1" },
    board: BELOW_HALF_HP,
    // 解除対象を実 production 定義（EXが自身へ付けるダメージリンク）で用意する。
    precedingActions: [
      {
        effectActionDefinitionId: "ACT_SHOUKA_BEACH_EX_DAMAGE_LINK",
        target: "SELF",
        payloadBindingIds: ["TGT_TARGET"],
      },
    ],
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_AS1_REMOVE_DAMAGE_LINK",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_AS1_ATK_UP", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_AS1_MARKER_SHOKI",
          targets: ["ally:subject"],
        },
      ],
      effectsRemoved: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_EX_DAMAGE_LINK",
          magnitude: 0.25,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_AS1_ATK_UP",
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
    skillDefinitionId: "SKL_SHOUKA_BEACH_AS1",
    intent: "(不成立): 自身のHPが50％以上の場合は発動しない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_BEACH_AS1" },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_SHOUKA_BEACH_AS1",
    intent: "(不成立): 自身が「暑気」を所持している場合は発動しない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_BEACH_AS1" },
    board: {
      subject: { state: { currentHp: 4999 }, markers: [{ markerId: SHOKI }] },
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_SHOUKA_BEACH_AS2",
    intent:
      "自身が「暑気」を所持していない場合、自身に対し1行動の間、最大HP×10％のシールドを付与する。さらに敵前列に対し1行動の間、与ダメージを5％減少させるデバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_BEACH_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_AS2_SHIELD", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_AS2_FRONT_DMG_DOWN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_AS2_FRONT_DMG_DOWN",
          targets: ["enemy:left"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_AS2_SHIELD",
          magnitude: 1000,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_AS2_FRONT_DMG_DOWN",
          magnitude: -0.05,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_AS2_FRONT_DMG_DOWN",
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
    skillDefinitionId: "SKL_SHOUKA_BEACH_AS2",
    intent:
      "自身が「暑気」を所持している場合、敵単体に威力31.8で5ヒットEN攻撃し、与えたダメージの40％分自身のHPを回復する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_BEACH_AS2" },
    board: { subject: { markers: [{ markerId: SHOKI }] } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_AS2_DRAIN_HEAL", targets: ["ally:subject"] },
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
    skillDefinitionId: "SKL_SHOUKA_BEACH_AS2",
    intent: "この攻撃によって敵を倒した場合、追加で最大HPの7.5％分自身のHPを回復する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_BEACH_AS2" },
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
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_AS2_DRAIN_HEAL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_AS2_KILL_HEAL", targets: ["ally:subject"] },
      ],
      // 1ヒット目（159）が残HP100の enemy:front を倒し、超過59は破棄される（R-SHD-03）。
      // 吸収は破棄前の与ダメージ159×40%＝63で、撃破時の追加回復は最大HP10000の
      // 7.5%＝750。合計813。
      hpDeltas: { "enemy:front": -100, "ally:subject": 813 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHOUKA_BEACH_PS1",
    intent:
      "自身がアクティブスキルで敵から攻撃される直前に発動。この行動内での自分の防御力を最高17％上昇させる。防御バフは自分のHPが多いほど高い効果を発揮する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SHOUKA_BEACH_PS1",
      // `UnitBeingAttacked` は命中判定・ダメージ計算より**前**に発行される
      // （`observeHitSteps`）。`realDamage` は攻撃を最後まで完了させてから
      // 記録済みイベントを流すため、ここで使うと被弾後のHPで `HP_RATIO_SCALE` を
      // 評価してしまう。この行は契機・対象・期間宣言を固定する目的なので、契機
      // イベントだけを渡して評価点を production と揃える。実タイミングでの付与量と
      // 同一ヒットへの反映は `-004` が実pipelineで固定する。
      trigger: unitBeingAttacked({
        source: "enemy:front",
        target: "ally:subject",
        skillType: "AS",
      }),
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_PS1_DEF_UP", targets: ["ally:subject"] },
      ],
      // 被弾前の現在HP5000/最大HP10000＝50%。0〜0.17をHP割合で線形補間して0.085。
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_PS1_DEF_UP",
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
    skillDefinitionId: "SKL_SHOUKA_BEACH_PS2",
    intent:
      "ターン開始時に発動。自分の最大HPを80％上昇させ（解除不可）、自身と自身以外の味方全体に対してダメージリンクを付与し、自身以外の味方が受けたダメージの75％を自身に転送する状態にする",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SHOUKA_BEACH_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_PS2_MAX_HP_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_PS2_DAMAGE_LINK", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_SHOUKA_BEACH_PS2_DAMAGE_LINK", targets: ["ally:back"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_PS2_MAX_HP_UP",
          magnitude: 0.8,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_PS2_DAMAGE_LINK",
          magnitude: 0.75,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_PS2_DAMAGE_LINK",
          magnitude: 0.75,
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
    skillDefinitionId: "SKL_SHOUKA_BEACH_PS2",
    intent: "(不成立): このスキルは戦闘中に1度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SHOUKA_BEACH_PS2",
      trigger: turnStarted({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
    },
    board: PS2_ALREADY_ACTIVATED,
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_SHOUKA_BEACH_AS2",
    intent: "同上: 敵前列がいなくても、自身へのシールド付与は成立する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHOUKA_BEACH_AS2" },
    board: { enemies: [{ id: "enemy:back", position: { column: "CENTER", row: "BACK" } }] },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_AS2_SHIELD",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHOUKA_BEACH_AS2_SHIELD",
          magnitude: 1000,
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
];

describe("production Catalog UNIT_SHOUKA_BEACH (【砂浜の策謀家】姜小花)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-SHOUKA-BEACH-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-SHOUKA-BEACH-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-SHOUKA-BEACH-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-SHOUKA-BEACH-004 (R-DMG-04): PS1は被弾**前**のHPで防御バフを評価し、そのバフが同じヒットのダメージ計算へ入る", () => {
    // 「この行動内での自分の防御力を最高17%上昇させる」は、実 pipeline の
    // `UnitBeingAttacked`（命中判定・ダメージ計算より前）でPS連鎖が解決されて
    // はじめて意味を持つ。契機イベントを手組みする `-001` は評価点だけを揃えており、
    // 「同じヒットへ効くこと」までは見ていない。ここは実ダメージ経路の
    // `onFactEventForPassiveChain` へ実PS連鎖を挿し、防御上昇が同一ヒットの
    // `DamageCalculated` に反映されることを固定する。
    const strike = (currentHp: number, withPassive: boolean) => {
      const board = productionBoard(snapshot, UNIT_DEFINITION_ID, {
        subject: { state: { currentHp } },
      });
      const chain = openPassiveChain({
        definitions: board.definitions,
        actorUnitId: "enemy:front",
        battleId: `B_SHOUKA_PS1_${currentHp}_${withPassive}`,
      });
      return observeLifecycleDamageProbe({
        definitions: board.definitions,
        units: board.units,
        attackerUnitId: "enemy:front",
        targetUnitId: "ally:subject",
        power: 2,
        ...(withPassive
          ? {
              onFactEventForPassiveChain: (event, units) => chain.fireRecorded(event, units),
            }
          : {}),
      });
    };

    // 満タン（被弾前HP割合1.0）なら上限の17%。`realDamage` 経由の観測が返す
    // 0.1615（被弾後95%）ではない。
    const full = strike(10000, true);
    const fullBuff = full.units
      .find((unit) => unit.battleUnitId === "ally:subject")!
      .appliedEffects.find(
        (effect) => effect.effectActionDefinitionId === "ACT_SHOUKA_BEACH_PS1_DEF_UP",
      );
    expect(fullBuff?.magnitude).toBeCloseTo(0.17, 6);

    // 同じヒットのダメージ計算に反映される: 防御力500が+17%の585へ上がり、
    // 威力2の攻撃は (1000 - 585) × 2 = 830 になる（PSなしなら (1000 - 500) × 2 = 1000）。
    const withoutPassive = strike(10000, false);
    expect(withoutPassive.effectiveDefense.effectiveDefense).toBe(500);
    expect(withoutPassive.hpDeltas["ally:subject"]).toBe(-1000);
    expect(full.effectiveDefense.effectiveDefense).toBe(585);
    expect(full.hpDeltas["ally:subject"]).toBe(-830);

    // HP割合が下がるほど防御バフも小さくなる（定数ではなく `HP_RATIO_SCALE`）。
    const half = strike(5000, true);
    expect(
      half.units
        .find((unit) => unit.battleUnitId === "ally:subject")!
        .appliedEffects.find(
          (effect) => effect.effectActionDefinitionId === "ACT_SHOUKA_BEACH_PS1_DEF_UP",
        )?.magnitude,
    ).toBeCloseTo(0.085, 6);
  });

  it("IT-UNIT-SHOUKA-BEACH-005 [R-CRT-04] (R-CRT-04): EXの「対象の現在HP×35%のENダメージ」は会心判定を行わない — AS2の威力ベース攻撃は従来どおり会心する", () => {
    const probe = (effectActionDefinitionId: string, skillDefinitionId: string) =>
      observeHitPointRatioCritical({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        effectActionDefinitionId,
        skillDefinitionId,
        attackerHoldsCriticalGuarantee: false,
        battleId: `B_SHOUKA_BEACH_CRT04_${effectActionDefinitionId}`,
      });

    // 会心率100%の盤面。規則に掛かる側だけが会心判定へ進まず、抽選も1本少ない。
    const ruled = probe("ACT_SHOUKA_BEACH_EX_DAMAGE", "SKL_SHOUKA_BEACH_EX");
    const control = probe("ACT_SHOUKA_BEACH_AS2_DAMAGE", "SKL_SHOUKA_BEACH_AS2");

    expect(ruled.criticalMode).toBe("PREVENTED");
    expect(ruled.isCritical).toBe(false);
    expect(ruled.criticalMultiplier).toBe(1);
    expect(control.criticalMode).toBe("NORMAL");
    expect(control.isCritical).toBe(true);
    expect(control.criticalMultiplier).toBeGreaterThan(1);
    expect(control.randomDraws - ruled.randomDraws).toBe(1);
  });
});
