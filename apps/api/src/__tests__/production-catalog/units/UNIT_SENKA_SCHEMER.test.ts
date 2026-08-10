import { describe, expect, it } from "vitest";
import { applyEffectActionGroups } from "../../../domain/battle/lifecycle/effect-action-group-resolver.js";
import { createBattleUnitId } from "../../../domain/shared/ids.js";
import { resolveSkillOrder } from "../../../domain/battle/skill/skill-resolution-service.js";
import {
  completedTargetIdsOf,
  effectActionGroupContext,
  initialSnapshotFor,
  loadProductionSnapshot,
  reconstruct,
  seedRecorder,
  skillFrom,
  unitFrom,
} from "../../../testing/fixtures/index.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import { observeContinuousDamage } from "../../../testing/production-unit/continuous-damage.js";
import {
  PRODUCTION_CATALOG_DIR,
  applyPrecedingActions,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardUnitSpec,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { realDamage, unitDefeated } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_SENKA_SCHEMER`(【自称腹黒の深謀策士】姫川泉花)のユニット単位production
 * 結合テスト(`12_テスト戦略.md`「ユニット効果軸」)。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_SENKA_SCHEMER";

/**
 * 炎上はシールドで受けない（R-DOT-04第2項・R-SUB-01・R-LNK-02）。シールドが1枚も
 * 無い盤面ではこの主張が空振りするため、泉花自身が配らないシールドを実 production
 * 定義で用意できるよう、供給元のユニットだけを併せて読み込む。`-002`／`-003` は
 * このユニットのSkill・EffectAction閉包だけを見るため、閉包の判定には影響しない。
 */
const SHIELD_SOURCE_UNIT_ID = "UNIT_AOI_GUARDIAN";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  SHIELD_SOURCE_UNIT_ID,
]);

/** HP割合が1体だけ低い敵陣。EXの `LOWEST_HP_RATIO` の判別用。 */
const ENEMY_LEFT_LOWEST_HP: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, state: { currentHp: 2000 } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** 同じ陣で、対象がEXの1撃目で落ちる残HP。生存分岐の不成立側を作る。 */
const ENEMY_LEFT_ALMOST_DEAD: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, state: { currentHp: 100 } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_SENKA_SCHEMER_EX",
    intent:
      "最もHP割合の低い敵を対象とし、対象が含まれる敵横一列に威力170.64で攻撃する。攻撃後に対象が生存していた場合、対象に対し、威力47.4でもう一度攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SENKA_SCHEMER_EX" },
    board: { enemies: ENEMY_LEFT_LOWEST_HP },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SENKA_SCHEMER_EX_DAMAGE_ROW", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SENKA_SCHEMER_EX_DAMAGE_ROW", targets: ["enemy:left"] },
        {
          effectActionDefinitionId: "ACT_SENKA_SCHEMER_EX_DAMAGE_FOLLOWUP",
          targets: ["enemy:left"],
        },
      ],
      // 横一列は853（威力170.64%）ずつ。対象へはさらに追撃237（威力47.4%）。
      hpDeltas: { "enemy:front": -853, "enemy:left": -1090 },
    },
  },
  {
    skillDefinitionId: "SKL_SENKA_SCHEMER_EX",
    intent: "(不成立): 対象が横一列の攻撃で戦闘不能になった場合、追撃は行われない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SENKA_SCHEMER_EX" },
    board: { enemies: ENEMY_LEFT_ALMOST_DEAD },
    expected: {
      // 敵が倒れたことがPS2（「敵が倒された際に発動」）の契機になり、同じ行動の中で
      // PS2が実際に走る。
      actions: [
        { effectActionDefinitionId: "ACT_SENKA_SCHEMER_EX_DAMAGE_ROW", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SENKA_SCHEMER_PS2_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SENKA_SCHEMER_PS2_HEALING_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SENKA_SCHEMER_PS2_DMG_DOWN", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SENKA_SCHEMER_EX_DAMAGE_ROW", targets: ["enemy:left"] },
      ],
      hpDeltas: { "enemy:front": -853, "enemy:left": -100 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SENKA_SCHEMER_PS2_ATK_UP",
          magnitude: 0.2,
          timeLimit: { unit: "ACTION", count: 3 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SENKA_SCHEMER_PS2_HEALING_UP",
          magnitude: 0.4,
          timeLimit: { unit: "ACTION", count: 3 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SENKA_SCHEMER_PS2_DMG_DOWN",
          magnitude: -0.3,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SENKA_SCHEMER_AS1",
    intent:
      "敵単体に威力42.4で5ヒット攻撃し、3行動分の炎上を付与する。炎上は攻撃力×30%の持続ダメージを与える",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SENKA_SCHEMER_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SENKA_SCHEMER_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SENKA_SCHEMER_AS1_BURN", targets: ["enemy:front"] },
      ],
      // 1ヒット212（威力42.4%）×5ヒット。
      hpDeltas: { "enemy:front": -1060 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SENKA_SCHEMER_AS1_BURN",
          magnitude: 300,
          timeLimit: { unit: "ACTION", count: 3 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SENKA_SCHEMER_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SENKA_SCHEMER_AS2",
    intent: "敵単体に威力190.8で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SENKA_SCHEMER_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SENKA_SCHEMER_AS2_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -954 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SENKA_SCHEMER_PS1",
    intent:
      "自身が攻撃を受けた直後に発動。2行動の間自身の攻撃力を20%、行動速度を100上昇させる(重複可)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SENKA_SCHEMER_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "AS" }),
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SENKA_SCHEMER_PS1_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SENKA_SCHEMER_PS1_SPD_UP", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SENKA_SCHEMER_PS1_ATK_UP",
          magnitude: 0.2,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SENKA_SCHEMER_PS1_SPD_UP",
          magnitude: 100,
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
    skillDefinitionId: "SKL_SENKA_SCHEMER_PS1",
    intent: "(不成立): 他の味方が攻撃を受けても発動しない(「自身が」に限る)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SENKA_SCHEMER_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:front", skillType: "AS" }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_SENKA_SCHEMER_PS2",
    intent:
      "敵が倒された際に発動。自身に対し、3行動の間攻撃力を20%、受ける回復量を40%上昇させるバフを付与する(重複可)。さらに次に受ける攻撃のダメージを30%減少させる効果を付与する(重複可)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SENKA_SCHEMER_PS2",
      trigger: unitDefeated({ unit: "enemy:front", defeatedBy: "ally:subject" }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SENKA_SCHEMER_PS2_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SENKA_SCHEMER_PS2_HEALING_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SENKA_SCHEMER_PS2_DMG_DOWN", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SENKA_SCHEMER_PS2_ATK_UP",
          magnitude: 0.2,
          timeLimit: { unit: "ACTION", count: 3 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SENKA_SCHEMER_PS2_HEALING_UP",
          magnitude: 0.4,
          timeLimit: { unit: "ACTION", count: 3 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SENKA_SCHEMER_PS2_DMG_DOWN",
          magnitude: -0.3,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SENKA_SCHEMER_PS2",
    intent: "(不成立): 味方が倒された際には発動しない(「敵が」に限る)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SENKA_SCHEMER_PS2",
      trigger: unitDefeated({ unit: "ally:front", defeatedBy: "enemy:front" }),
      triggeredBy: "enemy:front",
    },
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_SENKA_SCHEMER (【自称腹黒の深謀策士】姫川泉花)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-SENKA-SCHEMER-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-SENKA-SCHEMER-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-SENKA-SCHEMER-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-SENKA-SCHEMER-004 (R-SKL-07, R-ACTN-03): EXの実 `IS_ALIVE` BRANCHは `EffectStepStarting` を1件だけ発行し、その StateDelta だけからも独立Reducerが同じHPを復元する", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, {
      enemies: ENEMY_LEFT_LOWEST_HP,
    });
    const skill = skillFrom(snapshot, "SKL_SENKA_SCHEMER_EX");
    const { recorder, rootEventId } = seedRecorder("B_SENKA_BRANCH");
    const result = applyEffectActionGroups(
      resolveSkillOrder(
        skill,
        board.subject,
        board.units,
        board.definitions.effectActions,
        undefined,
        board.definitions.unitDefinitions,
      ),
      board.units,
      effectActionGroupContext({
        actor: board.subject,
        skillId: "SKL_SENKA_SCHEMER_EX",
        definitions: board.definitions,
        recorder,
        rootEventId,
      }),
    );

    expect(
      recorder
        .getEvents()
        .filter(
          (event) =>
            event.eventType === "EffectStepStarting" &&
            (event.payload as { stepKind?: string }).stepKind === "BRANCH",
        ),
    ).toHaveLength(1);
    expect(completedTargetIdsOf(recorder, "ACT_SENKA_SCHEMER_EX_DAMAGE_FOLLOWUP")).toEqual([
      "enemy:left",
    ]);

    const reconstructed = reconstruct(initialSnapshotFor(board.units), recorder);
    for (const battleUnitId of ["enemy:front", "enemy:left"].map((id) => createBattleUnitId(id))) {
      const updated = result.units.find((unit) => unit.battleUnitId === battleUnitId)!;
      expect(reconstructed.units[battleUnitId]?.hp).toBe(updated.currentHp);
    }
  });
  it("IT-UNIT-SENKA-SCHEMER-005 (R-DOT-01/R-DOT-03): AS1が配る炎上は保持者自身の行動開始で発生し、付与時攻撃力×30%をシールドに一切吸われずHPへ通す。3つ重なった保持者では各インスタンスが2倍になる", () => {
    // `-001` のAS1行は付与そのもの（`magnitude: 300`・3行動）までを固定する。
    // **発生**は保持者の以後の行動に属するためスキル使用1回の観測には載らない。
    // ここが引き受けるのは (1) 発生の契機が保持者自身の行動開始であること、
    // (2) 炎上はシールドで受けないこと（R-DOT-04第2項・R-SUB-01）、
    // (3) R-DOT-03の3つ重複での2倍、(4) 公開差分だけからの復元である。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    // 前提アクションは既定順の最も近い敵（enemy:front）だけへ入る。実 production の
    // シールド（攻撃力×120%＝1200）を同じ相手へ張り、炎上が素通りする対照にする。
    const burning = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_AOI_GUARDIAN_AS1_SHIELD", target: "ENEMY" },
      { effectActionDefinitionId: "ACT_SENKA_SCHEMER_AS1_BURN", target: "ENEMY" },
    ]);
    const single = observeContinuousDamage({
      units: burning,
      definitions: board.definitions,
      // 保持者の行動開始と、炎上を持たない別の敵の行動開始を並べる。
      actors: ["enemy:front", "enemy:left"],
      battleId: "B_SENKA_BURN",
    });

    expect(single.steps).toEqual([
      {
        step: "ACTION_START(enemy:front)",
        ticks: [
          {
            unitId: "enemy:front",
            effectActionDefinitionId: "ACT_SENKA_SCHEMER_AS1_BURN",
            continuousDamageKind: "BURN",
            damageType: "PHYSICAL",
            // R-DOT-01: 付与時の付与者攻撃力スナップショット。
            snapshotAttack: 1000,
            formulaResult: 300,
            burnStackMultiplier: 1,
            cappedBySnapshotAttack: false,
            calculatedDamage: 300,
            // R-DOT-04第2項／R-SUB-01: 1200のシールドが張ってあっても炎上は素通りする。
            typedShieldAbsorbed: 0,
            untypedShieldAbsorbed: 0,
            subUnitAbsorbed: 0,
            discardedDamage: 0,
            hitPointDamage: 300,
          },
        ],
        hpDeltas: { "enemy:front": -300 },
      },
      // 炎上を持たない敵の行動開始では何も起きない。
      { step: "ACTION_START(enemy:left)", ticks: [], hpDeltas: {} },
    ]);
    // シールドは1点も減っていない（吸収0の裏づけ）。
    expect(
      single.units
        .find((unit) => unit.battleUnitId === "enemy:front")!
        .appliedEffects.find(
          (effect) => effect.effectActionDefinitionId === "ACT_AOI_GUARDIAN_AS1_SHIELD",
        )!.shield?.remaining,
    ).toBe(1200);

    // R-DOT-03「炎上は最大3つまで保持し、3つ保持している場合は各インスタンスの
    // ダメージをそれぞれ2倍にする」。合計を後から2倍にするのではないため、
    // 3件が600ずつ発生する。
    const tripled = observeContinuousDamage({
      units: applyPrecedingActions(board, [
        { effectActionDefinitionId: "ACT_SENKA_SCHEMER_AS1_BURN", target: "ENEMY" },
        { effectActionDefinitionId: "ACT_SENKA_SCHEMER_AS1_BURN", target: "ENEMY" },
        { effectActionDefinitionId: "ACT_SENKA_SCHEMER_AS1_BURN", target: "ENEMY" },
      ]),
      definitions: board.definitions,
      actors: ["enemy:front"],
      battleId: "B_SENKA_BURN_TRIPLE",
    });
    expect(
      tripled.steps[0]!.ticks.map((tick) => ({
        burnStackMultiplier: tick.burnStackMultiplier,
        calculatedDamage: tick.calculatedDamage,
      })),
    ).toEqual([
      { burnStackMultiplier: 2, calculatedDamage: 600 },
      { burnStackMultiplier: 2, calculatedDamage: 600 },
      { burnStackMultiplier: 2, calculatedDamage: 600 },
    ]);
    expect(tripled.steps[0]!.hpDeltas).toEqual({ "enemy:front": -1800 });

    // 公開差分だけを当て直しても同じHPへ復元できる。
    const reconstructed = reconstruct(initialSnapshotFor(burning), single.recorder);
    for (const unit of single.units) {
      expect(reconstructed.units[unit.battleUnitId]?.hp).toBe(unit.currentHp);
    }
  });
});
