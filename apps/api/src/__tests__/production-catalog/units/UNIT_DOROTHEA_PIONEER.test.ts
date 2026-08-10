import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import { observeEffectExpiry } from "../../../testing/production-unit/effect-expiry.js";
import { observeActivationCounters } from "../../../testing/production-unit/runtime-counter.js";
import {
  PRODUCTION_CATALOG_DIR,
  applyPrecedingActions,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardOverrides,
  type BoardUnitSpec,
  type PrecedingAction,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { turnStarted, unitDefeated } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_DOROTHEA_PIONEER`（【新たなる時代の導き手】ドロテア・カークランド）のユニット
 * 単位production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_DOROTHEA_PIONEER";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const GRACE = "MARKER_DOROTHEA_PIONEER_GRACE";

/** EXゲージを溜めた敵配置（「EXゲージを3削る」が観測に載る局面）。 */
const ENEMIES_WITH_EX_GAUGE: readonly BoardUnitSpec[] = (
  [
    { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
    { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
    { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
  ] as const
).map((enemy) => ({ ...enemy, state: { currentExtraGauge: 5 } }));

/** そのPSが戦闘中に1度発動済みである局面。 */
function alreadyActivated(skillDefinitionId: string): BoardOverrides {
  return {
    subject: {
      state: {
        skillCounters: {
          [createSkillDefinitionId(skillDefinitionId)]: {
            [createRuntimeCounterId(`${skillDefinitionId}_ACTIVATIONS`)]: { value: 1, carry: 0 },
          },
        },
      },
    },
  };
}

/**
 * PS2の発動条件「自身がダメージリンクを付与した敵」を、実 production のリンク定義で
 * 作る。前提アクションはスキルの対象選択を通さないため、`linkTo` の参照先は対象自身に
 * 解決される — PS2が見るのは「自分が付けたリンクを保持しているか」だけで足りる。
 */
const LINKED_ENEMY: readonly PrecedingAction[] = [
  {
    effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_PS1_LINK_TO_FARTHEST",
    target: "ENEMY",
    payloadBindingIds: ["TGT_FARTHEST"],
  },
];

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_DOROTHEA_PIONEER_EX",
    intent: "敵3体に威力37.92で3ヒット、威力85.32でもう1ヒットEN攻撃をし、対象のEXゲージを3削る",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_DOROTHEA_PIONEER_EX" },
    board: { enemies: ENEMIES_WITH_EX_GAUGE },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_EX_DAMAGE_MULTI",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_EX_DAMAGE_EXTRA",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_EX_EX_DOWN", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_EX_DAMAGE_MULTI",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_EX_DAMAGE_EXTRA",
          targets: ["enemy:left"],
        },
        { effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_EX_EX_DOWN", targets: ["enemy:left"] },
        {
          effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_EX_DAMAGE_MULTI",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_EX_DAMAGE_EXTRA",
          targets: ["enemy:back"],
        },
        { effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_EX_EX_DOWN", targets: ["enemy:back"] },
      ],
      // 1ヒット189（500×37.92%）×3ヒットに、426（500×85.32%）の1ヒットを加える。
      hpDeltas: {
        "enemy:front": -993,
        "enemy:left": -993,
        "enemy:back": -993,
      },
      resources: [
        { unitId: "enemy:front", resource: "EX_GAUGE", delta: -3 },
        { unitId: "enemy:left", resource: "EX_GAUGE", delta: -3 },
        { unitId: "enemy:back", resource: "EX_GAUGE", delta: -3 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_DOROTHEA_PIONEER_AS1",
    intent:
      "敵単体に威力201.4でEN攻撃し、次に受ける攻撃の被ダメージを15%増加させるデバフ（重複可）と、「気品」を1つ付与する。この攻撃は所持している「気品」が最も少ない敵を優先する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_DOROTHEA_PIONEER_AS1" },
    // 既定順で先に来る敵前列に「気品」を持たせ、優先順位が入れ替わることを見る。
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          markers: [{ markerId: GRACE, stackCount: 2 }],
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_AS1_DEBUFF", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_AS1_MARKER", targets: ["enemy:left"] },
      ],
      // 500×201.4%は二進浮動小数で1007をわずかに下回るため切り捨てで1006になる。
      hpDeltas: {
        "enemy:left": -1006,
      },
      effectsApplied: [
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_AS1_DEBUFF",
          magnitude: 0.15,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
      markers: [{ unitId: "enemy:left", markerId: GRACE, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_DOROTHEA_PIONEER_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_DOROTHEA_PIONEER_AS2",
    intent: "敵単体に威力201.4でEN攻撃し、2行動の間防御力を5%低下させる（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_DOROTHEA_PIONEER_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_AS2_DEF_DOWN", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -1006,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_AS2_DEF_DOWN",
          magnitude: -0.05,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_DOROTHEA_PIONEER_PS1",
    intent:
      "ターン開始時に発動。自身に最も近い敵と最も遠い敵に1ターンの間リンクを付与し、対象同士が受けたダメージの35%を共有しあう状態にする",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_DOROTHEA_PIONEER_PS1",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_PS1_LINK_TO_FARTHEST",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_PS1_LINK_TO_NEAREST",
          targets: ["enemy:back"],
        },
      ],
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_PS1_LINK_TO_FARTHEST",
          magnitude: 0.35,
          timeLimit: { unit: "TURN", count: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_PS1_LINK_TO_NEAREST",
          magnitude: 0.35,
          timeLimit: { unit: "TURN", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_DOROTHEA_PIONEER_PS1",
    intent: "(不成立): 生存している敵が1体のみの場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_DOROTHEA_PIONEER_PS1",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    board: { enemies: [{ id: "enemy:front", position: { column: "CENTER", row: "FRONT" } }] },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_DOROTHEA_PIONEER_PS1",
    intent: "(不成立): このスキルは戦闘中に一度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_DOROTHEA_PIONEER_PS1",
      trigger: turnStarted({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    board: alreadyActivated("SKL_DOROTHEA_PIONEER_PS1"),
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_DOROTHEA_PIONEER_PS2",
    intent:
      "自身がダメージリンクを付与した敵が倒された際に発動。自身の行動速度を100上昇させる（重複可）。加えて、前列の味方を優先し、味方2体に攻撃力×25%のシールドを付与する。シールドは対象の2行動後に消滅する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_DOROTHEA_PIONEER_PS2",
      trigger: unitDefeated({ unit: "enemy:front", defeatedBy: "ally:subject" }),
      triggeredBy: "ally:subject",
    },
    precedingActions: LINKED_ENEMY,
    expected: {
      // 前列の味方は自身（CENTER前列）と ally:front（LEFT前列）の2体。
      actions: [
        {
          effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_PS2_SPEED_UP",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_PS2_SHIELD", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_PS2_SHIELD", targets: ["ally:front"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_PS2_SPEED_UP",
          magnitude: 100,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_PS2_SHIELD",
          magnitude: 250,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_TARGET" },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_PS2_SHIELD",
          magnitude: 250,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_TARGET" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_DOROTHEA_PIONEER_PS2",
    intent:
      "(不成立): 自身が付与したダメージリンクがすでに消滅している場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_DOROTHEA_PIONEER_PS2",
      trigger: unitDefeated({ unit: "enemy:front", defeatedBy: "ally:subject" }),
      triggeredBy: "ally:subject",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_DOROTHEA_PIONEER_PS2",
    intent: "(不成立): このスキルは戦闘中に1度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_DOROTHEA_PIONEER_PS2",
      trigger: unitDefeated({ unit: "enemy:front", defeatedBy: "ally:subject" }),
      triggeredBy: "ally:subject",
    },
    precedingActions: LINKED_ENEMY,
    board: alreadyActivated("SKL_DOROTHEA_PIONEER_PS2"),
    expected: {
      activated: false,
    },
  },
];

describe("production Catalog UNIT_DOROTHEA_PIONEER (【新たなる時代の導き手】ドロテア・カークランド)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-DOROTHEA-PIONEER-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-DOROTHEA-PIONEER-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-DOROTHEA-PIONEER-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-DOROTHEA-PIONEER-004 (R-EFF-11): PS1・PS2 が宣言する発動回数counterは、自分自身の PassiveActivated でだけ増える。同じユニットの別PSの発動でも、このユニットのものではないPSの発動でも動かない", () => {
    // counterの増減は `-001` の振る舞い表の観測に載らない（表はスキル使用1回が
    // 起こしたことを見るもので、`RuntimeCounterChanged` は契機イベントから
    // `detectRuntimeCounterUpdates` が独立に起こす）。宣言は実 `catalog/` の
    // ユニット定義から導くため、counterを持つPSが増えれば行が増えて落ちる。
    expect(observeActivationCounters(snapshot, UNIT_DEFINITION_ID)).toEqual({
      declarations: [
        {
          skillDefinitionId: "SKL_DOROTHEA_PIONEER_PS1",
          counter: "SKL_DOROTHEA_PIONEER_PS1_ACTIVATIONS",
          scope: "SKILL_RUNTIME",
          amount: 1,
        },
        {
          skillDefinitionId: "SKL_DOROTHEA_PIONEER_PS2",
          counter: "SKL_DOROTHEA_PIONEER_PS2_ACTIVATIONS",
          scope: "SKILL_RUNTIME",
          amount: 1,
        },
      ],
      changesByActivatedSkill: {
        SKL_DOROTHEA_PIONEER_PS1: [
          {
            skillDefinitionId: "SKL_DOROTHEA_PIONEER_PS1",
            counter: "SKL_DOROTHEA_PIONEER_PS1_ACTIVATIONS",
            before: 0,
            after: 1,
            valueChanged: true,
          },
        ],
        SKL_DOROTHEA_PIONEER_PS2: [
          {
            skillDefinitionId: "SKL_DOROTHEA_PIONEER_PS2",
            counter: "SKL_DOROTHEA_PIONEER_PS2_ACTIVATIONS",
            before: 0,
            after: 1,
            valueChanged: true,
          },
        ],
      },
      changesOnUnrelatedSkill: [],
    });
  });

  it("IT-UNIT-DOROTHEA-PIONEER-005 (R-EFF-04): AS2の「2行動の間」は`owner`を省略した既定の`EFFECT_TARGET`で、保持者である敵自身の行動終了でだけ減り、0で失効して防御力が戻る", () => {
    // 付与そのものと `timeLimit: { unit: ACTION, count: 2 }` の宣言は `-001` の
    // AS2行が持つ。ここが引き受けるのは、**別の行動を跨いで**残り回数がどう動くか。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const granted = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_AS2_DEF_DOWN", target: "ENEMY" },
    ]);

    expect(
      observeEffectExpiry({
        units: granted,
        definitions: board.definitions,
        steps: [
          { kind: "ACTION_END", actor: "ally:subject" },
          { kind: "ACTION_END", actor: "enemy:front" },
          { kind: "ACTION_END", actor: "enemy:left" },
          { kind: "ACTION_END", actor: "enemy:front" },
        ],
        watch: [{ unitId: "enemy:front", stat: "defense" }],
      }).steps,
    ).toEqual([
      // 付与した側（ドロテア）の行動終了では減らない — 期間の所有者は保持者自身。
      {
        step: "ACTION_END(ally:subject)",
        remaining: { "enemy:front/ACT_DOROTHEA_PIONEER_AS2_DEF_DOWN": 2 },
      },
      {
        step: "ACTION_END(enemy:front)",
        remaining: { "enemy:front/ACT_DOROTHEA_PIONEER_AS2_DEF_DOWN": 1 },
      },
      // 同じ陣営でも保持者以外の行動終了では減らない。
      {
        step: "ACTION_END(enemy:left)",
        remaining: { "enemy:front/ACT_DOROTHEA_PIONEER_AS2_DEF_DOWN": 1 },
      },
      {
        step: "ACTION_END(enemy:front)",
        remaining: {},
        expired: [
          {
            unitId: "enemy:front",
            effectActionDefinitionId: "ACT_DOROTHEA_PIONEER_AS2_DEF_DOWN",
            reason: "TIME_LIMIT",
            cascaded: false,
          },
        ],
        // 失効で `recalculateCombatStats` が5%低下を巻き戻す（475 → 500）。
        stats: { "enemy:front/defense": 500 },
      },
    ]);
  });
});
