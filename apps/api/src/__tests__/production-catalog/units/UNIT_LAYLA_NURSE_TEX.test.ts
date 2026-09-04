import { describe, expect, it } from "vitest";
import { createEffectActionDefinitionId } from "../../../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../../domain/catalog/definitions/effect-action-definition.js";
import type { BattleDomainEvent } from "../../../domain/battle/events/domain-event.js";
import { applyHealAction } from "../../../domain/battle/resolution/heal-application-service.js";
import { loadProductionSnapshot, seedRecorder, unitFrom } from "../../../testing/fixtures/index.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import { openPassiveChain } from "../../../testing/production-unit/passive-activation.js";
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
import {
  realDamage,
  skillUseCompleted,
  turnStarted,
  unitDefeated,
} from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_LAYLA_NURSE_TEX`（破壊：レイラ・ジェンキンス・戦術演習版）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * このユニットは戦術演習の敵専用（`category: EXERCISE_ENEMY`、R-TEX-11）で、原文は
 * `raw/units/` のwiki転記ではなく**ゲーム内スクリーンショットからの転記**である
 * （Issue #665に原文を引用）。プレイアブル版`UNIT_LAYLA_NURSE`との差分は**Lv200固定の
 * ステータスのみ**で、スキルの威力・閾値・内容はプレイアブル版と完全一致する
 * （他TEX前例と異なりスキル側の「+」強化がない）。
 */

const UNIT_DEFINITION_ID = "UNIT_LAYLA_NURSE_TEX";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const KANSATSU = "MARKER_LAYLA_NURSE_TEX_KANSATSU";

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_LAYLA_NURSE_TEX_EX",
    intent:
      "最もHP割合の低い敵を対象とし、対象が含まれる敵前後列に威力78で攻撃する。さらに対象が含まれる敵横一列に威力53で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LAYLA_NURSE_TEX_EX" },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 1000 },
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      // 最もHP割合が低いenemy:front(10%)が基準対象。前後列(CENTER列)はfront+back、
      // 横一列(FRONT行)はfront+left。基準対象は両方に含まれ二重ヒットする。
      actions: [
        {
          effectActionDefinitionId: "ACT_LAYLA_NURSE_TEX_EX_DAMAGE_COLUMN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_LAYLA_NURSE_TEX_EX_DAMAGE_COLUMN",
          targets: ["enemy:back"],
        },
        { effectActionDefinitionId: "ACT_LAYLA_NURSE_TEX_EX_DAMAGE_ROW", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LAYLA_NURSE_TEX_EX_DAMAGE_ROW", targets: ["enemy:left"] },
      ],
      // (1000-500)×0.78=390、(1000-500)×0.53=265。enemy:frontは両方を受ける。
      hpDeltas: { "enemy:front": -655, "enemy:back": -390, "enemy:left": -265 },
    },
  },
  {
    skillDefinitionId: "SKL_LAYLA_NURSE_TEX_AS1",
    intent: "「観察」状態の敵を優先し、敵単体に威力127.2で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LAYLA_NURSE_TEX_AS1" },
    expected: {
      // 「観察」の保持者がいないため通常の対象選択(DEFAULT)へフォールバックする。
      actions: [
        { effectActionDefinitionId: "ACT_LAYLA_NURSE_TEX_AS1_DAMAGE", targets: ["enemy:front"] },
      ],
      // (1000-500)×1.272=636。
      hpDeltas: { "enemy:front": -636 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LAYLA_NURSE_TEX_AS1",
    intent: "「観察」状態の敵を優先し...。対象が「観察」状態の場合、この攻撃は防御力を30%無視する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LAYLA_NURSE_TEX_AS1" },
    board: {
      enemies: [
        {
          id: "enemy:left",
          position: { column: "LEFT", row: "FRONT" },
          markers: [{ markerId: KANSATSU }],
        },
      ],
    },
    expected: {
      // 「観察」を保持するenemy:leftがDEFAULT順序を無視して優先選択される。
      actions: [
        {
          effectActionDefinitionId: "ACT_LAYLA_NURSE_TEX_AS1_DAMAGE_PIERCE",
          targets: ["enemy:left"],
        },
      ],
      // 防御力30%無視: 実効防御500×0.7=350。(1000-350)×1.272=826.8→826。
      hpDeltas: { "enemy:left": -826 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LAYLA_NURSE_TEX_PS1",
    intent:
      "自身が敵から攻撃を受けた直後に発動。攻撃してきた敵単体に対し、自身が2回行動を終えるまでの間「観察」を付与する。さらに対象の攻撃力を20%低下させ（重複可）、対象と自身に対して回復リンクを付与し、対象が得られる回復効果を100%自身に転送する状態にする",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LAYLA_NURSE_TEX_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "AS" }),
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_LAYLA_NURSE_TEX_PS1_KANSATSU_MARK",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_LAYLA_NURSE_TEX_PS1_ATK_DOWN", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_LAYLA_NURSE_TEX_PS1_HEALING_LINK",
          targets: ["enemy:front"],
        },
      ],
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_LAYLA_NURSE_TEX_PS1_ATK_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_LAYLA_NURSE_TEX_PS1_HEALING_LINK",
          magnitude: 1,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
      ],
      markers: [{ unitId: "enemy:front", markerId: KANSATSU, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LAYLA_NURSE_TEX_PS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LAYLA_NURSE_TEX_PS2",
    intent:
      "「観察」状態の敵がアクティブスキルを使用した後に発動。対象の敵単体に威力110.44で攻撃し、対象のEXゲージとPPを１ずつ削る",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LAYLA_NURSE_TEX_PS2",
      trigger: skillUseCompleted({
        actor: "enemy:front",
        targets: ["ally:subject"],
        skillType: "AS",
      }),
    },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          markers: [{ markerId: KANSATSU }],
          state: { currentExtraGauge: 2 },
        },
      ],
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LAYLA_NURSE_TEX_PS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LAYLA_NURSE_TEX_PS2_EX_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LAYLA_NURSE_TEX_PS2_PP_DOWN", targets: ["enemy:front"] },
      ],
      // (1000-500)×1.1044=552.2→552。
      hpDeltas: { "enemy:front": -552 },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "enemy:front", resource: "PP", delta: -1 },
        { unitId: "enemy:front", resource: "EX_GAUGE", delta: -1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LAYLA_NURSE_TEX_PS2",
    intent: "(不成立): 「観察」状態ではない敵がアクティブスキルを使用しても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LAYLA_NURSE_TEX_PS2",
      trigger: skillUseCompleted({
        actor: "enemy:front",
        targets: ["ally:subject"],
        skillType: "AS",
      }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_LAYLA_NURSE_TEX_PS2",
    intent: "(不成立): 「観察」状態の敵がEXスキルを使用しても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LAYLA_NURSE_TEX_PS2",
      trigger: skillUseCompleted({
        actor: "enemy:front",
        targets: ["ally:subject"],
        skillType: "EX",
      }),
    },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          markers: [{ markerId: KANSATSU }],
        },
      ],
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_LAYLA_NURSE_TEX_PS3",
    intent:
      "ターン開始時に発動。自身に対し1ターンのステルスと、1ターンの間自身の現在HPの20%を超えるダメージのみ65%減少させる効果を付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LAYLA_NURSE_TEX_PS3",
      trigger: turnStarted({ turnNumber: 1 }),
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LAYLA_NURSE_TEX_PS3_STEALTH", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_LAYLA_NURSE_TEX_PS3_THRESHOLD_DMG_DOWN",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LAYLA_NURSE_TEX_PS3_STEALTH",
          magnitude: 0,
          timeLimit: { unit: "TURN", count: 1 },
          statusKind: "STEALTH",
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LAYLA_NURSE_TEX_PS3_THRESHOLD_DMG_DOWN",
          magnitude: -0.65,
          timeLimit: { unit: "TURN", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LAYLA_NURSE_TEX_PS3", remaining: 1 },
      ],
    },
  },
];

describe("production Catalog UNIT_LAYLA_NURSE_TEX (破壊：レイラ・ジェンキンス)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-LAYLA-NURSE-TEX-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-LAYLA-NURSE-TEX-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-LAYLA-NURSE-TEX-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  // -004〜-005: PS1の回復リンク（R-HEAL-04）とLinked Effect Group連動失効
  // （R-EFF-09、R-EFF-10）は、「付与」と「以後の別の出来事（回復の転送／付与者の
  // 戦闘不能）」が別の時点で起こるため、単発のEffectAction観測（`-001`表）には
  // 現れない。PS1自身が実際に配る3つのproduction EffectAction
  // （KANSATSU_MARK/ATK_DOWN/HEALING_LINK）を`applyPrecedingActions`で敵へ実際に
  // 保持させたうえで、別経路の回復・`UnitDefeated`を通して確認する。

  const ATK_DOWN_ID = "ACT_LAYLA_NURSE_TEX_PS1_ATK_DOWN";
  const HEALING_LINK_ID = "ACT_LAYLA_NURSE_TEX_PS1_HEALING_LINK";
  const KANSATSU_MARK_ID = "ACT_LAYLA_NURSE_TEX_PS1_KANSATSU_MARK";

  /** PS1が実際に付与する3つの効果を、実productionEffectActionでenemy:frontへ持たせた盤面。 */
  function boardWithKansatsuGranted() {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const units = applyPrecedingActions(board, [
      { effectActionDefinitionId: KANSATSU_MARK_ID, target: "ENEMY" },
      { effectActionDefinitionId: ATK_DOWN_ID, target: "ENEMY" },
      { effectActionDefinitionId: HEALING_LINK_ID, target: "ENEMY" },
    ]);
    return { board, units };
  }

  it("IT-UNIT-LAYLA-NURSE-TEX-004 [R-HEAL-04]: ACT_LAYLA_NURSE_TEX_PS1_HEALING_LINK resolves transferTo: SELF to ally:subject (Layla) at grant time, and a real heal landing on the holder transfers 100% to Layla instead of applying to the holder", () => {
    const { board, units } = boardWithKansatsuGranted();
    const enemyAfterGrant = units.find((unit) => unit.battleUnitId === "enemy:front")!;
    const link = enemyAfterGrant.appliedEffects.find(
      (effect) => effect.effectActionDefinitionId === HEALING_LINK_ID,
    );
    // 付与時点でtransferToはレイラ（付与者=SKILL_SOURCE）へ解決済みでなければならない。
    expect(link?.healingLink).toEqual({ transferToUnitId: SUBJECT_ID, transferRate: 1 });

    const healAction: Extract<EffectActionDefinition, { kind: "HEAL" }> = {
      kind: "HEAL",
      effectActionDefinitionId: createEffectActionDefinitionId(
        "ACT_TEST_LAYLA_NURSE_TEX_HEAL_PROBE",
      ),
      metadata: { tags: [] },
      payload: {
        formula: { kind: "CONSTANT", value: 100 },
        overheal: "DISCARD",
        distribution: "NONE",
      },
    };
    const enemy = units.find((unit) => unit.battleUnitId === "enemy:front")!;
    const subjectBefore = units.find((unit) => unit.battleUnitId === SUBJECT_ID)!;
    const { recorder, rootEventId } = seedRecorder("B_LAYLA_NURSE_TEX_PS1_HEAL_PROBE");

    const healed = applyHealAction(
      [
        {
          targetUnitId: enemy.battleUnitId,
          effectActionDefinitionId: healAction.effectActionDefinitionId,
          hitIndex: 1,
        },
      ],
      enemy,
      healAction,
      units,
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 1,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
        parentEventId: rootEventId,
        sourceUnitId: enemy.battleUnitId,
        effectActions: board.definitions.effectActions,
      },
    );

    // 保持者(enemy:front)自身のHPは動かない — 全量がレイラへ転送される。
    const enemyAfterHeal = healed.units.find((unit) => unit.battleUnitId === "enemy:front")!;
    expect(enemyAfterHeal.currentHp).toBe(enemy.currentHp);
    const subjectAfterHeal = healed.units.find((unit) => unit.battleUnitId === SUBJECT_ID)!;
    expect(subjectAfterHeal.currentHp).toBe(subjectBefore.currentHp + 100);

    const transferred = recorder
      .getEvents()
      .find(
        (event): event is Extract<BattleDomainEvent, { eventType: "HealingTransferred" }> =>
          event.eventType === "HealingTransferred",
      );
    // `effectActionDefinitionId`は転送を発生させたHEAL自身ではなく、転送元の
    // 回復リンクを指す（PS1が付与したACT_LAYLA_NURSE_TEX_PS1_HEALING_LINK）。
    expect(transferred?.payload).toMatchObject({
      effectActionDefinitionId: HEALING_LINK_ID,
      fromUnitId: enemy.battleUnitId,
      toUnitId: SUBJECT_ID,
      transferRate: 1,
      transferredAmount: 100,
      appliedAmount: 100,
    });
  });

  it("IT-UNIT-LAYLA-NURSE-TEX-005 [R-EFF-09, R-EFF-10]: the ATK debuff and healing link are removed together with the KANSATSU marker when Layla (the grantor) is defeated", () => {
    const { board, units } = boardWithKansatsuGranted();
    const enemyBefore = units.find((unit) => unit.battleUnitId === "enemy:front")!;
    expect(enemyBefore.markerStates.map((marker) => marker.markerId)).toEqual([KANSATSU]);
    expect(
      [...enemyBefore.appliedEffects.map((effect) => effect.effectActionDefinitionId)].sort(),
    ).toEqual([ATK_DOWN_ID, HEALING_LINK_ID].sort());

    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: SUBJECT_ID,
      battleId: "B_LAYLA_NURSE_TEX_PS1_DEFEAT",
    });
    const afterDefeat = chain.fire(
      unitDefeated({ unit: SUBJECT_ID, defeatedBy: "enemy:front" }),
      units.map((unit) =>
        unit.battleUnitId === SUBJECT_ID ? { ...unit, currentHp: 0, isAlive: false } : unit,
      ),
    );

    const enemyAfter = afterDefeat.find((unit) => unit.battleUnitId === "enemy:front")!;
    expect(enemyAfter.markerStates).toEqual([]);
    const remainingActionIds = enemyAfter.appliedEffects.map(
      (effect) => effect.effectActionDefinitionId,
    );
    expect(remainingActionIds).not.toContain(ATK_DOWN_ID);
    expect(remainingActionIds).not.toContain(HEALING_LINK_ID);
  });
});
