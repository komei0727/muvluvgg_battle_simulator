import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "../../../domain/battle/resolution/action-skill-use-resolver.js";
import { EventRecorder } from "../../../domain/battle/events/event-recorder.js";
import type { BattleUnit } from "../../../domain/battle/model/battle-unit.js";
import type { BattleDefinitions } from "../../../domain/battle/model/battle-definitions.js";
import { createSkillDefinitionId } from "../../../domain/catalog/definitions/catalog-ids.js";
import { createActionId } from "../../../domain/shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../../domain/shared/ids.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
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
import {
  criticalCheckResolved,
  turnCompleting,
} from "../../../testing/production-unit/trigger-events.js";
import { rideStandInAttack } from "../../../testing/production-unit/follow-up-ride.js";
import {
  activatedPassiveSkillIds,
  openPassiveChain,
} from "../../../testing/production-unit/passive-activation.js";
import { computeCombatStats } from "../../../domain/battle/effects/combat-stat-recalculation-service.js";

/**
 * `UNIT_YIFEI_STORM`（【暴風小隊長】崔亦菲）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」、Issue #756）。
 *
 * AS1は原文の「攻撃し、…「ご指名」を付与する」と順序を入れ替え、ご指名を付けてから
 * 攻撃する。PS1は会心判定の時点でご指名を持つ敵にしか発動しないため（R-ATM-01）、
 * 原文どおりの順序ではAS1自身の会心で追撃が出ない。
 */

const UNIT_DEFINITION_ID = "UNIT_YIFEI_STORM";
const NOMINATION = "MARKER_YIFEI_STORM_NOMINATION";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** EX: 後列の敵だけ会心率が高く、既定順で先頭の前列中央ではなく後列を狙う盤面。 */
const BACK_ENEMY_HIGHEST_CRIT: BoardOverrides = {
  enemies: [
    { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
    { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
    {
      id: "enemy:back",
      position: { column: "CENTER", row: "BACK" },
      combatStats: { criticalRate: 0.5 },
    },
  ],
};

/** PS1: 前列中央の敵がご指名を持つ盤面。 */
const NOMINATED_FRONT_ENEMY: BoardOverrides = {
  enemies: [
    {
      id: "enemy:front",
      position: { column: "CENTER", row: "FRONT" },
      markers: [{ markerId: NOMINATION, stackCount: 1 }],
    },
    { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
    { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
  ],
};

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_YIFEI_STORM_EX",
    intent: "最も会心率の高い敵単体に威力23.4で7ヒット、さらに威力84.8で1ヒット攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_YIFEI_STORM_EX" },
    board: BACK_ENEMY_HIGHEST_CRIT,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_YIFEI_STORM_EX_DAMAGE_MULTI", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_YIFEI_STORM_EX_DAMAGE_FINISH", targets: ["enemy:back"] },
      ],
      hpDeltas: { "enemy:back": -1243 },
    },
  },
  {
    skillDefinitionId: "SKL_YIFEI_STORM_AS1",
    intent:
      "前列優先で敵2体に威力90.36で攻撃し、自身が2回行動を終えるまでの間「ご指名」を付与する。「ご指名」は自身が倒れると解除される",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_YIFEI_STORM_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_YIFEI_STORM_AS1_NOMINATION", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_YIFEI_STORM_AS1_NOMINATION", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_YIFEI_STORM_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_YIFEI_STORM_AS1_DAMAGE", targets: ["enemy:left"] },
      ],
      hpDeltas: { "enemy:front": -451, "enemy:left": -451 },
      markers: [
        { unitId: "enemy:front", markerId: NOMINATION, stackCount: 1 },
        { unitId: "enemy:left", markerId: NOMINATION, stackCount: 1 },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_YIFEI_STORM_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_YIFEI_STORM_AS2",
    intent:
      "敵単体に威力39で4ヒット攻撃する。さらに自身に対し最大HP×25%のシールドを付与し、会心率を7.5%·会心ダメージを13.5%上昇させる(重複可)。会心率·会心ダメージバフは解除不可だが、シールドと同時に消滅する。シールドは1回攻撃を受けると消滅する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_YIFEI_STORM_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_YIFEI_STORM_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_YIFEI_STORM_AS2_SHIELD", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_YIFEI_STORM_AS2_CRIT_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_YIFEI_STORM_AS2_CRIT_DMG_UP", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:front": -780 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_YIFEI_STORM_AS2_SHIELD",
          magnitude: 2500,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_YIFEI_STORM_AS2_CRIT_UP",
          magnitude: 0.075,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_YIFEI_STORM_AS2_CRIT_DMG_UP",
          magnitude: 0.135,
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_YIFEI_STORM_PS1",
    intent:
      "「ご指名」状態の敵への味方の攻撃が会心攻撃になるたびに発動。攻撃された敵単体に威力106で追撃し、自身のPPを1回復する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YIFEI_STORM_PS1",
      trigger: criticalCheckResolved({ source: "ally:front", target: "enemy:front", result: true }),
      triggeredBy: "ally:front",
    },
    board: NOMINATED_FRONT_ENEMY,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_YIFEI_STORM_PS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_YIFEI_STORM_PS1_PP_UP", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:front": -530 },
      // PPは発動で1消費し追撃後に1回復するため差し引き0。消費分のEXゲージだけが残る。
      resources: [{ unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_YIFEI_STORM_PS1",
    intent: "(自身の攻撃): 自身の攻撃が会心攻撃になった場合も発動する（味方には自身を含む）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YIFEI_STORM_PS1",
      trigger: criticalCheckResolved({
        source: "ally:subject",
        target: "enemy:front",
        result: true,
      }),
      triggeredBy: "ally:subject",
    },
    board: NOMINATED_FRONT_ENEMY,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_YIFEI_STORM_PS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_YIFEI_STORM_PS1_PP_UP", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:front": -530 },
      // PPは発動で1消費し追撃後に1回復するため差し引き0。消費分のEXゲージだけが残る。
      resources: [{ unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_YIFEI_STORM_PS1",
    intent: "(不成立): 「ご指名」状態でない敵への会心攻撃では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YIFEI_STORM_PS1",
      trigger: criticalCheckResolved({ source: "ally:front", target: "enemy:left", result: true }),
      triggeredBy: "ally:front",
    },
    board: NOMINATED_FRONT_ENEMY,
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_YIFEI_STORM_PS1",
    intent: "(不成立): 会心攻撃にならなかった攻撃では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YIFEI_STORM_PS1",
      trigger: criticalCheckResolved({
        source: "ally:front",
        target: "enemy:front",
        result: false,
      }),
      triggeredBy: "ally:front",
    },
    board: NOMINATED_FRONT_ENEMY,
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_YIFEI_STORM_PS2",
    intent: "ターン終了時に発動。自身の会心率を7.5％·防御力を7.5％上昇させる(重複可)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YIFEI_STORM_PS2",
      trigger: turnCompleting({ turnNumber: 1 }),
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_YIFEI_STORM_PS2_CRIT_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_YIFEI_STORM_PS2_DEF_UP", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_YIFEI_STORM_PS2_CRIT_UP",
          magnitude: 0.075,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_YIFEI_STORM_PS2_DEF_UP",
          magnitude: 0.075,
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
];

describe("production Catalog UNIT_YIFEI_STORM (【暴風小隊長】崔亦菲)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-YIFEI-STORM-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-YIFEI-STORM-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-YIFEI-STORM-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
        [],
      ),
    ).toEqual([]);
  });

  /** 崔亦菲に実定義のスキルを1回使わせる（PS連鎖を含む実`resolveSkillUse`経路）。 */
  function useSkill(options: {
    readonly units: readonly BattleUnit[];
    readonly definitions: BattleDefinitions;
    readonly skillId: string;
    readonly random: readonly number[];
    readonly recorder: EventRecorder;
    readonly actionNumber: number;
  }): readonly BattleUnit[] {
    const subjectId = createBattleUnitId("ally:subject");
    const actor = options.units.find((unit) => unit.battleUnitId === subjectId)!;
    const skill = options.definitions.skillDefinitions.get(
      createSkillDefinitionId(options.skillId),
    )!;
    return resolveSkillUse(
      actor,
      skill,
      "AS",
      "AS",
      options.units,
      options.definitions,
      new SequenceRandomSource(options.random),
      options.recorder,
      1,
      0,
      createActionId(`B_YIFEI:action:${options.actionNumber}`),
      options.recorder.nextResolutionScopeId(),
    ).units;
  }

  const ALWAYS_CRITICAL = Array.from({ length: 64 }, () => 0);
  const NEVER_CRITICAL = Array.from({ length: 64 }, () => 0.99);

  it("IT-UNIT-YIFEI-STORM-004 [R-ATM-01, R-PS-07]: AS1の攻撃が会心になると、付与したばかりのご指名を契機にPS1の追撃が出る。2体とも会心でも追撃は1行動1回で、PPは差し引き0になる", () => {
    // 盤面の既定会心率は0のため、会心を確定させるには会心率を上げる必要がある。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, {
      combatStats: { criticalRate: 1 },
    });
    const recorder = new EventRecorder(createBattleId("B_YIFEI_AS1_CRIT"));

    const units = useSkill({
      units: board.units,
      definitions: board.definitions,
      skillId: "SKL_YIFEI_STORM_AS1",
      random: ALWAYS_CRITICAL,
      recorder,
      actionNumber: 1,
    });

    const ps1Activations = recorder
      .getEvents()
      .filter(
        (event) =>
          event.eventType === "PassiveActivated" &&
          event.payload.skillDefinitionId === "SKL_YIFEI_STORM_PS1",
      );
    expect(ps1Activations).toHaveLength(1);
    const hpLoss = (id: string) => {
      const before = board.units.find((unit) => unit.battleUnitId === createBattleUnitId(id))!;
      const after = units.find((unit) => unit.battleUnitId === createBattleUnitId(id))!;
      return before.currentHp - after.currentHp;
    };
    // 追撃は最初に会心になった前列中央へだけ入る。
    expect(hpLoss("enemy:front")).toBeGreaterThan(hpLoss("enemy:left"));
    const subject = units.find((unit) => unit.battleUnitId === board.subject.battleUnitId)!;
    expect(subject.currentPp).toBe(board.subject.currentPp);
  });

  it("IT-UNIT-YIFEI-STORM-005 [R-EFF-07, R-EFF-09]: AS2を2回使ってシールドとバフを2セット持つと、1回の攻撃で消えるのは古いセットのシールドとバフだけで、新しいセットは残る", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, { allies: [] });
    const recorder = new EventRecorder(createBattleId("B_YIFEI_AS2_SETS"));
    const afterFirst = useSkill({
      units: board.units,
      definitions: board.definitions,
      skillId: "SKL_YIFEI_STORM_AS2",
      random: NEVER_CRITICAL,
      recorder,
      actionNumber: 1,
    });
    const afterSecond = useSkill({
      units: afterFirst,
      definitions: board.definitions,
      skillId: "SKL_YIFEI_STORM_AS2",
      random: NEVER_CRITICAL,
      recorder,
      actionNumber: 2,
    });
    const setMembersOf = (units: readonly BattleUnit[]) =>
      units
        .find((unit) => unit.battleUnitId === board.subject.battleUnitId)!
        .appliedEffects.filter((effect) =>
          effect.effectActionDefinitionId.startsWith("ACT_YIFEI_STORM_AS2_"),
        );
    const shieldsBefore = setMembersOf(afterSecond).filter(
      (effect) => effect.effectActionDefinitionId === "ACT_YIFEI_STORM_AS2_SHIELD",
    );
    expect(shieldsBefore).toHaveLength(2);
    const newerSkillUseId = shieldsBefore[1]!.duration.linkedGroupSkillUseId;

    const { units } = rideStandInAttack({
      attackerUnitId: "enemy:front",
      units: afterSecond,
      definitions: board.definitions,
      battleId: "B_YIFEI_AS2_SETS_HIT",
    });

    const remaining = setMembersOf(units);
    expect(remaining.map((effect) => effect.effectActionDefinitionId).sort()).toEqual([
      "ACT_YIFEI_STORM_AS2_CRIT_DMG_UP",
      "ACT_YIFEI_STORM_AS2_CRIT_UP",
      "ACT_YIFEI_STORM_AS2_SHIELD",
    ]);
    expect(
      remaining.every((effect) => effect.duration.linkedGroupSkillUseId === newerSkillUseId),
    ).toBe(true);
  });

  it("IT-UNIT-YIFEI-STORM-006 [R-EFF-05]: PS2はターン終了のたびに発動し、会心率と防御力の上昇が置き換わらずに重なって残る", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    let units = board.units;
    for (const turnNumber of [1, 2]) {
      const chain = openPassiveChain({
        definitions: board.definitions,
        actorUnitId: "ally:subject",
        battleId: `B_YIFEI_PS2_TURN_${turnNumber}`,
        turnNumber,
      });
      units = chain.fire(turnCompleting({ turnNumber }), units);
      expect(activatedPassiveSkillIds(chain)).toEqual(["SKL_YIFEI_STORM_PS2"]);
    }

    const subject = units.find((unit) => unit.battleUnitId === board.subject.battleUnitId)!;
    const countOf = (id: string) =>
      subject.appliedEffects.filter((effect) => effect.effectActionDefinitionId === id).length;
    expect(countOf("ACT_YIFEI_STORM_PS2_CRIT_UP")).toBe(2);
    expect(countOf("ACT_YIFEI_STORM_PS2_DEF_UP")).toBe(2);
    const effective = computeCombatStats(subject, board.definitions.effectActions).combatStats;
    expect(effective.criticalRate).toBeCloseTo(subject.baseCombatStats.criticalRate + 0.15, 10);
    expect(effective.defense).toBe(Math.floor(subject.baseCombatStats.defense * 1.15));
  });
});
