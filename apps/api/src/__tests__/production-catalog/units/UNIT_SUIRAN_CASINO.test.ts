import { describe, expect, it } from "vitest";
import {
  initialSnapshotFor,
  loadProductionSnapshot,
  noMissNoCrit,
  skillFrom,
  unitFrom,
} from "../../../testing/fixtures/index.js";
import type { BattleDomainEvent } from "../../../domain/battle/events/domain-event.js";
import { EventRecorder } from "../../../domain/battle/events/event-recorder.js";
import { resolveSkillUse } from "../../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { applyStateDelta } from "../../../domain/battle/lifecycle/state-delta-reducer.js";
import type { BattleUnit } from "../../../domain/battle/model/battle-unit.js";
import { decrementActionEffectDurations } from "../../../domain/battle/model/applied-effect-duration.js";
import { expireEffects } from "../../../domain/battle/effects/duration-expiry-service.js";
import { createActionId } from "../../../domain/shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../../domain/shared/ids.js";
import { observeDamageProbe } from "../../../testing/production-unit/damage-probe.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardOverrides,
  type ProductionBoard,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { realDamage } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_SUIRAN_CASINO`(【恥じらうカジノラビット】劉翠蘭)のユニット単位production
 * 結合テスト(`12_テスト戦略.md`「ユニット効果軸」)。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_SUIRAN_CASINO";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const THREE_CARD = "MARKER_SUIRAN_CASINO_THREE_CARD";

/** AS1の対象数分岐が「スリーカード」の腕を選ぶ前提。 */
const HOLDS_THREE_CARD: BoardOverrides = {
  subject: { markers: [{ markerId: THREE_CARD, stackCount: 1 }] },
};

/** AS2のBRANCHが成立するHP（70%以上）。 */
const SUBJECT_AT_80_PERCENT: BoardOverrides = { subject: { state: { currentHp: 8000 } } };

/** PS1のBRANCHが成立するHP（30%以下）。契機の被弾を含めて閾値を跨ぐ。 */
const SUBJECT_AT_25_PERCENT: BoardOverrides = { subject: { state: { currentHp: 2500 } } };

/** AS3のBRANCHが成立する（この攻撃で倒せる）敵陣。 */
const ENEMY_ALMOST_DEAD: BoardOverrides = {
  enemies: [
    { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, state: { currentHp: 100 } },
    { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
    { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
  ],
};

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_SUIRAN_CASINO_EX",
    intent: "敵全体に威力120.48で攻撃し、自身に対し3行動の間「スリーカード」を1つ付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SUIRAN_CASINO_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_EX_MARKER", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:front": -602, "enemy:left": -602, "enemy:back": -602 },
      markers: [{ unitId: "ally:subject", markerId: THREE_CARD, stackCount: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CASINO_AS1",
    intent:
      "自身に対し、最大HP×10%のシールドを1枚付与する。さらに最大HPが最も高い敵単体に威力156で攻撃し、与えたダメージの100%分のシールドをもう1枚自身に付与する。…さらに自身と自身以外の味方全体にダメージリンクを付与し（解除不可）、自身以外の味方が受けたダメージの50%を自身に転送する状態にする",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SUIRAN_CASINO_AS1" },
    expected: {
      // 「スリーカード」を持たないため対象は敵単体。
      actions: [
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_SHIELD1", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_SHIELD2", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK", targets: ["ally:back"] },
      ],
      hpDeltas: { "enemy:front": -780 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_SHIELD1",
          magnitude: 1000,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_SHIELD2",
          magnitude: 780,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK",
          magnitude: 0.5,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK",
          magnitude: 0.5,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK",
          magnitude: 0.5,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SUIRAN_CASINO_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CASINO_AS1",
    intent:
      "自身が「スリーカード」を所持していた場合、この攻撃の対象は最大HPが高い順の敵3体になる（「ワンペア」は本ユニットのどの定義も付与しないため、敵2体の腕は production に存在しない）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SUIRAN_CASINO_AS1" },
    board: HOLDS_THREE_CARD,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_SHIELD1", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_SHIELD2", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK", targets: ["ally:back"] },
      ],
      hpDeltas: { "enemy:front": -780, "enemy:left": -780, "enemy:back": -780 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_SHIELD1",
          magnitude: 1000,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_SHIELD2",
          // 3体へ与えた合計（780×3）が2枚目のシールドになる。
          magnitude: 2340,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK",
          magnitude: 0.5,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK",
          magnitude: 0.5,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK",
          magnitude: 0.5,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SUIRAN_CASINO_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CASINO_AS2",
    intent: "自身の最大HPの10%を消費し、敵単体に消費分HP×424%のダメージを与える攻撃をする",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SUIRAN_CASINO_AS2" },
    expected: {
      // HPが70%未満のため、APを削る腕は選ばれない。
      actions: [
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS2_HP_COST", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:front": -4240, "ally:subject": -1000 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SUIRAN_CASINO_AS2", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CASINO_AS2",
    intent: "スキル発動時に自身のHPが70%以上の場合、加えて対象のAPを1削る",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SUIRAN_CASINO_AS2" },
    board: SUBJECT_AT_80_PERCENT,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS2_AP_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS2_HP_COST", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:front": -4240, "ally:subject": -1000 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "enemy:front", resource: "AP", delta: -1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SUIRAN_CASINO_AS2", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CASINO_AS3",
    intent: "敵単体に威力62.4で3ヒット攻撃し、与えたダメージの150%分自身のHPを回復する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SUIRAN_CASINO_AS3" },
    expected: {
      // 倒せなかったため「スリーカード」の腕は選ばれない。
      actions: [
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS3_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS3_HEAL", targets: ["ally:subject"] },
      ],
      // 1ヒット312の3ヒットで936。その150%＝1404を回復する。
      hpDeltas: { "enemy:front": -936, "ally:subject": 1404 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CASINO_AS3",
    intent: "この攻撃で敵を倒した場合、1行動の間「スリーカード」を自身に付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SUIRAN_CASINO_AS3" },
    board: ENEMY_ALMOST_DEAD,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS3_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS3_HEAL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS3_MARKER", targets: ["ally:subject"] },
      ],
      // 1ヒット目で倒れるため残り2ヒットは走らない。回復は削れたHPではなく確定した
      // ダメージ312の150%＝468。
      hpDeltas: { "enemy:front": -100, "ally:subject": 468 },
      markers: [{ unitId: "ally:subject", markerId: THREE_CARD, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CASINO_PS1",
    intent:
      "自身が攻撃を受けた直後に発動。攻撃してきた敵単体に対し、2ヒットまで被ダメージが50%増加するデバフを付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SUIRAN_CASINO_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "AS" }),
    },
    expected: {
      // HPが30%を上回っているためシールドの腕は選ばれない。
      actions: [
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_PS1_DEBUFF", targets: ["enemy:front"] },
      ],
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SUIRAN_CASINO_PS1_DEBUFF",
          magnitude: 0.5,
          consumption: { kind: "INCOMING_HIT", maxCount: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CASINO_PS1",
    intent:
      "自身のHPが30%以下だった場合、味方全体に最大HP×20%のシールドを付与する。シールドは1回攻撃を受けたら消滅する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SUIRAN_CASINO_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "AS" }),
    },
    board: SUBJECT_AT_25_PERCENT,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_PS1_DEBUFF", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_PS1_SHIELD", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_PS1_SHIELD", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_SUIRAN_CASINO_PS1_SHIELD", targets: ["ally:back"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SUIRAN_CASINO_PS1_SHIELD",
          magnitude: 2000,
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_SUIRAN_CASINO_PS1_SHIELD",
          magnitude: 2000,
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_SUIRAN_CASINO_PS1_SHIELD",
          magnitude: 2000,
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SUIRAN_CASINO_PS1_DEBUFF",
          magnitude: 0.5,
          consumption: { kind: "INCOMING_HIT", maxCount: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CASINO_PS1",
    intent: "(不成立): 味方への攻撃では発動しない（契機は自身が受けた攻撃に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SUIRAN_CASINO_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:front", skillType: "AS" }),
    },
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_SUIRAN_CASINO (【恥じらうカジノラビット】劉翠蘭)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-SUIRAN-CASINO-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-SUIRAN-CASINO-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-SUIRAN-CASINO-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  /** 実AS1を実ライフサイクルへ通し、味方全体がダメージリンクを保持した状態を作る。 */
  function grantDamageLink(battleId: string): {
    readonly board: ProductionBoard;
    readonly recorder: EventRecorder;
    readonly units: readonly BattleUnit[];
  } {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const recorder = new EventRecorder(createBattleId(battleId));
    const resolved = resolveSkillUse(
      board.subject,
      skillFrom(snapshot, "SKL_SUIRAN_CASINO_AS1"),
      "AS",
      "AS",
      board.units,
      board.definitions,
      noMissNoCrit(),
      recorder,
      1,
      0,
      createActionId(`${battleId}:action:1`),
      recorder.nextResolutionScopeId(),
    );
    return { board, recorder, units: resolved.units };
  }

  it("IT-UNIT-SUIRAN-CASINO-004 (R-LNK-01/02/03): AS1が配る実ダメージリンクは、味方が受けたダメージの50%を**追加で**劉翠蘭へ発生させる。元ダメージは減らず、リンクダメージは `isLinkedDamage` を持ち、リンク先自身のシールドで受ける", () => {
    // `-001` のAS1行は付与そのもの（`linkTo: SELF`の解決先・50%・期間の所有者）を持つが、
    // 転送は**別のスキル使用**である被弾でしか起きないため表の外にある。
    const { board, recorder, units } = grantDamageLink("B_SUIRAN_LINK");
    const link = units
      .find((unit) => unit.battleUnitId === "ally:front")!
      .appliedEffects.find(
        (effect) => effect.effectActionDefinitionId === "ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK",
      )!;
    // 付与時点で `linkTo: SELF` は使用者（劉翠蘭）へ解決して焼き込む。
    expect(link.damageLink).toEqual({
      linkToUnitId: createBattleUnitId("ally:subject"),
      linkRate: 0.5,
    });

    // 公開差分だけを開始前スナップショットへ当てても、焼き込んだリンク先ごと復元される。
    const applied = recorder
      .getEvents()
      .find(
        (event): event is Extract<BattleDomainEvent, { eventType: "EffectApplied" }> =>
          event.eventType === "EffectApplied" &&
          event.payload.effectActionDefinitionId === "ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK" &&
          event.payload.targetUnitId === createBattleUnitId("ally:front"),
      )!;
    expect(applied.payload.effectKind).toBe("APPLY_DAMAGE_LINK");
    expect(
      applyStateDelta(initialSnapshotFor(board.units, { status: "READY" }), applied.stateDelta!)
        .units[createBattleUnitId("ally:front")]!.effects![0],
    ).toMatchObject({
      effectDefinitionId: "ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK",
      damageLink: { linkToUnitId: "ally:subject", linkRate: 0.5 },
    });

    const hit = observeDamageProbe({
      units,
      attackerUnitId: "enemy:front",
      targetUnitId: "ally:front",
      battleId: "B_SUIRAN_LINK_HIT",
    });
    expect(hit.linked).toEqual([
      {
        effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK",
        linkedFromUnitId: "ally:front",
        linkToUnitId: "ally:subject",
        sourceDamage: 500,
        linkRate: 0.5,
        linkedDamage: 250,
        damageType: "PHYSICAL",
        shieldApplicable: true,
      },
    ]);
    // R-LNK-01: 元ダメージは減らず、リンクは**追加で**発生する。
    // R-LNK-02第4項: リンク先自身のシールド（AS1が劉翠蘭へ張った1枚目）が250を吸収する。
    expect(hit.applications).toEqual([
      {
        targetUnitId: "ally:front",
        calculatedDamage: 500,
        hitPointDamage: 500,
        untypedShieldAbsorbed: 0,
        isLinkedDamage: false,
      },
      {
        targetUnitId: "ally:subject",
        calculatedDamage: 250,
        hitPointDamage: 0,
        untypedShieldAbsorbed: 250,
        isLinkedDamage: true,
      },
    ]);
    expect(hit.hpDeltas).toEqual({ "ally:front": -500 });
  });

  it("IT-UNIT-SUIRAN-CASINO-005 (R-EFF-01): 味方が保持するリンクの「2行動」は付与者（劉翠蘭）の時計で減る。素早い味方が2回行動してもリンクは残り、劉翠蘭が2回行動して初めて親の2枚目シールドと同時に失効する", () => {
    // `-001` のAS1行は `timeLimit: { unit: ACTION, count: 2, owner: EFFECT_SOURCE }` を
    // 宣言として持つが、**誰の行動で減るか**は行動を跨がないと現れない。
    const { recorder, units: granted } = grantDamageLink("B_SUIRAN_LINK_CLOCK");
    let units = granted;
    const linkOf = (all: readonly BattleUnit[]) =>
      all
        .find((unit) => unit.battleUnitId === "ally:front")!
        .appliedEffects.find(
          (effect) => effect.effectActionDefinitionId === "ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK",
        );
    expect(linkOf(units)?.duration.timeLimitRemaining).toBe(2);

    for (const sequence of [2, 3]) {
      const decrement = decrementActionEffectDurations(
        units,
        createBattleUnitId("ally:front"),
        createActionId(`B_SUIRAN_LINK_CLOCK:action:${sequence}`),
      );
      units = decrement.units;
      expect(decrement.changes).toEqual([]);
    }
    expect(linkOf(units)?.duration.timeLimitRemaining).toBe(2);

    const expiredDefinitionIdsPerAction: string[][] = [];
    for (const sequence of [4, 5]) {
      const currentActionId = createActionId(`B_SUIRAN_LINK_CLOCK:action:${sequence}`);
      const decrement = decrementActionEffectDurations(
        units,
        createBattleUnitId("ally:subject"),
        currentActionId,
      );
      const seeds = decrement.changes
        .filter((change) => change.after === 0)
        .map((change) => ({
          battleUnitId: change.battleUnitId,
          effectInstanceId: change.effectInstanceId,
          reason: "TIME_LIMIT" as const,
        }));
      expiredDefinitionIdsPerAction.push(
        units
          .flatMap((unit) => unit.appliedEffects)
          .filter((effect) =>
            seeds.some((seed) => seed.effectInstanceId === effect.effectInstanceId),
          )
          .map((effect) => effect.effectActionDefinitionId)
          .sort(),
      );
      units = decrement.units;
      if (seeds.length === 0) {
        continue;
      }
      units = expireEffects(
        {
          recorder,
          turnNumber: 1,
          cycleNumber: 1,
          actionId: currentActionId,
          resolutionScopeId: recorder.nextResolutionScopeId(),
          rootEventId: recorder.getEvents()[0]!.eventId,
        },
        units,
        seeds,
        snapshot.effectActions,
        recorder.getEvents()[recorder.getEvents().length - 1]!.eventId,
      ).units;
    }

    // 1行動目では1件も落ちない。2行動目で、親（2枚目シールド）と同じ時計を共有する
    // 全インスタンスが揃って失効する — 味方2体ぶんと劉翠蘭自身の自己リンク、
    // それに同じ2行動のシールド2枚。
    expect(expiredDefinitionIdsPerAction).toEqual([
      [],
      [
        "ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK",
        "ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK",
        "ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK",
        "ACT_SUIRAN_CASINO_AS1_SHIELD1",
        "ACT_SUIRAN_CASINO_AS1_SHIELD2",
      ],
    ]);
    expect(linkOf(units)).toBeUndefined();
  });
});
