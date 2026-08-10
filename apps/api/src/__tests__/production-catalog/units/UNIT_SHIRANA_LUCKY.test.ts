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
  type BoardOverrides,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { realDamage, turnStarted } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_SHIRANA_LUCKY`(【純白のラッキーガール】一条白奈)のユニット単位production
 * 結合テスト(`12_テスト戦略.md`「ユニット効果軸」)。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_SHIRANA_LUCKY";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const EX_SHIELD = "ACT_SHIRANA_LUCKY_EX_SHIELD";

/**
 * PS1の `ATTRIBUTE: SMART` フィルタを判別できる盤面。「自身を含む」を観測するため
 * 検証対象自身へも実定義どおりのスマート属性を置き、相手役は既定の `AGGRESSIVE` の
 * まま残して、スマート属性の味方だけが対象へ入ることを固定する。
 */
const SMART_SUBJECT_AND_ALLY: BoardOverrides = {
  subject: { attribute: "SMART" },
  allies: [
    { id: "ally:front", position: { column: "LEFT", row: "FRONT" }, attribute: "SMART" },
    { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
  ],
};

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_SHIRANA_LUCKY_EX",
    intent:
      "後列優先で、敵横一列に威力117で攻撃する。さらに自身に対し、最大HP×100%のダメージを防ぐシールドを付与する。シールドは1行動に付き最大値の25%減少する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHIRANA_LUCKY_EX" },
    expected: {
      // 後列優先の基点は enemy:back で、横一列はその後列だけ（前列2体は入らない）。
      actions: [
        { effectActionDefinitionId: "ACT_SHIRANA_LUCKY_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_SHIRANA_LUCKY_EX_SHIELD", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:back": -585 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHIRANA_LUCKY_EX_SHIELD",
          magnitude: 10000,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHIRANA_LUCKY_AS1",
    intent:
      "後列優先で、敵単体に威力106で3ヒット攻撃する。さらに自身が次に行動を終えるまでの間対象与ダメージを25%減少させ、被ダメージを25%増加させるデバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHIRANA_LUCKY_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHIRANA_LUCKY_AS1_DAMAGE", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_SHIRANA_LUCKY_AS1_OUTGOING_DOWN",
          targets: ["enemy:back"],
        },
        { effectActionDefinitionId: "ACT_SHIRANA_LUCKY_AS1_INCOMING_UP", targets: ["enemy:back"] },
      ],
      // 1ヒット530の3ヒット。
      hpDeltas: { "enemy:back": -1590 },
      effectsApplied: [
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_SHIRANA_LUCKY_AS1_OUTGOING_DOWN",
          magnitude: -0.25,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_SHIRANA_LUCKY_AS1_INCOMING_UP",
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
        { unitId: "ally:subject", skillDefinitionId: "SKL_SHIRANA_LUCKY_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHIRANA_LUCKY_AS2",
    intent:
      "後列優先で、敵単体に威力156で攻撃する。さらに自身から最も近い味方に対し、攻撃力×100%までのダメージを防ぐシールドを付与する。シールドは対象の3行動後に消滅する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHIRANA_LUCKY_AS2" },
    expected: {
      // 「最も近い味方」は距離0の自身。
      actions: [
        { effectActionDefinitionId: "ACT_SHIRANA_LUCKY_AS2_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_SHIRANA_LUCKY_AS2_SHIELD", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:back": -780 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHIRANA_LUCKY_AS2_SHIELD",
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
    skillDefinitionId: "SKL_SHIRANA_LUCKY_PS1",
    intent:
      "自身のHPが50%以下になった際に発動。自身を含むスマート属性の味方に対し、被ダメージを15%減少させる効果を付与する（重複可）このスキルは戦闘中に1度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SHIRANA_LUCKY_PS1",
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
          effectActionDefinitionId: "ACT_SHIRANA_LUCKY_PS1_DAMAGE_DOWN",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_SHIRANA_LUCKY_PS1_DAMAGE_DOWN", targets: ["ally:front"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHIRANA_LUCKY_PS1_DAMAGE_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_SHIRANA_LUCKY_PS1_DAMAGE_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SHIRANA_LUCKY_PS1", remaining: 99 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHIRANA_LUCKY_PS1",
    intent: "(不成立): HPが50%より多く残っている被弾では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SHIRANA_LUCKY_PS1",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:subject",
        skillType: "AS",
        event: "HitPointReduced",
      }),
    },
    // 被弾後も 8500/10000 で閾値を跨がない。
    board: {
      ...SMART_SUBJECT_AND_ALLY,
      subject: { attribute: "SMART", state: { currentHp: 9000 } },
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_SHIRANA_LUCKY_PS2",
    intent:
      "ターン開始時に発動。自身を除く味方全体に対し、2回攻撃を受けるまで物理攻撃による被ダメージを30%減少させる効果を付与する（重複可）。さらに自身から最も遠い敵単体に対し、3行動分の炎上を付与する。このスキルは戦闘中に1度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SHIRANA_LUCKY_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHIRANA_LUCKY_PS2_GUARD", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_SHIRANA_LUCKY_PS2_GUARD", targets: ["ally:back"] },
        { effectActionDefinitionId: "ACT_SHIRANA_LUCKY_PS2_BURN", targets: ["enemy:back"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_SHIRANA_LUCKY_PS2_GUARD",
          magnitude: -0.3,
          consumption: { kind: "INCOMING_HIT", maxCount: 2 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_SHIRANA_LUCKY_PS2_GUARD",
          magnitude: -0.3,
          consumption: { kind: "INCOMING_HIT", maxCount: 2 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_SHIRANA_LUCKY_PS2_BURN",
          magnitude: 300,
          timeLimit: { unit: "ACTION", count: 3 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SHIRANA_LUCKY_PS2", remaining: 99 },
      ],
    },
  },
];

describe("production Catalog UNIT_SHIRANA_LUCKY (【純白のラッキーガール】一条白奈)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-SHIRANA-LUCKY-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-SHIRANA-LUCKY-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-SHIRANA-LUCKY-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-SHIRANA-LUCKY-004 (R-SHD-01第3項): EXが配る実シールドは1行動につき付与最大値の25%ずつ減り、4行動目でちょうど枯渇して `SHIELD_DEPLETED` で失効する。期間宣言を一切持たないため、漸減そのものが消滅契機になる", () => {
    // `-001` のEX行は付与そのもの（`magnitude: 10000`＝最大HP×100%）までを固定し、
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
      battleId: "B_SHIRANA_SHIELD_DECAY",
    });

    const maximum = board.subject.combatStats.maximumHp;
    expect(observation.steps).toEqual([
      {
        step: `ACTION_END(${SUBJECT_ID})`,
        remaining: {},
        shields: { [`${SUBJECT_ID}/${EX_SHIELD}`]: maximum * 0.75 },
      },
      {
        step: `ACTION_END(${SUBJECT_ID})`,
        remaining: {},
        shields: { [`${SUBJECT_ID}/${EX_SHIELD}`]: maximum * 0.5 },
      },
      {
        step: `ACTION_END(${SUBJECT_ID})`,
        remaining: {},
        shields: { [`${SUBJECT_ID}/${EX_SHIELD}`]: maximum * 0.25 },
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
