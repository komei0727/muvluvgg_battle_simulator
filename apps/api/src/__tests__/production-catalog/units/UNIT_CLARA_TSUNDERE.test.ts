import { describe, expect, it } from "vitest";
import { createSkillDefinitionId } from "../../../domain/catalog/definitions/catalog-ids.js";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import { observeEffectExpiry } from "../../../testing/production-unit/effect-expiry.js";
import {
  PRODUCTION_CATALOG_DIR,
  applyPrecedingActions,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardOverrides,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { skillUseCompleted, turnStarted } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_CLARA_TSUNDERE`（【正々堂々なミス・ツンデレ】綺羅クララ）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_CLARA_TSUNDERE";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** AS2の分岐が読む `UNIT_TYPE` を、対象ごとに作り分ける盤面。 */
const ENERGY_TYPE_ENEMY: BoardOverrides = {
  enemies: [
    { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, unitType: "ENERGY" },
    { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
    { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
  ],
};

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_CLARA_TSUNDERE_EX",
    intent:
      "敵横一列に威力150.6で攻撃し、対象がその時点で保有しているPPを全て削り、1行動分の気絶を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CLARA_TSUNDERE_EX" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_EX_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_EX_PP_ZERO",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_EX_STUN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_EX_DAMAGE",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_EX_PP_ZERO",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_EX_STUN",
          targets: ["enemy:left"],
        },
      ],
      hpDeltas: {
        "enemy:front": -753,
        "enemy:left": -753,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_EX_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_EX_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
      ],
      resources: [
        { unitId: "enemy:front", resource: "PP", delta: -4 },
        { unitId: "enemy:left", resource: "PP", delta: -4 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CLARA_TSUNDERE_AS1",
    intent: "敵単体に威力36.14で4ヒット攻撃し、与えたダメージの40%分自身のHPを回復する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CLARA_TSUNDERE_AS1" },
    expected: {
      // PS1（「自身がアクティブスキルで攻撃した後に発動」）はAS完了そのものを契機に
      // 持つため、AS 1回の観測には必ずPS1の連鎖が含まれる。
      actions: [
        {
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_AS1_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_AS1_HEAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_PS1_DEF_DOWN",
          targets: ["enemy:front"],
        },
        // 原文は「自身が攻撃した対象」だが、`TRIGGER_TARGET` は契機イベントの
        // `targetUnitIds` 全体を指す。AS1は回復stepで自身も対象に含めるため、
        // PS1の防御力低下はクララ自身へも乗る（`targetSelector: ENEMY` は
        // 候補化の判定にしか使われず、`TRIGGER_TARGET` の解決先を絞らない）。
        {
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_PS1_DEF_DOWN",
          targets: ["ally:subject"],
        },
      ],
      // 180×4ヒット = 720 の40%。「与えたダメージ」はこのEffectSequence解決で
      // 確定したDAMAGE結果の合計であり、最終ヒット1発分ではない。
      hpDeltas: {
        "ally:subject": 288,
        "enemy:front": -720,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_PS1_DEF_DOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_PS1_DEF_DOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_CLARA_TSUNDERE_AS1",
          remaining: 1,
        },
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_CLARA_TSUNDERE_PS1",
          remaining: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CLARA_TSUNDERE_AS2",
    intent: "敵単体に威力117で攻撃する。対象が物理タイプの場合、防御力を20%、攻撃力を20%低下させる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CLARA_TSUNDERE_AS2" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_AS2_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_AS2_DEF_DOWN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_AS2_ATK_DOWN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_PS1_DEF_DOWN",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -585,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_AS2_DEF_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_AS2_ATK_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_PS1_DEF_DOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_CLARA_TSUNDERE_AS2",
          remaining: 1,
        },
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_CLARA_TSUNDERE_PS1",
          remaining: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CLARA_TSUNDERE_AS2",
    intent: "(分岐): 対象が物理タイプでなければ防御力・攻撃力低下は付かない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CLARA_TSUNDERE_AS2" },
    board: ENERGY_TYPE_ENEMY,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_AS2_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_PS1_DEF_DOWN",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -585,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_PS1_DEF_DOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_CLARA_TSUNDERE_AS2",
          remaining: 1,
        },
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_CLARA_TSUNDERE_PS1",
          remaining: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CLARA_TSUNDERE_PS1",
    intent:
      "自身がアクティブスキルで攻撃した後に発動。自身が攻撃した対象が次に行動を終えるまでの間、防御力を30%低下させる(重複可)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CLARA_TSUNDERE_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:back"],
        skillType: "AS",
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_PS1_DEF_DOWN",
          targets: ["enemy:back"],
        },
      ],
      effectsApplied: [
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_PS1_DEF_DOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_CLARA_TSUNDERE_PS1",
          remaining: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CLARA_TSUNDERE_PS1",
    intent: "(不成立): EXスキルの完了では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CLARA_TSUNDERE_PS1",
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
    skillDefinitionId: "SKL_CLARA_TSUNDERE_PS2",
    intent:
      "ターン開始時に発動。自身を除く味方全員の行動速度を1行動の間160上昇させ（重複可）、自身を除く味方単体のEXゲージを1加算する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CLARA_TSUNDERE_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_PS2_SPEED_UP",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_PS2_SPEED_UP",
          targets: ["ally:back"],
        },
        {
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_PS2_EX_UP",
          targets: ["ally:front"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_PS2_SPEED_UP",
          magnitude: 160,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_CLARA_TSUNDERE_PS2_SPEED_UP",
          magnitude: 160,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "ally:front", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_CLARA_TSUNDERE_PS2",
          remaining: 99,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CLARA_TSUNDERE_PS2",
    intent: "(不成立): このスキルは戦闘中に1度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CLARA_TSUNDERE_PS2",
      trigger: turnStarted({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    board: {
      subject: {
        state: {
          cooldowns: {
            [createSkillDefinitionId("SKL_CLARA_TSUNDERE_PS2")]: {
              remaining: 99,
              unit: "TURN",
            },
          },
        },
      },
    },
    expected: {
      activated: false,
    },
  },
];

describe("production Catalog UNIT_CLARA_TSUNDERE (【正々堂々なミス・ツンデレ】綺羅クララ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-CLARA-TSUNDERE-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-CLARA-TSUNDERE-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-CLARA-TSUNDERE-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-CLARA-TSUNDERE-004 (R-EFF-04): PS1の防御力低下は`owner: EFFECT_SOURCE`なので、効果を保持している敵ではなく**付与したクララ自身**の行動終了で減り、0で失効して防御力が戻る", () => {
    // 付与そのものと `timeLimit: { unit: ACTION, count: 1, owner: EFFECT_SOURCE }`
    // の宣言は `-001` のAS1行が持つ。ここが引き受けるのは、その `owner` が実際に
    // 誰の行動終了を指すか — `EFFECT_TARGET`（既定）との差は保持者以外の行動を
    // 跨がないと現れない（`IT-UNIT-DOROTHEA-PIONEER-005` が既定側を持つ）。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const granted = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_CLARA_TSUNDERE_PS1_DEF_DOWN", target: "ENEMY" },
    ]);

    expect(
      observeEffectExpiry({
        units: granted,
        definitions: board.definitions,
        steps: [
          { kind: "ACTION_END", actor: "enemy:front" },
          { kind: "ACTION_END", actor: "enemy:left" },
          { kind: "ACTION_END", actor: "ally:subject" },
        ],
        watch: [{ unitId: "enemy:front", stat: "defense" }],
      }).steps,
    ).toEqual([
      // 保持者自身の行動終了では減らない（既定の `EFFECT_TARGET` ならここで失効する）。
      {
        step: "ACTION_END(enemy:front)",
        remaining: { "enemy:front/ACT_CLARA_TSUNDERE_PS1_DEF_DOWN": 1 },
      },
      {
        step: "ACTION_END(enemy:left)",
        remaining: { "enemy:front/ACT_CLARA_TSUNDERE_PS1_DEF_DOWN": 1 },
      },
      {
        step: "ACTION_END(ally:subject)",
        remaining: {},
        expired: [
          {
            unitId: "enemy:front",
            effectActionDefinitionId: "ACT_CLARA_TSUNDERE_PS1_DEF_DOWN",
            reason: "TIME_LIMIT",
            cascaded: false,
          },
        ],
        // 30%低下が巻き戻る（350 → 500）。
        stats: { "enemy:front/defense": 500 },
      },
    ]);
  });
});
