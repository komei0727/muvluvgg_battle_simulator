import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import { observeEffectExpiry } from "../../../testing/production-unit/effect-expiry.js";
import {
  PRODUCTION_CATALOG_DIR,
  SUBJECT_ID,
  applyPrecedingActions,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { realDamage, turnStarted } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_SHIRANA_LUCKY_TEX`（【純白のラッキーガール】一条白奈・戦術演習版）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * このユニットは戦術演習の敵専用（`category: EXERCISE_ENEMY`、R-TEX-11）で、原文は
 * `raw/units/` のwiki転記ではなく**ゲーム内スクリーンショットからの転記**である。
 * `intent` はそのスクリーンショットの効果説明文で、転記が正しいかをレビューできる
 * 唯一の接点になる。プレイアブル版 `UNIT_SHIRANA_LUCKY` とは威力・消費値が完全一致し、
 * 差分はEXシールド倍率（最大HP×100%→5%）とPS2の被ダメージ軽減の付与先（自身以外の
 * 味方全体→自身のみ）だけである。AS1（クールスラッシュ・トリプル）は無変更、AS2
 * （バックエイムファイア+）のシールド付与先は表記上「自身」だが、ベース版の「最も近い
 * 味方」は距離0の自身に常に解決するため観測できる挙動差はない。PS1（スマートバリア+）
 * も数値・対象ともに無変更（表示名のみ"+"が付く）。
 *
 * 盤面は攻撃力1000・防御力500・現在HP5000/最大HP10000
 * （`skill-behaviour.ts`）。
 */

const UNIT_DEFINITION_ID = "UNIT_SHIRANA_LUCKY_TEX";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const EX_SHIELD = "ACT_SHIRANA_LUCKY_TEX_EX_SHIELD";

/**
 * PS1の `ATTRIBUTE: SMART` フィルタを判別できる盤面。「自身を含む」を観測するため
 * 検証対象自身へも実定義どおりのスマート属性を置き、相手役は既定の `AGGRESSIVE` の
 * まま残して、スマート属性の味方だけが対象へ入ることを固定する。
 */
const SMART_SUBJECT_AND_ALLY = {
  subject: { attribute: "SMART" as const },
  allies: [
    {
      id: "ally:front",
      position: { column: "LEFT" as const, row: "FRONT" as const },
      attribute: "SMART" as const,
    },
    { id: "ally:back", position: { column: "CENTER" as const, row: "BACK" as const } },
  ],
};

/** (SKL_ID, スクリーンショット原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_SHIRANA_LUCKY_TEX_EX",
    intent:
      "後列優先で、敵横一列に威力117で攻撃する。さらに自身に対し、最大HP×5%のダメージを防ぐシールドを付与する。シールドは1行動に付き最大値の25%減少する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHIRANA_LUCKY_TEX_EX" },
    expected: {
      // 後列優先の基点は enemy:back で、横一列はその後列だけ（前列2体は入らない）。
      actions: [
        { effectActionDefinitionId: "ACT_SHIRANA_LUCKY_TEX_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_SHIRANA_LUCKY_TEX_EX_SHIELD", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:back": -585 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHIRANA_LUCKY_TEX_EX_SHIELD",
          // 最大HP10000の5%＝500（プレイアブル版の100%＝10000との差分点）。
          magnitude: 500,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHIRANA_LUCKY_TEX_AS1",
    intent:
      "後列優先で、敵単体に威力106で3ヒット攻撃する。さらに自身が次に行動を終えるまでの間、対象の与ダメージを25%減少させ、被ダメージを25%増加させるデバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHIRANA_LUCKY_TEX_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHIRANA_LUCKY_TEX_AS1_DAMAGE", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_SHIRANA_LUCKY_TEX_AS1_OUTGOING_DOWN",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_SHIRANA_LUCKY_TEX_AS1_INCOMING_UP",
          targets: ["enemy:back"],
        },
      ],
      // 1ヒット530の3ヒット。
      hpDeltas: { "enemy:back": -1590 },
      effectsApplied: [
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_SHIRANA_LUCKY_TEX_AS1_OUTGOING_DOWN",
          magnitude: -0.25,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_SHIRANA_LUCKY_TEX_AS1_INCOMING_UP",
          magnitude: 0.25,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -2 },
        // EX獲得は消費APと同数（R-RES-03）。
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SHIRANA_LUCKY_TEX_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHIRANA_LUCKY_TEX_AS2",
    intent:
      "後列優先で、敵単体に威力156で攻撃する。さらに自身に対し、攻撃力×100%までのダメージを防ぐシールドを付与する。シールドは対象の3行動後に消滅する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHIRANA_LUCKY_TEX_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHIRANA_LUCKY_TEX_AS2_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_SHIRANA_LUCKY_TEX_AS2_SHIELD", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:back": -780 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHIRANA_LUCKY_TEX_AS2_SHIELD",
          magnitude: 1000,
          timeLimit: { unit: "ACTION", count: 3, owner: "EFFECT_TARGET" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHIRANA_LUCKY_TEX_PS1",
    intent:
      "自身のHPが50%以下になった際に発動。自身を含むスマート属性の味方に対し、被ダメージを15%減少させる効果を付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SHIRANA_LUCKY_TEX_PS1",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:subject",
        skillType: "AS",
        event: "HitPointReduced",
      }),
    },
    board: SMART_SUBJECT_AND_ALLY,
    expected: {
      // 「自身を含む」— 検証対象自身とスマート属性の味方だけが入り、ally:back は入らない。
      actions: [
        {
          effectActionDefinitionId: "ACT_SHIRANA_LUCKY_TEX_PS1_DAMAGE_DOWN",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_SHIRANA_LUCKY_TEX_PS1_DAMAGE_DOWN",
          targets: ["ally:front"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHIRANA_LUCKY_TEX_PS1_DAMAGE_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_SHIRANA_LUCKY_TEX_PS1_DAMAGE_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SHIRANA_LUCKY_TEX_PS1", remaining: 99 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHIRANA_LUCKY_TEX_PS1",
    intent: "(不成立): HPが50%より多く残っている被弾では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SHIRANA_LUCKY_TEX_PS1",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:subject",
        skillType: "AS",
        event: "HitPointReduced",
      }),
    },
    // 被弾後も 9000/10000 で閾値を跨がない。
    board: {
      ...SMART_SUBJECT_AND_ALLY,
      subject: { attribute: "SMART" as const, state: { currentHp: 9000 } },
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_SHIRANA_LUCKY_TEX_PS2",
    intent:
      "ターン開始時に発動。自身に対し、2回攻撃を受けるまで物理攻撃による被ダメージを30%減少させる効果を付与する（重複可）。さらに自身から最も遠い敵単体に対し、3行動分の炎上を付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SHIRANA_LUCKY_TEX_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      // プレイアブル版は「自身以外の味方全体」（ally:front / ally:back）が対象だが、
      // TEX版は自身のみ — ally:front / ally:back は対象に入らない。
      actions: [
        { effectActionDefinitionId: "ACT_SHIRANA_LUCKY_TEX_PS2_GUARD", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SHIRANA_LUCKY_TEX_PS2_BURN", targets: ["enemy:back"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHIRANA_LUCKY_TEX_PS2_GUARD",
          magnitude: -0.3,
          consumption: { kind: "INCOMING_HIT", maxCount: 2 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_SHIRANA_LUCKY_TEX_PS2_BURN",
          magnitude: 300,
          timeLimit: { unit: "ACTION", count: 3 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SHIRANA_LUCKY_TEX_PS2", remaining: 99 },
      ],
    },
  },
];

describe("production Catalog UNIT_SHIRANA_LUCKY_TEX (【純白のラッキーガール】一条白奈・戦術演習版)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-SHIRANA-LUCKY-TEX-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-SHIRANA-LUCKY-TEX-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-SHIRANA-LUCKY-TEX-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-SHIRANA-LUCKY-TEX-004 [R-SHD-01] (R-SHD-01第3項): EXが配る実シールドは1行動につき付与最大値の25%ずつ減り、4行動目でちょうど枯渇して `SHIELD_DEPLETED` で失効する。期間宣言を一切持たないため、漸減そのものが消滅契機になる", () => {
    // `-001` のEX行は付与そのもの（`magnitude: 500`＝最大HP×5%）までを固定し、
    // `timeLimit` を持たないことも `toEqual` の完全一致で表している。**漸減は以後の
    // 行動ごとに起きる**ためスキル使用1回の観測には載らず、`duration` を一切動かさない
    // ので期間の残り回数にも現れない。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const shielded = applyPrecedingActions(board, [
      { effectActionDefinitionId: EX_SHIELD, target: "SELF" },
    ]);

    const observation = observeEffectExpiry({
      units: shielded,
      definitions: board.definitions,
      // 保持者自身が4回行動する。`decay.unit: ACTION` の漸減は実 `recordActionCompletion`
      // が行動完了のたびに駆動する。
      steps: Array.from({ length: 4 }, () => ({ kind: "ACTION_END" as const, actor: SUBJECT_ID })),
      watchShields: [SUBJECT_ID],
      battleId: "B_SHIRANA_LUCKY_TEX_SHIELD_DECAY",
    });

    const maximum = board.subject.combatStats.maximumHp;
    expect(observation.steps).toEqual([
      {
        step: `ACTION_END(${SUBJECT_ID})`,
        remaining: {},
        shields: { [`${SUBJECT_ID}/${EX_SHIELD}`]: maximum * 0.05 * 0.75 },
      },
      {
        step: `ACTION_END(${SUBJECT_ID})`,
        remaining: {},
        shields: { [`${SUBJECT_ID}/${EX_SHIELD}`]: maximum * 0.05 * 0.5 },
      },
      {
        step: `ACTION_END(${SUBJECT_ID})`,
        remaining: {},
        shields: { [`${SUBJECT_ID}/${EX_SHIELD}`]: maximum * 0.05 * 0.25 },
      },
      // 4行動目で0になり、その場で失効する（インスタンスごと消えるため
      // `shields` からもキーが落ちる）。
      {
        step: `ACTION_END(${SUBJECT_ID})`,
        remaining: {},
        expired: [
          {
            unitId: SUBJECT_ID,
            effectActionDefinitionId: EX_SHIELD,
            reason: "SHIELD_DEPLETED",
            cascaded: false,
          },
        ],
        shields: {},
      },
    ]);
  });
});
