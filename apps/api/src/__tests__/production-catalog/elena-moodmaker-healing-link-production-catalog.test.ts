import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { createBattleUnit, type BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { createActionId } from "../../domain/shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { TargetSelectorDefinition } from "../../domain/catalog/definitions/target-selector-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import type { Side } from "../../domain/shared/side.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { applyStateDelta } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import type { BattleStateSnapshot } from "../../domain/battle/lifecycle/battle-state-snapshot.js";

/**
 * `M7-005-HEAL-LINK`（Issue #229、R-HEAL-04）: `SKL_ELENA_MOODMAKER_AS1`
 * （私に任せて！）の「最もHP割合の低い敵単体と自身に対して自身が1回行動を終える
 * までの間回復リンクを付与し、対象が得られる回復効果を100%自身に転送する」を、
 * 実カタログから読み込んだ定義で実ライフサイクル（`resolveSkillUse`→
 * `resolveEffectSequencePlan`→`effect-grant-service.ts`／
 * `heal-application-service.ts`）まで検証する。`15_Unit_Memory変換台帳.md`の
 * 不完全変換テーマ`HEALING_LINK`（1行）が解消したことの証跡。
 *
 * リンクの付与（001）と転送の成立（002）を分けるのは、AS1自身は敵を回復しないため
 * ——転送が観測できるのは、リンク付与後に別の回復が保持者へ届いたときだけである。
 * 002/003は実production定義`ACT_ELENA_MOODMAKER_AS1_HEAL`を最小限の合成skillで
 * 単体実行する（`mao-committee-ps2-stealth-production-catalog.test.ts`と同じ手法）。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const ELENA_UNIT_ID = "UNIT_ELENA_MOODMAKER";
const AS1_SKILL_ID = "SKL_ELENA_MOODMAKER_AS1";
const AS1_HEAL_ID = "ACT_ELENA_MOODMAKER_AS1_HEAL";
const AS1_HEALING_LINK_ID = "ACT_ELENA_MOODMAKER_AS1_HEALING_LINK";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };
const OTHER_UNIT_ID = "UNIT_TEST_HEAL_LINK_PEER";

function member(
  battleUnitId: string,
  unitDefinitionId: string,
  side: Side,
  position: FormationPosition,
): BattlePartyMember {
  return {
    battleUnitId: createBattleUnitId(battleUnitId),
    unitDefinitionId: unitDefinitionId as never,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 1000,
      attack: 100,
      defense: 0,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
}

function testUnitDefinition(id: string): UnitDefinition {
  return {
    unitDefinitionId: createUnitDefinitionId(id),
    attribute: "AGGRESSIVE",
    unitType: "PHYSICAL",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT", "BACK"],
    baseStats: {
      maximumHp: 1000,
      attack: 100,
      defense: 0,
      criticalRate: 0,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
      actionSpeed: 10,
      maximumAp: LIMITS.maximumAp,
      maximumPp: LIMITS.maximumPp,
    },
    extraGaugeMaximum: LIMITS.maximumExtraGauge,
    activeSkillDefinitionIds: [],
    passiveSkillDefinitionIds: [],
    extraSkillDefinitionId: createSkillDefinitionId("SKL_EX_DEFAULT"),
    requiredCapabilities: [],
    metadata: {
      displayName: id,
      characterName: id,
      characterId: `CHAR_${id}`,
      affiliations: [],
      tags: [],
    },
  };
}

const TRAITS: SkillDefinition["traits"] = {
  priorityAttack: false,
  simultaneousActivationLimited: false,
  exclusiveActivationGroupId: null,
  accuracy: { guaranteedHit: false },
  piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
};

/** ONLY the real production HEAL, aimed at the lowest-HP-ratio enemy (the link holder). */
function lowestEnemyHealSkill(): SkillDefinition {
  const selector: TargetSelectorDefinition = {
    kind: "SELECT",
    side: "ENEMY",
    count: 1,
    filters: [],
    order: ["LOWEST_HP_RATIO"],
    includeDefeated: false,
  };
  return {
    skillDefinitionId: createSkillDefinitionId("SKL_TEST_HEAL_LOWEST_ENEMY"),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [{ targetBindingId: createTargetBindingId("TGT_LOWEST_ENEMY"), selector }],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_LOWEST_ENEMY") },
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(AS1_HEAL_ID) }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: TRAITS,
    requiredCapabilities: [],
    metadata: { displayName: "TestHealLowestEnemy", tags: [] },
  };
}

/** ONLY the real production HEAL, self-targeted (exercises the self-link identity). */
function selfHealSkill(): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId("SKL_TEST_HEAL_SELF"),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "SELF" },
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(AS1_HEAL_ID) }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: TRAITS,
    requiredCapabilities: [],
    metadata: { displayName: "TestHealSelf", tags: [] },
  };
}

type Snapshot = ReturnType<ReturnType<typeof loadCatalogFromDirectory>["loadSnapshot"]>;

function definitionsWith(snapshot: Snapshot, extraSkills: readonly SkillDefinition[]) {
  const skillDefinitions = new Map(snapshot.skills);
  for (const skill of extraSkills) {
    skillDefinitions.set(skill.skillDefinitionId, skill);
  }
  const unitDefinitions = new Map(snapshot.units);
  unitDefinitions.set(createUnitDefinitionId(OTHER_UNIT_ID), testUnitDefinition(OTHER_UNIT_ID));
  const definitions: BattleDefinitions = {
    activeSkillsByUnit: new Map(),
    exSkillByUnit: new Map(),
    effectActions: new Map(snapshot.effectActions),
    unitDefinitions,
    skillDefinitions,
  };
  return definitions;
}

interface Board {
  readonly snapshot: Snapshot;
  readonly elena: BattleUnit;
  readonly woundedAlly: BattleUnit;
  readonly woundedEnemy: BattleUnit;
  readonly healthyEnemy: BattleUnit;
}

/**
 * AS1の不発条件（`activationCondition`、Issue #180）を満たす盤面。
 * - Elena: 400/1000（HP割合40% = 下限ちょうど）
 * - 味方: 100/1000（HP70%未満の味方が存在し、かつ自身以外の味方が生存している）
 * - 敵: 300/1000 と 900/1000（最もHP割合の低い敵は前者）
 */
function board(): Board {
  const catalog = loadCatalogFromDirectory(CATALOG_DIR);
  const snapshot = catalog.loadSnapshot([ELENA_UNIT_ID as never], []);
  const elena: BattleUnit = {
    ...createBattleUnit(
      member("ally:elena", ELENA_UNIT_ID, "ALLY", { column: "CENTER", row: "BACK" }),
      "ALLY",
      LIMITS,
    ),
    currentAp: LIMITS.maximumAp,
    currentHp: 400,
  };
  const woundedAlly: BattleUnit = {
    ...createBattleUnit(
      member("ally:peer", OTHER_UNIT_ID, "ALLY", { column: "LEFT", row: "FRONT" }),
      "ALLY",
      LIMITS,
    ),
    currentHp: 100,
  };
  const woundedEnemy: BattleUnit = {
    ...createBattleUnit(
      member("enemy:wounded", OTHER_UNIT_ID, "ENEMY", { column: "LEFT", row: "FRONT" }),
      "ENEMY",
      LIMITS,
    ),
    currentHp: 300,
  };
  const healthyEnemy: BattleUnit = {
    ...createBattleUnit(
      member("enemy:healthy", OTHER_UNIT_ID, "ENEMY", { column: "RIGHT", row: "FRONT" }),
      "ENEMY",
      LIMITS,
    ),
    currentHp: 900,
  };
  return { snapshot, elena, woundedAlly, woundedEnemy, healthyEnemy };
}

function unitStateFor(units: readonly BattleUnit[]): BattleStateSnapshot {
  return {
    status: "READY",
    currentTurn: 1,
    units: Object.fromEntries(
      units.map((u) => [
        u.battleUnitId,
        {
          hp: u.currentHp,
          ap: u.currentAp,
          pp: u.currentPp,
          extraGauge: u.currentExtraGauge,
          maximumAp: u.maximumAp,
          maximumPp: u.maximumPp,
          maximumExtraGauge: u.maximumExtraGauge,
          combatStats: u.combatStats,
        },
      ]),
    ),
  };
}

describe("production Catalog SKL_ELENA_MOODMAKER_AS1 healing link (M7-005-HEAL-LINK, Issue #229, R-HEAL-04)", () => {
  it("IT-CAP-HEALING-LINK-PROD-001 (real lifecycle wiring): the real SKL_ELENA_MOODMAKER_AS1 heals the lowest-HP ally and grants ACT_ELENA_MOODMAKER_AS1_HEALING_LINK to both the lowest-HP-ratio enemy and Elena herself, each resolving transferTo: SELF to Elena at grant time", () => {
    const { snapshot, elena, woundedAlly, woundedEnemy, healthyEnemy } = board();
    const linkDefinition = snapshot.effectActions.get(
      createEffectActionDefinitionId(AS1_HEALING_LINK_ID),
    )!;
    // 変換台帳が記録していた近似（回復リンクの省略）が解消されたことをCatalog自身に対して確かめる。
    expect(linkDefinition).toMatchObject({
      kind: "APPLY_HEALING_LINK",
      payload: {
        transferTo: { kind: "SELF" },
        transferRate: 1,
        duration: { timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" } },
      },
    });
    const as1 = snapshot.skills.get(createSkillDefinitionId(AS1_SKILL_ID))!;
    expect(as1.requiredCapabilities).toContain("CAP_HEALING_LINK");

    const units = [elena, woundedAlly, woundedEnemy, healthyEnemy];
    const recorder = new EventRecorder(createBattleId("B_1"));

    const result = resolveSkillUse(
      elena,
      as1,
      "AS",
      "AS",
      units,
      definitionsWith(snapshot, []),
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:1"),
      recorder.nextResolutionScopeId(),
    );

    // CURRENT_HP_RATIO(SKILL_SOURCE) 0.235 * Elena's 400 = 94, to the lowest-HP-ratio ally.
    const healApplied = recorder.getEvents().find((e) => e.eventType === "HealApplied")!;
    expect(healApplied.payload).toMatchObject({
      effectActionDefinitionId: createEffectActionDefinitionId(AS1_HEAL_ID),
      targetUnitId: woundedAlly.battleUnitId,
      healAmount: 94,
      transferredAmount: 0,
      appliedAmount: 94,
    });
    expect(result.units.find((u) => u.battleUnitId === woundedAlly.battleUnitId)!.currentHp).toBe(
      194,
    );
    // 付与時点では転送は起こらない（リンクは以後の回復にだけ作用する）。
    expect(recorder.getEvents().some((e) => e.eventType === "HealingTransferred")).toBe(false);

    const linkGrants = recorder
      .getEvents()
      .filter(
        (e) =>
          e.eventType === "EffectApplied" &&
          e.payload.effectActionDefinitionId === linkDefinition.effectActionDefinitionId,
      ) as Extract<BattleDomainEvent, { eventType: "EffectApplied" }>[];
    expect(linkGrants.map((e) => e.payload.targetUnitId)).toEqual([
      woundedEnemy.battleUnitId,
      elena.battleUnitId,
    ]);
    for (const grant of linkGrants) {
      expect(grant.payload).toMatchObject({
        sourceUnitId: elena.battleUnitId,
        durationUnit: "ACTION",
        initialRemaining: 1,
        durationOwner: "EFFECT_SOURCE",
      });
    }
    // 最もHP割合の低い敵1体だけがリンクを受ける（900/1000の敵は対象外）。
    expect(
      result.units.find((u) => u.battleUnitId === healthyEnemy.battleUnitId)!.appliedEffects,
    ).toHaveLength(0);
    for (const holderId of [woundedEnemy.battleUnitId, elena.battleUnitId]) {
      const holder = result.units.find((u) => u.battleUnitId === holderId)!;
      expect(holder.appliedEffects).toHaveLength(1);
      expect(holder.appliedEffects[0]).toMatchObject({
        effectActionDefinitionId: linkDefinition.effectActionDefinitionId,
        healingLink: { transferToUnitId: elena.battleUnitId, transferRate: 1 },
      });
    }

    // 独立Reducer: `EffectApplied`のStateDeltaだけから同じリンク（転送先・転送率を含む）を復元できる。
    let restored = unitStateFor(units);
    for (const grant of linkGrants) {
      restored = applyStateDelta(restored, grant.stateDelta!);
    }
    expect(restored.units[woundedEnemy.battleUnitId]!.effects).toMatchObject([
      {
        effectDefinitionId: linkDefinition.effectActionDefinitionId,
        healingLink: { transferToUnitId: elena.battleUnitId, transferRate: 1 },
        duration: { unit: "ACTION", remaining: 1 },
      },
    ]);
    expect(restored.units[elena.battleUnitId]!.effects).toMatchObject([
      { healingLink: { transferToUnitId: elena.battleUnitId, transferRate: 1 } },
    ]);
  });

  it("IT-CAP-HEALING-LINK-PROD-002 (real lifecycle wiring): once the AS1 link is held by the enemy, healing that enemy transfers 100% to Elena — the enemy's HP does not move, HealingTransferred carries the causality and the HP StateDelta, and the independent Reducer restores the same HP", () => {
    const { snapshot, elena, woundedAlly, woundedEnemy, healthyEnemy } = board();
    const definitions = definitionsWith(snapshot, [lowestEnemyHealSkill()]);
    const as1 = snapshot.skills.get(createSkillDefinitionId(AS1_SKILL_ID))!;
    const recorder = new EventRecorder(createBattleId("B_1"));

    const granted = resolveSkillUse(
      elena,
      as1,
      "AS",
      "AS",
      [elena, woundedAlly, woundedEnemy, healthyEnemy],
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:1"),
      recorder.nextResolutionScopeId(),
    );

    const beforeTransfer = granted.units;
    const elenaBefore = beforeTransfer.find((u) => u.battleUnitId === elena.battleUnitId)!;
    expect(elenaBefore.currentHp).toBe(400);
    const eventsBefore = recorder.getEvents().length;

    const healed = resolveSkillUse(
      elenaBefore,
      lowestEnemyHealSkill(),
      "AS",
      "AS",
      beforeTransfer,
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:2"),
      recorder.nextResolutionScopeId(),
    );

    const newEvents = recorder.getEvents().slice(eventsBefore);
    const healApplied = newEvents.find((e) => e.eventType === "HealApplied")!;
    expect(healApplied.payload).toMatchObject({
      targetUnitId: woundedEnemy.battleUnitId,
      healAmount: 94,
      transferredAmount: 94,
      appliedAmount: 0,
      discardedAmount: 0,
    });
    // 転送された分は保持者のHP変化ではないため、`HealApplied`はStateDeltaを持たない。
    expect(healApplied.stateDelta).toBeUndefined();

    const transferred = newEvents.find((e) => e.eventType === "HealingTransferred") as Extract<
      BattleDomainEvent,
      { eventType: "HealingTransferred" }
    >;
    expect(transferred.category).toBe("FACT");
    expect(transferred.parentEventId).toBe(healApplied.eventId);
    expect(transferred.rootEventId).toBe(healApplied.rootEventId);
    expect(transferred.payload).toMatchObject({
      effectActionDefinitionId: createEffectActionDefinitionId(AS1_HEALING_LINK_ID),
      fromUnitId: woundedEnemy.battleUnitId,
      toUnitId: elena.battleUnitId,
      transferRate: 1,
      transferredAmount: 94,
      appliedAmount: 94,
      discardedAmount: 0,
      hpBefore: 400,
      hpAfter: 494,
    });
    // 転送は1回だけ（Elena自身も同じリンクを持つが、転送によって生じた回復から
    // さらに転送は起こらない — R-HEAL-04の再リンク禁止）。
    expect(newEvents.filter((e) => e.eventType === "HealingTransferred")).toHaveLength(1);

    expect(healed.units.find((u) => u.battleUnitId === woundedEnemy.battleUnitId)!.currentHp).toBe(
      300,
    );
    expect(healed.units.find((u) => u.battleUnitId === elena.battleUnitId)!.currentHp).toBe(494);

    const restored = applyStateDelta(unitStateFor(beforeTransfer), transferred.stateDelta!);
    expect(restored.units[elena.battleUnitId]!.hp).toBe(494);
    expect(restored.units[woundedEnemy.battleUnitId]!.hp).toBe(300);
  });

  it("IT-CAP-HEALING-LINK-PROD-003 (BOUNDARY, real lifecycle wiring): the link AS1 also grants to Elena herself is the identity — healing Elena keeps the whole amount with her and emits no HealingTransferred", () => {
    const { snapshot, elena, woundedAlly, woundedEnemy, healthyEnemy } = board();
    const definitions = definitionsWith(snapshot, [selfHealSkill()]);
    const as1 = snapshot.skills.get(createSkillDefinitionId(AS1_SKILL_ID))!;
    const recorder = new EventRecorder(createBattleId("B_1"));

    const granted = resolveSkillUse(
      elena,
      as1,
      "AS",
      "AS",
      [elena, woundedAlly, woundedEnemy, healthyEnemy],
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:1"),
      recorder.nextResolutionScopeId(),
    );
    const elenaBefore = granted.units.find((u) => u.battleUnitId === elena.battleUnitId)!;
    expect(elenaBefore.appliedEffects[0]!.healingLink).toMatchObject({
      transferToUnitId: elena.battleUnitId,
    });
    const eventsBefore = recorder.getEvents().length;

    const healed = resolveSkillUse(
      elenaBefore,
      selfHealSkill(),
      "AS",
      "AS",
      granted.units,
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:2"),
      recorder.nextResolutionScopeId(),
    );

    const newEvents = recorder.getEvents().slice(eventsBefore);
    expect(newEvents.find((e) => e.eventType === "HealApplied")!.payload).toMatchObject({
      targetUnitId: elena.battleUnitId,
      healAmount: 94,
      transferredAmount: 0,
      appliedAmount: 94,
    });
    expect(newEvents.some((e) => e.eventType === "HealingTransferred")).toBe(false);
    expect(healed.units.find((u) => u.battleUnitId === elena.battleUnitId)!.currentHp).toBe(494);
  });
});
