import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { createActionId } from "../../domain/shared/event-ids.js";
import { createBattleId } from "../../domain/shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { TargetSelectorDefinition } from "../../domain/catalog/definitions/target-selector-definition.js";
import { applyStateDelta } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import {
  definitionsWith,
  effectActionFrom,
  initialSnapshotFor,
  loadProductionSnapshot,
  testBattleUnit,
} from "../../testing/fixtures/index.js";

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

const COMBAT_STATS = { maximumHp: 1000, attack: 100, defense: 0 };

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
    metadata: { displayName: "TestSelfContinuousHeal", tags: [] },
  };
}

describe("production Catalog UNIT_LUCIE_COMPANION heal definitions (M7-005, Issue #184, R-HEAL-01〜03)", () => {
  it("IT-CAP-HEAL-PROD-001 (HEAL_DISTRIBUTE, real lifecycle wiring): the real ACT_LUCIE_COMPANION_AS3_HEAL splits one 威力65 total heal evenly across every ally instead of granting each ally the full amount", () => {
    const snapshot = loadProductionSnapshot(CATALOG_DIR, [LUCIE_UNIT_ID]);
    const healDefinition = effectActionFrom(snapshot, AS3_HEAL_ID);
    expect(healDefinition.kind).toBe("HEAL");
    // The approximation this Issue removes lived in the Catalog itself: the
    // ledger row recorded that the "distribute one total amount" wording was
    // converted as a per-target full-power HEAL.
    expect(healDefinition).toMatchObject({
      kind: "HEAL",
      payload: { formula: { kind: "SKILL_POWER", power: 0.65 }, distribution: "EVEN" },
    });

    const otherAllyUnitId = "UNIT_TEST_HEAL_ALLY";
    const lucie = testBattleUnit({
      battleUnitId: "ally:lucie",
      unitDefinitionId: LUCIE_UNIT_ID,
      position: { column: "CENTER", row: "BACK" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
      overrides: { currentAp: LIMITS.maximumAp, currentHp: 100 },
    });
    const otherAlly = testBattleUnit({
      battleUnitId: "ally:other",
      unitDefinitionId: otherAllyUnitId,
      position: { column: "LEFT", row: "FRONT" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
      overrides: { currentHp: 100 },
    });
    const skill = allAlliesSkill(AS3_HEAL_ID);
    const recorder = new EventRecorder(createBattleId("B_1"));

    const result = resolveSkillUse(
      lucie,
      skill,
      "AS",
      "AS",
      [lucie, otherAlly],
      definitionsWith(snapshot, { units: [otherAllyUnitId], skills: [skill] }),
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
    const snapshot = loadProductionSnapshot(CATALOG_DIR, [LUCIE_UNIT_ID]);
    const hotDefinition = effectActionFrom(snapshot, PS1_CONTINUOUS_HEAL_ID);
    expect(hotDefinition).toMatchObject({
      kind: "APPLY_CONTINUOUS_HEAL",
      payload: { timing: { eventType: "ActionStarted", targetSelector: "EFFECT_OWNER" } },
    });

    const lucie = testBattleUnit({
      battleUnitId: "ally:lucie",
      unitDefinitionId: LUCIE_UNIT_ID,
      position: { column: "CENTER", row: "BACK" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
      overrides: { currentAp: LIMITS.maximumAp, currentHp: 100 },
    });
    const skill = selfTargetedSkill(PS1_CONTINUOUS_HEAL_ID);
    const recorder = new EventRecorder(createBattleId("B_1"));

    const result = resolveSkillUse(
      lucie,
      skill,
      "AS",
      "AS",
      [lucie],
      definitionsWith(snapshot, { skills: [skill] }),
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

    const emptyState = initialSnapshotFor([lucie], { status: "READY" });
    const reduced = applyStateDelta(emptyState, applied.stateDelta!);
    expect(reduced.units[lucie.battleUnitId]!.effects).toHaveLength(1);
    expect(reduced.units[lucie.battleUnitId]!.effects![0]).toMatchObject({
      effectDefinitionId: hotDefinition.effectActionDefinitionId,
      duration: { unit: "ACTION", remaining: 2 },
    });
  });
});
