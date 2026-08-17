import { describe, expect, it } from "vitest";
import { grantEffect, isStackLimitReached } from "./effect-grant-service.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { EventRecorder } from "../events/event-recorder.js";
import {
  createActionId,
  createSkillUseId,
  type createDomainEventId,
} from "../../shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createEffectKindKey,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { StatusKind } from "../../catalog/definitions/effect-action-payload.js";
import { DomainValidationError } from "../../shared/errors.js";
import { UNUSED_ENHANCED_BASE_STATS } from "../../../testing/fixtures/battle-actors.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 10 };

function unit(id: string): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    enhancedBaseStats: UNUSED_ENHANCED_BASE_STATS,
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate("ALLY", position),
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  return createBattleUnit(member, "ALLY", LIMITS);
}

function seedRecorder(): {
  recorder: EventRecorder;
  rootEventId: ReturnType<typeof createDomainEventId>;
} {
  const recorder = new EventRecorder(createBattleId("B_1"));
  const seed = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber: 1 },
  });
  return { recorder, rootEventId: seed.eventId };
}

const EFFECT_ACTION_DEFINITION_ID = createEffectActionDefinitionId("ACT_ATK_UP");

const TURN_DURATION: DurationDefinition = {
  timeLimit: { unit: "TURN", count: 2 },
  dispellable: true,
  linkedEffectGroupId: null,
};

/**
 * M7-011（Issue #265）: `grantEffect`は`EffectActionDefinition`そのものを受け取り、
 * `EffectApplied`の分類payload（`effectKind`/`categories`）を`effect-category-classifier.ts`
 * から導く。テストも定義IDだけでなく実際の定義を渡す。
 */
function statModDefinition(): EffectActionDefinition {
  return {
    kind: "APPLY_STAT_MOD",
    effectActionDefinitionId: EFFECT_ACTION_DEFINITION_ID,
    metadata: { tags: [] },
    payload: {
      stat: "ATTACK",
      valueType: "RATIO",
      formula: { kind: "CONSTANT", value: 0.2 },
      stacking: { mode: "STACKABLE", max: null },
      duration: TURN_DURATION,
    },
  };
}

function statusDefinition(status: StatusKind): EffectActionDefinition {
  return {
    kind: "APPLY_STATUS",
    effectActionDefinitionId: createEffectActionDefinitionId(`ACT_${status}`),
    metadata: { tags: [] },
    payload: { status, duration: TURN_DURATION },
  };
}

describe("grantEffect", () => {
  it("UT-R-EFF-01-016 (R-EFF-01): appends a new AppliedEffect instance to the target's individually-held registry", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();

    const result = grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        actionId: createActionId("B_1:action:1"),
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        definition: statModDefinition(),
        sourceUnitId: source.battleUnitId,
        targetUnitId: target.battleUnitId,
        duplicate: true,
        magnitude: 20,
        durationDefinition: TURN_DURATION,
      },
      rootEventId,
    );

    const updatedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.appliedEffects).toHaveLength(1);
    expect(updatedTarget.appliedEffects[0]).toMatchObject({
      effectActionDefinitionId: EFFECT_ACTION_DEFINITION_ID,
      sourceUnitId: source.battleUnitId,
      targetUnitId: target.battleUnitId,
      duplicate: true,
      magnitude: 20,
      appliedTurnNumber: 1,
    });
    expect(result.appliedEffect).toBe(updatedTarget.appliedEffects[0]);
  });

  // Issue #519（R-STA-03）: 同種グループの鍵はCatalog宣言由来になる。宣言した
  // 定義から付与されたインスタンスと`EffectApplied`は、定義IDではなくその鍵を運ぶ。
  it("UT-R-STA-03-009: stamps the Catalog-declared kindKey onto the instance and EffectApplied", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();

    const result = grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        definition: {
          ...statModDefinition(),
          kindKey: createEffectKindKey("KIND_ATK_UP"),
        },
        sourceUnitId: source.battleUnitId,
        targetUnitId: target.battleUnitId,
        duplicate: false,
        magnitude: 0.35,
        durationDefinition: TURN_DURATION,
      },
      rootEventId,
    );

    expect(result.appliedEffect.kindKey).toBe("KIND_ATK_UP");
    // 表示・名指し用の定義IDは鍵と独立に運び続ける（イベント契約は変えない）。
    expect(result.appliedEffect.effectActionDefinitionId).toBe(EFFECT_ACTION_DEFINITION_ID);
    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied");
    expect(applied!.payload).toMatchObject({
      kindKey: "KIND_ATK_UP",
      effectActionDefinitionId: EFFECT_ACTION_DEFINITION_ID,
    });
  });

  it("UT-R-EFF-01-017 (R-EFF-01): retains a second grant as a separate instance instead of merging with an existing one of the same kind", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = {
      recorder,
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      rootEventId,
    };
    const request = {
      definition: statModDefinition(),
      sourceUnitId: source.battleUnitId,
      targetUnitId: target.battleUnitId,
      duplicate: true,
      magnitude: 20,
      durationDefinition: TURN_DURATION,
    };

    const first = grantEffect(context, [source, target], request, rootEventId);
    const second = grantEffect(context, first.units, request, rootEventId);

    const updatedTarget = second.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updatedTarget.appliedEffects).toHaveLength(2);
    expect(updatedTarget.appliedEffects[0]!.effectInstanceId).not.toBe(
      updatedTarget.appliedEffects[1]!.effectInstanceId,
    );
  });

  it("UT-R-EFF-01-018 (R-EFF-01/08_ドメインイベント.md EffectApplied payload): records an EffectApplied FACT event carrying the instance id, source/target, duration unit/remaining, and linkedEffectGroupId", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();

    const result = grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        definition: statModDefinition(),
        sourceUnitId: source.battleUnitId,
        targetUnitId: target.battleUnitId,
        duplicate: true,
        magnitude: 20,
        durationDefinition: TURN_DURATION,
      },
      rootEventId,
    );

    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied");
    expect(applied).toBeDefined();
    expect(applied!.eventId).toBe(result.lastEventId);
    expect(applied!.payload).toMatchObject({
      effectInstanceId: result.appliedEffect.effectInstanceId,
      effectActionDefinitionId: EFFECT_ACTION_DEFINITION_ID,
      sourceUnitId: source.battleUnitId,
      targetUnitId: target.battleUnitId,
      duplicate: true,
      kindKey: EFFECT_ACTION_DEFINITION_ID,
      magnitude: 20,
      durationUnit: "TURN",
      initialRemaining: 2,
      linkedEffectGroupId: null,
    });
    const effectDelta =
      applied!.stateDelta?.units?.[target.battleUnitId]?.effects?.[
        result.appliedEffect.effectInstanceId
      ];
    expect(effectDelta?.before).toBeUndefined();
    expect(effectDelta?.after?.effectInstanceId).toBe(result.appliedEffect.effectInstanceId);
  });

  it("UT-R-EFF-01-019 (R-EFF-01): stores a snapshot value fixed at grant time (e.g. continuous-damage source attack)", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();

    const result = grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        definition: statModDefinition(),
        sourceUnitId: source.battleUnitId,
        targetUnitId: target.battleUnitId,
        duplicate: true,
        magnitude: 5,
        durationDefinition: TURN_DURATION,
        snapshot: { sourceAttack: 10 },
      },
      rootEventId,
    );

    expect(result.appliedEffect.snapshot).toEqual({ sourceAttack: 10 });
    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied");
    expect(applied!.payload).toMatchObject({ snapshot: { sourceAttack: 10 } });
  });

  it("UT-R-EFF-01-020 (defensive; preflight should already guarantee this): throws when targetUnitId references an unknown BattleUnitId", () => {
    const source = unit("source-1");
    const { recorder, rootEventId } = seedRecorder();

    expect(() =>
      grantEffect(
        {
          recorder,
          turnNumber: 1,
          cycleNumber: 0,
          resolutionScopeId: recorder.nextResolutionScopeId(),
          rootEventId,
        },
        [source],
        {
          definition: statModDefinition(),
          sourceUnitId: source.battleUnitId,
          targetUnitId: createBattleUnitId("MISSING"),
          duplicate: true,
          magnitude: 20,
          durationDefinition: TURN_DURATION,
        },
        rootEventId,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-R-EFF-01-023 (08_ドメインイベント.md EffectApplied payload: duration owner and expiration conditions): carries timeLimit.owner and expiration.conditions in the recorded event when the duration definition has them", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const durationWithOwnerAndExpiration: DurationDefinition = {
      timeLimit: { unit: "TURN", count: 2, owner: "EFFECT_SOURCE" },
      expiration: { conditions: [{ kind: "TRUE" }] },
      dispellable: true,
      linkedEffectGroupId: null,
    };

    grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        definition: statModDefinition(),
        sourceUnitId: source.battleUnitId,
        targetUnitId: target.battleUnitId,
        duplicate: true,
        magnitude: 20,
        durationDefinition: durationWithOwnerAndExpiration,
      },
      rootEventId,
    );

    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied");
    expect(applied!.payload).toMatchObject({
      durationOwner: "EFFECT_SOURCE",
      expirationConditions: [{ kind: "TRUE" }],
    });
  });

  it("UT-R-EFF-01-024: omits durationOwner/expirationConditions when the duration definition has neither", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();

    grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        definition: statModDefinition(),
        sourceUnitId: source.battleUnitId,
        targetUnitId: target.battleUnitId,
        duplicate: true,
        magnitude: 20,
        durationDefinition: TURN_DURATION,
      },
      rootEventId,
    );

    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied");
    expect(applied!.payload).not.toHaveProperty("durationOwner");
    expect(applied!.payload).not.toHaveProperty("expirationConditions");
  });

  it("UT-R-EFF-01-028 (08_ドメインイベント.md EffectApplied payload: 初期回数、残り回数): carries the instance's own remainingCount/consumptionRemaining, not just the definition's static initialRemaining/consumptionMaxCount", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const durationWithConsumption: DurationDefinition = {
      timeLimit: { unit: "TURN", count: 2 },
      consumption: { kind: "OUTGOING_HIT", maxCount: 3 },
      dispellable: true,
      linkedEffectGroupId: null,
    };

    grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        definition: statModDefinition(),
        sourceUnitId: source.battleUnitId,
        targetUnitId: target.battleUnitId,
        duplicate: true,
        magnitude: 20,
        durationDefinition: durationWithConsumption,
      },
      rootEventId,
    );

    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied");
    expect(applied!.payload).toMatchObject({
      initialRemaining: 2,
      remainingCount: 2,
      consumptionMaxCount: 3,
      consumptionRemaining: 3,
    });
  });

  it("UT-R-EFF-01-042 (TGT-004フェーズ3、Issue #167、R-ACTN-03): a statusKind request carries through to the created AppliedEffect and the EffectApplied payload", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();

    const result = grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        definition: statusDefinition("STEALTH"),
        sourceUnitId: source.battleUnitId,
        targetUnitId: target.battleUnitId,
        duplicate: true,
        magnitude: 0,
        statusKind: "STEALTH",
        durationDefinition: TURN_DURATION,
      },
      rootEventId,
    );

    expect(result.appliedEffect.statusKind).toBe("STEALTH");
    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied");
    expect(applied!.payload).toMatchObject({ statusKind: "STEALTH" });
    const effectDelta =
      applied!.stateDelta?.units?.[target.battleUnitId]?.effects?.[
        result.appliedEffect.effectInstanceId
      ];
    expect(effectDelta?.after?.statusKind).toBe("STEALTH");
  });

  it("UT-R-EFF-01-043 (TGT-004フェーズ3、Issue #167): omits statusKind from the EffectApplied payload when the request has none (non-APPLY_STATUS kinds)", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();

    const result = grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        definition: statModDefinition(),
        sourceUnitId: source.battleUnitId,
        targetUnitId: target.battleUnitId,
        duplicate: true,
        magnitude: 20,
        durationDefinition: TURN_DURATION,
      },
      rootEventId,
    );

    expect(result.appliedEffect.statusKind).toBeUndefined();
    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied");
    expect(applied!.payload).not.toHaveProperty("statusKind");
    const effectDelta =
      applied!.stateDelta?.units?.[target.battleUnitId]?.effects?.[
        result.appliedEffect.effectInstanceId
      ];
    expect(effectDelta?.after).not.toHaveProperty("statusKind");
  });

  it("UT-R-EFF-01-048 (TGT-004フェーズ3、Issue #167): a SKILL_USE-unit duration grant records context.skillUseId as grantedSkillUseId, so the granting skill use itself can be excluded from decrementSkillUseEffectDurations", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const skillUseId = createSkillUseId("B_1:skill-use:1");
    const skillUseDuration: DurationDefinition = {
      timeLimit: { unit: "SKILL_USE", count: 3 },
      dispellable: true,
      linkedEffectGroupId: null,
    };

    const result = grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        skillUseId,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        definition: statusDefinition("STEALTH"),
        sourceUnitId: source.battleUnitId,
        targetUnitId: target.battleUnitId,
        duplicate: true,
        magnitude: 0,
        statusKind: "STEALTH",
        durationDefinition: skillUseDuration,
      },
      rootEventId,
    );

    expect(result.appliedEffect.duration.grantedSkillUseId).toBe(skillUseId);
  });

  it("UT-R-EFF-01-059 (M7-011、Issue #265、EFFECT_APPLIED_CLASSIFICATION_PAYLOAD): carries the effect classification (effectKind + effectCategoriesOf categories) of a negative APPLY_STAT_MOD in the EffectApplied payload, so a TriggerDefinition can filter on DEBUFF", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();

    grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        definition: statModDefinition(),
        sourceUnitId: source.battleUnitId,
        targetUnitId: target.battleUnitId,
        duplicate: true,
        magnitude: -20,
        durationDefinition: TURN_DURATION,
      },
      rootEventId,
    );

    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied");
    expect(applied!.payload).toMatchObject({
      effectKind: "APPLY_STAT_MOD",
      categories: ["DEBUFF"],
    });
  });

  it("UT-R-EFF-01-060 (M7-011、Issue #265): classifies a positive APPLY_STAT_MOD as BUFF only, so a DEBUFF-filtered trigger does not match it", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();

    grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        definition: statModDefinition(),
        sourceUnitId: source.battleUnitId,
        targetUnitId: target.battleUnitId,
        duplicate: true,
        magnitude: 20,
        durationDefinition: TURN_DURATION,
      },
      rootEventId,
    );

    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied");
    expect(applied!.payload).toMatchObject({
      effectKind: "APPLY_STAT_MOD",
      categories: ["BUFF"],
    });
  });

  it("UT-R-EFF-01-061 (M7-011、Issue #265、R-STS-01): classifies a status-ailment APPLY_STATUS as both STATUS and DEBUFF, in a deterministic order", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();

    grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        definition: statusDefinition("STUN"),
        sourceUnitId: source.battleUnitId,
        targetUnitId: target.battleUnitId,
        duplicate: true,
        magnitude: 0,
        statusKind: "STUN",
        durationDefinition: TURN_DURATION,
      },
      rootEventId,
    );

    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied");
    expect(applied!.payload).toMatchObject({
      effectKind: "APPLY_STATUS",
      categories: ["DEBUFF", "STATUS"],
    });
  });

  it("UT-R-EFF-01-062 (M7-011、Issue #265、R-STS-01境界): classifies a beneficial APPLY_STATUS (STEALTH) as BUFF only, so a STATUS-filtered trigger does not match it", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();

    grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        definition: statusDefinition("STEALTH"),
        sourceUnitId: source.battleUnitId,
        targetUnitId: target.battleUnitId,
        duplicate: true,
        magnitude: 0,
        statusKind: "STEALTH",
        durationDefinition: TURN_DURATION,
      },
      rootEventId,
    );

    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied");
    expect(applied!.payload).toMatchObject({
      effectKind: "APPLY_STATUS",
      categories: ["BUFF"],
    });
  });

  it("UT-R-EFF-01-063 (M7-001E、Issue #248、TARGET_STATE_QUERY_BUFF_DEBUFF): burns the effectCategoriesOf classification onto the AppliedEffect instance itself, so a condition evaluator can query it without a Catalog effectActions lookup", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();

    const result = grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        definition: statusDefinition("STUN"),
        sourceUnitId: source.battleUnitId,
        targetUnitId: target.battleUnitId,
        duplicate: true,
        magnitude: 0,
        statusKind: "STUN",
        durationDefinition: TURN_DURATION,
      },
      rootEventId,
    );

    // R-STS-01: 状態異常はデバフの一種。順序は`EffectApplied.payload.categories`と
    // 同じソート済み配列で固定する（インスタンスとイベントの分類元は同一）。
    expect(result.appliedEffect.categories).toEqual(["DEBUFF", "STATUS"]);
    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied");
    expect(applied!.payload.categories).toEqual(result.appliedEffect.categories);
  });

  it("UT-R-EFF-01-064 (M7-001E、Issue #248): records the APPLY_STAT_MOD target stat on the instance, so a DEBUFF query can be narrowed to a specific stat", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();

    const result = grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        definition: statModDefinition(),
        sourceUnitId: source.battleUnitId,
        targetUnitId: target.battleUnitId,
        duplicate: true,
        magnitude: -0.2,
        durationDefinition: TURN_DURATION,
      },
      rootEventId,
    );

    expect(result.appliedEffect.categories).toEqual(["DEBUFF"]);
    expect(result.appliedEffect.statModStat).toBe("ATTACK");
  });

  it("UT-R-EFF-01-065 (M7-001E、Issue #248): leaves statModStat unset for a non APPLY_STAT_MOD grant, so a stat-narrowed query never matches it", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();

    const result = grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        definition: statusDefinition("STEALTH"),
        sourceUnitId: source.battleUnitId,
        targetUnitId: target.battleUnitId,
        duplicate: true,
        magnitude: 0,
        statusKind: "STEALTH",
        durationDefinition: TURN_DURATION,
      },
      rootEventId,
    );

    expect(result.appliedEffect.statModStat).toBeUndefined();
  });

  it("UT-R-EFF-01-066 (M7-001E、Issue #248): carries the classification into the EffectApplied stateDelta, so an independent Reducer restores the same categories/statModStat as the live state", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();

    const result = grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        definition: statModDefinition(),
        sourceUnitId: source.battleUnitId,
        targetUnitId: target.battleUnitId,
        duplicate: true,
        magnitude: -0.2,
        durationDefinition: TURN_DURATION,
      },
      rootEventId,
    );

    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied");
    const after =
      applied!.stateDelta?.units?.[target.battleUnitId]?.effects?.[
        result.appliedEffect.effectInstanceId
      ]?.after;
    expect(after?.categories).toEqual(["DEBUFF"]);
    expect(after?.statModStat).toBe("ATTACK");
  });
});

/**
 * R-EFF-12（`DYNAMIC_DURATION_ON_REAPPLY`、M7-014、Issue #268）: `statusKind`を
 * 持たない汎用効果は`effectActionDefinitionId`で「同じ効果が残っているか」を
 * 判定する。`EffectApplied`は差し替え後の初期残り回数をそのまま運ぶため、
 * 独立Reducerも`stateDelta`だけで解決後の状態を復元できる。
 *
 * Issue #519でR-STA-03の同種グループ鍵（`EffectKindKey`）がCatalog宣言由来に
 * なった後も、この一致判定だけは定義ID単位に据え置く（`UT-R-EFF-12-008`が
 * 据え置きを固定する。理由は`resolveDurationOnReapply`のコメント）。
 */
describe("grantEffect with a dynamic duration on re-apply (R-EFF-12)", () => {
  const REAPPLYING_DURATION: DurationDefinition = {
    timeLimit: { unit: "TURN", count: 2 },
    dispellable: true,
    linkedEffectGroupId: null,
    reapply: { existingRemaining: { op: "GTE", value: 1 }, count: 3 },
  };

  function request(
    source: BattleUnit,
    target: BattleUnit,
    definitionId?: string,
    kindKey?: string,
  ) {
    const id =
      definitionId === undefined
        ? EFFECT_ACTION_DEFINITION_ID
        : createEffectActionDefinitionId(definitionId);
    return {
      definition: {
        ...statModDefinition(),
        effectActionDefinitionId: id,
        ...(kindKey !== undefined ? { kindKey: createEffectKindKey(kindKey) } : {}),
      },
      sourceUnitId: source.battleUnitId,
      targetUnitId: target.battleUnitId,
      duplicate: true,
      magnitude: 0.2,
      durationDefinition: REAPPLYING_DURATION,
    };
  }

  it("UT-R-EFF-12-004: applies the reapply count to the new instance and reports it in EffectApplied", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = {
      recorder,
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      rootEventId,
    };

    const first = grantEffect(context, [source, target], request(source, target), rootEventId);
    expect(first.appliedEffect.duration.timeLimitRemaining).toBe(2);

    const second = grantEffect(context, first.units, request(source, target), first.lastEventId);
    const secondTarget = second.units.find((u) => u.battleUnitId === target.battleUnitId)!;

    // R-EFF-01「重複あり効果は個別インスタンスとして保持する」はそのまま —
    // 変わるのは新規インスタンスの初期残り回数だけ。
    expect(secondTarget.appliedEffects).toHaveLength(2);
    expect(second.appliedEffect.duration.timeLimitRemaining).toBe(3);
    expect(second.appliedEffect.duration.definition.timeLimit).toEqual({
      unit: "TURN",
      count: 3,
    });

    const applied = recorder.getEvents().filter((e) => e.eventType === "EffectApplied");
    expect(applied[1]!.payload).toMatchObject({
      durationUnit: "TURN",
      initialRemaining: 3,
      remainingCount: 3,
    });
    expect(
      applied[1]!.stateDelta?.units?.[target.battleUnitId]?.effects?.[
        second.appliedEffect.effectInstanceId
      ]?.after,
    ).toMatchObject({ duration: { unit: "TURN", remaining: 3 } });
  });

  /**
   * Issue #519: R-EFF-12の「同じ効果」判定だけは`EffectKindKey`ではなく
   * `EffectActionDefinitionId`単位に据え置く（R-STA-03の同種グループ鍵とは
   * 別の同一性）。`STATUS_KINDS_AGGREGATED_ON_REAPPLY`の`statusKind`集約は
   * 付与サービス側（既存インスタンスへ集約する）の挙動と一組であり、一致判定
   * だけを新しい鍵へ寄せると片肺になるため、統合は別Issueで行う。
   */
  it("UT-R-EFF-12-008: a shared kindKey does not make another definition the same effect for the reapply duration", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = {
      recorder,
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      rootEventId,
    };

    const other = grantEffect(
      context,
      [source, target],
      request(source, target, "ACT_OTHER_ATK_UP", "KIND_ATK_UP"),
      rootEventId,
    );
    const second = grantEffect(
      context,
      other.units,
      request(source, target, "ACT_ATK_UP", "KIND_ATK_UP"),
      other.lastEventId,
    );

    expect(second.appliedEffect.duration.timeLimitRemaining).toBe(2);
  });

  it("UT-R-EFF-12-005: another definition's instance is not the same effect, so the base count applies", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = {
      recorder,
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      rootEventId,
    };

    const other = grantEffect(
      context,
      [source, target],
      request(source, target, "ACT_OTHER_ATK_UP"),
      rootEventId,
    );
    const second = grantEffect(context, other.units, request(source, target), other.lastEventId);

    expect(second.appliedEffect.duration.timeLimitRemaining).toBe(2);
  });

  /**
   * `statusKind`一致は「再付与時に状態種別単位で1インスタンス
   * へ集約する状態異常」（`grantStunStatus`のSTUN／`grantFreezeStatus`のFREEZE）
   * だけの規則である。それ以外の`APPLY_STATUS`は`grantEffect`が常に新規インスタンス
   * を追加する（R-EFF-01）ため、状態種別で同一視すると別定義の同種ステータスが
   * 残っているだけで差し替えが誤発動する。特にR-STS-04の暗闇は「複数の暗闇を
   * 付与順に独立して処理する」と規定されており、状態種別単位の同一視自体が誤り。
   */
  function statusRequest(
    source: BattleUnit,
    target: BattleUnit,
    status: StatusKind,
    definitionId: string,
  ) {
    const definition = statusDefinition(status);
    return {
      definition: {
        ...definition,
        effectActionDefinitionId: createEffectActionDefinitionId(definitionId),
        payload: { status, duration: REAPPLYING_DURATION },
      } as EffectActionDefinition,
      sourceUnitId: source.battleUnitId,
      targetUnitId: target.battleUnitId,
      duplicate: true,
      magnitude: 0,
      statusKind: status,
      durationDefinition: REAPPLYING_DURATION,
    };
  }

  it.each([{ status: "STEALTH" as const }, { status: "BLIND" as const }])(
    "UT-R-EFF-12-006: another definition's $status instance is not the same effect, so the base count applies (only STUN/FREEZE aggregate by status kind)",
    ({ status }) => {
      const source = unit("source-1");
      const target = unit("target-1");
      const { recorder, rootEventId } = seedRecorder();
      const context = {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      };

      const other = grantEffect(
        context,
        [source, target],
        statusRequest(source, target, status, `ACT_OTHER_${status}`),
        rootEventId,
      );
      const second = grantEffect(
        context,
        other.units,
        statusRequest(source, target, status, `ACT_REAPPLY_${status}`),
        other.lastEventId,
      );

      const grantedTarget = second.units.find((u) => u.battleUnitId === target.battleUnitId)!;
      expect(grantedTarget.appliedEffects).toHaveLength(2);
      expect(second.appliedEffect.duration.timeLimitRemaining).toBe(2);
    },
  );

  it("UT-R-EFF-12-007: the same non-aggregated APPLY_STATUS definition re-applied matches by definition id and takes the reapply count", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = {
      recorder,
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      rootEventId,
    };
    const request = statusRequest(source, target, "STEALTH", "ACT_REAPPLY_STEALTH");

    const first = grantEffect(context, [source, target], request, rootEventId);
    expect(first.appliedEffect.duration.timeLimitRemaining).toBe(2);

    const second = grantEffect(context, first.units, request, first.lastEventId);
    expect(second.appliedEffect.duration.timeLimitRemaining).toBe(3);
  });
});

/**
 * M7-012（Issue #266、R-EFF-05／`STACK_LIMIT_ON_STAT_MOD`）: `APPLY_STAT_MOD`の
 * 重複上限（`stacking.max`）判定。`APPLY_MARKER.stack.max`が単一`MarkerState`の
 * スタック数をclampするのに対し、`AppliedEffect`は同じ`EffectKindKey`の
 * インスタンス数そのものが重複数になるため、上限到達時は付与自体を行わない
 * （clampする先の可変スタック数を持たない）。
 */
describe("isStackLimitReached (R-EFF-05 重複上限)", () => {
  function withEffects(
    target: BattleUnit,
    definitionIds: readonly string[],
    kindKey?: string,
  ): BattleUnit {
    return {
      ...target,
      appliedEffects: definitionIds.map((definitionId, index) => ({
        effectInstanceId: `E_${index}` as never,
        effectActionDefinitionId: createEffectActionDefinitionId(definitionId),
        kindKey: (kindKey ?? definitionId) as never,
        duplicate: true,
        targetUnitId: target.battleUnitId,
        magnitude: 0.025,
        categories: ["BUFF"],
        duration: { definition: TURN_DURATION, timeLimitRemaining: 2 },
        appliedTurnNumber: 1,
      })),
    };
  }

  it("UT-R-EFF-05-014: a null max means no limit, so the grant is never blocked", () => {
    const target = withEffects(
      unit("target-1"),
      Array.from({ length: 20 }, () => "ACT_ATK_UP"),
    );
    expect(isStackLimitReached(target, statModDefinition(), null)).toBe(false);
  });

  it("UT-R-EFF-05-015: the limit is reached exactly when the target already holds max instances of the same kindKey", () => {
    const target = unit("target-1");
    for (const [held, expected] of [
      [0, false],
      [1, false],
      [2, true],
      [3, true],
    ] as const) {
      const withHeld = withEffects(
        target,
        Array.from({ length: held }, () => "ACT_ATK_UP"),
      );
      expect(isStackLimitReached(withHeld, statModDefinition(), 2)).toBe(expected);
    }
  });

  it("UT-R-EFF-05-016: instances of a different kindKey do not count toward this definition's limit", () => {
    const target = withEffects(unit("target-1"), ["ACT_OTHER_ATK_UP", "ACT_OTHER_ATK_UP"]);
    expect(isStackLimitReached(target, statModDefinition(), 1)).toBe(false);
  });

  // Issue #519: 重複数の単位はR-EFF-05の文言どおり「同種インスタンス数」であり、
  // 同種の単位はR-STA-03と共有する`EffectKindKey`である。鍵を宣言した定義群は
  // 定義をまたいで1つの上限を数える。
  it("UT-R-EFF-05-022: instances granted by another definition sharing the declared kindKey count toward the limit", () => {
    const definition = {
      ...statModDefinition(),
      kindKey: createEffectKindKey("KIND_ATK_UP"),
    };
    const target = withEffects(
      unit("target-1"),
      ["ACT_OTHER_ATK_UP", "ACT_OTHER_ATK_UP"],
      "KIND_ATK_UP",
    );
    expect(isStackLimitReached(target, definition, 2)).toBe(true);
    expect(isStackLimitReached(target, definition, 3)).toBe(false);
  });

  // 宣言の無い定義は従来どおり定義ID単位で数える（`ACT_TARISA_TROUBLEMAKER_PS1_ATK_UP`
  // の`max: 14`が本Issueで挙動を変えないことの単体側の回帰。実production Catalogでの
  // 検証は`IT-UNIT-TARISA-TROUBLEMAKER-004/005`が担う）。
  it("UT-R-EFF-05-023: a definition without a declared kindKey keeps counting per definition ID", () => {
    const sharedKindKeyHolders = withEffects(
      unit("target-1"),
      ["ACT_OTHER_ATK_UP", "ACT_OTHER_ATK_UP"],
      "KIND_ATK_UP",
    );
    expect(isStackLimitReached(sharedKindKeyHolders, statModDefinition(), 2)).toBe(false);
  });
});
