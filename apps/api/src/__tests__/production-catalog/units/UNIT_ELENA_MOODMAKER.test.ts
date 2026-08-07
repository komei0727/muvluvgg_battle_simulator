import { describe, expect, it } from "vitest";
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
import type { SkillDefinition } from "../../../domain/catalog/definitions/skill-definition.js";
import type { TargetReference } from "../../../domain/catalog/definitions/references.js";
import type { TargetSelectorDefinition } from "../../../domain/catalog/definitions/target-selector-definition.js";
import { createActionId } from "../../../domain/shared/event-ids.js";
import { createBattleId } from "../../../domain/shared/ids.js";
import {
  definitionsWith,
  effectActionFrom,
  initialSnapshotFor,
  loadProductionSnapshot,
  skillFrom,
  testBattleUnit,
  unitFrom,
} from "../../../testing/fixtures/index.js";
import {
  PRODUCTION_CATALOG_DIR,
  STAND_IN_UNIT_ID,
  observeEffectAction,
  type EffectManifestationCase,
} from "../../../testing/production-unit/effect-manifestation.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";

/**
 * `UNIT_ELENA_MOODMAKER`（【心色見つめるムードメーカー】エレーナ・パステルコワ）のユニット単位production結合テスト
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

const UNIT_DEFINITION_ID = "UNIT_ELENA_MOODMAKER";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const AS1_SKILL_ID = "SKL_ELENA_MOODMAKER_AS1";
const AS1_HEAL_ID = "ACT_ELENA_MOODMAKER_AS1_HEAL";
const AS1_HEALING_LINK_ID = "ACT_ELENA_MOODMAKER_AS1_HEALING_LINK";

/**
 * AS1の回復リンク（R-HEAL-04）を観測するための盤面。AS1自身の発動条件
 * （自身のHP割合が下限ちょうど・HP70%未満の味方が存在・自身以外の味方が生存）を
 * すべて満たす最小構成にする。
 */
const LINK_COMBAT_STATS = { maximumHp: 1000, attack: 100, defense: 0 };
const LINK_LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

const LINK_TRAITS: SkillDefinition["traits"] = {
  priorityAttack: false,
  simultaneousActivationLimited: false,
  exclusiveActivationGroupId: null,
  accuracy: { guaranteedHit: false },
  piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
};

/**
 * 実production定義の`ACT_ELENA_MOODMAKER_AS1_HEAL`だけを、指定の相手へ単体で撃つ
 * 合成AS。リンクは「付与後に別の回復が保持者へ届いたとき」にしか観測できないため、
 * 転送の検証にはAS1本体とは別の回復経路が要る。
 */
function healSkill(id: string, target: TargetReference): SkillDefinition {
  const selector: TargetSelectorDefinition = {
    kind: "SELECT",
    side: "ENEMY",
    count: 1,
    filters: [],
    order: ["LOWEST_HP_RATIO"],
    includeDefeated: false,
  };
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings:
        target.kind === "SELF"
          ? []
          : [{ targetBindingId: createTargetBindingId("TGT_LOWEST_ENEMY"), selector }],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target,
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(AS1_HEAL_ID) }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: LINK_TRAITS,
    metadata: { displayName: id, tags: [] },
  };
}

const LOWEST_ENEMY_HEAL_ID = "SKL_TEST_ELENA_HEAL_LOWEST_ENEMY";
const SELF_HEAL_ID = "SKL_TEST_ELENA_HEAL_SELF";

interface LinkBoard {
  readonly elena: BattleUnit;
  readonly woundedAlly: BattleUnit;
  readonly woundedEnemy: BattleUnit;
  readonly healthyEnemy: BattleUnit;
  readonly units: readonly BattleUnit[];
  readonly definitions: BattleDefinitions;
}

function linkBoard(): LinkBoard {
  const member = (
    battleUnitId: string,
    unitDefinitionId: string,
    side: "ALLY" | "ENEMY",
    column: "LEFT" | "CENTER" | "RIGHT",
    row: "FRONT" | "BACK",
    currentHp: number,
    extra: Partial<BattleUnit> = {},
  ): BattleUnit =>
    testBattleUnit({
      battleUnitId,
      unitDefinitionId,
      side,
      position: { column, row },
      combatStats: LINK_COMBAT_STATS,
      limits: LINK_LIMITS,
      overrides: { currentHp, ...extra },
    });

  // Elena 400/1000（HP割合40% = 発動条件の下限ちょうど）、味方 100/1000（70%未満）、
  // 敵 300/1000 と 900/1000（最もHP割合の低い敵は前者）。
  const elena = member("ally:elena", UNIT_DEFINITION_ID, "ALLY", "CENTER", "BACK", 400, {
    currentAp: LINK_LIMITS.maximumAp,
  });
  const woundedAlly = member("ally:peer", STAND_IN_UNIT_ID, "ALLY", "LEFT", "FRONT", 100);
  const woundedEnemy = member("enemy:wounded", STAND_IN_UNIT_ID, "ENEMY", "LEFT", "FRONT", 300);
  const healthyEnemy = member("enemy:healthy", STAND_IN_UNIT_ID, "ENEMY", "RIGHT", "FRONT", 900);
  return {
    elena,
    woundedAlly,
    woundedEnemy,
    healthyEnemy,
    units: [elena, woundedAlly, woundedEnemy, healthyEnemy],
    definitions: definitionsWith(snapshot, {
      units: [STAND_IN_UNIT_ID],
      skills: [
        healSkill(LOWEST_ENEMY_HEAL_ID, {
          kind: "BINDING",
          targetBindingId: createTargetBindingId("TGT_LOWEST_ENEMY"),
        }),
        healSkill(SELF_HEAL_ID, { kind: "SELF" }),
      ],
    }),
  };
}

function unitOf(units: readonly BattleUnit[], battleUnitId: string): BattleUnit {
  const found = units.find((unit) => unit.battleUnitId === battleUnitId);
  if (found === undefined) {
    throw new Error(`unit "${battleUnitId}" is not on the board`);
  }
  return found;
}

/** 盤面へ1件のスキルを解決する。同じrecorderを使い回して因果の連続性を保つ。 */
function useSkill(
  board: LinkBoard,
  recorder: EventRecorder,
  actor: BattleUnit,
  skill: SkillDefinition,
  units: readonly BattleUnit[],
  actionIndex: number,
): ReturnType<typeof resolveSkillUse> {
  return resolveSkillUse(
    actor,
    skill,
    "AS",
    "AS",
    units,
    board.definitions,
    new SequenceRandomSource([]),
    recorder,
    1,
    0,
    createActionId(`B_ELENA:action:${actionIndex}`),
    recorder.nextResolutionScopeId(),
  );
}

/** (SKL_ID, ACT_ID, 期待効果)。行の並びは AS → PS → EX のSkill定義順。 */
const MANIFESTATIONS: readonly EffectManifestationCase[] = [
  {
    skillDefinitionId: "SKL_ELENA_MOODMAKER_AS1",
    effectActionDefinitionId: "ACT_ELENA_MOODMAKER_AS1_HEAL",
    target: "ALLY",
    expected: {
      eventTypes: ["HealApplied"],
      hpDeltas: {
        "ally:peer": 1175,
      },
    },
  },
  {
    skillDefinitionId: "SKL_ELENA_MOODMAKER_AS1",
    effectActionDefinitionId: "ACT_ELENA_MOODMAKER_AS1_HEALING_LINK",
    target: "SELF",
    expected: {
      eventTypes: ["EffectApplied"],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_AS1_HEALING_LINK",
          magnitude: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ELENA_MOODMAKER_AS2",
    effectActionDefinitionId: "ACT_ELENA_MOODMAKER_AS2_DAMAGE",
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
        "enemy:foe": -500,
      },
    },
  },
  {
    skillDefinitionId: "SKL_ELENA_MOODMAKER_PS1",
    effectActionDefinitionId: "ACT_ELENA_MOODMAKER_PS1_HEAL",
    target: "SELF",
    expected: {
      eventTypes: ["HealApplied"],
      hpDeltas: {
        "ally:subject": 650,
      },
    },
  },
  {
    skillDefinitionId: "SKL_ELENA_MOODMAKER_PS2",
    effectActionDefinitionId: "ACT_ELENA_MOODMAKER_PS2_ATK_UP",
    target: "SELF",
    expected: {
      eventTypes: ["EffectApplied", "CombatStatChanged"],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_PS2_ATK_UP",
          magnitude: 0.6,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ELENA_MOODMAKER_PS2",
    effectActionDefinitionId: "ACT_ELENA_MOODMAKER_PS2_DAMAGE",
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
        "enemy:foe": -234,
      },
    },
  },
  {
    skillDefinitionId: "SKL_ELENA_MOODMAKER_EX",
    effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_ATK_UP_HIGH",
    target: "ALLY",
    expected: {
      eventTypes: ["EffectApplied", "CombatStatChanged"],
      effectsApplied: [
        {
          unitId: "ally:peer",
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_ATK_UP_HIGH",
          magnitude: 0.35,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ELENA_MOODMAKER_EX",
    effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_ATK_UP_LOW",
    target: "ALLY",
    expected: {
      eventTypes: ["EffectApplied", "CombatStatChanged"],
      effectsApplied: [
        {
          unitId: "ally:peer",
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_ATK_UP_LOW",
          magnitude: 0.35,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ELENA_MOODMAKER_EX",
    effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_BONUS_DAMAGE",
    target: "ALLY",
    expected: {
      eventTypes: ["EffectApplied"],
      effectsApplied: [
        {
          unitId: "ally:peer",
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_BONUS_DAMAGE",
          magnitude: 150,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ELENA_MOODMAKER_EX",
    effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_DMGUP_HIGH",
    target: "ALLY",
    expected: {
      eventTypes: ["EffectApplied"],
      effectsApplied: [
        {
          unitId: "ally:peer",
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_DMGUP_HIGH",
          magnitude: 0.1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ELENA_MOODMAKER_EX",
    effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_DMGUP_LOW",
    target: "ALLY",
    expected: {
      eventTypes: ["EffectApplied"],
      effectsApplied: [
        {
          unitId: "ally:peer",
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_DMGUP_LOW",
          magnitude: 0.1,
        },
      ],
    },
  },
];

describe("production Catalog UNIT_ELENA_MOODMAKER (【心色見つめるムードメーカー】エレーナ・パステルコワ)", () => {
  it.each(MANIFESTATIONS)(
    "IT-UNIT-ELENA-MOODMAKER-001: $effectActionDefinitionId ($skillDefinitionId) manifests exactly the declared effect on the $target target",
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

  it("IT-UNIT-ELENA-MOODMAKER-002: the table's skill column covers exactly the Skills the production UnitDefinition declares", () => {
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
      "SKL_ELENA_MOODMAKER_AS1",
      "SKL_ELENA_MOODMAKER_AS2",
      "SKL_ELENA_MOODMAKER_PS1",
      "SKL_ELENA_MOODMAKER_PS2",
      "SKL_ELENA_MOODMAKER_EX",
    ]);
    expect([...new Set(MANIFESTATIONS.map((entry) => entry.skillDefinitionId))].sort()).toEqual(
      [...declared].sort(),
    );
  });
  // -003〜-005: 表で表現できない機構 — 回復リンク（R-HEAL-04）は「付与」と
  // 「以後の回復の転送」が別の時点で起こるため、単発のEffectAction観測では
  // 転送そのものが現れない。実スキルの対象選択と、リンク保持後の別経路の回復を通す。

  it("IT-UNIT-ELENA-MOODMAKER-003 (R-HEAL-04): the real SKL_ELENA_MOODMAKER_AS1 heals the lowest-HP ally and grants ACT_ELENA_MOODMAKER_AS1_HEALING_LINK to both the lowest-HP-ratio enemy and Elena herself, each resolving transferTo: SELF to Elena at grant time", () => {
    const board = linkBoard();
    // Catalog自身に対して、回復リンクが近似なしで表現されていることも確かめる。
    expect(effectActionFrom(snapshot, AS1_HEALING_LINK_ID)).toMatchObject({
      kind: "APPLY_HEALING_LINK",
      payload: {
        transferTo: { kind: "SELF" },
        transferRate: 1,
        duration: { timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" } },
      },
    });

    const recorder = new EventRecorder(createBattleId("B_ELENA"));
    const result = useSkill(
      board,
      recorder,
      board.elena,
      skillFrom(snapshot, AS1_SKILL_ID),
      board.units,
      1,
    );

    // CURRENT_HP_RATIO(SKILL_SOURCE) 0.235 × Elenaの400 = 94 が、最もHPの低い味方へ。
    const healApplied = recorder.getEvents().find((event) => event.eventType === "HealApplied")!;
    expect(healApplied.payload).toMatchObject({
      effectActionDefinitionId: createEffectActionDefinitionId(AS1_HEAL_ID),
      targetUnitId: board.woundedAlly.battleUnitId,
      healAmount: 94,
      transferredAmount: 0,
      appliedAmount: 94,
    });
    expect(unitOf(result.units, board.woundedAlly.battleUnitId).currentHp).toBe(194);
    // 付与時点では転送は起こらない（リンクは以後の回復にだけ作用する）。
    expect(recorder.getEvents().some((event) => event.eventType === "HealingTransferred")).toBe(
      false,
    );

    const linkGrants = recorder
      .getEvents()
      .filter(
        (event): event is Extract<BattleDomainEvent, { eventType: "EffectApplied" }> =>
          event.eventType === "EffectApplied" &&
          event.payload.effectActionDefinitionId === AS1_HEALING_LINK_ID,
      );
    expect(linkGrants.map((event) => event.payload.targetUnitId)).toEqual([
      board.woundedEnemy.battleUnitId,
      board.elena.battleUnitId,
    ]);
    for (const grant of linkGrants) {
      expect(grant.payload).toMatchObject({
        sourceUnitId: board.elena.battleUnitId,
        durationUnit: "ACTION",
        initialRemaining: 1,
        durationOwner: "EFFECT_SOURCE",
      });
    }
    // 最もHP割合の低い敵1体だけがリンクを受ける（900/1000の敵は対象外）。
    expect(unitOf(result.units, board.healthyEnemy.battleUnitId).appliedEffects).toHaveLength(0);
    for (const holderId of [board.woundedEnemy.battleUnitId, board.elena.battleUnitId]) {
      const holder = unitOf(result.units, holderId);
      expect(holder.appliedEffects).toHaveLength(1);
      expect(holder.appliedEffects[0]).toMatchObject({
        effectActionDefinitionId: AS1_HEALING_LINK_ID,
        healingLink: { transferToUnitId: board.elena.battleUnitId, transferRate: 1 },
      });
    }

    // 独立Reducer: `EffectApplied`のStateDeltaだけから同じリンク（転送先・転送率を
    // 含む）を復元できる。
    let restored = initialSnapshotFor(board.units, { status: "READY" });
    for (const grant of linkGrants) {
      restored = applyStateDelta(restored, grant.stateDelta!);
    }
    expect(restored.units[board.woundedEnemy.battleUnitId]!.effects).toMatchObject([
      {
        effectDefinitionId: AS1_HEALING_LINK_ID,
        healingLink: { transferToUnitId: board.elena.battleUnitId, transferRate: 1 },
        duration: { unit: "ACTION", remaining: 1 },
      },
    ]);
    expect(restored.units[board.elena.battleUnitId]!.effects).toMatchObject([
      { healingLink: { transferToUnitId: board.elena.battleUnitId, transferRate: 1 } },
    ]);
  });

  it("IT-UNIT-ELENA-MOODMAKER-004 (R-HEAL-04): once the enemy holds the AS1 link, healing that enemy transfers 100% to Elena — the enemy's HP does not move, HealingTransferred carries the causality and the HP StateDelta, and the independent Reducer restores the same HP", () => {
    const board = linkBoard();
    const recorder = new EventRecorder(createBattleId("B_ELENA"));
    const granted = useSkill(
      board,
      recorder,
      board.elena,
      skillFrom(snapshot, AS1_SKILL_ID),
      board.units,
      1,
    );

    const elenaBefore = unitOf(granted.units, board.elena.battleUnitId);
    expect(elenaBefore.currentHp).toBe(400);
    const eventsBefore = recorder.getEvents().length;

    const healSkillDefinition = board.definitions.skillDefinitions.get(
      createSkillDefinitionId(LOWEST_ENEMY_HEAL_ID),
    )!;
    const healed = useSkill(board, recorder, elenaBefore, healSkillDefinition, granted.units, 2);

    const newEvents = recorder.getEvents().slice(eventsBefore);
    const healApplied = newEvents.find((event) => event.eventType === "HealApplied")!;
    expect(healApplied.payload).toMatchObject({
      targetUnitId: board.woundedEnemy.battleUnitId,
      healAmount: 94,
      transferredAmount: 94,
      appliedAmount: 0,
      discardedAmount: 0,
    });
    // 転送された分は保持者のHP変化ではないため、`HealApplied`はStateDeltaを持たない。
    expect(healApplied.stateDelta).toBeUndefined();

    const transferred = newEvents.find(
      (event): event is Extract<BattleDomainEvent, { eventType: "HealingTransferred" }> =>
        event.eventType === "HealingTransferred",
    )!;
    expect(transferred.category).toBe("FACT");
    expect(transferred.parentEventId).toBe(healApplied.eventId);
    expect(transferred.rootEventId).toBe(healApplied.rootEventId);
    expect(transferred.payload).toMatchObject({
      effectActionDefinitionId: createEffectActionDefinitionId(AS1_HEALING_LINK_ID),
      fromUnitId: board.woundedEnemy.battleUnitId,
      toUnitId: board.elena.battleUnitId,
      transferRate: 1,
      transferredAmount: 94,
      appliedAmount: 94,
      discardedAmount: 0,
      hpBefore: 400,
      hpAfter: 494,
    });
    // 転送は1回だけ（Elena自身も同じリンクを持つが、転送によって生じた回復から
    // さらに転送は起こらない — R-HEAL-04の再リンク禁止）。
    expect(newEvents.filter((event) => event.eventType === "HealingTransferred")).toHaveLength(1);

    expect(unitOf(healed.units, board.woundedEnemy.battleUnitId).currentHp).toBe(300);
    expect(unitOf(healed.units, board.elena.battleUnitId).currentHp).toBe(494);

    const restored = applyStateDelta(
      initialSnapshotFor(granted.units, { status: "READY" }),
      transferred.stateDelta!,
    );
    expect(restored.units[board.elena.battleUnitId]!.hp).toBe(494);
    expect(restored.units[board.woundedEnemy.battleUnitId]!.hp).toBe(300);
  });

  it("IT-UNIT-ELENA-MOODMAKER-005 (BOUNDARY, R-HEAL-04): the link AS1 also grants to Elena herself is the identity — healing Elena keeps the whole amount with her and emits no HealingTransferred", () => {
    const board = linkBoard();
    const recorder = new EventRecorder(createBattleId("B_ELENA"));
    const granted = useSkill(
      board,
      recorder,
      board.elena,
      skillFrom(snapshot, AS1_SKILL_ID),
      board.units,
      1,
    );
    const elenaBefore = unitOf(granted.units, board.elena.battleUnitId);
    expect(elenaBefore.appliedEffects[0]!.healingLink).toMatchObject({
      transferToUnitId: board.elena.battleUnitId,
    });
    const eventsBefore = recorder.getEvents().length;

    const selfHeal = board.definitions.skillDefinitions.get(createSkillDefinitionId(SELF_HEAL_ID))!;
    const healed = useSkill(board, recorder, elenaBefore, selfHeal, granted.units, 2);

    const newEvents = recorder.getEvents().slice(eventsBefore);
    expect(newEvents.find((event) => event.eventType === "HealApplied")!.payload).toMatchObject({
      targetUnitId: board.elena.battleUnitId,
      healAmount: 94,
      transferredAmount: 0,
      appliedAmount: 94,
    });
    expect(newEvents.some((event) => event.eventType === "HealingTransferred")).toBe(false);
    expect(unitOf(healed.units, board.elena.battleUnitId).currentHp).toBe(494);
  });
});
