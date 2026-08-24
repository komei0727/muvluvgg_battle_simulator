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
  type BoardUnitSpec,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { skillUseCompleted, turnStarted } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_JULIE_SNOW`（【雪山もこもこ少女】ジュリー・ステイシー）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 *
 * PS2「防寒はバッチリ！」は自身のAS/EX完了を契機にするため、AS/EXの行にはこの
 * PS連鎖が必ず現れる。
 */

const UNIT_DEFINITION_ID = "UNIT_JULIE_SNOW";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** 敵前列だけHP割合を35%以下にした配置。 */
const LOW_HP_FRONT: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, state: { currentHp: 3500 } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** 3ヒット分（1053）でちょうど全滅する敵配置。 */
const ENEMIES_DYING_TO_FIRST_VOLLEY: readonly BoardUnitSpec[] = (
  [
    { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
    { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
    { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
  ] as const
).map((enemy) => ({ ...enemy, state: { currentHp: 1053 } }));

/** PS2の連鎖が敵1体へ付ける炎上と回復量デバフ。 */
function burnAndHealingDown(unitId: string) {
  return [
    {
      unitId,
      effectActionDefinitionId: "ACT_JULIE_SNOW_PS2_BURN",
      magnitude: 300,
      timeLimit: { unit: "ACTION", count: 2 },
    },
    {
      unitId,
      effectActionDefinitionId: "ACT_JULIE_SNOW_PS2_HEALING_DOWN",
      magnitude: -0.3,
      timeLimit: { unit: "ACTION", count: 2 },
    },
  ] as const;
}

/**
 * PS2の連鎖が実行するEffectAction。回復量デバフは「対象が既に保持していれば付与
 * しない」`targetCondition` を持つ別stepに分かれているため、炎上が全対象分そろって
 * から回復量デバフが全対象分続く順になる。
 */
function ps2Actions(...unitIds: readonly string[]) {
  return [
    ...unitIds.map((unitId) => ({
      effectActionDefinitionId: "ACT_JULIE_SNOW_PS2_BURN",
      targets: [unitId],
    })),
    ...unitIds.map((unitId) => ({
      effectActionDefinitionId: "ACT_JULIE_SNOW_PS2_HEALING_DOWN",
      targets: [unitId],
    })),
  ] as const;
}

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_JULIE_SNOW_EX",
    intent:
      "敵3体に威力70.2で3ヒットEN攻撃する。加えて自身に対し、次に敵から受ける攻撃を一度だけ無効にする効果と、次の行動を終えるまでの間自身に向けられるデバフを無効にするバフを付与する。さらに攻撃後に敵が生存していた場合、同範囲に追加で威力90の攻撃をする",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_JULIE_SNOW_EX" },
    expected: {
      // 1ヒット351×3ヒット＝1053に、追加の450を重ねる。
      actions: [
        { effectActionDefinitionId: "ACT_JULIE_SNOW_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_JULIE_SNOW_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_JULIE_SNOW_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_JULIE_SNOW_EX_IMMUNITY", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_JULIE_SNOW_EX_DEBUFF_IMMUNITY",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_JULIE_SNOW_EX_DAMAGE_FOLLOWUP", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_JULIE_SNOW_EX_DAMAGE_FOLLOWUP", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_JULIE_SNOW_EX_DAMAGE_FOLLOWUP", targets: ["enemy:back"] },
        ...ps2Actions("enemy:front", "enemy:left", "enemy:back"),
      ],
      hpDeltas: {
        "enemy:front": -1503,
        "enemy:left": -1503,
        "enemy:back": -1503,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_JULIE_SNOW_EX_IMMUNITY",
          magnitude: 0,
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
          statusKind: "DAMAGE_IMMUNITY",
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_JULIE_SNOW_EX_DEBUFF_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        ...burnAndHealingDown("enemy:front"),
        ...burnAndHealingDown("enemy:left"),
        ...burnAndHealingDown("enemy:back"),
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_JULIE_SNOW_PS2", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_JULIE_SNOW_EX",
    intent: "(分岐): 攻撃後に敵が生存していなければ、追加の攻撃は行わない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_JULIE_SNOW_EX" },
    board: { enemies: ENEMIES_DYING_TO_FIRST_VOLLEY },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_JULIE_SNOW_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_JULIE_SNOW_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_JULIE_SNOW_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_JULIE_SNOW_EX_IMMUNITY", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_JULIE_SNOW_EX_DEBUFF_IMMUNITY",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1053,
        "enemy:left": -1053,
        "enemy:back": -1053,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_JULIE_SNOW_EX_IMMUNITY",
          magnitude: 0,
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
          statusKind: "DAMAGE_IMMUNITY",
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_JULIE_SNOW_EX_DEBUFF_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      // PS2自体は発動するが、攻撃した敵が全員倒れているため対象が残らない。
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_JULIE_SNOW_PS2", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_JULIE_SNOW_AS1",
    intent:
      "敵前後列に威力190.8でEN攻撃し、与えたダメージの20%分自身のHPを回復する。さらに自身に対し、次に受ける攻撃の被ダメージを15%減少させる効果を付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_JULIE_SNOW_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_JULIE_SNOW_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_JULIE_SNOW_AS1_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_JULIE_SNOW_AS1_HEAL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_JULIE_SNOW_AS1_DMG_DOWN", targets: ["ally:subject"] },
        ...ps2Actions("enemy:front", "enemy:back"),
      ],
      // 回復は与えた合計1908の20%。
      hpDeltas: {
        "ally:subject": 381,
        "enemy:front": -954,
        "enemy:back": -954,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_JULIE_SNOW_AS1_DMG_DOWN",
          magnitude: -0.15,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
        ...burnAndHealingDown("enemy:front"),
        ...burnAndHealingDown("enemy:back"),
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_JULIE_SNOW_AS1", remaining: 1 },
        { unitId: "ally:subject", skillDefinitionId: "SKL_JULIE_SNOW_PS2", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_JULIE_SNOW_AS2",
    intent:
      "敵単体に威力212でEN攻撃し、3行動の間、行動時に攻撃力×10%のENダメージを受けるデバフを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_JULIE_SNOW_AS2" },
    expected: {
      // 対象のHPは50%なので、追加攻撃の腕は選ばれない。
      actions: [
        { effectActionDefinitionId: "ACT_JULIE_SNOW_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_JULIE_SNOW_AS2_DOT", targets: ["enemy:front"] },
        ...ps2Actions("enemy:front"),
      ],
      hpDeltas: {
        "enemy:front": -1060,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_JULIE_SNOW_AS2_DOT",
          magnitude: 100,
          timeLimit: { unit: "ACTION", count: 3 },
        },
        ...burnAndHealingDown("enemy:front"),
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_JULIE_SNOW_PS2", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_JULIE_SNOW_AS2",
    intent: "さらに攻撃時に対象のHPが35%以下だった場合、追加で威力31.2のEN攻撃を行う",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_JULIE_SNOW_AS2" },
    board: { enemies: LOW_HP_FRONT },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_JULIE_SNOW_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_JULIE_SNOW_AS2_DOT", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_JULIE_SNOW_AS2_FOLLOWUP", targets: ["enemy:front"] },
        ...ps2Actions("enemy:front"),
      ],
      // 1060に追加の156を重ねる。
      hpDeltas: {
        "enemy:front": -1216,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_JULIE_SNOW_AS2_DOT",
          magnitude: 100,
          timeLimit: { unit: "ACTION", count: 3 },
        },
        ...burnAndHealingDown("enemy:front"),
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_JULIE_SNOW_PS2", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_JULIE_SNOW_PS1",
    intent:
      "ターン開始時に発動。自分よりもHP割合が高い相手から攻撃された場合にのみ被ダメージを10%減少させる効果を付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_JULIE_SNOW_PS1",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      // 自身のHPは50%なので、EXゲージ加算の腕は選ばれない。
      actions: [
        { effectActionDefinitionId: "ACT_JULIE_SNOW_PS1_DMG_DOWN", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_JULIE_SNOW_PS1_DMG_DOWN",
          magnitude: -0.1,
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
    skillDefinitionId: "SKL_JULIE_SNOW_PS1",
    intent: "さらに自身のHPが35%以下の場合、自身のEXゲージを1加算する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_JULIE_SNOW_PS1",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    board: { subject: { state: { currentHp: 3000 } } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_JULIE_SNOW_PS1_DMG_DOWN", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_JULIE_SNOW_PS1_EX_UP", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_JULIE_SNOW_PS1_DMG_DOWN",
          magnitude: -0.1,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
      // PS発動分の+1と、この腕の+1。
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_JULIE_SNOW_PS2",
    intent:
      "自身がアクティブスキルまたはEXスキルで攻撃した後に発動。攻撃した敵単体に対して2行動の炎上と、2行動の間回復量を30%減少させるデバフを付与する。炎上は攻撃力×30%の持続ダメージを与える",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_JULIE_SNOW_PS2",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:left"],
        skillType: "AS",
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [...ps2Actions("enemy:left")],
      effectsApplied: [...burnAndHealingDown("enemy:left")],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_JULIE_SNOW_PS2", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_JULIE_SNOW_PS2",
    intent: "(不成立): パッシブスキルの解決では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_JULIE_SNOW_PS2",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:left"],
        skillType: "PS",
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      activated: false,
    },
  },
];

describe("production Catalog UNIT_JULIE_SNOW (【雪山もこもこ少女】ジュリー・ステイシー)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-JULIE-SNOW-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-JULIE-SNOW-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-JULIE-SNOW-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-JULIE-SNOW-004 [R-SKL-06] (Q-CAT-EFF-16): PS2の回復量30%減少は原文に「重複可」が無く重複しない — 対象が既に保持していれば付与stepごと実行されない", () => {
    // `APPLY_HEALING_MOD` は `STACKABLE` しか受理せず合成側で最強1件を選ぶ経路が
    // 無いため、2件目を作らないことで重複なしへ揃える（`targetCondition` のfalse側）。
    const observed = observeSkillUse({
      snapshot,
      unitDefinitionId: UNIT_DEFINITION_ID,
      use: {
        kind: "PASSIVE",
        skillDefinitionId: "SKL_JULIE_SNOW_PS2",
        trigger: skillUseCompleted({
          actor: "ally:subject",
          targets: ["enemy:front"],
          skillType: "AS",
        }),
        triggeredBy: "ally:subject",
      },
      precedingActions: [
        { effectActionDefinitionId: "ACT_JULIE_SNOW_PS2_HEALING_DOWN", target: "ENEMY" },
      ],
    });

    expect(observed.actions?.map((action) => action.effectActionDefinitionId) ?? []).not.toContain(
      "ACT_JULIE_SNOW_PS2_HEALING_DOWN",
    );
    // 炎上は原文が別の効果として並べており、ガードの対象ではない。
    expect(observed.actions?.map((action) => action.effectActionDefinitionId) ?? []).toContain(
      "ACT_JULIE_SNOW_PS2_BURN",
    );
  });

  it("IT-UNIT-JULIE-SNOW-005 [R-SKL-06] (BOUNDARY, Q-CAT-EFF-16, R-SKL-06): 契機が複数の敵へ解決するとき、既に保持している対象だけが除外され、残りには付与される", () => {
    // `TGT_ATTACKED` は `TRIGGER_TARGET` で複数体へ解決するため `BRANCH`
    // （step全体を一度だけ評価する）では表せない。ACTIONの `targetCondition` は
    // 対象ごとに評価されるという、この選択そのものを固定する。
    // 前提アクションは `ENEMY_ONE`（`DEFAULT`順の1体＝`enemy:front`）へ解決する。
    const observed = observeSkillUse({
      snapshot,
      unitDefinitionId: UNIT_DEFINITION_ID,
      use: {
        kind: "PASSIVE",
        skillDefinitionId: "SKL_JULIE_SNOW_PS2",
        trigger: skillUseCompleted({
          actor: "ally:subject",
          targets: ["enemy:front", "enemy:left", "enemy:back"],
          skillType: "AS",
        }),
        triggeredBy: "ally:subject",
      },
      precedingActions: [
        { effectActionDefinitionId: "ACT_JULIE_SNOW_PS2_HEALING_DOWN", target: "ENEMY" },
      ],
    });

    // 炎上は3体すべてへ。回復量デバフは保持していない2体だけへ。
    expect(observed.actions).toEqual([
      { effectActionDefinitionId: "ACT_JULIE_SNOW_PS2_BURN", targets: ["enemy:front"] },
      { effectActionDefinitionId: "ACT_JULIE_SNOW_PS2_BURN", targets: ["enemy:left"] },
      { effectActionDefinitionId: "ACT_JULIE_SNOW_PS2_BURN", targets: ["enemy:back"] },
      { effectActionDefinitionId: "ACT_JULIE_SNOW_PS2_HEALING_DOWN", targets: ["enemy:left"] },
      { effectActionDefinitionId: "ACT_JULIE_SNOW_PS2_HEALING_DOWN", targets: ["enemy:back"] },
    ]);
    expect(
      observed.effectsApplied?.filter(
        (effect) => effect.effectActionDefinitionId === "ACT_JULIE_SNOW_PS2_HEALING_DOWN",
      ),
    ).toEqual([
      {
        unitId: "enemy:left",
        effectActionDefinitionId: "ACT_JULIE_SNOW_PS2_HEALING_DOWN",
        magnitude: -0.3,
        timeLimit: { unit: "ACTION", count: 2 },
      },
      {
        unitId: "enemy:back",
        effectActionDefinitionId: "ACT_JULIE_SNOW_PS2_HEALING_DOWN",
        magnitude: -0.3,
        timeLimit: { unit: "ACTION", count: 2 },
      },
    ]);
  });
});
