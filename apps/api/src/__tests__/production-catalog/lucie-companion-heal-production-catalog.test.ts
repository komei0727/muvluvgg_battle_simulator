import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { createBattleUnit } from "../../domain/battle/model/battle-unit.js";
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
 * M7-005（Issue #184、R-HEAL-01〜03）: production Catalogの回復定義を実カタログ
 * から読み込み、実ライフサイクル（`resolveSkillUse`→`resolveEffectSequencePlan`→
 * `heal-application-service.ts`）経由で近似なしに解決できることを検証する。
 *
 * - `ACT_LUCIE_COMPANION_AS3_HEAL`: 変換テーマ`HEAL_DISTRIBUTE`
 *   （`15_Unit_Memory変換台帳.md`）。「威力65分のHP回復量を均等に配分して回復する」
 *   を`payload.distribution: "EVEN"`で表現し、対象ごとに威力65を個別付与する
 *   従来の近似を解消したことを、実定義に対して確かめる。
 * - `ACT_LUCIE_COMPANION_PS1_CONTINUOUS_HEAL`: `CAP_CONTINUOUS_HEAL`。
 *   `timing: {eventType: ActionStarted, targetSelector: EFFECT_OWNER}`の付与が
 *   実resolver経由で`AppliedEffect`になり、Domain Event・StateDelta・独立Reducer
 *   復元まで一致することを確かめる（発火自体のライフサイクル配線は
 *   `action-phase-resolver.test.ts`のUT-R-HEAL-03-002が実行経路で検証する）。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const LUCIE_UNIT_ID = "UNIT_LUCIE_COMPANION";
const AS3_HEAL_ID = "ACT_LUCIE_COMPANION_AS3_HEAL";
const PS1_CONTINUOUS_HEAL_ID = "ACT_LUCIE_COMPANION_PS1_CONTINUOUS_HEAL";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function member(
  battleUnitId: string,
  unitDefinitionId: string,
  side: Side,
  position: FormationPosition,
  overrides: { maximumHp?: number; attack?: number } = {},
): BattlePartyMember {
  return {
    battleUnitId: createBattleUnitId(battleUnitId),
    unitDefinitionId: unitDefinitionId as never,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: overrides.maximumHp ?? 1000,
      attack: overrides.attack ?? 100,
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

/** ONLY the real production effect action, applied to every ally (the AS3 binding shape). */
function allAlliesSkill(effectActionId: string): SkillDefinition {
  const selector: TargetSelectorDefinition = {
    kind: "SELECT",
    side: "ALLY",
    count: "ALL",
    filters: [],
    order: ["DEFAULT"],
    includeDefeated: false,
  };
  return {
    skillDefinitionId: createSkillDefinitionId("SKL_TEST_HEAL_ALL_ALLIES"),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [{ targetBindingId: createTargetBindingId("TGT_ALL_ALLIES"), selector }],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_ALL_ALLIES") },
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(effectActionId) }],
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
    requiredCapabilities: [],
    metadata: { displayName: "TestHealAllAllies", tags: [] },
  };
}

/** ONLY the real production effect action, self-targeted. */
function selfTargetedSkill(effectActionId: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId("SKL_TEST_SELF_CONTINUOUS_HEAL"),
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
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(effectActionId) }],
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
    requiredCapabilities: [],
    metadata: { displayName: "TestSelfContinuousHeal", tags: [] },
  };
}

function definitionsWith(
  snapshot: ReturnType<ReturnType<typeof loadCatalogFromDirectory>["loadSnapshot"]>,
  skill: SkillDefinition,
  extraUnitDefinitionIds: readonly string[],
): BattleDefinitions {
  const skillDefinitions = new Map(snapshot.skills);
  skillDefinitions.set(skill.skillDefinitionId, skill);
  const unitDefinitions = new Map(snapshot.units);
  for (const id of extraUnitDefinitionIds) {
    unitDefinitions.set(createUnitDefinitionId(id), testUnitDefinition(id));
  }
  return {
    activeSkillsByUnit: new Map(),
    exSkillByUnit: new Map(),
    effectActions: new Map(snapshot.effectActions),
    unitDefinitions,
    skillDefinitions,
  };
}

describe("production Catalog UNIT_LUCIE_COMPANION heal definitions (M7-005, Issue #184, R-HEAL-01〜03)", () => {
  it("IT-CAP-HEAL-PROD-001 (HEAL_DISTRIBUTE, real lifecycle wiring): the real ACT_LUCIE_COMPANION_AS3_HEAL splits one 威力65 total heal evenly across every ally instead of granting each ally the full amount", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([LUCIE_UNIT_ID as never], []);
    const healDefinition = snapshot.effectActions.get(createEffectActionDefinitionId(AS3_HEAL_ID))!;
    expect(healDefinition.kind).toBe("HEAL");
    // The approximation this Issue removes lived in the Catalog itself: the
    // ledger row recorded that the "distribute one total amount" wording was
    // converted as a per-target full-power HEAL.
    expect(healDefinition).toMatchObject({
      kind: "HEAL",
      payload: { formula: { kind: "SKILL_POWER", power: 0.65 }, distribution: "EVEN" },
    });

    const otherAllyUnitId = "UNIT_TEST_HEAL_ALLY";
    const lucie = {
      ...createBattleUnit(
        member("ally:lucie", LUCIE_UNIT_ID, "ALLY", { column: "CENTER", row: "BACK" }),
        "ALLY",
        LIMITS,
      ),
      currentAp: LIMITS.maximumAp,
      currentHp: 100,
    };
    const otherAlly = {
      ...createBattleUnit(
        member("ally:other", otherAllyUnitId, "ALLY", { column: "LEFT", row: "FRONT" }),
        "ALLY",
        LIMITS,
      ),
      currentHp: 100,
    };
    const skill = allAlliesSkill(AS3_HEAL_ID);
    const recorder = new EventRecorder(createBattleId("B_1"));

    const result = resolveSkillUse(
      lucie,
      skill,
      "AS",
      "AS",
      [lucie, otherAlly],
      definitionsWith(snapshot, skill, [otherAllyUnitId]),
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:1"),
      recorder.nextResolutionScopeId(),
    );

    // attack 100 * power 0.65 = 65 total, split evenly across the 2 allies.
    const healEvents = recorder.getEvents().filter((e) => e.eventType === "HealApplied");
    expect(healEvents).toHaveLength(2);
    for (const event of healEvents) {
      expect(event.payload).toMatchObject({
        effectActionDefinitionId: healDefinition.effectActionDefinitionId,
        formulaResult: 65,
        distributionShareCount: 2,
        healingModifierMultiplier: 1,
        healAmount: 32,
        appliedAmount: 32,
      });
    }
    expect(result.units.find((u) => u.battleUnitId === lucie.battleUnitId)!.currentHp).toBe(132);
    expect(result.units.find((u) => u.battleUnitId === otherAlly.battleUnitId)!.currentHp).toBe(
      132,
    );
  });

  it("IT-CAP-CONTINUOUS-HEAL-PROD-001 (R-HEAL-03, real lifecycle wiring): the real ACT_LUCIE_COMPANION_PS1_CONTINUOUS_HEAL grants an AppliedEffect carrying the production ACTION(2) duration without healing at grant time, and its EffectApplied StateDelta reconstructs the same effect through the independent Reducer", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([LUCIE_UNIT_ID as never], []);
    const hotDefinition = snapshot.effectActions.get(
      createEffectActionDefinitionId(PS1_CONTINUOUS_HEAL_ID),
    )!;
    expect(hotDefinition).toMatchObject({
      kind: "APPLY_CONTINUOUS_HEAL",
      payload: { timing: { eventType: "ActionStarted", targetSelector: "EFFECT_OWNER" } },
    });

    const lucie = {
      ...createBattleUnit(
        member("ally:lucie", LUCIE_UNIT_ID, "ALLY", { column: "CENTER", row: "BACK" }),
        "ALLY",
        LIMITS,
      ),
      currentAp: LIMITS.maximumAp,
      currentHp: 100,
    };
    const skill = selfTargetedSkill(PS1_CONTINUOUS_HEAL_ID);
    const recorder = new EventRecorder(createBattleId("B_1"));

    const result = resolveSkillUse(
      lucie,
      skill,
      "AS",
      "AS",
      [lucie],
      definitionsWith(snapshot, skill, []),
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:1"),
      recorder.nextResolutionScopeId(),
    );

    const lucieAfter = result.units.find((u) => u.battleUnitId === lucie.battleUnitId)!;
    // 継続回復は付与時点では回復しない（保持者の次の`ActionStarted`で発火する）。
    expect(lucieAfter.currentHp).toBe(100);
    expect(recorder.getEvents().some((e) => e.eventType === "HealApplied")).toBe(false);
    expect(lucieAfter.appliedEffects).toHaveLength(1);
    expect(lucieAfter.appliedEffects[0]!.duration.definition).toMatchObject({
      timeLimit: { unit: "ACTION", count: 2 },
      dispellable: true,
    });

    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied") as Extract<
      BattleDomainEvent,
      { eventType: "EffectApplied" }
    >;
    expect(applied.payload).toMatchObject({
      effectActionDefinitionId: hotDefinition.effectActionDefinitionId,
      durationUnit: "ACTION",
      initialRemaining: 2,
    });

    const emptyState: BattleStateSnapshot = {
      status: "READY",
      currentTurn: 1,
      units: {
        [lucie.battleUnitId]: {
          hp: lucie.currentHp,
          ap: lucie.currentAp,
          pp: lucie.currentPp,
          extraGauge: lucie.currentExtraGauge,
          maximumAp: lucie.maximumAp,
          maximumPp: lucie.maximumPp,
          maximumExtraGauge: lucie.maximumExtraGauge,
          combatStats: lucie.combatStats,
        },
      },
    };
    const reduced = applyStateDelta(emptyState, applied.stateDelta!);
    expect(reduced.units[lucie.battleUnitId]!.effects).toHaveLength(1);
    expect(reduced.units[lucie.battleUnitId]!.effects![0]).toMatchObject({
      effectDefinitionId: hotDefinition.effectActionDefinitionId,
      duration: { unit: "ACTION", remaining: 2 },
    });
  });
});
