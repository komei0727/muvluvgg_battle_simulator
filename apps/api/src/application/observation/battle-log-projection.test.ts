import { describe, expect, it } from "vitest";
import { projectEventsForLogLevel } from "./battle-log-projection.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { createBattleId } from "../../domain/shared/ids.js";

const BATTLE_ID = createBattleId("battle-1");

function recordAllEvents(): readonly BattleDomainEvent[] {
  const recorder = new EventRecorder(BATTLE_ID);
  const scope = () => recorder.nextResolutionScopeId();
  const actionId = recorder.nextActionId();
  const skillUseId = recorder.nextSkillUseId();

  recorder.record({
    eventType: "BattleStarted",
    category: "FACT",
    turnNumber: 0,
    cycleNumber: 0,
    resolutionScopeId: scope(),
    payload: { turnLimit: 1, allySlotCount: 1, enemySlotCount: 1 },
  });
  recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: scope(),
    payload: { turnNumber: 1 },
  });
  recorder.record({
    eventType: "ResourcesRecovered",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: scope(),
    payload: { units: [] },
  });
  recorder.record({
    eventType: "ActionQueueCreated",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    resolutionScopeId: scope(),
    payload: { cycleNumber: 1, reservations: [] },
  });
  recorder.record({
    eventType: "ActionStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    resolutionScopeId: scope(),
    payload: {
      actorUnitId: "ally:1" as never,
      reservedActionType: "AS",
      effectiveActionType: "AS",
      apBefore: 1,
      apAfter: 0,
      exBefore: 0,
      exAfter: 0,
    },
  });
  // R-ACT-03: EXゲージ上限超過分の破棄（DIAGNOSTIC）。
  recorder.record({
    eventType: "ExtraGaugeOverflowDiscarded",
    category: "DIAGNOSTIC",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    resolutionScopeId: scope(),
    sourceUnitId: "ally:1" as never,
    payload: {
      battleUnitId: "ally:1" as never,
      baseDelta: 5,
      requestedAmount: 5,
      actualAmount: 2,
      discardedAmount: 3,
    },
  });
  recorder.record({
    eventType: "TargetsSelected",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    skillUseId,
    resolutionScopeId: scope(),
    payload: { skillDefinitionId: "SKL_1" as never, bindings: [] },
  });
  recorder.record({
    eventType: "SkillUseStarting",
    category: "TIMING",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    skillUseId,
    resolutionScopeId: scope(),
    payload: {
      skillDefinitionId: "SKL_1" as never,
      skillType: "AS",
      actorUnitId: "ally:1" as never,
      targetUnitIds: [],
      costResource: "AP",
      costAmount: 1,
    },
  });
  recorder.record({
    eventType: "SkillUseStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    skillUseId,
    resolutionScopeId: scope(),
    payload: { skillDefinitionId: "SKL_1" as never, costResource: "AP", costAmount: 1 },
  });
  // `08_ドメインイベント.md`「公開レベル」: `EffectStepSkipped`はDIAGNOSTIC。
  // 直後のFACTイベントの親に据えて、DETAILEDで間引かれた親の連番が
  // `parentSequence`として残ることも同時に確認できるようにする。
  const stepSkipped = recorder.record({
    eventType: "EffectStepSkipped",
    category: "DIAGNOSTIC",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    skillUseId,
    resolutionScopeId: scope(),
    payload: { stepIndex: 0, conditionKind: "TRUE", result: false },
  });
  recorder.record({
    eventType: "HitConfirmed",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    skillUseId,
    resolutionScopeId: scope(),
    parentEventId: stepSkipped.eventId,
    rootEventId: stepSkipped.eventId,
    payload: {
      skillDefinitionId: "SKL_1" as never,
      effectActionDefinitionId: "ACT_1" as never,
      hitIndex: 1,
      targetUnitId: "enemy:1" as never,
    },
  });
  recorder.record({
    eventType: "CriticalCheckResolved",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    skillUseId,
    resolutionScopeId: scope(),
    payload: { mode: "PREVENTED", baseCriticalRate: 0, effectiveCriticalRate: 0, result: false },
  });
  recorder.record({
    eventType: "DamageCalculated",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    skillUseId,
    resolutionScopeId: scope(),
    payload: {
      skillDefinitionId: "SKL_1" as never,
      effectActionDefinitionId: "ACT_1" as never,
      hitIndex: 1,
      targetUnitId: "enemy:1" as never,
      attackerAttack: 10,
      defenderDefense: 0,
      effectiveDefense: 0,
      defenseIgnoreRate: 0,
      shieldIgnoreRate: 0,
      damageReductionIgnoreRate: 0,
      baseDamage: 10,
      skillPower: 1,
      skillPowerFormulaKind: "SKILL_POWER",
      attributeMultiplier: 1,
      attackerAttribute: "AGGRESSIVE",
      defenderAttribute: "AGGRESSIVE",
      isFavorableAttribute: false,
      attackerAffinityBonus: 0.25,
      criticalMultiplier: 1,
      outgoingDamageMultiplier: 1,
      incomingDamageMultiplier: 1,
      actionDamageMultiplier: 1,
      confusionDamageMultiplier: 1,
      rawPreTruncationDamage: 10,
      preTruncationDamage: 10,
      freezeMultiplier: 1,
      guardRate: 0,
      thresholdReductionMultiplier: 1,
      damageImmunityNullified: false,
      finalDamage: 10,
      damageType: "PHYSICAL",
    },
  });
  const damageApplied = recorder.record({
    eventType: "DamageApplied",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    skillUseId,
    resolutionScopeId: scope(),
    payload: {
      effectActionDefinitionId: "ACT_1" as never,
      hitIndex: 1,
      targetUnitId: "enemy:1" as never,
      calculatedDamage: 10,
      // DMG-004（Issue #194、R-SHD-02/03）: シールド未所持の対象なので全量がHPへ向かう。
      hpDirectDamage: 0,
      typedShieldAbsorbed: 0,
      untypedShieldAbsorbed: 0,
      subUnitAbsorbed: 0,
      discardedDamage: 0,
      hitPointDamage: 10,
      hpBefore: 10,
      hpAfter: 0,
      defeated: true,
    },
  });
  recorder.record({
    eventType: "UnitDefeated",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    skillUseId,
    resolutionScopeId: scope(),
    // 撃破は致死ダメージ適用の子である（`UnitDefeated`はSUMMARY対象、親の
    // `DamageApplied`は対象外）。この親子関係が、間引きが子へ波及しないことを
    // `UT-LOG-PROJECTION-005`が検証できる唯一の組み合わせになる。
    parentEventId: damageApplied.eventId,
    payload: { unitId: "enemy:1" as never, causeEventId: damageApplied.eventId },
  });
  recorder.record({
    eventType: "SkillUseCompleted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    skillUseId,
    resolutionScopeId: scope(),
    payload: {
      skillDefinitionId: "SKL_1" as never,
      skillType: "AS",
      resolvedStepCount: 1,
      targetUnitIds: [],
    },
  });
  recorder.record({
    eventType: "ActionCompleting",
    category: "TIMING",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    resolutionScopeId: scope(),
    payload: { actorUnitId: "ally:1" as never, effectiveActionType: "AS" },
  });
  recorder.record({
    eventType: "ActionCompleted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    resolutionScopeId: scope(),
    payload: { actorUnitId: "ally:1" as never, effectiveActionType: "AS" },
  });
  recorder.record({
    eventType: "TurnCompleting",
    category: "TIMING",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: scope(),
    payload: { turnNumber: 1 },
  });
  recorder.record({
    eventType: "TurnCompleted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: scope(),
    payload: { turnNumber: 1 },
  });
  recorder.record({
    eventType: "BattleCompleted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: scope(),
    payload: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 1 },
  });

  return recorder.getEvents();
}

describe("projectEventsForLogLevel", () => {
  it("UT-LOG-PROJECTION-001 (10_API設計.md「公開レベル」): SUMMARY publishes no event at all", () => {
    const events = recordAllEvents();

    const projected = projectEventsForLogLevel(events, "SUMMARY");

    expect(projected).toEqual([]);
    // fixtureが空でなければこそ「1件も返さない」ことに意味がある。
    expect(events.length).toBeGreaterThan(0);
  });

  it("UT-LOG-PROJECTION-002 (08_ドメインイベント.md「公開レベル」): DETAILED returns every event, including the DIAGNOSTIC-category ones that explain why an effect did not fire", () => {
    const events = recordAllEvents();

    const projected = projectEventsForLogLevel(events, "DETAILED");

    expect(projected).toEqual(events);
    expect(projected.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["EffectStepSkipped", "ExtraGaugeOverflowDiscarded"]),
    );
    // fixtureが実際にDIAGNOSTICカテゴリを含んでいなければ、この検証は無意味になる。
    expect(events.filter((event) => event.category === "DIAGNOSTIC").length).toBeGreaterThan(0);
  });

  it("UT-LOG-PROJECTION-004: DETAILED preserves the recorded sequence order", () => {
    const events = recordAllEvents();

    const projected = projectEventsForLogLevel(events, "DETAILED");

    const sequences = projected.map((e) => e.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });

  it("UT-LOG-PROJECTION-006 (12_テスト戦略.md「ログレベルを下げても状態履歴が変わらない」): the projection only ever drops events, so no level can invent one the recorder never produced", () => {
    const events = recordAllEvents();
    const recorded = new Set(events);

    for (const logLevel of ["SUMMARY", "DETAILED"] as const) {
      for (const event of projectEventsForLogLevel(events, logLevel)) {
        expect(recorded.has(event)).toBe(true);
      }
    }
  });
});
