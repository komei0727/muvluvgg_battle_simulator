import { describe, expect, it } from "vitest";
import {
  applyEffectActionGroups,
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
  contextFor,
  seedRecorder,
  singleActionStep,
} from "../../../testing/fixtures/effect-sequence-plan.js";

describe("APPLY_CONTINUOUS_DAMAGE (R-DOT-01〜04, DMG-008 Issue #189)", () => {
  function continuousDamage(
    id: string,
    continuousDamageKind: "FIXED" | "BURN" | "POISON",
    ratio: number,
    durationCount = 3,
  ): EffectActionDefinition {
    return {
      kind: "APPLY_CONTINUOUS_DAMAGE",
      effectActionDefinitionId: createEffectActionDefinitionId(id),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        continuousDamageKind,
        damageType: "PHYSICAL",
        formula:
          continuousDamageKind === "POISON"
            ? { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio }
            : { kind: "STAT_RATIO", source: { kind: "SKILL_SOURCE" }, stat: "ATTACK", ratio },
        timing: { eventType: "ActionStarted", targetSelector: "EFFECT_OWNER" },
        duration: {
          timeLimit: { unit: "ACTION", count: durationCount },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
  }

  function applyOnce(
    definition: EffectActionDefinition,
    units: readonly BattleUnit[],
    actor: BattleUnit,
    target: BattleUnit,
    recorder: EventRecorder,
    rootEventId: string,
    // R-DOT-04の統合は既存インスタンスの定義もCatalogから引くため、production経路と
    // 同じく「その戦闘に登場する全定義」を渡せるようにする。
    known: readonly EffectActionDefinition[] = [],
  ): EffectActionGroupsResult {
    const effectActions = new Map(
      [...known, definition].map((d) => [d.effectActionDefinitionId, d]),
    );
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, target.battleUnitId, definition.effectActionDefinitionId)],
      targetUnitIds: [target.battleUnitId],
      resolvedBindings: new Map(),
    };
    return applyEffectActionGroups(
      plan,
      units,
      contextFor(actor, effectActions, recorder, rootEventId),
    );
  }

  it("UT-R-DOT-01-006 (real lifecycle wiring): granting a continuous damage records the granter's attack as a snapshot and carries the kind on the instance", () => {
    const actor = unit("ACTOR", "ALLY");
    const target = unit("TARGET", "ENEMY");
    const { recorder, rootEventId } = seedRecorder();

    const result = applyOnce(
      continuousDamage("ACT_DOT", "FIXED", 0.3),
      [actor, target],
      actor,
      target,
      recorder,
      rootEventId,
    );

    const applied = result.units.find((u) => u.battleUnitId === target.battleUnitId)!
      .appliedEffects[0]!;
    expect(applied.continuousDamage).toEqual({
      continuousDamageKind: "FIXED",
      damageType: "PHYSICAL",
    });
    // R-DOT-01: 付与者の攻撃力そのものをスナップショットとして持つ。
    expect(applied.snapshot).toEqual({ sourceAttack: actor.combatStats.attack });
    // 付与時に一度だけ評価したFormula結果＝固定ダメージ量。
    expect(applied.magnitude).toBe(actor.combatStats.attack * 0.3);
    // 付与時点ではダメージを与えない（発生は保持者のActionStarted）。
    expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentHp).toBe(
      target.currentHp,
    );
  });

  it("UT-R-DOT-03-003 (negative, 重複上限): a fourth burn is not granted and completes as SKIPPED without EffectApplied", () => {
    const actor = unit("ACTOR", "ALLY");
    const target = unit("TARGET", "ENEMY");
    const { recorder, rootEventId } = seedRecorder();
    const burn = continuousDamage("ACT_BURN", "BURN", 0.3);

    let units: readonly BattleUnit[] = [actor, target];
    for (const expectedCount of [1, 2, 3]) {
      units = applyOnce(burn, units, actor, target, recorder, rootEventId).units;
      expect(
        units.find((u) => u.battleUnitId === target.battleUnitId)!.appliedEffects,
      ).toHaveLength(expectedCount);
    }

    const before = recorder.getEvents().length;
    const fourth = applyOnce(burn, units, actor, target, recorder, rootEventId);
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
    expect(
      fourth.units.find((u) => u.battleUnitId === target.battleUnitId)!.appliedEffects,
    ).toHaveLength(3);
  });

  it("UT-R-DOT-04-008 (real lifecycle wiring): re-applying a poison merges into the existing instance instead of adding a second one", () => {
    const actor = unit("ACTOR", "ALLY");
    const target = unit("TARGET", "ENEMY");
    const { recorder, rootEventId } = seedRecorder();

    const weak = continuousDamage("ACT_POISON_A", "POISON", 0.1, 1);
    const strong = continuousDamage("ACT_POISON_B", "POISON", 0.2, 4);

    const first = applyOnce(weak, [actor, target], actor, target, recorder, rootEventId, [strong]);
    const second = applyOnce(strong, first.units, actor, target, recorder, rootEventId, [weak]);

    const effects = second.units.find(
      (u) => u.battleUnitId === target.battleUnitId,
    )!.appliedEffects;
    expect(effects).toHaveLength(1);
    expect(effects[0]!.duration.timeLimitRemaining).toBe(4);
    expect(recorder.getEvents().filter((e) => e.eventType === "EffectMerged")).toHaveLength(1);
    expect(recorder.getEvents().filter((e) => e.eventType === "EffectApplied")).toHaveLength(1);
  });
});
