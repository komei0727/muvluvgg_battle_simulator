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
  passiveResolved,
  realDamage,
  skillUseCompleted,
} from "../../../testing/production-unit/trigger-events.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";

/**
 * `UNIT_ROSIE_ARTIST`（【空想造形アーティスト】ロージー・ヒューズ）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_ROSIE_ARTIST";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** PS2の `UNIT_TYPE` 別適用を作り分ける盤面（既定のスタンドインは物理タイプ）。 */
const ENERGY_TYPE_ALLY: BoardOverrides = {
  allies: [
    { id: "ally:front", position: { column: "LEFT", row: "FRONT" }, unitType: "ENERGY" },
    { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
  ],
};

/**
 * 敵を満タンで置く盤面。既定のHP半分では自分の攻撃だけでHP割合が50%を割り、
 * PS1（「敵のHPが50%以下になった際」）とそれが誘発するPS3の連鎖が毎行混ざって
 * 「そのスキルが何をしたか」が読めなくなる。連鎖自体はPS1・PS3の行で検証する。
 */
const FULL_HEALTH_ENEMIES: BoardOverrides = {
  enemies: [
    {
      id: "enemy:front",
      position: { column: "CENTER", row: "FRONT" },
      state: { currentHp: 10000 },
    },
    { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, state: { currentHp: 10000 } },
    { id: "enemy:back", position: { column: "CENTER", row: "BACK" }, state: { currentHp: 10000 } },
  ],
};

/** 会心判定を必ず当たり側へ倒す抽選列。 */
function critical(): SequenceRandomSource {
  return new SequenceRandomSource(new Array<number>(64).fill(0));
}

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_EX",
    intent:
      "敵全体に威力93.6で攻撃する。生存中の敵の数が多いほどダメージが増加する（+100%まで）。さらに自身に一度だけ被ダメージを75%減少させる効果を付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ROSIE_ARTIST_EX" },
    board: FULL_HEALTH_ENEMIES,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DMG_DOWN", targets: ["ally:subject"] },
      ],
      // 468 に、生存敵3体分の増加率（0.1667×3）が乗る。
      hpDeltas: {
        "enemy:front": -702,
        "enemy:left": -702,
        "enemy:back": -702,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_EX_DMG_DOWN",
          magnitude: -0.75,
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_AS1",
    intent: "敵横一列に威力117で攻撃する（会心なし: 追撃の腕へ進まない）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ROSIE_ARTIST_AS1" },
    board: FULL_HEALTH_ENEMIES,
    expected: {
      // PS2（「自身がアクティブスキルで攻撃した後に発動」）はAS完了そのものを契機に
      // 持つため、AS 1回の観測には必ずPS2の連鎖が含まれる。
      actions: [
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DAMAGE", targets: ["enemy:left"] },
        {
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          targets: ["ally:back"],
        },
        // PS2の解決そのものが `PassiveResolved` を出し、PS3の
        // `sourceSelector: ALLY` はロージー自身も味方として満たすため連鎖する。
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS3_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS3_EX_UP", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "enemy:front": -803,
        "enemy:left": -585,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          magnitude: 0.6,
          timeLimit: { unit: "ACTION", count: 5 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          magnitude: 0.6,
          timeLimit: { unit: "ACTION", count: 5 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          magnitude: 0.6,
          timeLimit: { unit: "ACTION", count: 5 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 4 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_ROSIE_ARTIST_PS2", remaining: 2 },
        { unitId: "ally:subject", skillDefinitionId: "SKL_ROSIE_ARTIST_PS3", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_AS1",
    intent:
      "会心攻撃が発生した場合、敵横一列に対して追加で威力39の攻撃を行い、自身の次の攻撃の与ダメージが25%増加するバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ROSIE_ARTIST_AS1" },
    board: { ...ENERGY_TYPE_ALLY, ...FULL_HEALTH_ENEMIES, combatStats: { criticalRate: 1 } },
    random: critical,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DAMAGE_CRIT", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DAMAGE_CRIT", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DMG_UP", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          targets: ["ally:back"],
        },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS3_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS3_EX_UP", targets: ["ally:subject"] },
      ],
      // 会心2ヒット 877 + 292（会心倍率1.5）。前列へはさらにPS3の追撃が入り、その1発が
      // `ACT_ROSIE_ARTIST_AS1_DMG_UP`（次の攻撃+25%）を消費する。
      hpDeltas: {
        "enemy:front": -1579,
        "enemy:left": -1169,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          magnitude: 0.6,
          timeLimit: { unit: "ACTION", count: 5 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP",
          magnitude: 0.3,
          timeLimit: { unit: "ACTION", count: 5 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          magnitude: 0.6,
          timeLimit: { unit: "ACTION", count: 5 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 4 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_ROSIE_ARTIST_PS2", remaining: 2 },
        { unitId: "ally:subject", skillDefinitionId: "SKL_ROSIE_ARTIST_PS3", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_PS1",
    intent:
      "敵のHPが50%以下になった際に発動。自身の次の攻撃の与ダメージが50%増加するバフを付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_ARTIST_PS1",
      trigger: realDamage({ from: "ally:front", to: "enemy:front", skillType: "AS" }),
      triggeredBy: "ally:front",
    },
    expected: {
      // PS1の解決が `PassiveResolved` を出すため、そのままPS3が連鎖して追撃が入り、
      // 付けたばかりの与ダメージ増加バフ（次の攻撃1回）はその追撃で消費される。
      actions: [
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS1_DMG_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS3_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS3_EX_UP", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "enemy:front": -328,
      },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 3 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_ROSIE_ARTIST_PS1", remaining: 1 },
        { unitId: "ally:subject", skillDefinitionId: "SKL_ROSIE_ARTIST_PS3", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_PS1",
    intent: "(不成立): 敵のHPが50%より多く残っていれば発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_ARTIST_PS1",
      trigger: realDamage({ from: "ally:front", to: "enemy:front", skillType: "AS" }),
      triggeredBy: "ally:front",
    },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 10000 },
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_PS2",
    intent:
      "自身がアクティブスキルで攻撃した後に発動。味方全体にHP回復量を5行動の間30%上昇させるバフを付与する（重複可）。物理タイプの味方の場合、バフ効果が2倍になる",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_ARTIST_PS2",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:subject",
    },
    board: ENERGY_TYPE_ALLY,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP", targets: ["ally:front"] },
        {
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          targets: ["ally:back"],
        },
        // PS2解決 → PS3追撃 → その追撃で敵前列がHP50%以下になり PS1 まで連鎖する。
        // R-ATM-01: PS1の候補はPS3の効果処理中に検出され、発動はPS3の完了後。
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS3_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS3_EX_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS1_DMG_UP", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "enemy:front": -218,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          magnitude: 0.6,
          timeLimit: { unit: "ACTION", count: 5 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS1_DMG_UP",
          magnitude: 0.5,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP",
          magnitude: 0.3,
          timeLimit: { unit: "ACTION", count: 5 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          magnitude: 0.6,
          timeLimit: { unit: "ACTION", count: 5 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -3 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 4 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_ROSIE_ARTIST_PS2", remaining: 2 },
        { unitId: "ally:subject", skillDefinitionId: "SKL_ROSIE_ARTIST_PS3", remaining: 1 },
        { unitId: "ally:subject", skillDefinitionId: "SKL_ROSIE_ARTIST_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_PS2",
    intent: "(不成立): EXスキルの完了では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_ARTIST_PS2",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "EX",
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_PS3",
    intent:
      "自身が他の味方からパッシブスキルを受けた後に発動。自身に最も近い敵単体に威力43.75で1回攻撃し、自身のEXゲージを1加算する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_ARTIST_PS3",
      trigger: passiveResolved({
        actor: "ally:front",
        skillDefinitionId: "SKL_ROSIE_ARTIST_PS2",
      }),
      triggeredBy: "ally:front",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS3_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS3_EX_UP", targets: ["ally:subject"] },
        // 追撃で敵前列がHP50%以下になり、PS3の効果処理完了後にPS1が発動する（R-ATM-01）。
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS1_DMG_UP", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "enemy:front": -218,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS1_DMG_UP",
          magnitude: 0.5,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 3 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_ROSIE_ARTIST_PS3", remaining: 1 },
        { unitId: "ally:subject", skillDefinitionId: "SKL_ROSIE_ARTIST_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_ARTIST_PS3",
    intent: "(不成立): 敵のパッシブスキル解決では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_ARTIST_PS3",
      trigger: passiveResolved({
        actor: "enemy:front",
        skillDefinitionId: "SKL_ROSIE_ARTIST_PS2",
      }),
    },
    expected: {
      activated: false,
    },
  },
];

describe("production Catalog UNIT_ROSIE_ARTIST (【空想造形アーティスト】ロージー・ヒューズ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-ROSIE-ARTIST-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-ROSIE-ARTIST-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-ROSIE-ARTIST-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-ROSIE-ARTIST-004 (R-SKL-08): AS1の会心分岐が読む `LAST_RESULT.criticalHitCount` は直前のACTION step全体のスコープを持つ — 横一列2体のうち1体だけが会心した回でも、追撃は2体ともへ入る", () => {
    // `-001` の会心行は会心率を0/1へ倒して表を決定的にするため、step内の全ヒットが
    // 揃って会心するか揃って非会心かのどちらかにしかならず、「最後に処理した対象1体が
    // 会心したか」との違いが差として現れない。会心率を0.5に置き、抽選列で1発目だけを
    // 非会心・2発目だけを会心へ倒すと、この2つの読み方が初めて分かれる。
    const partialCritical = () =>
      new SequenceRandomSource([0.99, 0, ...new Array<number>(62).fill(0.99)]);

    expect(
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use: { kind: "ACTIVE", skillDefinitionId: "SKL_ROSIE_ARTIST_AS1" },
        board: { ...FULL_HEALTH_ENEMIES, combatStats: { criticalRate: 0.5 } },
        random: partialCritical(),
      }),
    ).toEqual({
      actions: [
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DAMAGE", targets: ["enemy:left"] },
        // 会心したのは enemy:left の1発だけだが、追撃は横一列の2体ともへ入る。
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DAMAGE_CRIT", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DAMAGE_CRIT", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_AS1_DMG_UP", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          targets: ["ally:back"],
        },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS3_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS3_EX_UP", targets: ["ally:subject"] },
      ],
      // enemy:front は非会心の585 + 追撃195 + PS3の追撃273（`ACT_ROSIE_ARTIST_AS1_DMG_UP`
      // の+25%を消費した218）。enemy:left は会心の877（会心倍率1.5）+ 追撃195。
      hpDeltas: {
        "enemy:front": -1053,
        "enemy:left": -1072,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          magnitude: 0.6,
          timeLimit: { unit: "ACTION", count: 5 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          magnitude: 0.6,
          timeLimit: { unit: "ACTION", count: 5 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
          magnitude: 0.6,
          timeLimit: { unit: "ACTION", count: 5 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 4 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_ROSIE_ARTIST_PS2", remaining: 2 },
        { unitId: "ally:subject", skillDefinitionId: "SKL_ROSIE_ARTIST_PS3", remaining: 1 },
      ],
    });

    // 対照: 会心率は同じ0.5のまま、どのヒットも会心しない抽選列では分岐が閉じたままで
    // 追撃も与ダメージバフも一切現れない（差は会心が出たか出ないかだけである）。
    const noCritical = observeSkillUse({
      snapshot,
      unitDefinitionId: UNIT_DEFINITION_ID,
      use: { kind: "ACTIVE", skillDefinitionId: "SKL_ROSIE_ARTIST_AS1" },
      board: { ...FULL_HEALTH_ENEMIES, combatStats: { criticalRate: 0.5 } },
      random: new SequenceRandomSource(new Array<number>(64).fill(0.99)),
    });
    expect(noCritical.actions?.map((action) => action.effectActionDefinitionId)).not.toContain(
      "ACT_ROSIE_ARTIST_AS1_DAMAGE_CRIT",
    );
    expect(noCritical.hpDeltas).toEqual({ "enemy:front": -803, "enemy:left": -585 });
  });
});
