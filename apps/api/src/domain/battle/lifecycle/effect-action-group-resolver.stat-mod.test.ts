import { describe, expect, it } from "vitest";
import {
  applyEffectActionGroups,
  type EffectActionGroupContext,
  type EffectActionGroupsResult,
} from "./effect-action-group-resolver.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { EffectSequencePlan } from "../skill/skill-resolution-service.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { createEffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import {
  unit,
  damageAction,
  statModAction,
  contextFor,
  seedRecorder,
  singleActionStep,
  expectCompleted,
} from "../../../testing/fixtures/effect-sequence-plan.js";

describe("applyEffectActionGroups", () => {
  it("UT-R-EFF-01-021 (R-EFF-01, real lifecycle wiring): an APPLY_STAT_MOD ACTION step grants an AppliedEffect through the real Catalog -> EffectSequence -> AppliedEffect -> event pipeline, emitting EffectApplied before EffectActionCompleted(APPLIED)", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const statMod = statModAction("ACT_ATK_UP");
    const effectActions = new Map([[statMod.effectActionDefinitionId, statMod]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, statMod.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const before = recorder.getEvents().length;
    const result = applyEffectActionGroups(plan, [actor, enemy], context);
    const emitted = recorder
      .getEvents()
      .slice(before)
      .map((e) => e.eventType);

    expect(emitted).toEqual([
      "EffectStepStarting",
      "EffectActionStarting",
      "EffectApplied",
      "CombatStatChanged",
      "EffectActionCompleted",
      "EffectStepCompleted",
    ]);
    expectCompleted(result, 1);

    const grantedTarget = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(grantedTarget.appliedEffects).toHaveLength(1);
    expect(grantedTarget.appliedEffects[0]).toMatchObject({
      effectActionDefinitionId: statMod.effectActionDefinitionId,
      sourceUnitId: actor.battleUnitId,
      targetUnitId: enemy.battleUnitId,
      duplicate: true,
      magnitude: 20,
      appliedTurnNumber: 1,
    });

    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied") as Extract<
      BattleDomainEvent,
      { eventType: "EffectApplied" }
    >;
    expect(applied.payload.effectInstanceId).toBe(
      grantedTarget.appliedEffects[0]!.effectInstanceId,
    );

    const combatStatChanged = recorder
      .getEvents()
      .find((e) => e.eventType === "CombatStatChanged") as Extract<
      BattleDomainEvent,
      { eventType: "CombatStatChanged" }
    >;
    expect(combatStatChanged.payload).toMatchObject({
      battleUnitId: enemy.battleUnitId,
      stat: "ATTACK",
      before: 20,
      after: 40,
      reason: "EFFECT_APPLIED",
    });
    expect(combatStatChanged.parentEventId).toBe(applied.eventId);

    const completed = recorder
      .getEvents()
      .find((e) => e.eventType === "EffectActionCompleted") as Extract<
      BattleDomainEvent,
      { eventType: "EffectActionCompleted" }
    >;
    expect(completed.payload.resultKind).toBe("APPLIED");
    expect(completed.parentEventId).toBe(combatStatChanged.eventId);
  });

  it("UT-R-EFF-01-022 (R-EFF-01, mirrors the R-SKL-06 FACT/TIMING case): onFactEventForPassiveChain is invoked for the EffectApplied event an APPLY_STAT_MOD grant records, not just DAMAGE/COOLDOWN_MANIPULATION's own hit-unit events", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const statMod = statModAction("ACT_ATK_UP");
    const effectActions = new Map([[statMod.effectActionDefinitionId, statMod]]);
    const { recorder, rootEventId } = seedRecorder();
    const observedEventTypes: string[] = [];
    const context = contextFor(actor, effectActions, recorder, rootEventId, (event, units) => {
      observedEventTypes.push(event.eventType);
      return units;
    });
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, statMod.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    applyEffectActionGroups(plan, [actor, enemy], context);

    expect(observedEventTypes).toContain("EffectApplied");
  });

  it("UT-R-NUM-04-027 (real lifecycle wiring): an APPLY_STAT_MOD formula can use any FormulaKind now that the general FormulaEvaluator is wired in, not just CONSTANT", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const statMod: EffectActionDefinition = {
      kind: "APPLY_STAT_MOD",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATK_UP_RATIO"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        stat: "ATTACK",
        valueType: "FIXED",
        formula: {
          kind: "STAT_RATIO",
          source: { kind: "SKILL_SOURCE" },
          stat: "ATTACK",
          ratio: 0.5,
        },
        stacking: { mode: "STACKABLE", max: null },
        duration: {
          timeLimit: { unit: "TURN", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[statMod.effectActionDefinitionId, statMod]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, statMod.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    // actor.combatStats.attack = 20; STAT_RATIO(SKILL_SOURCE, ATTACK, 0.5) = 10.
    const grantedTarget = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(grantedTarget.appliedEffects[0]).toMatchObject({ magnitude: 10 });
  });

  it("UT-CAP-TRIGGER-CONTEXT-009 (RES-005): a TRIGGER_TARGET Formula reads the unit's CURRENT state at evaluation time, not a stale snapshot from when the PS activated", () => {
    const actor = unit("ACTOR", "ALLY");
    // `defense: 0` so `SKILL_POWER power: 1` damage equals the attacker's
    // attack (20) exactly, with no rounding ambiguity.
    const triggerTarget = unit("TRIGGER_TARGET_UNIT", "ENEMY", {
      combatStats: {
        maximumHp: 100,
        attack: 20,
        defense: 0,
        criticalRate: 0,
        actionSpeed: 10,
        criticalDamageBonus: 0.5,
        affinityBonus: 0,
      },
    });
    const attack = damageAction("ACT_ATTACK");
    // Reads `TRIGGER_TARGET`'s CURRENT_HP_RATIO (ratio 1 => just currentHp) —
    // if the step below evaluates this using a `BattleUnit` snapshot resolved
    // once when the PS activated (before the DAMAGE step reduced its HP),
    // this reads the pre-damage 100. If it correctly re-resolves the current
    // `box.units` state at Formula-evaluation time, it reads the post-damage
    // 80 (100 - 20 attack, 0 defense).
    const hpRatioStatMod: EffectActionDefinition = {
      kind: "APPLY_STAT_MOD",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_HP_RATIO_BUFF"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        stat: "ATTACK",
        valueType: "FIXED",
        formula: { kind: "CURRENT_HP_RATIO", source: { kind: "TRIGGER_TARGET" }, ratio: 1 },
        stacking: { mode: "STACKABLE", max: null },
        duration: {
          timeLimit: { unit: "TURN", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([
      [attack.effectActionDefinitionId, attack],
      [hpRatioStatMod.effectActionDefinitionId, hpRatioStatMod],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context: EffectActionGroupContext = {
      ...contextFor(actor, effectActions, recorder, rootEventId),
      triggerTargetUnitIds: [triggerTarget.battleUnitId],
    };
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        // Step 0: DAMAGE reduces triggerTarget's HP from 100 to 80.
        singleActionStep(0, true, triggerTarget.battleUnitId, attack.effectActionDefinitionId),
        // Step 1: APPLY_STAT_MOD on the actor, magnitude = triggerTarget's
        // CURRENT HP (post-step-0) via TRIGGER_TARGET.
        singleActionStep(1, true, actor.battleUnitId, hpRatioStatMod.effectActionDefinitionId),
      ],
      targetUnitIds: [triggerTarget.battleUnitId, actor.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, triggerTarget], context);

    const updatedActor = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(updatedActor.appliedEffects[0]).toMatchObject({ magnitude: 80 });
  });
});

/**
 * M7-012（Issue #266、R-EFF-05／`STACK_LIMIT_ON_STAT_MOD`）: `APPLY_STAT_MOD`の
 * 重複なし（`NON_STACKABLE`）表現と重複上限（`stacking.max`）の実ライフサイクル配線。
 * それまで`stacking.mode`は`STACKABLE`しかCatalogスキーマに存在せず、resolverも
 * `duplicate: true`固定で付与していたため、重複なし経路・最強選択・
 * `EffectiveEffectChanged`のいずれにも実ライフサイクルから到達できなかった。
 */
describe("applyEffectActionGroups: R-EFF-05 stacking mode and stack limit (M7-012, Issue #266)", () => {
  function ratioStatMod(
    id: string,
    value: number,
    stacking: { mode: "STACKABLE" | "NON_STACKABLE"; max: number | null },
  ): EffectActionDefinition {
    return {
      kind: "APPLY_STAT_MOD",
      effectActionDefinitionId: createEffectActionDefinitionId(id),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        stat: "ATTACK",
        valueType: "FIXED",
        formula: { kind: "CONSTANT", value },
        stacking,
        duration: {
          timeLimit: { unit: "BATTLE", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
  }

  /**
   * `recalculateCombatStats`は`context.definitions.effectActions`から各
   * `AppliedEffect`の定義を引くため、既に付与済みの効果の定義も併せて渡す
   * （`known`）。渡さないと過去に付与した効果がCombatStat合成から黙って
   * 落ちてしまい、テスト自身の前提が崩れる。
   */
  function applyOnce(
    definition: EffectActionDefinition,
    units: readonly BattleUnit[],
    actor: BattleUnit,
    recorder: EventRecorder,
    rootEventId: string,
    known: readonly EffectActionDefinition[] = [],
  ): EffectActionGroupsResult {
    const effectActions = new Map(
      [...known, definition].map((d) => [d.effectActionDefinitionId, d]),
    );
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, actor.battleUnitId, definition.effectActionDefinitionId)],
      targetUnitIds: [actor.battleUnitId],
      resolvedBindings: new Map(),
    };
    return applyEffectActionGroups(
      plan,
      units,
      contextFor(actor, effectActions, recorder, rootEventId),
    );
  }

  it("UT-R-EFF-05-017 (real lifecycle wiring): a NON_STACKABLE APPLY_STAT_MOD is granted with duplicate: false, so only the strongest instance feeds CombatStat", () => {
    const actor = unit("ACTOR", "ALLY");
    const { recorder, rootEventId } = seedRecorder();
    const weak = ratioStatMod("ACT_ATK_UP_WEAK", 20, { mode: "NON_STACKABLE", max: null });

    const first = applyOnce(weak, [actor], actor, recorder, rootEventId);
    const afterFirst = first.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(afterFirst.appliedEffects).toHaveLength(1);
    expect(afterFirst.appliedEffects[0]!.duplicate).toBe(false);
    expect(afterFirst.combatStats.attack).toBe(actor.baseCombatStats.attack + 20);

    // 同じ`EffectKindKey`の2件目（同じ効果量）は保持されるが（R-EFF-05第2項
    // 「重複なし効果も、既存効果を上書きせず個別に保持する」）、計算へ採用される
    // のは最強1件だけなので攻撃力は増えない — `STACKABLE`なら+40になる。
    const second = applyOnce(weak, first.units, actor, recorder, rootEventId);
    const afterSecond = second.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(afterSecond.appliedEffects).toHaveLength(2);
    expect(afterSecond.combatStats.attack).toBe(actor.baseCombatStats.attack + 20);
  });

  it("UT-R-EFF-05-018 (real lifecycle wiring): a stronger NON_STACKABLE instance displaces the previous winner, emitting EffectiveEffectChanged before CombatStatChanged", () => {
    const actor = unit("ACTOR", "ALLY");
    const { recorder, rootEventId } = seedRecorder();
    // 同じ`EffectKindKey`（＝同じ`EffectActionDefinitionId`）でなければ同種
    // グループにならないため、効果量だけをFormulaで差し替えた同一IDの定義を使う。
    const weak = ratioStatMod("ACT_ATK_UP", 20, { mode: "NON_STACKABLE", max: null });
    const strong = ratioStatMod("ACT_ATK_UP", 50, { mode: "NON_STACKABLE", max: null });

    const first = applyOnce(weak, [actor], actor, recorder, rootEventId);
    const before = recorder.getEvents().length;
    const second = applyOnce(strong, first.units, actor, recorder, rootEventId);

    const emitted = recorder
      .getEvents()
      .slice(before)
      .map((e) => e.eventType);
    expect(emitted).toContain("EffectiveEffectChanged");
    expect(emitted.indexOf("EffectiveEffectChanged")).toBeLessThan(
      emitted.indexOf("CombatStatChanged"),
    );

    const changed = recorder
      .getEvents()
      .slice(before)
      .find((e) => e.eventType === "EffectiveEffectChanged") as Extract<
      BattleDomainEvent,
      { eventType: "EffectiveEffectChanged" }
    >;
    const winner = first.units.find((u) => u.battleUnitId === actor.battleUnitId)!
      .appliedEffects[0]!.effectInstanceId;
    expect(changed.payload).toMatchObject({
      battleUnitId: actor.battleUnitId,
      kindKey: "ACT_ATK_UP",
      before: winner,
    });

    const afterSecond = second.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(afterSecond.combatStats.attack).toBe(actor.baseCombatStats.attack + 50);
  });

  it("UT-R-EFF-05-019 (real lifecycle wiring, 重複上限): a grant at stacking.max adds no instance and completes as SKIPPED without EffectApplied", () => {
    const actor = unit("ACTOR", "ALLY");
    const { recorder, rootEventId } = seedRecorder();
    const capped = ratioStatMod("ACT_ATK_UP_CAPPED", 20, { mode: "STACKABLE", max: 2 });

    let units: readonly BattleUnit[] = [actor];
    for (const expectedCount of [1, 2]) {
      units = applyOnce(capped, units, actor, recorder, rootEventId).units;
      expect(units.find((u) => u.battleUnitId === actor.battleUnitId)!.appliedEffects).toHaveLength(
        expectedCount,
      );
    }

    const before = recorder.getEvents().length;
    const third = applyOnce(capped, units, actor, recorder, rootEventId);
    const emitted = recorder
      .getEvents()
      .slice(before)
      .map((e) => e.eventType);

    expect(emitted).toEqual([
      "EffectStepStarting",
      "EffectActionStarting",
      "EffectActionCompleted",
      "EffectStepCompleted",
    ]);
    const completed = recorder
      .getEvents()
      .slice(before)
      .find((e) => e.eventType === "EffectActionCompleted") as Extract<
      BattleDomainEvent,
      { eventType: "EffectActionCompleted" }
    >;
    expect(completed.payload.resultKind).toBe("SKIPPED");
    expectCompleted(third, 1);

    const afterThird = third.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(afterThird.appliedEffects).toHaveLength(2);
    expect(afterThird.combatStats.attack).toBe(actor.baseCombatStats.attack + 40);
  });

  it("UT-R-EFF-05-020 (boundary): instances of another definition never consume this definition's stacking.max", () => {
    const actor = unit("ACTOR", "ALLY");
    const { recorder, rootEventId } = seedRecorder();
    const other = ratioStatMod("ACT_ATK_UP_OTHER", 20, { mode: "STACKABLE", max: null });
    const capped = ratioStatMod("ACT_ATK_UP_CAPPED", 20, { mode: "STACKABLE", max: 1 });

    const withOther = applyOnce(other, [actor], actor, recorder, rootEventId);
    const withCapped = applyOnce(capped, withOther.units, actor, recorder, rootEventId, [other]);

    const target = withCapped.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(2);
    expect(target.combatStats.attack).toBe(actor.baseCombatStats.attack + 40);
  });
});
