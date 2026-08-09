import { describe, expect, it } from "vitest";
import { applyEffectActionGroups } from "../../../domain/battle/lifecycle/effect-action-group-resolver.js";
import { createBattleUnitId } from "../../../domain/shared/ids.js";
import { resolveSkillOrder } from "../../../domain/battle/skill/skill-resolution-service.js";
import {
  completedTargetIdsOf,
  effectActionGroupContext,
  initialSnapshotFor,
  loadProductionSnapshot,
  reconstruct,
  seedRecorder,
  skillFrom,
  unitFrom,
} from "../../../testing/fixtures/index.js";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
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
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { effectApplied, turnStarted } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_KEI_JACKKNIFE`（【無邪気なジャックナイフ】彩峰慧）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_KEI_JACKKNIFE";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const ROUSHIN_MARKER_ID = "MARKER_ROUSHIN";

/** 「狼心」はAS1が自身へ付けるMarkerで、AS2の分岐条件になる。 */
const ROUSHIN: BoardOverrides = { subject: { markers: [{ markerId: ROUSHIN_MARKER_ID }] } };

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_KEI_JACKKNIFE_EX",
    intent: "敵全体に威力74.2で5ヒット攻撃し、1行動の間行動速度を50低下させる（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KEI_JACKKNIFE_EX" },
    expected: {
      // 速度低下はデバフなので、最初の1体への付与がPS2（敵にデバフが付与された際）を
      // 呼ぶ。PS2はクールタイム1行動のため2体目以降では発動しない。
      actions: [
        { effectActionDefinitionId: "ACT_KEI_JACKKNIFE_EX_DAMAGE", targets: ["enemy:front"] },
        // PS2の連鎖は`EffectApplied`の時点で走るため、付与側の完了記録より先に出る。
        { effectActionDefinitionId: "ACT_KEI_JACKKNIFE_PS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KEI_JACKKNIFE_EX_SPEED_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KEI_JACKKNIFE_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_KEI_JACKKNIFE_EX_SPEED_DOWN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_KEI_JACKKNIFE_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_KEI_JACKKNIFE_EX_SPEED_DOWN", targets: ["enemy:back"] },
      ],
      // 1ヒット371（(1000-500)×74.2%）×5ヒット。enemy:frontはPS2の795が加わる。
      hpDeltas: {
        "enemy:front": -2650,
        "enemy:left": -1855,
        "enemy:back": -1855,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_KEI_JACKKNIFE_EX_SPEED_DOWN",
          magnitude: -50,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_KEI_JACKKNIFE_EX_SPEED_DOWN",
          magnitude: -50,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_KEI_JACKKNIFE_EX_SPEED_DOWN",
          magnitude: -50,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_KEI_JACKKNIFE_PS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KEI_JACKKNIFE_AS1",
    intent:
      "敵3体に威力151.68で攻撃し、さらに自身に最も近い敵に隣接する敵に対して威力94.8で攻撃する。加えて自身に対し1行動の「狼心」を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KEI_JACKKNIFE_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_KEI_JACKKNIFE_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KEI_JACKKNIFE_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_KEI_JACKKNIFE_AS1_DAMAGE", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_KEI_JACKKNIFE_AS1_DAMAGE_ADJACENT",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_KEI_JACKKNIFE_AS1_DAMAGE_ADJACENT",
          targets: ["enemy:back"],
        },
        { effectActionDefinitionId: "ACT_KEI_JACKKNIFE_AS1_MARKER", targets: ["ally:subject"] },
      ],
      // 3体への758に加え、最も近い敵（enemy:front）へ隣接する2体は474を上乗せされる。
      hpDeltas: {
        "enemy:front": -758,
        "enemy:left": -1232,
        "enemy:back": -1232,
      },
      markers: [{ unitId: "ally:subject", markerId: ROUSHIN_MARKER_ID, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_KEI_JACKKNIFE_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KEI_JACKKNIFE_AS2",
    intent: "敵単体に威力156で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KEI_JACKKNIFE_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_KEI_JACKKNIFE_AS2_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -780,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KEI_JACKKNIFE_AS2",
    intent: "自身が「狼心」を所持している場合この攻撃の威力は254.4になり、攻撃範囲が3体になる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KEI_JACKKNIFE_AS2" },
    board: ROUSHIN,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_KEI_JACKKNIFE_AS2_DAMAGE_BOOSTED",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_KEI_JACKKNIFE_AS2_DAMAGE_BOOSTED",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_KEI_JACKKNIFE_AS2_DAMAGE_BOOSTED",
          targets: ["enemy:back"],
        },
      ],
      hpDeltas: {
        "enemy:front": -1272,
        "enemy:left": -1272,
        "enemy:back": -1272,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KEI_JACKKNIFE_PS1",
    intent:
      "ターン開始時に発動。自身の最大HPを20%上昇させ（解除不可）、自身に対し、自身のHPが最大HPの65%以上の場合にのみ被ダメージを30%減少させる効果を付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KEI_JACKKNIFE_PS1",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_KEI_JACKKNIFE_PS1_MAXHP_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_KEI_JACKKNIFE_PS1_DMG_DOWN", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_KEI_JACKKNIFE_PS1_MAXHP_UP",
          magnitude: 0.2,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_KEI_JACKKNIFE_PS1_DMG_DOWN",
          magnitude: -0.3,
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
    skillDefinitionId: "SKL_KEI_JACKKNIFE_PS1",
    intent: "(不成立): このスキルは戦闘中に1度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KEI_JACKKNIFE_PS1",
      trigger: turnStarted({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    board: {
      subject: {
        state: {
          skillCounters: {
            [createSkillDefinitionId("SKL_KEI_JACKKNIFE_PS1")]: {
              [createRuntimeCounterId("SKL_KEI_JACKKNIFE_PS1_ACTIVATIONS")]: { value: 1, carry: 0 },
            },
          },
        },
      },
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_KEI_JACKKNIFE_PS2",
    intent: "敵にデバフが付与された際に発動。付与された敵単体に対し、威力159で攻撃する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KEI_JACKKNIFE_PS2",
      trigger: effectApplied({
        source: "ally:subject",
        target: "enemy:left",
        effectKind: "APPLY_STAT_MOD",
        categories: ["DEBUFF"],
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      // 攻撃は「付与された敵」へ向かうため、既定の対象選択ではなく enemy:left になる。
      actions: [
        { effectActionDefinitionId: "ACT_KEI_JACKKNIFE_PS2_DAMAGE", targets: ["enemy:left"] },
      ],
      hpDeltas: {
        "enemy:left": -795,
      },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_KEI_JACKKNIFE_PS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KEI_JACKKNIFE_PS2",
    intent: "(不成立): 敵にバフが付与されても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KEI_JACKKNIFE_PS2",
      trigger: effectApplied({
        source: "enemy:front",
        target: "enemy:left",
        effectKind: "APPLY_STAT_MOD",
        categories: ["BUFF"],
      }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_KEI_JACKKNIFE_PS2",
    intent: "(不成立): 味方にデバフが付与されても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KEI_JACKKNIFE_PS2",
      trigger: effectApplied({
        source: "enemy:front",
        target: "ally:front",
        effectKind: "APPLY_STAT_MOD",
        categories: ["DEBUFF"],
      }),
    },
    expected: {
      activated: false,
    },
  },
];

describe("production Catalog UNIT_KEI_JACKKNIFE (【無邪気なジャックナイフ】彩峰慧)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-KEI-JACKKNIFE-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-KEI-JACKKNIFE-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-KEI-JACKKNIFE-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-KEI-JACKKNIFE-004 (R-SKL-07, R-ACTN-03): AS2の実マーカーBRANCHは `EffectStepStarting` を1件だけ発行し、選ばれなかった腕のEffectActionを一切実行せず、その StateDelta だけからも独立Reducerが同じHPを復元する", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, ROUSHIN);
    const skill = skillFrom(snapshot, "SKL_KEI_JACKKNIFE_AS2");
    const { recorder, rootEventId } = seedRecorder("B_KEI_BRANCH");
    const result = applyEffectActionGroups(
      resolveSkillOrder(
        skill,
        board.subject,
        board.units,
        board.definitions.effectActions,
        undefined,
        board.definitions.unitDefinitions,
      ),
      board.units,
      effectActionGroupContext({
        actor: board.subject,
        skillId: "SKL_KEI_JACKKNIFE_AS2",
        definitions: board.definitions,
        recorder,
        rootEventId,
      }),
    );

    expect(
      recorder
        .getEvents()
        .filter(
          (event) =>
            event.eventType === "EffectStepStarting" &&
            (event.payload as { stepKind?: string }).stepKind === "BRANCH",
        ),
    ).toHaveLength(1);
    expect(
      [...completedTargetIdsOf(recorder, "ACT_KEI_JACKKNIFE_AS2_DAMAGE_BOOSTED")].sort(),
    ).toEqual(["enemy:back", "enemy:front", "enemy:left"]);
    expect(completedTargetIdsOf(recorder, "ACT_KEI_JACKKNIFE_AS2_DAMAGE")).toEqual([]);

    const reconstructed = reconstruct(initialSnapshotFor(board.units), recorder);
    for (const battleUnitId of ["enemy:front", "enemy:left", "enemy:back"].map((id) =>
      createBattleUnitId(id),
    )) {
      const updated = result.units.find((unit) => unit.battleUnitId === battleUnitId)!;
      expect(reconstructed.units[battleUnitId]?.hp).toBe(updated.currentHp);
    }
  });
});
