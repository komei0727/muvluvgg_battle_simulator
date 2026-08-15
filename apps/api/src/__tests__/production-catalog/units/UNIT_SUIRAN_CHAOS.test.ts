import { describe, expect, it } from "vitest";
import { createSkillDefinitionId } from "../../../domain/catalog/definitions/catalog-ids.js";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import {
  BOARD_COMBAT_STATS,
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  resetExecutedActionIds,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  hitPointReduced,
  skillUseStarting,
  unitBeingAttacked,
} from "../../../testing/production-unit/trigger-events.js";
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
import { createTargetBindingId } from "../../../domain/catalog/definitions/catalog-ids.js";
import { createEffectActionDefinitionId } from "../../../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../../domain/catalog/definitions/effect-action-definition.js";
import type { SkillDefinition } from "../../../domain/catalog/definitions/skill-definition.js";
import { createActionId } from "../../../domain/shared/event-ids.js";
import { createBattleId } from "../../../domain/shared/ids.js";
import { createTurnLimit } from "../../../domain/battle/model/turn-limit.js";
import {
  definitionsWith,
  initialSnapshotFor,
  skillFrom,
  testBattleUnit,
  testUnitDefinition,
} from "../../../testing/fixtures/index.js";
import {
  BOARD_LIMITS,
  STAND_IN_UNIT_ID,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  activatedPassiveSkillIds,
  openPassiveChain,
} from "../../../testing/production-unit/passive-activation.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";

/**
 * `UNIT_SUIRAN_CHAOS`（【混沌の立役者】劉翠蘭）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 *
 * 変化しなかった観測項目はキーごと落ちるため、`toEqual` の完全一致が
 * 「宣言した振る舞いが起きること」と「余計なことを起こさないこと」を同時に固定する。
 */

const UNIT_DEFINITION_ID = "UNIT_SUIRAN_CHAOS";

/** 翠蘭は後列適性で、PSはいずれも「自身の目の前の味方」を条件にする。 */
const SUIRAN_BACK = { subject: { position: { column: "LEFT", row: "BACK" } as const } };

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const PASSIVE_COMBAT_STATS = BOARD_COMBAT_STATS;
const PASSIVE_LIMITS = BOARD_LIMITS;
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

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_SUIRAN_CHAOS_AS1",
    intent: "一破能弾: 敵単体へEN攻撃し、次に受ける攻撃の被ダメージを上げるデバフを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SUIRAN_CHAOS_AS1" },
    board: SUIRAN_BACK,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_SUIRAN_CHAOS_AS1_DAMAGE",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_SUIRAN_CHAOS_AS1_DEBUFF",
          targets: ["enemy:left"],
        },
      ],
      hpDeltas: {
        "enemy:left": -780,
      },
      effectsApplied: [
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_SUIRAN_CHAOS_AS1_DEBUFF",
          magnitude: 0.7,
          consumption: {
            kind: "NEXT_INCOMING_ATTACK",
            maxCount: 1,
          },
        },
      ],
      resources: [
        {
          unitId: "ally:subject",
          resource: "AP",
          delta: -1,
        },
        {
          unitId: "ally:subject",
          resource: "EX_GAUGE",
          delta: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CHAOS_PS1",
    intent: "代助一避: 自身の目の前の味方が敵に攻撃されるとき、その味方へ回避を付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SUIRAN_CHAOS_PS1",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:front" }),
      triggeredBy: "enemy:front",
    },
    board: SUIRAN_BACK,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS1_EVASION",
          targets: ["ally:front"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS1_EVASION",
          magnitude: 0,
          timeLimit: {
            unit: "ACTION",
            count: 1,
          },
          consumption: {
            kind: "INCOMING_HIT",
            maxCount: 1,
          },
          statusKind: "EVASION",
        },
      ],
      resources: [
        {
          unitId: "ally:subject",
          resource: "PP",
          delta: -2,
        },
        {
          unitId: "ally:subject",
          resource: "EX_GAUGE",
          delta: 2,
        },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_SUIRAN_CHAOS_PS1",
          remaining: 2,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CHAOS_PS1",
    intent: "代助一避(不成立): 目の前ではない味方が攻撃されても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SUIRAN_CHAOS_PS1",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:back" }),
      triggeredBy: "enemy:front",
    },
    board: SUIRAN_BACK,
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CHAOS_PS2",
    intent: "再起律動: 目の前の味方のHPが半分以下になったとき、回復と攻防バフを与える",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SUIRAN_CHAOS_PS2",
      trigger: hitPointReduced({
        source: "enemy:front",
        target: "ally:front",
        damage: 1000,
        hpBefore: 5000,
      }),
      triggeredBy: "enemy:front",
    },
    board: {
      subject: SUIRAN_BACK.subject,
      allies: [
        {
          id: "ally:front",
          position: { column: "LEFT", row: "FRONT" },
          state: { currentHp: 4000 },
        },
        { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS2_HEAL",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS2_ATK_UP",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS2_DEF_UP",
          targets: ["ally:front"],
        },
      ],
      hpDeltas: {
        "ally:front": 450,
      },
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS2_ATK_UP",
          magnitude: 0.3,
          timeLimit: {
            unit: "ACTION",
            count: 1,
          },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS2_DEF_UP",
          magnitude: 0.3,
          timeLimit: {
            unit: "ACTION",
            count: 1,
          },
        },
      ],
      resources: [
        {
          unitId: "ally:subject",
          resource: "PP",
          delta: -1,
        },
        {
          unitId: "ally:subject",
          resource: "EX_GAUGE",
          delta: 1,
        },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_SUIRAN_CHAOS_PS2",
          remaining: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CHAOS_PS2",
    intent: "再起律動(不成立): HPが半分より多く残っている間は発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SUIRAN_CHAOS_PS2",
      trigger: hitPointReduced({
        source: "enemy:front",
        target: "ally:front",
        damage: 1000,
        hpBefore: 9000,
      }),
      triggeredBy: "enemy:front",
    },
    board: {
      subject: SUIRAN_BACK.subject,
      allies: [
        {
          id: "ally:front",
          position: { column: "LEFT", row: "FRONT" },
          state: { currentHp: 8000 },
        },
        { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CHAOS_PS3",
    intent:
      "追撃符: 目の前の味方がASで攻撃する前に、味方へ会心率上昇と、当該攻撃に相乗りする追撃バフを与える",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SUIRAN_CHAOS_PS3",
      trigger: skillUseStarting({ actor: "ally:front", targets: ["enemy:front"], skillType: "AS" }),
      triggeredBy: "ally:front",
    },
    board: SUIRAN_BACK,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS3_CRIT_UP",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS3_FOLLOW_UP",
          targets: ["ally:front"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS3_CRIT_UP",
          magnitude: 0.15,
          consumption: {
            kind: "NEXT_OUTGOING_ATTACK",
            maxCount: 1,
          },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS3_FOLLOW_UP",
          magnitude: 0,
          consumption: {
            kind: "NEXT_OUTGOING_ATTACK",
            maxCount: 1,
          },
        },
      ],
      resources: [
        {
          unitId: "ally:subject",
          resource: "PP",
          delta: -2,
        },
        {
          unitId: "ally:subject",
          resource: "EX_GAUGE",
          delta: 2,
        },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_SUIRAN_CHAOS_PS3",
          remaining: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CHAOS_PS3",
    intent: "追撃符(不成立): AS以外（EX）の使用では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SUIRAN_CHAOS_PS3",
      trigger: skillUseStarting({ actor: "ally:front", targets: ["enemy:front"], skillType: "EX" }),
      triggeredBy: "ally:front",
    },
    board: SUIRAN_BACK,
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_SUIRAN_CHAOS_EX",
    intent: "ブラック・スタイル: 敵単体へEN攻撃し、消費したEXゲージを自身を除く味方全体へ分配する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SUIRAN_CHAOS_EX" },
    board: SUIRAN_BACK,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_SUIRAN_CHAOS_EX_DAMAGE",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_SUIRAN_CHAOS_EX_EX_DISTRIBUTE",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_SUIRAN_CHAOS_EX_EX_DISTRIBUTE",
          targets: ["ally:back"],
        },
      ],
      hpDeltas: {
        "enemy:left": -1590,
      },
      resources: [
        {
          unitId: "ally:front",
          resource: "EX_GAUGE",
          delta: 4,
        },
        {
          unitId: "ally:back",
          resource: "EX_GAUGE",
          delta: 4,
        },
      ],
    },
  },
];

describe("production Catalog UNIT_SUIRAN_CHAOS (【混沌の立役者】劉翠蘭)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-SUIRAN-CHAOS-001: $skillDefinitionId — $intent",
    ({ use, board, precedingActions, expected }) => {
      expect(
        observeSkillUse({
          snapshot,
          unitDefinitionId: UNIT_DEFINITION_ID,
          use,
          ...(board === undefined ? {} : { board }),
          ...(precedingActions === undefined ? {} : { precedingActions }),
        }),
      ).toEqual(expected);
    },
  );

  it("IT-UNIT-SUIRAN-CHAOS-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-SUIRAN-CHAOS-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
    // 全ID網羅監査（`UT-AUDIT-UNITCOV-001`）は「IDが文字列として書かれているか」しか
    // 見ないため、表に載っているだけで一度も実行されない定義を見逃す。実行された
    // 集合そのものを閉包と突き合わせる。表をこのテスト内で回し直すのは、
    // 収集器がモジュール全域の状態であり、テストファイル間の isolation 設定に
    // 結果を依存させないため。
    resetExecutedActionIds();
    for (const { use, board, precedingActions } of BEHAVIOURS) {
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use,
        ...(board === undefined ? {} : { board }),
        ...(precedingActions === undefined ? {} : { precedingActions }),
      });
    }
    expect(
      unexecutedEffectActionIds(
        unitEffectActionClosure(snapshot, UNIT_DEFINITION_ID),
        collectedExecutedActionIds(),
        // R-FUP-01: 速度低下は追撃バフ（`ACT_SUIRAN_CHAOS_PS3_FOLLOW_UP`の
        // `onHitEffect`参照）が味方の攻撃に相乗りしたときだけ実行される。表は
        // 「スキル使用1回」単位のためPS発動（バフ付与）までしか表せず、
        // 実行は`IT-UNIT-SUIRAN-CHAOS-011`が保持者の実AS経路で検証する。
        ["ACT_SUIRAN_CHAOS_PS3_SPEED_DOWN"],
      ),
    ).toEqual([]);
  });

  // -004〜-009: 表で表現できない機構 — PSは「実際に発行されたイベント」を契機に
  // しか発動しないため、契機イベント・発動条件・TRIGGER_TARGET/TRIGGER_SOURCEの
  // 解決先を個別に検証する。

  it("IT-UNIT-SUIRAN-CHAOS-004 (R-PS-01, POSITION_RELATION): SKL_SUIRAN_CHAOS_PS3 activates from the very SkillUseStarting a real battle emits for an ally in front of Suiran, resolving TRIGGER_TARGET to that ally's enemy target and TRIGGER_SOURCE to the ally herself", () => {
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
    // R-FUP-01: PS発動の時点では敵に何も起きない — TRIGGER_SOURCE（味方自身）へ
    // 会心率バフと追撃バフを付与するだけで、追撃と速度低下は当該攻撃の解決に
    // 相乗りして初めて発生する（`IT-UNIT-SUIRAN-CHAOS-011`）。
    const enemyAfter = unitOf(units, board.enemy.battleUnitId);
    expect(enemyAfter.currentHp).toBe(board.enemy.currentHp);
    expect(enemyAfter.appliedEffects).toEqual([]);
    expect(
      unitOf(units, board.frontAlly.battleUnitId).appliedEffects.map(
        (effect) => effect.effectActionDefinitionId,
      ),
    ).toEqual(["ACT_SUIRAN_CHAOS_PS3_CRIT_UP", "ACT_SUIRAN_CHAOS_PS3_FOLLOW_UP"]);
    expect(
      chain.eventsOfType("PassiveResolved").map((event) => event.payload.skillDefinitionId),
    ).toEqual(["SKL_SUIRAN_CHAOS_PS3"]);
  });

  it("IT-UNIT-SUIRAN-CHAOS-011 (R-FUP-01): the rider SKL_SUIRAN_CHAOS_PS3 grants makes the ally's own AS deliver the follow-up — computed from the ally's stats, critical inherited from the boosted attack, speed-down applied to the hit enemy, and both buffs spent by that one attack", () => {
    const board = passiveBoard();
    // PS3の付与は実trigger経由（IT-004と同じ）。会心+15%と追撃バフが味方へ載る。
    const realSkillUseStarting = emitRealSkillUseStarting(board);
    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: board.frontAlly.battleUnitId,
      battleId: "B_SUIRAN_PS3_RIDE",
    });
    const afterGrant = chain.fireRecorded(realSkillUseStarting, board.units);
    // `createBattleUnit`はAP0で始まるため、AS使用分を明示する（PPと同じ扱い）。
    const boostedAlly = { ...unitOf(afterGrant, board.frontAlly.battleUnitId), currentAp: 1 };
    const boosted = afterGrant.map((unit) =>
      unit.battleUnitId === boostedAlly.battleUnitId ? boostedAlly : unit,
    );
    expect(boostedAlly.appliedEffects.map((effect) => effect.effectActionDefinitionId)).toEqual([
      "ACT_SUIRAN_CHAOS_PS3_CRIT_UP",
      "ACT_SUIRAN_CHAOS_PS3_FOLLOW_UP",
    ]);

    // 会心継承を観測するため、相手役ASは会心NORMALで撃つ。会心率は素0 + バフ0.15。
    const skill = standInAttackSkill();
    const criticalCapableDamage: EffectActionDefinition = {
      ...standInDamageAction(),
      payload: { ...standInDamageAction().payload, critical: { mode: "NORMAL" } },
    };
    const standInDefinition = testUnitDefinition(STAND_IN_UNIT_ID, {
      baseStats: { attack: PASSIVE_COMBAT_STATS.attack, defense: PASSIVE_COMBAT_STATS.defense },
      activeSkillDefinitionIds: [createSkillDefinitionId(STAND_IN_AS_ID)],
    });
    const definitions: BattleDefinitions = {
      ...definitionsWith(snapshot, { units: [standInDefinition], skills: [skill] }),
      activeSkillsByUnit: new Map([[standInDefinition.unitDefinitionId, [skill]]]),
      effectActions: new Map(snapshot.effectActions).set(
        createEffectActionDefinitionId(STAND_IN_DAMAGE_ID),
        criticalCapableDamage,
      ),
    };
    const recorder = new EventRecorder(createBattleId("B_SUIRAN_PS3_RIDE_AS"));
    const result = resolveSkillUse(
      boostedAlly,
      skill,
      "AS",
      "AS",
      boosted,
      definitions,
      // AS本体1ヒットの会心判定1回だけ（0.10 < 実効0.15 → 会心）。追撃は判定を持たず
      // 乱数を消費しない。
      new SequenceRandomSource([0.1]),
      recorder,
      1,
      0,
      createActionId("B_SUIRAN_PS3_RIDE_AS:action:1"),
      recorder.nextResolutionScopeId(),
    );

    // AS本体: (1000 - 500) x 会心2.0 = 1000。追撃: (1000 - 500) x 0.3588 x 会心継承2.0
    // = 358.8 → 358（味方のステータス・会心ダメージボーナスで計算。翠蘭は参照しない）。
    const enemyAfter = unitOf(result.units, board.enemy.battleUnitId);
    expect(enemyAfter.currentHp).toBe(board.enemy.currentHp - 1000 - 358);
    // 追撃がヒットした敵へ1行動の速度-200デバフ。
    expect(enemyAfter.appliedEffects).toHaveLength(1);
    expect(enemyAfter.appliedEffects[0]).toMatchObject({
      effectActionDefinitionId: "ACT_SUIRAN_CHAOS_PS3_SPEED_DOWN",
      magnitude: -200,
      sourceUnitId: board.suiran.battleUnitId,
    });
    // どちらのバフも「次の攻撃1回」で消費・失効している。
    const allyAfter = unitOf(result.units, board.frontAlly.battleUnitId);
    expect(allyAfter.appliedEffects).toEqual([]);
    // 追撃の`DamageCalculated`は味方の攻撃力・会心継承倍率で記録される。
    const followUpDamage = recorder
      .getEvents()
      .filter(
        (event) =>
          event.eventType === "DamageCalculated" &&
          (event.payload as { effectActionDefinitionId?: string }).effectActionDefinitionId ===
            "ACT_SUIRAN_CHAOS_PS3_FOLLOW_UP",
      );
    expect(followUpDamage).toHaveLength(1);
    expect(followUpDamage[0]?.payload).toMatchObject({
      attackerAttack: PASSIVE_COMBAT_STATS.attack,
      criticalMultiplier: 2,
      finalDamage: 358,
      damageType: "EN",
    });
  });

  it("IT-UNIT-SUIRAN-CHAOS-005 (NEGATIVE, EVENT_PAYLOAD): SKL_SUIRAN_CHAOS_PS3 does not activate for a SkillUseStarting whose skillType is not AS, nor for one emitted by an ally who is not in front of Suiran", () => {
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

  it("IT-UNIT-SUIRAN-CHAOS-006 (R-HIT-02): SKL_SUIRAN_CHAOS_PS1 activates from a UnitBeingAttacked aimed at the ally in front of Suiran and grants that ally a single-hit EVASION status", () => {
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

  it("IT-UNIT-SUIRAN-CHAOS-007 (sourceSelector: ANY): SKL_SUIRAN_CHAOS_PS2 activates from the HitPointReduced the real damage pipeline emits once the ally in front drops to half HP, whether the damage came from an enemy or from an ally", () => {
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

  // -008〜-009: EX連鎖 — 表は`ACT_SUIRAN_CHAOS_EX_EX_DISTRIBUTE`を1体へ向けたときの
  // 発現しか見ないため、「総量を対象数で等分する」というDISTRIBUTE本来の意味は
  // 実スキル（自身を除く味方全体bindings）を通さないと現れない。

  it("IT-UNIT-SUIRAN-CHAOS-008 (R-ACTN-02, R-NUM-02): SKL_SUIRAN_CHAOS_EX splits the 8 EX it consumed evenly across every ally except the user, and its ResourceChanged StateDelta reconstructs the same gauges through the independent Reducer", () => {
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

  it("IT-UNIT-SUIRAN-CHAOS-009 (BOUNDARY, R-NUM-02): an indivisible total is truncated per ally, so three allies receive 2 each and the remainder is discarded rather than redistributed", () => {
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
});
