import { describe, expect, it } from "vitest";
import { applyDamageAction } from "../../../domain/battle/combat/damage-application-service.js";
import {
  advanceBattle,
  createBattle,
  startBattle,
} from "../../../domain/battle/lifecycle/battle.js";
import type { BattleDomainEvent } from "../../../domain/battle/events/domain-event.js";
import { EventRecorder } from "../../../domain/battle/events/event-recorder.js";
import { resolveSkillUse } from "../../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { applyStateDelta } from "../../../domain/battle/lifecycle/state-delta-reducer.js";
import type { BattleDefinitions } from "../../../domain/battle/model/battle-definitions.js";
import type { BattleUnit } from "../../../domain/battle/model/battle-unit.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../../domain/catalog/definitions/effect-action-definition.js";
import type { SkillDefinition } from "../../../domain/catalog/definitions/skill-definition.js";
import { createActionId } from "../../../domain/shared/event-ids.js";
import { createBattleId } from "../../../domain/shared/ids.js";
import { createTurnLimit } from "../../../domain/battle/model/turn-limit.js";
import {
  definitionsWith,
  initialSnapshotFor,
  loadProductionSnapshot,
  skillFrom,
  testBattleUnit,
  testUnitDefinition,
  unitFrom,
} from "../../../testing/fixtures/index.js";
import {
  MANIFESTATION_COMBAT_STATS,
  MANIFESTATION_LIMITS,
  PRODUCTION_CATALOG_DIR,
  STAND_IN_UNIT_ID,
  observeEffectAction,
  type EffectManifestationCase,
} from "../../../testing/production-unit/effect-manifestation.js";
import {
  declaredSkillIds,
  observeFullBattle,
  standardFullBattleBoard,
} from "../../../testing/production-unit/full-battle.js";
import { assertBattleInvariants } from "../../../testing/scenario/run-scenario.js";
import {
  activatedPassiveSkillIds,
  openPassiveChain,
} from "../../../testing/production-unit/passive-activation.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";

/**
 * `UNIT_SUIRAN_CHAOS`（【混沌の立役者】劉翠蘭）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 下の表が、このユニットの全Skillから到達できる全EffectActionを1件ずつ、
 * 実`catalog/`の未改変定義のまま実解決経路（`resolveSkillOrder`→
 * `applyEffectActionGroups`）へ通したときの観測結果を宣言する。イベント列・HP変動・
 * 効果付与・リソース変動・マーカー・クールタイムのうち**実際に動いた項目だけ**が
 * 観測に現れるため、`toEqual`の完全一致は「宣言した効果が出ること」と
 * 「余計な副作用を出さないこと」を同時に固定する。
 *
 * 表は全Skill ID・全EffectAction IDを文字列リテラルで持つため、production全ID
 * 網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。スキル側の対象選択・発動
 * 条件・PSトリガ・step分岐は表の対象外で、`-002`以降が機構ごとに検証する。
 */

const UNIT_DEFINITION_ID = "UNIT_SUIRAN_CHAOS";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const PASSIVE_COMBAT_STATS = MANIFESTATION_COMBAT_STATS;
const PASSIVE_LIMITS = MANIFESTATION_LIMITS;
/** PS検証で相手役が使う合成スキル・EffectActionのID（実Catalogとは無関係）。 */
const STAND_IN_AS_ID = "SKL_TEST_SUIRAN_PEER_AS";
const STAND_IN_DAMAGE_ID = "ACT_TEST_SUIRAN_PEER_DAMAGE";

function unitOf(units: readonly BattleUnit[], battleUnitId: string): BattleUnit {
  const found = units.find((unit) => unit.battleUnitId === battleUnitId);
  if (found === undefined) {
    throw new Error(`unit "${battleUnitId}" is not on the board`);
  }
  return found;
}

/** 攻撃力1000 - 防御力500 = 500ダメージの、相手役専用の最小DAMAGE定義。 */
function standInDamageAction(): Extract<EffectActionDefinition, { kind: "DAMAGE" }> {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(STAND_IN_DAMAGE_ID),
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: 1 },
      hitCount: 1,
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

interface PassiveBoard {
  readonly suiran: BattleUnit;
  /** Suiranと同じ列の前衛 = PS1〜PS3が要求する`IN_FRONT_OF`を満たす味方。 */
  readonly frontAlly: BattleUnit;
  readonly enemy: BattleUnit;
  readonly units: readonly BattleUnit[];
  readonly definitions: BattleDefinitions;
}

function passiveBoard(options: { readonly frontAllyHp?: number } = {}): PassiveBoard {
  const suiran = testBattleUnit({
    battleUnitId: "ally:suiran",
    unitDefinitionId: UNIT_DEFINITION_ID,
    position: { column: "LEFT", row: "BACK" },
    combatStats: PASSIVE_COMBAT_STATS,
    limits: PASSIVE_LIMITS,
    // `createBattleUnit`はPP0で始まる（READY→RUNNINGの回復でしか増えない）。
    // PS1/PS3のコスト2を満たすため、PS runtimeを直接駆動するここでは明示する。
    overrides: { currentPp: PASSIVE_LIMITS.maximumPp },
  });
  const frontAlly = testBattleUnit({
    battleUnitId: "ally:front",
    unitDefinitionId: STAND_IN_UNIT_ID,
    position: { column: "LEFT", row: "FRONT" },
    combatStats: PASSIVE_COMBAT_STATS,
    limits: PASSIVE_LIMITS,
    ...(options.frontAllyHp === undefined ? {} : { overrides: { currentHp: options.frontAllyHp } }),
  });
  const enemy = testBattleUnit({
    battleUnitId: "enemy:1",
    unitDefinitionId: STAND_IN_UNIT_ID,
    side: "ENEMY",
    position: { column: "LEFT", row: "FRONT" },
    combatStats: PASSIVE_COMBAT_STATS,
    limits: PASSIVE_LIMITS,
  });
  return {
    suiran,
    frontAlly,
    enemy,
    units: [suiran, frontAlly, enemy],
    definitions: definitionsWith(snapshot, { units: [STAND_IN_UNIT_ID] }),
  };
}

/**
 * 相手役の最小ASを実戦闘で1回使わせ、`action-skill-use-resolver.ts`が実際に発行した
 * `SkillUseStarting`を取り出す。PS3の`EVENT_PAYLOAD`条件が読む`skillType`が、
 * 手組みのstand-inではなく実装の発行地点から来ていることを保証する。
 */
function emitRealSkillUseStarting(
  board: PassiveBoard,
): Extract<BattleDomainEvent, { eventType: "SkillUseStarting" }> {
  const skill = standInAttackSkill();
  const standInDefinition = testUnitDefinition(STAND_IN_UNIT_ID, {
    baseStats: { attack: PASSIVE_COMBAT_STATS.attack, defense: PASSIVE_COMBAT_STATS.defense },
    activeSkillDefinitionIds: [createSkillDefinitionId(STAND_IN_AS_ID)],
  });
  const definitions: BattleDefinitions = {
    ...definitionsWith(snapshot, { units: [standInDefinition], skills: [skill] }),
    activeSkillsByUnit: new Map([[standInDefinition.unitDefinitionId, [skill]]]),
    effectActions: new Map(snapshot.effectActions).set(
      createEffectActionDefinitionId(STAND_IN_DAMAGE_ID),
      standInDamageAction(),
    ),
  };
  const battleId = createBattleId("B_SUIRAN_REAL");
  const battle = startBattle(
    createBattle(battleId, [board.frontAlly], [board.enemy], createTurnLimit(1), definitions),
    new SequenceRandomSource([]),
    new EventRecorder(battleId),
  );
  const turnRecorder = new EventRecorder(battleId);
  advanceBattle(battle, new SequenceRandomSource(new Array<number>(32).fill(0.99)), turnRecorder);
  const emitted = turnRecorder
    .getEvents()
    .find(
      (event): event is Extract<BattleDomainEvent, { eventType: "SkillUseStarting" }> =>
        event.eventType === "SkillUseStarting",
    );
  if (emitted === undefined) {
    throw new Error("the stand-in battle did not emit a SkillUseStarting event");
  }
  return emitted;
}

/** 相手役が実戦闘で1回だけ使う、敵単体へ`standInDamageAction`を撃つ最小のAS。 */
function standInAttackSkill(): SkillDefinition {
  const binding = createTargetBindingId("TGT_TEST_SUIRAN_PEER");
  return {
    skillDefinitionId: createSkillDefinitionId(STAND_IN_AS_ID),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [
        {
          targetBindingId: binding,
          selector: {
            kind: "SELECT",
            side: "ENEMY",
            count: "ALL",
            filters: [],
            order: ["DEFAULT"],
            includeDefeated: false,
          },
        },
      ],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: binding },
          actions: [
            { effectActionDefinitionId: createEffectActionDefinitionId(STAND_IN_DAMAGE_ID) },
          ],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    metadata: { displayName: STAND_IN_AS_ID, tags: [] },
  };
}

/** EXゲージ満タンのSuiran＋`allyCount`体の味方＋敵1体で、実EXを解決する。 */
function resolveProductionEx(allyCount: number): {
  readonly user: BattleUnit;
  readonly allies: readonly BattleUnit[];
  readonly recorder: EventRecorder;
  readonly result: ReturnType<typeof resolveSkillUse>;
} {
  const columns = ["LEFT", "CENTER", "RIGHT"] as const;
  const user = testBattleUnit({
    battleUnitId: "ally:suiran",
    unitDefinitionId: UNIT_DEFINITION_ID,
    position: { column: "CENTER", row: "FRONT" },
    combatStats: PASSIVE_COMBAT_STATS,
    limits: PASSIVE_LIMITS,
    // 原文どおりEXコストは8 — 分配される総量もこの8である。
    overrides: { currentExtraGauge: 8 },
  });
  const allies = Array.from({ length: allyCount }, (_, index) =>
    testBattleUnit({
      battleUnitId: `ally:peer:${index}`,
      unitDefinitionId: STAND_IN_UNIT_ID,
      position: { column: columns[index % columns.length]!, row: "BACK" },
      combatStats: PASSIVE_COMBAT_STATS,
      limits: PASSIVE_LIMITS,
    }),
  );
  const enemy = testBattleUnit({
    battleUnitId: "enemy:1",
    unitDefinitionId: STAND_IN_UNIT_ID,
    side: "ENEMY",
    position: { column: "CENTER", row: "FRONT" },
    combatStats: PASSIVE_COMBAT_STATS,
    limits: PASSIVE_LIMITS,
  });
  const recorder = new EventRecorder(createBattleId("B_SUIRAN_EX"));
  const result = resolveSkillUse(
    user,
    skillFrom(snapshot, "SKL_SUIRAN_CHAOS_EX"),
    "EX",
    "EX",
    [user, ...allies, enemy],
    definitionsWith(snapshot, { units: [STAND_IN_UNIT_ID] }),
    // 先頭のEN攻撃step（`ACT_SUIRAN_CHAOS_EX_DAMAGE`）の会心判定用。
    // criticalRateは0のため、どの値でも非会心に確定する。
    new SequenceRandomSource([0.99]),
    recorder,
    1,
    0,
    createActionId("B_SUIRAN_EX:action:1"),
    recorder.nextResolutionScopeId(),
  );
  return { user, allies, recorder, result };
}

/** (SKL_ID, ACT_ID, 期待効果)。行の並びは AS → PS → EX のSkill定義順。 */
const MANIFESTATIONS: readonly EffectManifestationCase[] = [
  {
    skillDefinitionId: "SKL_SUIRAN_CHAOS_AS1",
    effectActionDefinitionId: "ACT_SUIRAN_CHAOS_AS1_DAMAGE",
    target: "ENEMY",
    expected: {
      eventTypes: [
        "UnitBeingAttacked",
        "HitConfirmed",
        "CriticalCheckResolved",
        "DamageWillBeApplied",
        "DamageCalculated",
        "HitPointReduced",
        "DamageApplied",
      ],
      hpDeltas: {
        "enemy:foe": -780,
      },
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CHAOS_AS1",
    effectActionDefinitionId: "ACT_SUIRAN_CHAOS_AS1_DEBUFF",
    target: "ENEMY",
    expected: {
      eventTypes: ["EffectApplied"],
      effectsApplied: [
        {
          unitId: "enemy:foe",
          effectActionDefinitionId: "ACT_SUIRAN_CHAOS_AS1_DEBUFF",
          magnitude: 0.7,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CHAOS_PS1",
    effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS1_EVASION",
    target: "ALLY",
    expected: {
      eventTypes: ["EffectApplied"],
      effectsApplied: [
        {
          unitId: "ally:peer",
          effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS1_EVASION",
          magnitude: 0,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CHAOS_PS2",
    effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS2_ATK_UP",
    target: "ALLY",
    expected: {
      eventTypes: ["EffectApplied", "CombatStatChanged"],
      effectsApplied: [
        {
          unitId: "ally:peer",
          effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS2_ATK_UP",
          magnitude: 0.3,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CHAOS_PS2",
    effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS2_DEF_UP",
    target: "ALLY",
    expected: {
      eventTypes: ["EffectApplied", "CombatStatChanged"],
      effectsApplied: [
        {
          unitId: "ally:peer",
          effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS2_DEF_UP",
          magnitude: 0.3,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CHAOS_PS2",
    effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS2_HEAL",
    target: "ALLY",
    expected: {
      eventTypes: ["HealApplied"],
      hpDeltas: {
        "ally:peer": 450,
      },
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CHAOS_PS3",
    effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS3_CRIT_UP",
    target: "ALLY",
    expected: {
      eventTypes: ["EffectApplied"],
      effectsApplied: [
        {
          unitId: "ally:peer",
          effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS3_CRIT_UP",
          magnitude: 0.15,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CHAOS_PS3",
    effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS3_DAMAGE_ADD",
    target: "ENEMY",
    expected: {
      eventTypes: [
        "UnitBeingAttacked",
        "HitConfirmed",
        "CriticalCheckResolved",
        "DamageWillBeApplied",
        "DamageCalculated",
        "HitPointReduced",
        "DamageApplied",
      ],
      hpDeltas: {
        "enemy:foe": -179,
      },
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CHAOS_PS3",
    effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS3_SPEED_DOWN",
    target: "ENEMY",
    expected: {
      eventTypes: ["EffectApplied", "CombatStatChanged"],
      effectsApplied: [
        {
          unitId: "enemy:foe",
          effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS3_SPEED_DOWN",
          magnitude: -200,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CHAOS_EX",
    effectActionDefinitionId: "ACT_SUIRAN_CHAOS_EX_DAMAGE",
    target: "ENEMY",
    expected: {
      eventTypes: [
        "UnitBeingAttacked",
        "HitConfirmed",
        "CriticalCheckResolved",
        "DamageWillBeApplied",
        "DamageCalculated",
        "HitPointReduced",
        "DamageApplied",
      ],
      hpDeltas: {
        "enemy:foe": -1590,
      },
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CHAOS_EX",
    effectActionDefinitionId: "ACT_SUIRAN_CHAOS_EX_EX_DISTRIBUTE",
    target: "ALLY",
    expected: {
      eventTypes: ["ResourceChanged"],
      resources: [
        {
          unitId: "ally:peer",
          resource: "EX_GAUGE",
          delta: 8,
        },
      ],
    },
  },
];

describe("production Catalog UNIT_SUIRAN_CHAOS (【混沌の立役者】劉翠蘭)", () => {
  it.each(MANIFESTATIONS)(
    "IT-UNIT-SUIRAN-CHAOS-001: $effectActionDefinitionId ($skillDefinitionId) manifests exactly the declared effect on the $target target",
    ({ effectActionDefinitionId, target, board, precedingSteps, expected }) => {
      expect(
        observeEffectAction({
          snapshot,
          unitDefinitionId: UNIT_DEFINITION_ID,
          effectActionDefinitionId,
          target,
          ...(board === undefined ? {} : { board }),
          ...(precedingSteps === undefined ? {} : { precedingSteps }),
        }),
      ).toEqual(expected);
    },
  );

  it("IT-UNIT-SUIRAN-CHAOS-002: the table's skill column covers exactly the Skills the production UnitDefinition declares", () => {
    // 表の網羅は`UT-AUDIT-UNITCOV-001`がEffectAction側から機械検証するが、
    // 「Skillが1つ丸ごと表から漏れている」ことは、そのSkill専用のEffectActionが
    // 他Skillからも到達できる場合に検出できない。Skill集合そのものをここで固定する。
    const unit = unitFrom(snapshot, UNIT_DEFINITION_ID);
    const declared = [
      ...unit.activeSkillDefinitionIds,
      ...unit.passiveSkillDefinitionIds,
      unit.extraSkillDefinitionId,
    ];
    expect(declared).toEqual([
      "SKL_SUIRAN_CHAOS_AS1",
      "SKL_SUIRAN_CHAOS_PS1",
      "SKL_SUIRAN_CHAOS_PS2",
      "SKL_SUIRAN_CHAOS_PS3",
      "SKL_SUIRAN_CHAOS_EX",
    ]);
    expect([...new Set(MANIFESTATIONS.map((entry) => entry.skillDefinitionId))].sort()).toEqual(
      [...declared].sort(),
    );
  });
  // -003〜-007: 表で表現できない機構 — PSは「実際に発行されたイベント」を契機に
  // しか発動しないため、契機イベント・発動条件・TRIGGER_TARGET/TRIGGER_SOURCEの
  // 解決先を個別に検証する。

  it("IT-UNIT-SUIRAN-CHAOS-003 (R-PS-01, POSITION_RELATION): SKL_SUIRAN_CHAOS_PS3 activates from the very SkillUseStarting a real battle emits for an ally in front of Suiran, resolving TRIGGER_TARGET to that ally's enemy target and TRIGGER_SOURCE to the ally herself", () => {
    const board = passiveBoard();
    // 契機イベントは手組みせず、実戦闘（`advanceBattle`）に発行させる。PS3の
    // 発動条件は`EVENT_PAYLOAD field: "skillType"`を読むため、そのフィールドが実際に
    // 載って出てくることまで含めて1本で確かめる。
    const realSkillUseStarting = emitRealSkillUseStarting(board);
    expect(realSkillUseStarting.payload.skillType).toBe("AS");
    expect(realSkillUseStarting.sourceUnitId).toBe(board.frontAlly.battleUnitId);

    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: board.frontAlly.battleUnitId,
      battleId: "B_SUIRAN_PS3",
    });
    const units = chain.fireRecorded(realSkillUseStarting, board.units);

    expect(activatedPassiveSkillIds(chain)).toEqual(["SKL_SUIRAN_CHAOS_PS3"]);
    // TRIGGER_TARGET（味方が狙った敵）へダメージと行動速度デバフ、
    // TRIGGER_SOURCE（味方自身）へ会心率バフ — 同じEffectSequenceの中で別々の
    // 実ユニットへ解決していることが要点。
    const enemyAfter = unitOf(units, board.enemy.battleUnitId);
    expect(enemyAfter.currentHp).toBeLessThan(board.enemy.currentHp);
    expect(enemyAfter.appliedEffects.map((effect) => effect.effectActionDefinitionId)).toEqual([
      "ACT_SUIRAN_CHAOS_PS3_SPEED_DOWN",
    ]);
    expect(
      unitOf(units, board.frontAlly.battleUnitId).appliedEffects.map(
        (effect) => effect.effectActionDefinitionId,
      ),
    ).toEqual(["ACT_SUIRAN_CHAOS_PS3_CRIT_UP"]);
    expect(
      chain.eventsOfType("PassiveResolved").map((event) => event.payload.skillDefinitionId),
    ).toEqual(["SKL_SUIRAN_CHAOS_PS3"]);
  });

  it("IT-UNIT-SUIRAN-CHAOS-004 (NEGATIVE, EVENT_PAYLOAD): SKL_SUIRAN_CHAOS_PS3 does not activate for a SkillUseStarting whose skillType is not AS, nor for one emitted by an ally who is not in front of Suiran", () => {
    const board = passiveBoard();

    const exUse = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: board.frontAlly.battleUnitId,
      battleId: "B_SUIRAN_PS3_EX",
    });
    exUse.fire(
      {
        eventType: "SkillUseStarting",
        category: "TIMING",
        sourceUnitId: board.frontAlly.battleUnitId,
        targetUnitIds: [board.enemy.battleUnitId],
        payload: {
          skillDefinitionId: createSkillDefinitionId(STAND_IN_AS_ID),
          skillType: "EX",
          actorUnitId: board.frontAlly.battleUnitId,
          targetUnitIds: [board.enemy.battleUnitId],
          costResource: "EX_GAUGE",
          costAmount: 8,
        },
      },
      board.units,
    );
    expect(activatedPassiveSkillIds(exUse)).toEqual([]);

    // Suiran自身と同じ列に居ない味方（右前衛）からのAS使用は`IN_FRONT_OF`を満たさない。
    const sideAlly = testBattleUnit({
      battleUnitId: "ally:side",
      unitDefinitionId: STAND_IN_UNIT_ID,
      position: { column: "RIGHT", row: "FRONT" },
      combatStats: PASSIVE_COMBAT_STATS,
      limits: PASSIVE_LIMITS,
    });
    const offColumn = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: sideAlly.battleUnitId,
      battleId: "B_SUIRAN_PS3_COLUMN",
    });
    offColumn.fire(
      {
        eventType: "SkillUseStarting",
        category: "TIMING",
        sourceUnitId: sideAlly.battleUnitId,
        targetUnitIds: [board.enemy.battleUnitId],
        payload: {
          skillDefinitionId: createSkillDefinitionId(STAND_IN_AS_ID),
          skillType: "AS",
          actorUnitId: sideAlly.battleUnitId,
          targetUnitIds: [board.enemy.battleUnitId],
          costResource: "AP",
          costAmount: 1,
        },
      },
      [board.suiran, sideAlly, board.enemy],
    );
    expect(activatedPassiveSkillIds(offColumn)).toEqual([]);
  });

  it("IT-UNIT-SUIRAN-CHAOS-005 (R-HIT-02): SKL_SUIRAN_CHAOS_PS1 activates from a UnitBeingAttacked aimed at the ally in front of Suiran and grants that ally a single-hit EVASION status", () => {
    const board = passiveBoard();
    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: board.enemy.battleUnitId,
      battleId: "B_SUIRAN_PS1",
    });

    const units = chain.fire(
      {
        eventType: "UnitBeingAttacked",
        category: "TIMING",
        sourceUnitId: board.enemy.battleUnitId,
        targetUnitIds: [board.frontAlly.battleUnitId],
        payload: {
          skillDefinitionId: createSkillDefinitionId(STAND_IN_AS_ID),
          effectActionDefinitionId: createEffectActionDefinitionId(STAND_IN_DAMAGE_ID),
          hitIndex: 1,
          targetUnitId: board.frontAlly.battleUnitId,
        },
      },
      board.units,
    );

    expect(activatedPassiveSkillIds(chain)).toEqual(["SKL_SUIRAN_CHAOS_PS1"]);
    const guarded = unitOf(units, board.frontAlly.battleUnitId);
    expect(guarded.appliedEffects).toHaveLength(1);
    expect(guarded.appliedEffects[0]).toMatchObject({
      effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS1_EVASION",
      statusKind: "EVASION",
      sourceUnitId: board.suiran.battleUnitId,
      targetUnitId: board.frontAlly.battleUnitId,
      statusDetails: { probability: 1, appliesTo: { incomingActionKinds: ["DAMAGE"] } },
    });
  });

  it("IT-UNIT-SUIRAN-CHAOS-006 (sourceSelector: ANY): SKL_SUIRAN_CHAOS_PS2 activates from the HitPointReduced the real damage pipeline emits once the ally in front drops to half HP, whether the damage came from an enemy or from an ally", () => {
    for (const attackerSide of ["ENEMY", "ALLY"] as const) {
      const board = passiveBoard({ frontAllyHp: 5200 });
      const attacker =
        attackerSide === "ENEMY"
          ? board.enemy
          : testBattleUnit({
              battleUnitId: "ally:attacker",
              unitDefinitionId: STAND_IN_UNIT_ID,
              position: { column: "RIGHT", row: "FRONT" },
              combatStats: PASSIVE_COMBAT_STATS,
              limits: PASSIVE_LIMITS,
            });
      const roster = [board.suiran, board.frontAlly, attacker];
      const chain = openPassiveChain({
        definitions: board.definitions,
        actorUnitId: attacker.battleUnitId,
        battleId: `B_SUIRAN_PS2_${attackerSide}`,
      });

      // 契機となる`HitPointReduced`は手組みせず、実ダメージpipelineに出させる。
      const damaged = applyDamageAction(
        attacker,
        [
          {
            targetUnitId: board.frontAlly.battleUnitId,
            effectActionDefinitionId: createEffectActionDefinitionId(STAND_IN_DAMAGE_ID),
            hitIndex: 1,
          },
        ],
        standInDamageAction(),
        roster,
        new SequenceRandomSource([0.99, 0.99]),
        {
          recorder: chain.recorder,
          turnNumber: 1,
          cycleNumber: 1,
          actionId: chain.actionId,
          skillUseId: chain.recorder.nextSkillUseId(),
          resolutionScopeId: chain.resolutionScopeId,
          rootEventId: chain.rootEventId,
          parentEventId: chain.rootEventId,
          skillDefinitionId: createSkillDefinitionId(STAND_IN_AS_ID),
        },
      );
      const woundedAlly = unitOf(damaged.units, board.frontAlly.battleUnitId);
      // 攻撃力1000 - 防御力500 = 500ダメージ。5200 → 4700 で最大HP 10000 の
      // 半分（PS2のHP_RATIO <= 0.5）をちょうど跨ぐ。
      expect(woundedAlly.currentHp / woundedAlly.combatStats.maximumHp).toBeLessThanOrEqual(0.5);

      const hitPointReduced = chain.eventsOfType("HitPointReduced").at(-1)!;
      expect(hitPointReduced.sourceUnitId).toBe(attacker.battleUnitId);

      const healed = chain.fireRecorded(hitPointReduced, [board.suiran, woundedAlly, attacker]);
      expect(activatedPassiveSkillIds(chain)).toEqual(["SKL_SUIRAN_CHAOS_PS2"]);
      const recovered = unitOf(healed, board.frontAlly.battleUnitId);
      expect(recovered.currentHp).toBeGreaterThan(woundedAlly.currentHp);
      expect(recovered.appliedEffects.map((effect) => effect.effectActionDefinitionId)).toEqual([
        "ACT_SUIRAN_CHAOS_PS2_ATK_UP",
        "ACT_SUIRAN_CHAOS_PS2_DEF_UP",
      ]);
    }
  });

  // -007〜-008: EX連鎖 — 表は`ACT_SUIRAN_CHAOS_EX_EX_DISTRIBUTE`を1体へ向けたときの
  // 発現しか見ないため、「総量を対象数で等分する」というDISTRIBUTE本来の意味は
  // 実スキル（自身を除く味方全体bindings）を通さないと現れない。

  it("IT-UNIT-SUIRAN-CHAOS-007 (R-ACTN-02, R-NUM-02): SKL_SUIRAN_CHAOS_EX splits the 8 EX it consumed evenly across every ally except the user, and its ResourceChanged StateDelta reconstructs the same gauges through the independent Reducer", () => {
    const { user, allies, recorder, result } = resolveProductionEx(2);

    // R-ACT-03: EX使用で使用者のEXゲージは全消費される（分配の原資）。
    expect(unitOf(result.units, user.battleUnitId).currentExtraGauge).toBe(0);
    // 総量8を、自身を除く味方2体で等分 = 各4。対象ごとに8を配る`ADD`ではない。
    for (const ally of allies) {
      expect(unitOf(result.units, ally.battleUnitId).currentExtraGauge).toBe(4);
    }

    const distributed = recorder
      .getEvents()
      .filter(
        (event): event is Extract<BattleDomainEvent, { eventType: "ResourceChanged" }> =>
          event.eventType === "ResourceChanged" && event.payload.reason === "EFFECT_ACTION",
      );
    expect(distributed.map((event) => event.payload.battleUnitId).sort()).toEqual(
      allies.map((ally) => ally.battleUnitId).sort(),
    );
    for (const event of distributed) {
      expect(event.payload).toMatchObject({
        resource: "EX_GAUGE",
        before: 0,
        after: 4,
        delta: 4,
        baseDelta: 4,
      });
    }

    let state = initialSnapshotFor([user, ...allies], { status: "READY" });
    for (const event of distributed) {
      state = applyStateDelta(state, event.stateDelta!);
    }
    for (const ally of allies) {
      expect(state.units[ally.battleUnitId]!.extraGauge).toBe(4);
    }
  });

  it("IT-UNIT-SUIRAN-CHAOS-008 (BOUNDARY, R-NUM-02): an indivisible total is truncated per ally, so three allies receive 2 each and the remainder is discarded rather than redistributed", () => {
    const { allies, recorder, result } = resolveProductionEx(3);

    // 8 / 3 = 2.666… → 各2（合計6）。端数2は破棄する。
    for (const ally of allies) {
      expect(unitOf(result.units, ally.battleUnitId).currentExtraGauge).toBe(2);
    }
    expect(
      recorder
        .getEvents()
        .filter(
          (event) =>
            event.eventType === "ResourceChanged" && event.payload.reason === "EFFECT_ACTION",
        ),
    ).toHaveLength(3);
  });
  // -100: 1バトル完走の中での全スキル発動。`-001`の表はEffectActionを1件だけ包んで
  // 通すため、発動条件・PSトリガ・対象範囲・AP/PP/EXの資源経済・クールタイムが
  // 観測に現れない。ここはそれらを含んだ実戦闘を1本通し、宣言した全Skillが
  // 実際に到達可能であることを発動回数と発動順で固定する。
  it("IT-UNIT-SUIRAN-CHAOS-100: every declared Skill activates within one completed battle, with these counts and in this order", () => {
    const observation = observeFullBattle(
      standardFullBattleBoard({
        unitDefinitionId: UNIT_DEFINITION_ID,
        enemyCount: 1,
        frontPeerCooldown: 4,
        turnLimit: 2,
      }),
    );

    assertBattleInvariants(observation.result);
    expect(observation.completionReason).toBe("TURN_LIMIT_REACHED");

    // 宣言スキル集合との一致が「1つも発動しないSkillが無いこと」を守る。
    // Skillが増えたときはこの行が落ちるため、盤面の見直しが強制される。
    expect(Object.keys(observation.activationCounts).sort()).toEqual(
      [...declaredSkillIds(UNIT_DEFINITION_ID)].sort(),
    );
    expect(observation.activationCounts).toEqual({
      SKL_SUIRAN_CHAOS_AS1: 8,
      SKL_SUIRAN_CHAOS_PS1: 2,
      SKL_SUIRAN_CHAOS_PS2: 1,
      SKL_SUIRAN_CHAOS_PS3: 1,
      SKL_SUIRAN_CHAOS_EX: 1,
    });
    // PS1(2PP)とPS3(2PP)は最大PP4を使い切るため、正面の味方のASへクールタイムを置いてPS3が発動しないターンを作らないと、PS2(1PP)が発動する余地が生まれない。
    expect(observation.activationOrder).toEqual([
      "AS1",
      "PS3",
      "PS1",
      "AS1",
      "AS1",
      "AS1",
      "EX",
      "AS1",
      "PS1",
      "AS1",
      "PS2",
      "AS1",
      "AS1",
    ]);
  });
});
