import { describe, expect, it } from "vitest";
import { applyEffectActionGroups } from "../../../domain/battle/lifecycle/effect-action-group-resolver.js";
import { resolveSkillOrder } from "../../../domain/battle/skill/skill-resolution-service.js";
import type { BattleUnit } from "../../../domain/battle/model/battle-unit.js";
import {
  completedTargetIdsOf,
  effectActionGroupContext,
  loadProductionSnapshot,
  seedRecorder,
  skillFrom,
  unitFrom,
} from "../../../testing/fixtures/index.js";
import { removalDeclarationOf } from "../../../testing/production-unit/removal-declaration.js";
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
  type BoardUnitSpec,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { skillUseCompleted, turnStarted } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_NOEL_RUMBLE`(【体育祭の暴れん坊】ノエル・アルエ)のユニット単位production
 * 結合テスト(`12_テスト戦略.md`「ユニット効果軸」)。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_NOEL_RUMBLE";

// 混乱（R-CFS-01）を付与するproduction定義は `ACT_OLGA_VETERAN_EX_CONFUSION` の1件だけ。
// ノエル自身は自分にデバフを配らないため、PS2の「バフを**すべて**解除」が
// デバフを巻き込まないことの対照になる実 production のデバフを1件併せて読み込む
// （戦闘終了まで残るものにする — `timeLimit: ACTION` は保持者の行動で失効し得る）。
const SELF_DEBUFF_ACTION_ID = "ACT_SHOUKA_SCHEMER_PS1_ATK_DOWN";
const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  "UNIT_OLGA_VETERAN",
  "UNIT_SHOUKA_SCHEMER",
]);

/** 最も近い敵だけがEX1撃目で落ちる残HP。生存分岐の不成立側を作る。 */
const NEAREST_ENEMY_ALMOST_DEAD: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, state: { currentHp: 100 } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/**
 * 混乱（R-CFS-01）はASの`DAMAGE` stepのTargetSelectorを反転させ、
 * `SkillUseStarting`/`SkillUseCompleted.targetUnitIds` にも反転後の味方が入る。
 * 「自身がアクティブスキルで攻撃する」ことは変わらないため、この経路でもPSは
 * 発動しなければならない（契機の `targetSelector` を陣営で絞れない理由）。
 * 前提は実 production 定義で作る。
 */
const CONFUSED = [
  { effectActionDefinitionId: "ACT_OLGA_VETERAN_EX_CONFUSION", target: "SELF" },
] as const;

/** 混乱はその行動の`DAMAGE`で消費され、観測では解除として現れる。 */
const CONFUSION_CONSUMED = {
  unitId: "ally:subject",
  effectActionDefinitionId: "ACT_OLGA_VETERAN_EX_CONFUSION",
  magnitude: 0,
  timeLimit: { unit: "ACTION", count: 1 },
  statusKind: "CONFUSION",
} as const;

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_NOEL_RUMBLE_EX",
    intent:
      "最も近い位置にいる敵単体、および対象に隣接する敵に対し、威力275.6で攻撃する。攻撃後に最も近い位置にいる敵単体が生存していた場合、さらに敵単体に対して威力39でもう一度攻撃し、3行動分の炎上を付与する。炎上は攻撃力×30%の持続ダメージを与える",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NOEL_RUMBLE_EX" },
    expected: {
      // 自身は敵前列中央の正面に居るため最も近い敵は enemy:front。その直交隣接は
      // 同じ前列の enemy:left と真後ろの enemy:back。
      actions: [
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_EX_DAMAGE1", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_EX_DAMAGE1", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_EX_DAMAGE1", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_EX_DAMAGE2", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_EX_BURN", targets: ["enemy:front"] },
      ],
      // 1撃目1378（威力275.6%）、最も近い敵にはさらに2撃目195（威力39%）。
      hpDeltas: { "enemy:front": -1573, "enemy:left": -1378, "enemy:back": -1378 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_NOEL_RUMBLE_EX_BURN",
          magnitude: 300,
          timeLimit: { unit: "ACTION", count: 3 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NOEL_RUMBLE_EX",
    intent: "(不成立): 最も近い敵が1撃目で戦闘不能になった場合、2撃目と炎上は入らない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NOEL_RUMBLE_EX" },
    board: { enemies: NEAREST_ENEMY_ALMOST_DEAD },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_EX_DAMAGE1", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_EX_DAMAGE1", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_EX_DAMAGE1", targets: ["enemy:back"] },
      ],
      hpDeltas: { "enemy:front": -100, "enemy:left": -1378, "enemy:back": -1378 },
    },
  },
  {
    skillDefinitionId: "SKL_NOEL_RUMBLE_AS1",
    intent: "敵単体に威力162.24で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NOEL_RUMBLE_AS1" },
    expected: {
      // PS1（「自身がアクティブスキルで攻撃した直後に発動」）が使用完了の契機で走る。
      // 攻撃力上昇はこの攻撃の後に入るため、ダメージ自体は素の811のまま。
      actions: [
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_DMG_DOWN", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:front": -811 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_ATK_UP",
          magnitude: 0.18,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_DMG_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_NOEL_RUMBLE_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NOEL_RUMBLE_AS1",
    intent: "対象が炎上状態だった場合、この攻撃ダメージは50%増加する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NOEL_RUMBLE_AS1" },
    // 炎上は実 production 定義（EXが配る炎上）で用意する。
    precedingActions: [{ effectActionDefinitionId: "ACT_NOEL_RUMBLE_EX_BURN", target: "ENEMY" }],
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_NOEL_RUMBLE_AS1_DAMAGE_VS_BURNING",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_DMG_DOWN", targets: ["ally:subject"] },
      ],
      // 811（威力162.24%）の50%増しを、別定義の威力243.36%として持つ。
      hpDeltas: { "enemy:front": -1216 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_ATK_UP",
          magnitude: 0.18,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_DMG_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_NOEL_RUMBLE_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NOEL_RUMBLE_AS2",
    intent: "敵単体に威力212で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NOEL_RUMBLE_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_DMG_DOWN", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:front": -1060 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_ATK_UP",
          magnitude: 0.18,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_DMG_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NOEL_RUMBLE_PS1",
    intent:
      "自身がアクティブスキルで攻撃した直後に発動。自身の攻撃力を18%上昇させ(重複可)、被ダメージを15%減少させる効果を付与する(重複可)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NOEL_RUMBLE_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_NOEL_RUMBLE_AS2",
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_DMG_DOWN", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_ATK_UP",
          magnitude: 0.18,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_DMG_DOWN",
          magnitude: -0.15,
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
    skillDefinitionId: "SKL_NOEL_RUMBLE_PS1",
    intent: "(不成立): EXスキルの使用では発動しない(「アクティブスキルで」に限る)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NOEL_RUMBLE_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "EX",
        skillDefinitionId: "SKL_NOEL_RUMBLE_EX",
      }),
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_NOEL_RUMBLE_PS2",
    intent:
      "ターン開始時に発動。自身にかけられているバフをすべて解除し、自身のHPを威力50で回復する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NOEL_RUMBLE_PS2",
      trigger: turnStarted({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    // 解除対象のバフを実 production 定義（PS1の攻撃力上昇）で用意する。
    precedingActions: [{ effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_ATK_UP", target: "SELF" }],
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS2_REMOVE_BUFF", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS2_HEAL", targets: ["ally:subject"] },
      ],
      hpDeltas: { "ally:subject": 500 },
      effectsRemoved: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_ATK_UP",
          magnitude: 0.18,
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
    skillDefinitionId: "SKL_NOEL_RUMBLE_PS2",
    intent: "(不成立): このスキルは1ターン目には発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NOEL_RUMBLE_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_NOEL_RUMBLE_PS1",
    intent:
      "(発動): 混乱で攻撃対象が味方側へ反転しても、アクティブスキルで攻撃した事実は変わらず発動する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NOEL_RUMBLE_AS2" },
    precedingActions: CONFUSED,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_AS2_DAMAGE", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_DMG_DOWN", targets: ["ally:subject"] },
      ],
      // 1060（威力212%）に混乱の被ダメージ30%減少が掛かって742。
      hpDeltas: { "ally:subject": -742 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_ATK_UP",
          magnitude: 0.18,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_DMG_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      effectsRemoved: [CONFUSION_CONSUMED],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
    },
  },
];

describe("production Catalog UNIT_NOEL_RUMBLE (【体育祭の暴れん坊】ノエル・アルエ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-NOEL-RUMBLE-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-NOEL-RUMBLE-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-NOEL-RUMBLE-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-NOEL-RUMBLE-004 (R-EFF-02/R-SKL-07): AS1の炎上判定は単一BRANCHで一度だけ確定するため、強化ダメージの着弾と同時に連鎖が炎上を解除しても通常版は走らない", () => {
    const skillId = "SKL_NOEL_RUMBLE_AS1";
    const skill = skillFrom(snapshot, skillId);
    // 「条件」と「NOT(条件)」を2つのACTION stepへ分けると、`targetCondition`は各stepの
    // 連鎖の後に再評価されるため、強化版の適用中に条件が崩れると通常版まで走ってしまう。
    // 単一BRANCHにはその経路が構造的に存在しない。
    const steps = skill.resolution.kind === "IMMEDIATE" ? skill.resolution.steps : [];
    expect(steps.map((step) => step.kind)).toEqual(["BRANCH"]);

    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    // 炎上は実 production 定義（EXが配る炎上）で用意する。
    const baseline = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_NOEL_RUMBLE_EX_BURN", target: "ENEMY" },
    ]);
    const actor = baseline.find((unit) => unit.battleUnitId === "ally:subject")!;

    // 強化ダメージが着弾した瞬間に、PS連鎖が炎上を解除した状況を模す。
    const stripBurnOnDamage = (
      event: { readonly eventType: string },
      units: readonly BattleUnit[],
    ): readonly BattleUnit[] =>
      event.eventType === "DamageApplied"
        ? units.map((unit) =>
            unit.battleUnitId === "enemy:front" ? { ...unit, appliedEffects: [] } : unit,
          )
        : units;

    expect(
      baseline
        .find((unit) => unit.battleUnitId === "enemy:front")!
        .appliedEffects.map((effect) => effect.effectActionDefinitionId),
    ).toEqual(["ACT_NOEL_RUMBLE_EX_BURN"]);

    const { recorder, rootEventId } = seedRecorder("B_NOEL_BRANCH");
    const result = applyEffectActionGroups(
      resolveSkillOrder(
        skill,
        actor,
        baseline,
        board.definitions.effectActions,
        undefined,
        board.definitions.unitDefinitions,
      ),
      baseline,
      effectActionGroupContext({
        actor,
        skillId,
        definitions: board.definitions,
        recorder,
        rootEventId,
        extras: { onFactEventForPassiveChain: stripBurnOnDamage },
      }),
    );

    // 連鎖が実際に炎上を剥がしたことまで見ないと、フックが一度も呼ばれていない場合も
    // 「通常版が走らない」だけは成り立ってしまい、この検証が空振りする。
    expect(
      result.units.find((unit) => unit.battleUnitId === "enemy:front")!.appliedEffects,
    ).toEqual([]);
    expect(completedTargetIdsOf(recorder, "ACT_NOEL_RUMBLE_AS1_DAMAGE_VS_BURNING")).toEqual([
      "enemy:front",
    ]);
    expect(completedTargetIdsOf(recorder, "ACT_NOEL_RUMBLE_AS1_DAMAGE")).toEqual([]);
  });

  it("IT-UNIT-NOEL-RUMBLE-005 (R-EFF-02): PS2の「バフをすべて解除」は件数上限を持たず、バフ／デバフの別は `magnitude` の符号ではなく被ダメージ補正の向きで決まる", () => {
    // `-001` のPS2行は解除対象を1つしか持たないため、「すべて」も「1つまで」も
    // 同じ観測になる。上限が無いことは複数件でしか現れない。あわせて負の
    // `magnitude` を持つ被ダメージ**減少**（`direction: INCOMING`＝保持者に有利
    // ＝バフ）が解除され、同じく負の攻撃力デバフは残ることを1つの観測で並べる。
    // 「すべて」は上限の**不在**であり、実行結果からは「上限がたまたま投入件数と
    // 同じ」と区別できない。宣言そのものを固定して、`maxRemovals` の混入を落とす。
    expect(removalDeclarationOf(snapshot, "ACT_NOEL_RUMBLE_PS2_REMOVE_BUFF")).toEqual({
      categories: ["BUFF"],
      maxRemovals: null,
    });

    const grant = (effectActionDefinitionId: string) => ({
      effectActionDefinitionId,
      target: "SELF" as const,
    });
    const removedSelfEffect = (effectActionDefinitionId: string, magnitude: number) => ({
      unitId: "ally:subject",
      effectActionDefinitionId,
      magnitude,
      timeLimit: { unit: "BATTLE", count: 1 },
    });

    expect(
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use: {
          kind: "PASSIVE",
          skillDefinitionId: "SKL_NOEL_RUMBLE_PS2",
          trigger: turnStarted({ turnNumber: 2 }),
          triggeredBy: "ally:subject",
          turnNumber: 2,
        },
        precedingActions: [
          grant("ACT_NOEL_RUMBLE_PS1_ATK_UP"),
          grant("ACT_NOEL_RUMBLE_PS1_ATK_UP"),
          grant("ACT_NOEL_RUMBLE_PS1_DMG_DOWN"),
          grant("ACT_NOEL_RUMBLE_PS1_DMG_DOWN"),
          grant(SELF_DEBUFF_ACTION_ID),
        ],
      }),
    ).toEqual({
      actions: [
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS2_REMOVE_BUFF", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS2_HEAL", targets: ["ally:subject"] },
      ],
      // 回復は威力50%。残った攻撃力デバフ-3.5%の分だけ 500 から 482 へ落ちる。
      hpDeltas: { "ally:subject": 482 },
      effectsRemoved: [
        removedSelfEffect("ACT_NOEL_RUMBLE_PS1_ATK_UP", 0.18),
        removedSelfEffect("ACT_NOEL_RUMBLE_PS1_ATK_UP", 0.18),
        removedSelfEffect("ACT_NOEL_RUMBLE_PS1_DMG_DOWN", -0.15),
        removedSelfEffect("ACT_NOEL_RUMBLE_PS1_DMG_DOWN", -0.15),
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    });
  });
});
