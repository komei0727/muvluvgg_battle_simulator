import { describe, expect, it } from "vitest";
import { applyEffectActionGroups } from "./effect-action-group-resolver.js";
import type { BattleUnit } from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import type { EffectSequencePlan } from "../skill/skill-resolution-service.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import { createEffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import {
  unit,
  contextFor,
  seedRecorder,
  singleActionStep,
} from "../../../testing/fixtures/effect-sequence-plan.js";

describe("applyEffectActionGroups", () => {
  describe("MODIFY_RESOURCE (R-ACTN-02, M7-002 Issue #185, HP_DIRECT_COST full-stack wiring)", () => {
    function modifyResourceAction(
      id: string,
      payload: Extract<EffectActionDefinition, { kind: "MODIFY_RESOURCE" }>["payload"],
    ): EffectActionDefinition {
      return {
        kind: "MODIFY_RESOURCE",
        effectActionDefinitionId: createEffectActionDefinitionId(id),
        requiredCapabilities: [],
        metadata: { tags: [] },
        payload,
      };
    }

    it("UT-R-ACTN-02-008 (full stack): a self-targeted MODIFY_RESOURCE(resource: HP, ADD, MAX_HP_RATIO -10%) reduces the actor's own HP through the real effect-action-group-resolver.ts wiring, recording ResourceChanged(reason: EFFECT_ACTION)", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 100 });
      const cost = modifyResourceAction("ACT_HP_COST", {
        resource: "HP",
        operation: "ADD",
        formula: { kind: "MAX_HP_RATIO", source: { kind: "SKILL_SOURCE" }, ratio: -0.1 },
      });
      const effectActions = new Map([[cost.effectActionDefinitionId, cost]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, actor.battleUnitId, cost.effectActionDefinitionId)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      const updatedActor = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
      expect(updatedActor.currentHp).toBe(90);

      const resourceChanged = recorder.getEvents().find((e) => e.eventType === "ResourceChanged")!;
      expect(resourceChanged.payload).toMatchObject({
        battleUnitId: actor.battleUnitId,
        resource: "HP",
        before: 100,
        after: 90,
        delta: -10,
        baseDelta: -10,
        reason: "EFFECT_ACTION",
      });
      expect(resourceChanged.stateDelta).toEqual({
        units: { [actor.battleUnitId]: { hp: { before: 100, after: 90 } } },
      });
    });

    it("UT-R-ACTN-02-019 (full stack, DISTRIBUTE): one total EX amount is split evenly across every target of the same EffectAction in the step instead of granting each target the full amount", () => {
      const actor = unit("ACTOR", "ALLY");
      const ally = unit("ALLY_2", "ALLY");
      const distribute = modifyResourceAction("ACT_EX_DISTRIBUTE", {
        resource: "EX_GAUGE",
        operation: "DISTRIBUTE",
        formula: { kind: "CONSTANT", value: 8 },
        bounds: { min: 0, max: "CURRENT_MAX" },
      });
      const effectActions = new Map([[distribute.effectActionDefinitionId, distribute]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan = distributePlan(actor, ally, distribute, false);

      const result = applyEffectActionGroups(plan, [actor, ally], context);

      for (const target of [actor, ally]) {
        expect(
          result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentExtraGauge,
        ).toBe(4);
      }
      const changes = recorder.getEvents().filter((e) => e.eventType === "ResourceChanged");
      expect(changes).toHaveLength(2);
      expect(changes[0]!.stateDelta).toEqual({
        units: { [actor.battleUnitId]: { extraGauge: { before: 0, after: 4 } } },
      });
    });

    it("UT-R-ACTN-02-020 (BOUNDARY): a target that is already defeated when the distributing MODIFY_RESOURCE starts is excluded from the share count, so the surviving target still receives the whole total", () => {
      const actor = unit("ACTOR", "ALLY");
      // The EffectStepStarting chain can leave a planned target defeated. The
      // EffectAction is then SKIPPED for it, so it must not consume a share.
      const deadAlly = unit("ALLY_DEAD", "ALLY", { currentHp: 0 });
      const distribute = modifyResourceAction("ACT_EX_DISTRIBUTE", {
        resource: "EX_GAUGE",
        operation: "DISTRIBUTE",
        formula: { kind: "CONSTANT", value: 8 },
        bounds: { min: 0, max: "CURRENT_MAX" },
      });
      const effectActions = new Map([[distribute.effectActionDefinitionId, distribute]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan = distributePlan(actor, deadAlly, distribute, false);

      const result = applyEffectActionGroups(plan, [actor, deadAlly], context);

      expect(
        result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentExtraGauge,
      ).toBe(8);
      expect(
        result.units.find((u) => u.battleUnitId === deadAlly.battleUnitId)!.currentExtraGauge,
      ).toBe(0);
      expect(recorder.getEvents().filter((e) => e.eventType === "ResourceChanged")).toHaveLength(1);
    });

    it("UT-R-ACTN-02-021 (BOUNDARY): a defeated target selected with includeDefeated stays in the share count, because unlike HEAL a MODIFY_RESOURCE really does apply to it", () => {
      const actor = unit("ACTOR", "ALLY");
      const deadAlly = unit("ALLY_DEAD", "ALLY", { currentHp: 0 });
      const distribute = modifyResourceAction("ACT_EX_DISTRIBUTE", {
        resource: "EX_GAUGE",
        operation: "DISTRIBUTE",
        formula: { kind: "CONSTANT", value: 8 },
        bounds: { min: 0, max: "CURRENT_MAX" },
      });
      const effectActions = new Map([[distribute.effectActionDefinitionId, distribute]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan = distributePlan(actor, deadAlly, distribute, true);

      const result = applyEffectActionGroups(plan, [actor, deadAlly], context);

      // Both targets receive a share, so the total really is divided by 2.
      expect(
        result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentExtraGauge,
      ).toBe(4);
      expect(
        result.units.find((u) => u.battleUnitId === deadAlly.battleUnitId)!.currentExtraGauge,
      ).toBe(4);
      expect(recorder.getEvents().filter((e) => e.eventType === "ResourceChanged")).toHaveLength(2);
    });

    it("UT-R-ACTN-02-022: a step that references the same DISTRIBUTE EffectAction twice distributes one total per reference, not one total shared by both references", () => {
      const actor = unit("ACTOR", "ALLY");
      const ally = unit("ALLY_2", "ALLY");
      const distribute = modifyResourceAction("ACT_EX_DISTRIBUTE", {
        resource: "EX_GAUGE",
        operation: "DISTRIBUTE",
        formula: { kind: "CONSTANT", value: 8 },
        bounds: { min: 0, max: "CURRENT_MAX" },
      });
      const effectActions = new Map([[distribute.effectActionDefinitionId, distribute]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan = distributePlan(actor, ally, distribute, false, 2);

      const result = applyEffectActionGroups(plan, [actor, ally], context);

      // R-SKL-06 #4: 各`EffectActionReference`は独立して適用される。参照ごとに
      // 総量8を対象2体へ等分（各4）するため、対象は4を2回受け取り+8になる。
      // 4 application全体を1つの分配として数えると各対象+4にしかならない。
      for (const target of [actor, ally]) {
        expect(
          result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentExtraGauge,
        ).toBe(8);
      }
      expect(recorder.getEvents().filter((e) => e.eventType === "ResourceChanged")).toHaveLength(4);
    });

    /**
     * 1つのACTION stepで、同じEffectActionを`referenceCount`回参照し、
     * actorとotherの2対象へ適用する計画。`skill-resolution-service.ts`の
     * `buildApplications`と同じ「対象ごとに`actions`を定義順で並べる」順序で
     * applicationを並べる。
     */
    function distributePlan(
      actor: BattleUnit,
      other: BattleUnit,
      action: EffectActionDefinition,
      includeDefeated: boolean,
      referenceCount = 1,
    ): EffectSequencePlan {
      const step = singleActionStep(0, true, actor.battleUnitId, action.effectActionDefinitionId);
      if (step.planKind !== "ACTION_PLAN") {
        throw new Error("singleActionStep must produce an ACTION_PLAN");
      }
      const applicationFor = (
        target: BattleUnit,
        hitIndex: number,
      ): (typeof step.applications)[number] => ({
        targetBattleUnitId: target.battleUnitId,
        effectActionDefinitionId: action.effectActionDefinitionId,
        includeDefeated: target.battleUnitId === actor.battleUnitId ? false : includeDefeated,
        hits: [
          {
            targetBattleUnitId: target.battleUnitId,
            effectActionDefinitionId: action.effectActionDefinitionId,
            hitIndex,
          },
        ],
      });
      const references = Array.from({ length: referenceCount }, () => ({
        effectActionDefinitionId: action.effectActionDefinitionId,
      }));
      return {
        stealthConsumptions: [],
        steps: [
          {
            ...step,
            actions: references,
            applications: [actor, other].flatMap((target) =>
              references.map((_, index) => applicationFor(target, index + 1)),
            ),
          },
        ],
        targetUnitIds: [actor.battleUnitId, other.battleUnitId],
        resolvedBindings: new Map(),
      };
    }
  });

  describe("APPLY_RESOURCE_GAIN_MOD (G-05, M7-002 Issue #185, RESOURCE_GAIN_MOD full-stack wiring)", () => {
    function resourceGainModAction(
      id: string,
      payload: Extract<EffectActionDefinition, { kind: "APPLY_RESOURCE_GAIN_MOD" }>["payload"],
    ): EffectActionDefinition {
      return {
        kind: "APPLY_RESOURCE_GAIN_MOD",
        effectActionDefinitionId: createEffectActionDefinitionId(id),
        requiredCapabilities: [],
        metadata: { tags: [] },
        payload,
      };
    }

    it("UT-R-ACT-04-013 (full stack): a self-targeted APPLY_RESOURCE_GAIN_MOD(EX_GAUGE, +50%) grants an AppliedEffect with the evaluated rateDelta as magnitude, through the real effect-action-group-resolver.ts wiring", () => {
      const actor = unit("ACTOR", "ALLY");
      const buff = resourceGainModAction("ACT_EX_GAIN_BUFF", {
        resource: "EX_GAUGE",
        rateDelta: { kind: "CONSTANT", value: 0.5 },
        stacking: { mode: "STACKABLE" },
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      });
      const effectActions = new Map([[buff.effectActionDefinitionId, buff]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, actor.battleUnitId, buff.effectActionDefinitionId)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      const updatedActor = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
      expect(updatedActor.appliedEffects).toHaveLength(1);
      expect(updatedActor.appliedEffects[0]).toMatchObject({
        effectActionDefinitionId: buff.effectActionDefinitionId,
        magnitude: 0.5,
        duplicate: true,
      });
      expect(recorder.getEvents().some((e) => e.eventType === "EffectApplied")).toBe(true);
    });
  });

  describe("MODIFY_RESOURCE_CAPACITY (G-09, M7-002A Issue #255, CAP_RESOURCE_CAPACITY_MOD full-stack wiring)", () => {
    function capacityAction(
      id: string,
      payload: Extract<EffectActionDefinition, { kind: "MODIFY_RESOURCE_CAPACITY" }>["payload"],
    ): EffectActionDefinition {
      return {
        kind: "MODIFY_RESOURCE_CAPACITY",
        effectActionDefinitionId: createEffectActionDefinitionId(id),
        requiredCapabilities: [],
        metadata: { tags: [] },
        payload,
      };
    }

    // `ACT_FLUTE_VAMPIRE_PS1_MAX_AP_UP`と同じ形（`resource: AP` / `operation: ADD` /
    // 戦闘中恒久＝`timeLimit: {unit: BATTLE, count: 1}`）。
    const MAX_AP_UP: Extract<
      EffectActionDefinition,
      { kind: "MODIFY_RESOURCE_CAPACITY" }
    >["payload"] = {
      resource: "AP",
      operation: "ADD",
      formula: { kind: "CONSTANT", value: 1 },
      duration: {
        dispellable: false,
        linkedEffectGroupId: null,
        timeLimit: { unit: "BATTLE", count: 1 },
      },
    };

    it("UT-R-ACTN-03-015 (full stack): a self-targeted MODIFY_RESOURCE_CAPACITY(AP, ADD +1) grants an AppliedEffect and raises maximumAp through the real resolver wiring, emitting ResourceCapacityChanged", () => {
      const actor = unit("ACTOR", "ALLY");
      const buff = capacityAction("ACT_MAX_AP_UP", MAX_AP_UP);
      const effectActions = new Map([[buff.effectActionDefinitionId, buff]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, actor.battleUnitId, buff.effectActionDefinitionId)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      const updatedActor = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
      expect(updatedActor.appliedEffects).toHaveLength(1);
      expect(updatedActor.appliedEffects[0]).toMatchObject({
        effectActionDefinitionId: buff.effectActionDefinitionId,
        magnitude: 1,
        duplicate: true,
      });
      expect(updatedActor.maximumAp).toBe(actor.baseMaximumAp + 1);
      expect(updatedActor.baseMaximumAp).toBe(actor.baseMaximumAp);
      // 上限が上がっただけでは現在値は追随しない（R-ACT-04）。
      expect(updatedActor.currentAp).toBe(actor.currentAp);
      const capacityEvents = recorder
        .getEvents()
        .filter((e) => e.eventType === "ResourceCapacityChanged");
      expect(capacityEvents).toHaveLength(1);
      expect(capacityEvents[0]!.payload).toMatchObject({
        battleUnitId: actor.battleUnitId,
        resource: "AP",
        before: actor.baseMaximumAp,
        after: actor.baseMaximumAp + 1,
        reason: "EFFECT_APPLIED",
      });
      expect(recorder.getEvents().some((e) => e.eventType === "EffectApplied")).toBe(true);
    });

    it("UT-R-ACTN-03-016 (negative): a blocking EFFECT_IMMUNITY rejects the capacity change, leaving maximumAp at the base", () => {
      const buff = capacityAction("ACT_MAX_AP_UP", MAX_AP_UP);
      const immunityDefinitionId = createEffectActionDefinitionId("ACT_BUFF_IMMUNITY");
      const immunity: AppliedEffect = {
        effectInstanceId: createEffectInstanceId("ei-immunity-capacity"),
        effectActionDefinitionId: immunityDefinitionId,
        kindKey: effectKindKeyFromDefinitionId(immunityDefinitionId),
        duplicate: true,
        sourceId: createBattleUnitId("ACTOR"),
        targetId: createBattleUnitId("ACTOR"),
        magnitude: 0,
        categories: ["BUFF"],
        immunity: { categories: ["BUFF"], maxBlocks: null, blockedCount: 0 },
        duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
        appliedTurnNumber: 1,
      };
      const actor = unit("ACTOR", "ALLY", { appliedEffects: [immunity] });
      const effectActions = new Map([[buff.effectActionDefinitionId, buff]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, actor.battleUnitId, buff.effectActionDefinitionId)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      const updatedActor = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
      expect(updatedActor.maximumAp).toBe(actor.baseMaximumAp);
      expect(recorder.getEvents().some((e) => e.eventType === "EffectApplicationRejected")).toBe(
        true,
      );
      expect(
        recorder.getEvents().filter((e) => e.eventType === "ResourceCapacityChanged"),
      ).toHaveLength(0);
    });
  });
});
