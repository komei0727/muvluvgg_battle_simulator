import { describe, expect, it } from "vitest";
import {
  applyEffectActionGroups,
  resolveEffectSequencePlan,
} from "./effect-action-group-resolver.js";
import type { BattleUnit } from "../model/battle-unit.js";
import { createHitPoint } from "../model/resource-gauge.js";
import type { EffectSequencePlan } from "../skill/skill-resolution-service.js";
import { createEffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import {
  unit,
  damageAction,
  statModAction,
  contextFor,
  seedRecorder,
  singleActionStep,
} from "../../../testing/fixtures/effect-sequence-plan.js";
import { ExerciseRuntime } from "../model/exercise-runtime.js";

describe("zero-amount shield sweep (DMG-004, Issue #194)", () => {
  function shieldAction(
    id: string,
    amount: number,
    linked?: { readonly groupId: string; readonly role: "PARENT" | "CHILD" },
  ): EffectActionDefinition {
    return {
      kind: "APPLY_SHIELD",
      effectActionDefinitionId: createEffectActionDefinitionId(id),
      metadata: { tags: [] },
      payload: {
        formula: { kind: "CONSTANT", value: amount },
        duration: {
          timeLimit: { unit: "TURN", count: 5 },
          dispellable: true,
          linkedEffectGroupId: linked?.groupId ?? null,
          ...(linked !== undefined ? { linkedEffectGroupRole: linked.role } : {}),
        },
      },
    };
  }

  function linkedStatModAction(id: string, groupId: string): EffectActionDefinition {
    return {
      kind: "APPLY_STAT_MOD",
      effectActionDefinitionId: createEffectActionDefinitionId(id),
      metadata: { tags: [] },
      payload: {
        stat: "ATTACK",
        valueType: "RATIO",
        formula: { kind: "CONSTANT", value: 0.15 },
        stacking: { mode: "STACKABLE", max: null },
        duration: {
          timeLimit: { unit: "TURN", count: 5 },
          dispellable: false,
          linkedEffectGroupId: groupId,
          linkedEffectGroupRole: "CHILD",
        },
      },
    };
  }

  /** `SKL_LILY_SINGER_PS2`と同じ「同一ACTION stepでPARENT→CHILDの順に付与する」形。 */
  function parentChildPlan(
    targetUnitId: BattleUnit["battleUnitId"],
    parentId: EffectActionDefinition["effectActionDefinitionId"],
    childId: EffectActionDefinition["effectActionDefinitionId"],
  ): EffectSequencePlan {
    const actions = [{ effectActionDefinitionId: parentId }, { effectActionDefinitionId: childId }];
    return {
      stealthConsumptions: [],
      steps: [
        {
          planKind: "ACTION_PLAN",
          stepIndex: 0,
          stepKind: "ACTION",
          conditionKind: "TRUE",
          satisfied: true,
          actions,
          applications: [parentId, childId].map((effectActionDefinitionId) => ({
            targetUnitId,
            effectActionDefinitionId,
            includeDefeated: false,
            hits: [{ targetUnitId, effectActionDefinitionId, hitIndex: 1 }],
          })),
        },
      ],
      targetUnitIds: [targetUnitId],
      resolvedBindings: new Map(),
    };
  }

  it("UT-R-SHD-01-018: a zero-amount PARENT shield takes its later-granted CHILD with it, instead of leaving the group orphaned", () => {
    const actor = unit("ACTOR", "ALLY");
    const ally = unit("ALLY_2", "ALLY");
    // Formula結果0 → R-NUM-02の切り捨てで残量0。CHILDは同じstepの後続actionが付与する。
    const parent = shieldAction("ACT_SHIELD_ZERO", 0, { groupId: "GRP", role: "PARENT" });
    const child = linkedStatModAction("ACT_ATK_UP", "GRP");
    const effectActions = new Map([
      [parent.effectActionDefinitionId, parent],
      [child.effectActionDefinitionId, child],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);

    const result = applyEffectActionGroups(
      parentChildPlan(
        ally.battleUnitId,
        parent.effectActionDefinitionId,
        child.effectActionDefinitionId,
      ),
      [actor, ally],
      context,
    );

    // グループ全体が残らない（親も子も）。
    const target = result.units.find((u) => u.battleUnitId === ally.battleUnitId)!;
    expect(target.appliedEffects).toEqual([]);

    const expired = recorder.getEvents().filter((event) => event.eventType === "EffectExpired");
    // R-EFF-09「子を先に、親を最後に」。
    expect(
      expired.map(
        (event) => (event.payload as { effectActionDefinitionId: string }).effectActionDefinitionId,
      ),
    ).toEqual(["ACT_ATK_UP", "ACT_SHIELD_ZERO"]);
    expect(expired.map((event) => (event.payload as { reason: string }).reason)).toEqual([
      "LINKED_GROUP_CASCADE",
      "SHIELD_DEPLETED",
    ]);
  });

  it("UT-R-SHD-01-019: a positive-amount shield is left alone by the sweep", () => {
    const actor = unit("ACTOR", "ALLY");
    const ally = unit("ALLY_2", "ALLY");
    const parent = shieldAction("ACT_SHIELD_OK", 30, { groupId: "GRP", role: "PARENT" });
    const child = linkedStatModAction("ACT_ATK_UP", "GRP");
    const effectActions = new Map([
      [parent.effectActionDefinitionId, parent],
      [child.effectActionDefinitionId, child],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);

    const result = applyEffectActionGroups(
      parentChildPlan(
        ally.battleUnitId,
        parent.effectActionDefinitionId,
        child.effectActionDefinitionId,
      ),
      [actor, ally],
      context,
    );

    const target = result.units.find((u) => u.battleUnitId === ally.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(2);
    expect(recorder.getEvents().some((event) => event.eventType === "EffectExpired")).toBe(false);
  });

  it("UT-R-SHD-01-020: on the PS/Memory path (no onFactEventForPassiveChain) EffectApplied is yielded to the driver while the shield still exists, before the expiry step", () => {
    const actor = unit("ACTOR", "ALLY");
    const ally = unit("ALLY_2", "ALLY");
    const shield = shieldAction("ACT_SHIELD_ZERO", 0);
    const effectActions = new Map([[shield.effectActionDefinitionId, shield]]);
    const { recorder, rootEventId } = seedRecorder();
    // callback未指定＝PS/Memory自身のEffectSequence解決の経路。
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, ally.battleUnitId, shield.effectActionDefinitionId)],
      targetUnitIds: [ally.battleUnitId],
      resolvedBindings: new Map(),
    };

    // driverを模して、yieldされたステップごとにその時点の`box.units`を観測する。
    const box = { units: [actor, ally] as readonly BattleUnit[] };
    const observed: { readonly events: readonly string[]; readonly shields: number }[] = [];
    const generator = resolveEffectSequencePlan(plan, box, context);
    let step = generator.next();
    while (!step.done) {
      const events = step.value.kind === "TIMING_EVENT" ? [step.value.event] : step.value.events;
      observed.push({
        events: events.map((event) => event.eventType),
        shields: (box.units.find((u) => u.battleUnitId === ally.battleUnitId)?.appliedEffects ?? [])
          .length,
      });
      step = generator.next();
    }

    const appliedStep = observed.findIndex((entry) => entry.events.includes("EffectApplied"));
    const expiredStep = observed.findIndex((entry) => entry.events.includes("EffectExpired"));
    expect(appliedStep).toBeGreaterThanOrEqual(0);
    // 失効は別ステップとして後から届く（同じステップに畳み込まれない）。
    expect(expiredStep).toBeGreaterThan(appliedStep);
    // `EffectApplied`をdriverが受け取る時点では、まだシールドが存在する。
    expect(observed[appliedStep]!.shields).toBe(1);
    expect(
      step.value.units.find((u) => u.battleUnitId === ally.battleUnitId)!.appliedEffects,
    ).toEqual([]);
  });
});

describe("zero-amount shield sweep on interruption (DMG-004)", () => {
  it("UT-R-SHD-01-021: an interruption BETWEEN steps still expires a zero-amount shield granted by an earlier step", () => {
    // step 0: 残量0シールドを味方へ付与 → 最後のEffectActionで使用者へ自己ダメージ
    //         （致死）。step 0自体は最後のapplicationまで到達するため完了扱いになる。
    // step 1: 未解決のまま残る → 次のループ先頭の`isActorDefeated`で中断する。
    // この経路も掃除を通らなければ、残量0シールドが`EffectExpired`なしで永続する。
    const actor = unit("ACTOR", "ALLY", {
      currentHp: createHitPoint(5, 100),
    });
    const ally = unit("ALLY_2", "ALLY");
    const zeroShield: EffectActionDefinition = {
      kind: "APPLY_SHIELD",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_SHIELD_ZERO"),
      metadata: { tags: [] },
      payload: {
        formula: { kind: "CONSTANT", value: 0 },
        duration: {
          timeLimit: { unit: "TURN", count: 5 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const selfDamage = damageAction("ACT_SELF_DAMAGE");
    const laterAction = statModAction("ACT_LATER");
    const effectActions = new Map([
      [zeroShield.effectActionDefinitionId, zeroShield],
      [selfDamage.effectActionDefinitionId, selfDamage],
      [laterAction.effectActionDefinitionId, laterAction],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);

    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        {
          planKind: "ACTION_PLAN",
          stepIndex: 0,
          stepKind: "ACTION",
          conditionKind: "TRUE",
          satisfied: true,
          actions: [
            { effectActionDefinitionId: zeroShield.effectActionDefinitionId },
            { effectActionDefinitionId: selfDamage.effectActionDefinitionId },
          ],
          applications: [
            {
              targetUnitId: ally.battleUnitId,
              effectActionDefinitionId: zeroShield.effectActionDefinitionId,
              includeDefeated: false,
              hits: [
                {
                  targetUnitId: ally.battleUnitId,
                  effectActionDefinitionId: zeroShield.effectActionDefinitionId,
                  hitIndex: 1,
                },
              ],
            },
            {
              targetUnitId: actor.battleUnitId,
              effectActionDefinitionId: selfDamage.effectActionDefinitionId,
              includeDefeated: false,
              hits: [
                {
                  targetUnitId: actor.battleUnitId,
                  effectActionDefinitionId: selfDamage.effectActionDefinitionId,
                  hitIndex: 1,
                },
              ],
            },
          ],
        },
        singleActionStep(1, true, ally.battleUnitId, laterAction.effectActionDefinitionId),
      ],
      targetUnitIds: [ally.battleUnitId, actor.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, ally], context);

    // step間で中断したことを確かめる（step 0は完了、step 1は未着手）。
    // `unresolvedEffectCount: 0`が、step内の中断ではなくループ先頭の
    // `isActorDefeated`分岐を通ったことの証跡になる（step内で中断した場合は
    // 残りのヒット数が入る）。
    expect(result.outcome).toMatchObject({
      status: "INTERRUPTED",
      reason: "ACTOR_DEFEATED",
      unresolvedEffectCount: 0,
    });
    expect(result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentHp).toBe(0);
    expect(recorder.getEvents().filter((e) => e.eventType === "EffectStepCompleted")).toHaveLength(
      1,
    );

    // 中断経路でも残量0シールドは掃除される。
    const expired = recorder.getEvents().filter((event) => event.eventType === "EffectExpired");
    expect(expired).toHaveLength(1);
    expect(expired[0]!.payload).toMatchObject({
      effectActionDefinitionId: "ACT_SHIELD_ZERO",
      reason: "SHIELD_DEPLETED",
    });
    expect(result.units.find((u) => u.battleUnitId === ally.battleUnitId)!.appliedEffects).toEqual(
      [],
    );
  });
});

describe("APPLY_SHIELD/APPLY_SUBUNIT STAT_RATIO/MAX_HP_RATIO基準値 (R-TEX-04一般化)", () => {
  it("UT-R-TEX-04-026: a break-enhanced exercise enemy granting a shield to itself via STAT_RATIO(SKILL_SOURCE, ATTACK) sizes it against the Break0 original attack, not the current one", () => {
    // ブレイク強化後を模した現在攻撃力200。演習の原基準値は攻撃力100。
    const actor = unit("ACTOR", "ENEMY", {
      combatStats: { ...unit("ACTOR", "ENEMY").combatStats, attack: 200 },
    });
    const shield: EffectActionDefinition = {
      kind: "APPLY_SHIELD",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_SHIELD_ATK_RATIO"),
      metadata: { tags: [] },
      payload: {
        formula: { kind: "STAT_RATIO", source: { kind: "SKILL_SOURCE" }, stat: "ATTACK", ratio: 1 },
        duration: {
          timeLimit: { unit: "TURN", count: 5 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[shield.effectActionDefinitionId, shield]]);
    const { recorder, rootEventId } = seedRecorder();
    const exercise = new ExerciseRuntime({ ...actor.combatStats, attack: 100 });
    const context = { ...contextFor(actor, effectActions, recorder, rootEventId), exercise };

    const result = applyEffectActionGroups(
      {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, actor.battleUnitId, shield.effectActionDefinitionId)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      },
      [actor],
      context,
    );

    const target = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    // 原基準値の攻撃力100 × 1 = 100。現在攻撃力200基準の200ではない。
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]!.magnitude).toBe(100);
  });

  it("UT-R-TEX-04-027: a break-enhanced exercise enemy granting a sub-unit to itself via MAX_HP_RATIO sizes its durability against the Break0 original maximumHp, not the current one", () => {
    // ブレイク強化後を模した現在最大HP2000。演習の原基準値は最大HP1000。
    const actor = unit("ACTOR", "ENEMY", {
      combatStats: { ...unit("ACTOR", "ENEMY").combatStats, maximumHp: 2000 },
    });
    const subUnit: EffectActionDefinition = {
      kind: "APPLY_SUBUNIT",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_SUBUNIT_MAXHP_RATIO"),
      metadata: { tags: [] },
      payload: {
        durability: {
          formula: { kind: "MAX_HP_RATIO", source: { kind: "SKILL_SOURCE" }, ratio: 0.025 },
        },
        additionalDamage: {
          formula: {
            kind: "SUBUNIT_ADDITIONAL_DAMAGE",
            ownerAttack: "CURRENT_ATTACK",
            providerAttack: "SOURCE_SNAPSHOT_ATTACK",
            skillMultiplier: 0.25,
            targetDefense: "TARGET_CURRENT_DEFENSE",
          },
        },
        duration: {
          timeLimit: { unit: "BATTLE", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[subUnit.effectActionDefinitionId, subUnit]]);
    const { recorder, rootEventId } = seedRecorder();
    const exercise = new ExerciseRuntime({ ...actor.combatStats, maximumHp: 1000 });
    const context = { ...contextFor(actor, effectActions, recorder, rootEventId), exercise };

    const result = applyEffectActionGroups(
      {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, actor.battleUnitId, subUnit.effectActionDefinitionId)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      },
      [actor],
      context,
    );

    const target = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    // 原基準値の最大HP1000 × 0.025 = 25。現在最大HP2000基準の50ではない。
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]!.magnitude).toBe(25);
    expect(target.appliedEffects[0]!.subUnit?.durability).toBe(25);
  });
});
