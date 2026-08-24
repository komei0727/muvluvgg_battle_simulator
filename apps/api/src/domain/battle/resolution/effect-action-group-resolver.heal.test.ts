import { describe, expect, it } from "vitest";
import { applyEffectActionGroups } from "./effect-action-group-resolver.js";
import type { EffectSequencePlan } from "../skill/skill-resolution-service.js";
import {
  createEffectActionDefinitionId,
  createTargetBindingId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { DamageResultRegistry } from "../skill/formula-evaluator.js";
import {
  unit,
  damageAction,
  contextFor,
  seedRecorder,
  singleActionStep,
} from "../../../testing/fixtures/effect-sequence-plan.js";

describe("applyEffectActionGroups", () => {
  describe("HEAL / APPLY_HEALING_MOD / APPLY_CONTINUOUS_HEAL (R-HEAL-01〜03, M7-005 Issue #184)", () => {
    function healAction(
      id: string,
      payload: Extract<EffectActionDefinition, { kind: "HEAL" }>["payload"],
    ): EffectActionDefinition {
      return {
        kind: "HEAL",
        effectActionDefinitionId: createEffectActionDefinitionId(id),
        metadata: { tags: [] },
        payload,
      };
    }

    function healingModAction(
      id: string,
      payload: Extract<EffectActionDefinition, { kind: "APPLY_HEALING_MOD" }>["payload"],
    ): EffectActionDefinition {
      return {
        kind: "APPLY_HEALING_MOD",
        effectActionDefinitionId: createEffectActionDefinitionId(id),
        metadata: { tags: [] },
        payload,
      };
    }

    function continuousHealAction(
      id: string,
      payload: Extract<EffectActionDefinition, { kind: "APPLY_CONTINUOUS_HEAL" }>["payload"],
    ): EffectActionDefinition {
      return {
        kind: "APPLY_CONTINUOUS_HEAL",
        effectActionDefinitionId: createEffectActionDefinitionId(id),
        metadata: { tags: [] },
        payload,
      };
    }

    function healingLinkAction(id: string, transferRate = 1): EffectActionDefinition {
      return {
        kind: "APPLY_HEALING_LINK",
        effectActionDefinitionId: createEffectActionDefinitionId(id),
        metadata: { tags: [] },
        payload: {
          transferTo: { kind: "SELF" },
          transferRate,
          duration: {
            timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
            dispellable: true,
            linkedEffectGroupId: null,
          },
        },
      };
    }

    it("UT-R-HEAL-01-007 (full stack): a HEAL EffectAction raises the target's HP and emits HealApplied through the real effect-action-group-resolver.ts wiring", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 50 });
      const heal = healAction("ACT_HEAL", {
        formula: { kind: "MAX_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.3 },
        overheal: "DISCARD",
        distribution: "NONE",
      });
      const effectActions = new Map([[heal.effectActionDefinitionId, heal]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, actor.battleUnitId, heal.effectActionDefinitionId)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      expect(result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentHp).toBe(80);
      const healApplied = recorder.getEvents().find((e) => e.eventType === "HealApplied")!;
      expect(healApplied.payload).toMatchObject({
        effectActionDefinitionId: heal.effectActionDefinitionId,
        targetUnitId: actor.battleUnitId,
        healAmount: 30,
        appliedAmount: 30,
      });
      expect(
        recorder.getEvents().find((e) => e.eventType === "EffectActionCompleted")!.payload
          .resultKind,
      ).toBe("APPLIED");
    });

    it("UT-R-HEAL-02-001 (full stack): an APPLY_HEALING_MOD grants an AppliedEffect whose magnitude is the evaluated signed rate", () => {
      const actor = unit("ACTOR", "ALLY");
      const mod = healingModAction("ACT_HEAL_UP", {
        direction: "INCOMING",
        formula: { kind: "CONSTANT", value: 0.15 },
        stacking: { mode: "STACKABLE" },
        duration: {
          timeLimit: { unit: "BATTLE", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      });
      const effectActions = new Map([[mod.effectActionDefinitionId, mod]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, actor.battleUnitId, mod.effectActionDefinitionId)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      const updated = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
      expect(updated.appliedEffects).toHaveLength(1);
      expect(updated.appliedEffects[0]).toMatchObject({
        effectActionDefinitionId: mod.effectActionDefinitionId,
        magnitude: 0.15,
        duplicate: true,
      });
    });

    it("UT-R-HEAL-04-004 (full stack, R-HEAL-04): an APPLY_HEALING_LINK grants an AppliedEffect whose healingLink resolves transferTo: SELF to the granter at grant time", () => {
      const actor = unit("ACTOR", "ALLY");
      const holder = unit("HOLDER", "ENEMY");
      const link = healingLinkAction("ACT_LINK");
      const effectActions = new Map([[link.effectActionDefinitionId, link]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, holder.battleUnitId, link.effectActionDefinitionId)],
        targetUnitIds: [holder.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor, holder], context);

      const updated = result.units.find((u) => u.battleUnitId === holder.battleUnitId)!;
      expect(updated.appliedEffects).toHaveLength(1);
      expect(updated.appliedEffects[0]).toMatchObject({
        effectActionDefinitionId: link.effectActionDefinitionId,
        duplicate: true,
        healingLink: { transferToUnitId: actor.battleUnitId, transferRate: 1 },
      });
      const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied")!;
      expect(applied.payload).toMatchObject({
        targetUnitId: holder.battleUnitId,
        sourceUnitId: actor.battleUnitId,
      });
      expect(
        recorder.getEvents().find((e) => e.eventType === "EffectActionCompleted")!.payload
          .resultKind,
      ).toBe("APPLIED");
    });

    function damageLinkAction(
      id: string,
      linkTo: Extract<EffectActionDefinition, { kind: "APPLY_DAMAGE_LINK" }>["payload"]["linkTo"],
      linkRate = 0.5,
      polarity: "BUFF" | "DEBUFF" = "DEBUFF",
    ): EffectActionDefinition {
      return {
        kind: "APPLY_DAMAGE_LINK",
        effectActionDefinitionId: createEffectActionDefinitionId(id),
        metadata: { tags: [] },
        payload: {
          linkTo,
          linkRate,
          polarity,
          duration: {
            timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
            dispellable: false,
            linkedEffectGroupId: null,
          },
        },
      };
    }

    it("UT-R-LNK-01-001 (full stack, R-LNK-01): an APPLY_DAMAGE_LINK grants an AppliedEffect whose damageLink resolves linkTo: SELF to the granter at grant time", () => {
      const actor = unit("ACTOR", "ALLY");
      const holder = unit("HOLDER", "ALLY");
      const link = damageLinkAction("ACT_LINK", { kind: "SELF" });
      const effectActions = new Map([[link.effectActionDefinitionId, link]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, holder.battleUnitId, link.effectActionDefinitionId)],
        targetUnitIds: [holder.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor, holder], context);

      const updated = result.units.find((u) => u.battleUnitId === holder.battleUnitId)!;
      expect(updated.appliedEffects).toHaveLength(1);
      expect(updated.appliedEffects[0]).toMatchObject({
        effectActionDefinitionId: link.effectActionDefinitionId,
        duplicate: true,
        damageLink: { linkToUnitId: actor.battleUnitId, linkRate: 0.5 },
      });
      // R-EFF-02/03: リンクは保持者の被弾を波及させる不利な状態のため`DEBUFF`。
      expect(updated.appliedEffects[0]!.categories).toContain("DEBUFF");
      expect(
        recorder.getEvents().find((e) => e.eventType === "EffectActionCompleted")!.payload
          .resultKind,
      ).toBe("APPLIED");
    });

    it("UT-R-LNK-01-002 (full stack, R-LNK-01): a BINDING linkTo resolves to the unit that binding selected, so a mutual link can name the other side", () => {
      const actor = unit("ACTOR", "ALLY");
      const nearest = unit("NEAREST", "ENEMY");
      const farthest = unit("FARTHEST", "ENEMY");
      const link = damageLinkAction(
        "ACT_LINK",
        { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_FARTHEST") },
        0.35,
      );
      const effectActions = new Map([[link.effectActionDefinitionId, link]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, nearest.battleUnitId, link.effectActionDefinitionId)],
        targetUnitIds: [nearest.battleUnitId],
        resolvedBindings: new Map([
          [createTargetBindingId("TGT_FARTHEST"), { units: [farthest], includeDefeated: false }],
        ]),
      };

      const result = applyEffectActionGroups(plan, [actor, nearest, farthest], context);

      const updated = result.units.find((u) => u.battleUnitId === nearest.battleUnitId)!;
      expect(updated.appliedEffects[0]).toMatchObject({
        damageLink: { linkToUnitId: farthest.battleUnitId, linkRate: 0.35 },
      });
    });

    it("UT-R-LNK-01-003 (full stack, R-LNK-01, NEGATIVE): a BINDING linkTo that resolved to no unit grants nothing and reports SKIPPED", () => {
      const actor = unit("ACTOR", "ALLY");
      const holder = unit("HOLDER", "ENEMY");
      const link = damageLinkAction("ACT_LINK", {
        kind: "BINDING",
        targetBindingId: createTargetBindingId("TGT_FARTHEST"),
      });
      const effectActions = new Map([[link.effectActionDefinitionId, link]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, holder.battleUnitId, link.effectActionDefinitionId)],
        targetUnitIds: [holder.battleUnitId],
        resolvedBindings: new Map([
          [createTargetBindingId("TGT_FARTHEST"), { units: [], includeDefeated: false }],
        ]),
      };

      const result = applyEffectActionGroups(plan, [actor, holder], context);

      expect(
        result.units.find((u) => u.battleUnitId === holder.battleUnitId)!.appliedEffects,
      ).toHaveLength(0);
      expect(
        recorder.getEvents().find((e) => e.eventType === "EffectActionCompleted")!.payload
          .resultKind,
      ).toBe("SKIPPED");
    });

    it("UT-R-HEAL-02-002 (full stack): the target's INCOMING healing modifiers scale the heal amount before truncation", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 10 });
      const mod = healingModAction("ACT_HEAL_UP", {
        direction: "INCOMING",
        formula: { kind: "CONSTANT", value: 0.15 },
        stacking: { mode: "STACKABLE" },
        duration: {
          timeLimit: { unit: "BATTLE", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      });
      const heal = healAction("ACT_HEAL", {
        formula: { kind: "MAX_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.3 },
        overheal: "DISCARD",
        distribution: "NONE",
      });
      const effectActions = new Map([
        [mod.effectActionDefinitionId, mod],
        [heal.effectActionDefinitionId, heal],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [
          singleActionStep(0, true, actor.battleUnitId, mod.effectActionDefinitionId),
          singleActionStep(1, true, actor.battleUnitId, heal.effectActionDefinitionId),
        ],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      // 30 * 1.15 = 34.5 -> truncated once, at application time, to 34
      expect(result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentHp).toBe(44);
      expect(
        recorder.getEvents().find((e) => e.eventType === "HealApplied")!.payload,
      ).toMatchObject({ healingModifierMultiplier: 1.15, healAmount: 34 });
    });

    it("UT-R-HEAL-02-003 (BOUNDARY): stacked negative healing modifiers below -100% clamp the multiplier at 0 instead of draining HP", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 10 });
      const block = healingModAction("ACT_HEAL_BLOCK", {
        direction: "INCOMING",
        formula: { kind: "CONSTANT", value: -1 },
        stacking: { mode: "STACKABLE" },
        duration: {
          timeLimit: { unit: "BATTLE", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      });
      const heal = healAction("ACT_HEAL", {
        formula: { kind: "MAX_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.3 },
        overheal: "DISCARD",
        distribution: "NONE",
      });
      const effectActions = new Map([
        [block.effectActionDefinitionId, block],
        [heal.effectActionDefinitionId, heal],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [
          singleActionStep(0, true, actor.battleUnitId, block.effectActionDefinitionId),
          singleActionStep(1, true, actor.battleUnitId, block.effectActionDefinitionId),
          singleActionStep(2, true, actor.battleUnitId, heal.effectActionDefinitionId),
        ],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      expect(result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentHp).toBe(10);
      expect(
        recorder.getEvents().find((e) => e.eventType === "HealApplied")!.payload,
      ).toMatchObject({ healingModifierMultiplier: 0, healAmount: 0 });
    });

    it("UT-R-HEAL-03-001 (full stack): an APPLY_CONTINUOUS_HEAL grants an AppliedEffect that keeps its duration and is not applied immediately", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 50 });
      const hot = continuousHealAction("ACT_HOT", {
        formula: { kind: "MAX_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.1 },
        timing: { eventType: "ActionStarted", targetSelector: "EFFECT_OWNER" },
        duration: {
          timeLimit: { unit: "ACTION", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      });
      const effectActions = new Map([[hot.effectActionDefinitionId, hot]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, actor.battleUnitId, hot.effectActionDefinitionId)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      const updated = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
      expect(updated.currentHp).toBe(50);
      expect(updated.appliedEffects).toHaveLength(1);
      expect(updated.appliedEffects[0]).toMatchObject({
        effectActionDefinitionId: hot.effectActionDefinitionId,
        duplicate: true,
      });
      expect(updated.appliedEffects[0]!.duration.timeLimitRemaining).toBe(2);
      expect(recorder.getEvents().some((e) => e.eventType === "HealApplied")).toBe(false);
    });

    it("UT-R-HEAL-01-008 (HEAL_DISTRIBUTE): distribution EVEN splits one total heal amount across every target of the same EffectAction in the step", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 10 });
      const ally = unit("ALLY_2", "ALLY", { currentHp: 10 });
      const heal = healAction("ACT_HEAL_SHARED", {
        formula: { kind: "SKILL_POWER", power: 3 },
        overheal: "DISCARD",
        distribution: "EVEN",
      });
      const effectActions = new Map([[heal.effectActionDefinitionId, heal]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const step = singleActionStep(0, true, actor.battleUnitId, heal.effectActionDefinitionId);
      if (step.planKind !== "ACTION_PLAN") {
        throw new Error("singleActionStep must produce an ACTION_PLAN");
      }
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [
          {
            ...step,
            applications: [
              ...step.applications,
              {
                targetUnitId: ally.battleUnitId,
                effectActionDefinitionId: heal.effectActionDefinitionId,
                includeDefeated: false,
                hits: [
                  {
                    targetUnitId: ally.battleUnitId,
                    effectActionDefinitionId: heal.effectActionDefinitionId,
                    hitIndex: 1,
                  },
                ],
              },
            ],
          },
        ],
        targetUnitIds: [actor.battleUnitId, ally.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor, ally], context);

      // attack 20 * power 3 = 60 total, split evenly across the 2 targets = 30 each
      expect(result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentHp).toBe(40);
      expect(result.units.find((u) => u.battleUnitId === ally.battleUnitId)!.currentHp).toBe(40);
      const healEvents = recorder.getEvents().filter((e) => e.eventType === "HealApplied");
      expect(healEvents).toHaveLength(2);
      expect(healEvents[0]!.payload).toMatchObject({
        formulaResult: 60,
        distributionShareCount: 2,
        healAmount: 30,
      });
    });
  });

  describe("HEAL_DISTRIBUTE denominator", () => {
    it("UT-R-HEAL-01-011 (BOUNDARY): a target that is already defeated when the distributing HEAL starts is excluded from the share count, so the surviving targets still receive the whole total", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 10 });
      // This ally is defeated before the step resolves (the same state a PS
      // chain triggered by EffectStepStarting would leave behind), so the HEAL
      // never applies to it and it must not consume a share of the total.
      const deadAlly = unit("ALLY_DEAD", "ALLY", { currentHp: 0 });
      const heal: EffectActionDefinition = {
        kind: "HEAL",
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_HEAL_SHARED"),
        metadata: { tags: [] },
        payload: {
          formula: { kind: "SKILL_POWER", power: 3 },
          overheal: "DISCARD",
          distribution: "EVEN",
        },
      };
      const effectActions = new Map([[heal.effectActionDefinitionId, heal]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const step = singleActionStep(0, true, actor.battleUnitId, heal.effectActionDefinitionId);
      if (step.planKind !== "ACTION_PLAN") {
        throw new Error("singleActionStep must produce an ACTION_PLAN");
      }
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [
          {
            ...step,
            applications: [
              ...step.applications,
              {
                targetUnitId: deadAlly.battleUnitId,
                effectActionDefinitionId: heal.effectActionDefinitionId,
                includeDefeated: false,
                hits: [
                  {
                    targetUnitId: deadAlly.battleUnitId,
                    effectActionDefinitionId: heal.effectActionDefinitionId,
                    hitIndex: 1,
                  },
                ],
              },
            ],
          },
        ],
        targetUnitIds: [actor.battleUnitId, deadAlly.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor, deadAlly], context);

      // attack 20 * power 3 = 60 total. Only one target actually receives the
      // heal, so it gets the whole 60 — not 30 with the other half lost.
      expect(result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentHp).toBe(70);
      expect(result.units.find((u) => u.battleUnitId === deadAlly.battleUnitId)!.currentHp).toBe(0);
      const healEvents = recorder.getEvents().filter((e) => e.eventType === "HealApplied");
      expect(healEvents).toHaveLength(1);
      expect(healEvents[0]!.payload).toMatchObject({
        formulaResult: 60,
        distributionShareCount: 1,
        healAmount: 60,
      });
    });
  });

  describe("HEAL_DISTRIBUTE denominator with includeDefeated", () => {
    it("UT-R-HEAL-01-012 (BOUNDARY): a defeated target selected with includeDefeated is still excluded from the share count, because R-HEAL-01 never heals it", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 10 });
      const deadAlly = unit("ALLY_DEAD", "ALLY", { currentHp: 0 });
      const heal: EffectActionDefinition = {
        kind: "HEAL",
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_HEAL_SHARED"),
        metadata: { tags: [] },
        payload: {
          formula: { kind: "SKILL_POWER", power: 3 },
          overheal: "DISCARD",
          distribution: "EVEN",
        },
      };
      const effectActions = new Map([[heal.effectActionDefinitionId, heal]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const step = singleActionStep(0, true, actor.battleUnitId, heal.effectActionDefinitionId);
      if (step.planKind !== "ACTION_PLAN") {
        throw new Error("singleActionStep must produce an ACTION_PLAN");
      }
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [
          {
            ...step,
            applications: [
              ...step.applications,
              {
                targetUnitId: deadAlly.battleUnitId,
                effectActionDefinitionId: heal.effectActionDefinitionId,
                // The selector explicitly admits defeated units, but a HEAL
                // still cannot heal them (no revival rule in R-HEAL-01).
                includeDefeated: true,
                hits: [
                  {
                    targetUnitId: deadAlly.battleUnitId,
                    effectActionDefinitionId: heal.effectActionDefinitionId,
                    hitIndex: 1,
                  },
                ],
              },
            ],
          },
        ],
        targetUnitIds: [actor.battleUnitId, deadAlly.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor, deadAlly], context);

      expect(result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentHp).toBe(70);
      expect(result.units.find((u) => u.battleUnitId === deadAlly.battleUnitId)!.currentHp).toBe(0);
      const healEvents = recorder.getEvents().filter((e) => e.eventType === "HealApplied");
      expect(healEvents).toHaveLength(1);
      expect(healEvents[0]!.payload).toMatchObject({
        distributionShareCount: 1,
        healAmount: 60,
      });
    });

    it("UT-R-HEAL-01-017: a step that references the same distributing HEAL twice splits one total per reference, so each target is healed once per reference", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 10 });
      const ally = unit("ALLY_2", "ALLY", { currentHp: 10 });
      const heal: EffectActionDefinition = {
        kind: "HEAL",
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_HEAL_SHARED"),
        metadata: { tags: [] },
        payload: {
          formula: { kind: "SKILL_POWER", power: 3 },
          overheal: "DISCARD",
          distribution: "EVEN",
        },
      };
      const effectActions = new Map([[heal.effectActionDefinitionId, heal]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const step = singleActionStep(0, true, actor.battleUnitId, heal.effectActionDefinitionId);
      if (step.planKind !== "ACTION_PLAN") {
        throw new Error("singleActionStep must produce an ACTION_PLAN");
      }
      const references = [
        { effectActionDefinitionId: heal.effectActionDefinitionId },
        { effectActionDefinitionId: heal.effectActionDefinitionId },
      ];
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [
          {
            ...step,
            actions: references,
            // `buildApplications`と同じ「対象ごとに`actions`を定義順で並べる」順序。
            applications: [actor, ally].flatMap((target) =>
              references.map((_, index) => ({
                targetUnitId: target.battleUnitId,
                effectActionDefinitionId: heal.effectActionDefinitionId,
                includeDefeated: false,
                hits: [
                  {
                    targetUnitId: target.battleUnitId,
                    effectActionDefinitionId: heal.effectActionDefinitionId,
                    hitIndex: index + 1,
                  },
                ],
              })),
            ),
          },
        ],
        targetUnitIds: [actor.battleUnitId, ally.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor, ally], context);

      // attack 20 * power 3 = 60 を参照ごとに2対象へ等分（各30）。対象は30を2回
      // 受け取り10 + 60 = 70になる。4 applicationを1つの分配として数えると
      // 各回15、合計40にしかならない。
      for (const target of [actor, ally]) {
        expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentHp).toBe(
          70,
        );
      }
      const healEvents = recorder.getEvents().filter((e) => e.eventType === "HealApplied");
      expect(healEvents).toHaveLength(4);
      for (const event of healEvents) {
        expect(event.payload).toMatchObject({ distributionShareCount: 2, healAmount: 30 });
      }
    });

    it("UT-R-SKL-08-020 (full stack, G-10/RES-003A Issue #257): a HEAL referencing SUM_DAMAGE_RECEIVED reads every DAMAGE result this EffectSequence inflicted on the healer itself — neither the healer's larger dealt sum nor its single most recent received result", () => {
      // 1ヒットあたり attack(20) - defense(10) = 10。
      // step0: 敵へ10（actorのdealt累計だけが増える）
      // step1/step2: 自傷10ずつ（actorのreceived累計が20、dealt累計は合計30になる）
      // step3: SUM_DAMAGE_RECEIVED(=20) × 1.0 を回復する。
      // dealt累計30・直前received 10のどちらとも異なる値になるため、この1つの
      // 期待値が「対象側への累積」と「Formulaへの配線」を同時に固定する。
      const actor = unit("ACTOR", "ALLY", { currentHp: 60 });
      const enemy = unit("ENEMY", "ENEMY");
      const attack = damageAction("ACT_ATTACK_ENEMY");
      const selfDamage = damageAction("ACT_SELF_DAMAGE");
      const heal: EffectActionDefinition = {
        kind: "HEAL",
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_HEAL_BY_RECEIVED"),
        metadata: { tags: [] },
        payload: {
          formula: { kind: "DAMAGE_RECEIVED_RATIO", sourceResult: "SUM_DAMAGE_RECEIVED", ratio: 1 },
          overheal: "DISCARD",
          distribution: "NONE",
        },
      };
      const effectActions = new Map([
        [attack.effectActionDefinitionId, attack],
        [selfDamage.effectActionDefinitionId, selfDamage],
        [heal.effectActionDefinitionId, heal],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const damageResults: DamageResultRegistry = new Map();
      const context = {
        ...contextFor(actor, effectActions, recorder, rootEventId),
        damageResults,
      };
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [
          singleActionStep(0, true, enemy.battleUnitId, attack.effectActionDefinitionId),
          singleActionStep(1, true, actor.battleUnitId, selfDamage.effectActionDefinitionId),
          singleActionStep(2, true, actor.battleUnitId, selfDamage.effectActionDefinitionId),
          singleActionStep(3, true, actor.battleUnitId, heal.effectActionDefinitionId),
        ],
        targetUnitIds: [enemy.battleUnitId, actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor, enemy], context);

      // 60 - 10 - 10 (自傷2回) + 20 (SUM_DAMAGE_RECEIVED回復) = 60。
      expect(result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentHp).toBe(60);
      const healApplied = recorder.getEvents().find((e) => e.eventType === "HealApplied")!;
      expect(healApplied.payload).toMatchObject({
        effectActionDefinitionId: heal.effectActionDefinitionId,
        targetUnitId: actor.battleUnitId,
        formulaResult: 20,
        healAmount: 20,
        appliedAmount: 20,
      });
      // 実executorが与ダメージ側と被ダメージ側を同じEffectSequence解決へ
      // 独立に累積していることを、registry側からも固定する。
      const actorEntry = damageResults.get(actor.battleUnitId);
      expect(actorEntry?.sumDamageReceived?.get(context.skillUseId)).toBe(20);
      expect(actorEntry?.sumDamageDealt?.get(context.skillUseId)).toBe(30);
      expect(actorEntry?.lastDamageReceived).toBe(10);
    });
  });
});
