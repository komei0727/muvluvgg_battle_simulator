import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import {
  observeChargeEvasion,
  observeChargeLifecycle,
} from "../../../testing/production-unit/charge-restriction.js";
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
import { skillUseCompleted } from "../../../testing/production-unit/trigger-events.js";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";

/**
 * `UNIT_MIRIAM_MAGE`(【元気印の大魔導士】ミリアム・ヘイワード)のユニット単位production
 * 結合テスト(`12_テスト戦略.md`「ユニット効果軸」)。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_MIRIAM_MAGE";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/**
 * 「チャージ中は回避しない」（`R-HIT-02`）は抑止する側（このユニットのチャージAS）と
 * 抑止される側（回避効果）が別ユニットにあるため、回避効果の供給元だけをsnapshotへ
 * 併読する。回避効果そのものは未改変の実 production 定義を使う。
 */
const WITH_EVASION_SOURCE = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  "UNIT_ANIS_TROUBLEMAKER",
]);

/** 後列の敵だけがHP30%。EXの凍結が「HPが30%以下の敵」だけへ入ることを判別する。 */
const ENEMY_WITH_LOW_HP: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" }, state: { currentHp: 3000 } },
];

/** PS1は「アクティブスキル3回目の使用」でだけ発動する。counterを2に置いて次を3回目にする。 */
const PS1_COUNTER_AT_TWO = {
  subject: {
    state: {
      skillCounters: {
        [createSkillDefinitionId("SKL_MIRIAM_MAGE_PS1")]: {
          [createRuntimeCounterId("SKL_MIRIAM_MAGE_PS1_TRIGGER_COUNT")]: { value: 2, carry: 0 },
        },
      },
    },
  },
};

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_MIRIAM_MAGE_EX",
    intent:
      "敵全体に威力93.6でEN攻撃し、2行動の間、行動時に攻撃力×12%のENダメージを受けるデバフを付与する。さらにHPが30%以下の敵に対し、1行動の凍結を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MIRIAM_MAGE_EX" },
    board: { enemies: ENEMY_WITH_LOW_HP },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MIRIAM_MAGE_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MIRIAM_MAGE_EX_DOT_DEBUFF", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MIRIAM_MAGE_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MIRIAM_MAGE_EX_DOT_DEBUFF", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MIRIAM_MAGE_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_MIRIAM_MAGE_EX_DOT_DEBUFF", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_MIRIAM_MAGE_EX_FREEZE", targets: ["enemy:back"] },
      ],
      hpDeltas: { "enemy:front": -468, "enemy:left": -468, "enemy:back": -468 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_MIRIAM_MAGE_EX_DOT_DEBUFF",
          magnitude: 120,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_MIRIAM_MAGE_EX_DOT_DEBUFF",
          magnitude: 120,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_MIRIAM_MAGE_EX_DOT_DEBUFF",
          magnitude: 120,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_MIRIAM_MAGE_EX_FREEZE",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "FREEZE",
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MIRIAM_MAGE_AS1",
    intent:
      "敵3体に威力62.4でEN攻撃し、1行動の間対象の与ダメージを10%減少させる(重複可)。さらに威力31.2で1ヒットずつ追加攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MIRIAM_MAGE_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MIRIAM_MAGE_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MIRIAM_MAGE_AS1_DMG_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MIRIAM_MAGE_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MIRIAM_MAGE_AS1_DMG_DOWN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MIRIAM_MAGE_AS1_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_MIRIAM_MAGE_AS1_DMG_DOWN", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_MIRIAM_MAGE_AS1_DAMAGE_EXTRA", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MIRIAM_MAGE_AS1_DAMAGE_EXTRA", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MIRIAM_MAGE_AS1_DAMAGE_EXTRA", targets: ["enemy:back"] },
      ],
      // 本体312（威力62.4%）と追加攻撃156（威力31.2%）の合計。追加攻撃は本体と別の
      // stepであり、3体分の本体が解決し終えてから改めて3体へ入る。
      hpDeltas: { "enemy:front": -468, "enemy:left": -468, "enemy:back": -468 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_MIRIAM_MAGE_AS1_DMG_DOWN",
          magnitude: -0.1,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_MIRIAM_MAGE_AS1_DMG_DOWN",
          magnitude: -0.1,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_MIRIAM_MAGE_AS1_DMG_DOWN",
          magnitude: -0.1,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MIRIAM_MAGE_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MIRIAM_MAGE_AS2",
    intent: "スキルの発動タイミングでチャージを開始(消費ポイント2・クールタイム2行動)",
    use: { kind: "CHARGE", skillDefinitionId: "SKL_MIRIAM_MAGE_AS2", phase: "START" },
    expected: {
      charge: "SKL_MIRIAM_MAGE_AS2",
      resources: [{ unitId: "ally:subject", resource: "AP", delta: -2 }],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MIRIAM_MAGE_AS2", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MIRIAM_MAGE_AS2",
    intent:
      "次に自身の行動順が巡ってきた際、敵横一列に3行動の凍結を付与する。凍結状態中は全ての行動を行うことができない。ダメージを受けると凍結状態は解除されるが、その際の被ダメージが100%増加する",
    use: { kind: "CHARGE", skillDefinitionId: "SKL_MIRIAM_MAGE_AS2", phase: "RELEASE" },
    expected: {
      // 敵横一列は既定対象（敵前列中央）と同じ行の enemy:front・enemy:left。
      charge: null,
      actions: [
        { effectActionDefinitionId: "ACT_MIRIAM_MAGE_AS2_FREEZE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MIRIAM_MAGE_AS2_FREEZE", targets: ["enemy:left"] },
      ],
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_MIRIAM_MAGE_AS2_FREEZE",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 3 },
          statusKind: "FREEZE",
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_MIRIAM_MAGE_AS2_FREEZE",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 3 },
          statusKind: "FREEZE",
        },
      ],
      // 解放も自身の1行動であるため、開始時に置かれた自分のクールタイムが1つ減る。
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MIRIAM_MAGE_AS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MIRIAM_MAGE_AS3",
    intent: "敵単体に威力159でEN攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MIRIAM_MAGE_AS3" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MIRIAM_MAGE_AS3_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -795 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MIRIAM_MAGE_PS1",
    intent: "自身がアクティブスキルを3回使用するたびに発動。敵単体に威力95.4でEN攻撃する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MIRIAM_MAGE_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_MIRIAM_MAGE_AS3",
      }),
      triggeredBy: "ally:subject",
    },
    board: PS1_COUNTER_AT_TWO,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MIRIAM_MAGE_PS1_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -477 },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MIRIAM_MAGE_PS1",
    intent: "(不成立): 1回目・2回目の使用では発動しない(「3回使用するたび」に限る)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MIRIAM_MAGE_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_MIRIAM_MAGE_AS3",
      }),
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_MIRIAM_MAGE_PS1",
    intent: "(不成立): EXスキルの使用では数えない(「アクティブスキルを」に限る)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MIRIAM_MAGE_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "EX",
        skillDefinitionId: "SKL_MIRIAM_MAGE_EX",
      }),
      triggeredBy: "ally:subject",
    },
    board: PS1_COUNTER_AT_TWO,
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_MIRIAM_MAGE_EX",
    intent: "同上: HPが30%以下の敵が居なくても、敵全体への攻撃とデバフは成立する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MIRIAM_MAGE_EX", actionType: "EX" },
    board: { enemies: [{ id: "enemy:front", position: { column: "CENTER", row: "FRONT" } }] },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_MIRIAM_MAGE_EX_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_MIRIAM_MAGE_EX_DOT_DEBUFF",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -468,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_MIRIAM_MAGE_EX_DOT_DEBUFF",
          magnitude: 120,
          timeLimit: {
            unit: "ACTION",
            count: 2,
          },
        },
      ],
    },
  },
];

describe("production Catalog UNIT_MIRIAM_MAGE (【元気印の大魔導士】ミリアム・ヘイワード)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-MIRIAM-MAGE-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-MIRIAM-MAGE-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-MIRIAM-MAGE-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-MIRIAM-MAGE-004 [R-SKL-05] (R-SKL-05): 実 SKL_MIRIAM_MAGE_AS2 のチャージ開始はEffectSequenceを一つも解決せず、チャージ状態だけを ChargeStarted の StateDelta へ載せる。終了差分は ChargeReleaseCompleted が単独で所有し、開始直後・解放後のどちらも独立Reducerで復元できる", () => {
    // `-001` の CHARGE 行は `charge`／消費／クールタイムまでを持つが、`StateDelta` の
    // 所有者と独立Reducer復元、Catalog契約（開始側 `steps` が空であること）は
    // スキル使用1回の観測の外にある。
    expect(
      observeChargeLifecycle({
        snapshot,
        chargerUnitDefinitionId: UNIT_DEFINITION_ID,
        chargeSkillDefinitionId: "SKL_MIRIAM_MAGE_AS2",
      }),
    ).toEqual({
      // 開始側は EffectSequence を持たない（`targetBindings` だけが
      // `activationCondition` のスコープとして意味を持つ）。解放側は必ず持つ。
      startSteps: 0,
      releaseSteps: 1,
      // 「チャージ中」を表す `APPLY_MARKER` は `charge` 状態と重複するため除去済み。
      chargeMarkerEffectActionIds: [],
      afterStart: { charge: "SKL_MIRIAM_MAGE_AS2", markerStates: 0, appliedEffects: 0 },
      startEventTypes: [
        "ActionStarted",
        "CooldownStarted",
        "ChargeStarted",
        "ActionCompleting",
        "ActionCompleted",
      ],
      chargeStarted: {
        skillDefinitionId: "SKL_MIRIAM_MAGE_AS2",
        chargeDelta: {
          before: undefined,
          after: {
            skillDefinitionId: "SKL_MIRIAM_MAGE_AS2",
            startedActionId: "B_CHARGE:action:1",
          },
        },
      },
      replayedChargeAfterStart: {
        skillDefinitionId: "SKL_MIRIAM_MAGE_AS2",
        startedActionId: "B_CHARGE:action:1",
      },
      chargeAfterRelease: null,
      chargeClearingEventTypes: ["ChargeReleaseCompleted"],
      replayedChargeAfterRelease: null,
    });
  });

  it("IT-UNIT-MIRIAM-MAGE-005 [R-HIT-02] (R-HIT-02): SKL_MIRIAM_MAGE_AS2 でチャージ中のミリアムは、保持している実 ACT_ANIS_TROUBLEMAKER_EX_EVASION を発動させず2ヒットとも命中する。チャージ開始だけを抜いた対照では同じ回避が1ヒット目を回避するため、不発の原因はチャージ状態だけである", () => {
    const options = {
      snapshot: WITH_EVASION_SOURCE,
      chargerUnitDefinitionId: UNIT_DEFINITION_ID,
      chargeSkillDefinitionId: "SKL_MIRIAM_MAGE_AS2",
      evasionEffectActionId: "ACT_ANIS_TROUBLEMAKER_EX_EVASION",
    };

    // 回避効果は攻撃後も保持したまま（未付与や失効による不発ではない）。
    expect(observeChargeEvasion({ ...options, charging: true })).toEqual({
      charge: "SKL_MIRIAM_MAGE_AS2",
      heldEvasion: { statusKind: "EVASION", probability: 1, consumptionRemaining: 1 },
      evasionActivated: 0,
      hitConfirmed: 2,
      damaged: true,
    });

    expect(observeChargeEvasion({ ...options, charging: false })).toEqual({
      charge: null,
      heldEvasion: null,
      evasionActivated: 1,
      hitConfirmed: 1,
      damaged: true,
    });
  });
});
