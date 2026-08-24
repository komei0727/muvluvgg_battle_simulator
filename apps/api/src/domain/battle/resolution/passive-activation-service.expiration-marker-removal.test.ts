import { describe, expect, it } from "vitest";
import { PassiveActivationRuntime } from "./passive-activation-service.js";
import type { BattleUnit } from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { createBattleId, type createBattleUnitId } from "../../shared/ids.js";
import {
  createActionId,
  createEffectInstanceId,
  createMarkerInstanceId,
} from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createMarkerId,
  createTargetBindingId,
  createUnitDefinitionId,
  type SkillDefinitionId,
  type UnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { ConditionDefinition } from "../../catalog/definitions/condition-definition.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import {
  contextOf,
  damageEffectAction,
  definitionsOf,
  passiveSkillOf,
  recordTurnStarted,
  unit,
  unitDefinitionOf,
} from "../../../testing/fixtures/passive-activation-runtime.js";

/**
 * `passive-activation-service.test.ts`（観点分割、REF-050／REF-063 #2）から
 * 失効条件（R-EFF-08）・マーカー除去（R-EFF-10）の観点だけを切り出した。実装は
 * `./expiration-marker-removal-application-service.js`へ抽出済みだが、
 * `applyExpirationConditions`/`applyMarkerSourceDefeatRemovals`とその
 * `ForChain`版は`PassiveActivationRuntime`のprivate methodのままのため、
 * ここでは`PassiveActivationRuntime`の公開APIを経由して検証する
 * （移動前と同じテスト形）。
 */
describe("R-EFF-08 (expiration.conditions)", () => {
  const STAT_MOD_ID = createEffectActionDefinitionId("ACT_CURSE_ATK_DOWN");

  function statModDefinition(): EffectActionDefinition {
    return {
      effectActionDefinitionId: STAT_MOD_ID,
      kind: "APPLY_STAT_MOD",
      payload: {
        stat: "ATTACK",
        valueType: "RATIO",
        formula: { kind: "CONSTANT", value: 0 },
        stacking: { mode: "STACKABLE", max: null },
        duration: { dispellable: true, linkedEffectGroupId: null },
      },
      metadata: { tags: [] },
    };
  }

  function conditionalEffect(
    holderId: ReturnType<typeof createBattleUnitId>,
    conditions: readonly ConditionDefinition[],
  ): AppliedEffect {
    return {
      effectInstanceId: createEffectInstanceId("effect-curse"),
      effectActionDefinitionId: STAT_MOD_ID,
      kindKey: effectKindKeyFromDefinitionId(STAT_MOD_ID),
      duplicate: true,
      sourceUnitId: holderId,
      targetUnitId: holderId,
      magnitude: -0.2,
      categories: ["DEBUFF"],
      duration: {
        definition: { expiration: { conditions }, dispellable: true, linkedEffectGroupId: null },
      },
      appliedTurnNumber: 1,
    };
  }

  it("UT-R-EFF-08-008 (任意のFACT/TIMINGイベントに接続): expires a matching effect on a non-ActionCompleted event (TurnStarted), before that event's own PS candidates resolve", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_OWNER");
    const owner = unit("OWNER", "ALLY", { attack: 10, unitDefinitionId });
    const ownerWithEffect: BattleUnit = {
      ...owner,
      combatStats: { ...owner.combatStats, attack: 8 },
      appliedEffects: [
        conditionalEffect(owner.battleUnitId, [
          { kind: "EVENT_PAYLOAD", field: "turnNumber", op: "EQ", value: 1 },
        ]),
      ],
    };
    const skill = passiveSkillOf("SKL_ON_TURN_START", { ppCost: 0 });
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, unitDefinitionOf(unitDefinitionId, [skill.skillDefinitionId])]]),
      new Map([[skill.skillDefinitionId, skill]]),
      new Map([[STAT_MOD_ID, statModDefinition()]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(contextOf(recorder, definitions, turnStarted), [
      ownerWithEffect,
    ]);

    const updatedUnits = runtime.onFactEvent(turnStarted, [ownerWithEffect]).units;

    const updatedOwner = updatedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!;
    expect(updatedOwner.appliedEffects).toHaveLength(0);
    expect(updatedOwner.combatStats.attack).toBe(10);

    const eventTypes = recorder.getEvents().map((e) => e.eventType);
    const expiredIndex = eventTypes.indexOf("EffectExpired");
    const combatStatChangedIndex = eventTypes.indexOf("CombatStatChanged");
    const passiveActivatedIndex = eventTypes.indexOf("PassiveActivated");
    expect(expiredIndex).toBeGreaterThanOrEqual(0);
    expect(combatStatChangedIndex).toBeGreaterThan(expiredIndex);
    // The TurnStarted-triggered PS's own candidate resolution (PassiveActivated)
    // must come after the expiration-condition cascade for the SAME event.
    expect(passiveActivatedIndex).toBeGreaterThan(combatStatChangedIndex);
  });

  it("UT-R-EFF-08-009 (production Catalog ACT_HARRIET_SAGE_PS1_CONTINUOUS_HEAL相当、TARGET_STATE/SELF/IS_ALIVE): expires an effect whose holder is defeated by the event just recorded", () => {
    const holder = unit("HOLDER", "ALLY", { attack: 10, currentHp: 0 });
    const holderWithEffect: BattleUnit = {
      ...holder,
      combatStats: { ...holder.combatStats, attack: 8 },
      appliedEffects: [
        conditionalEffect(holder.battleUnitId, [
          {
            kind: "TARGET_STATE",
            target: { kind: "SELF" },
            field: "IS_ALIVE",
            op: "EQ",
            value: false,
          },
        ]),
      ],
    };
    const definitions = definitionsOf(
      new Map(),
      new Map(),
      new Map([[STAT_MOD_ID, statModDefinition()]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const unitDefeated = recorder.record({
      eventType: "UnitDefeated",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: turnStarted.resolutionScopeId,
      parentEventId: turnStarted.eventId,
      rootEventId: turnStarted.eventId,
      targetUnitIds: [holder.battleUnitId],
      payload: { unitId: holder.battleUnitId, causeEventId: turnStarted.eventId },
    });
    const runtime = new PassiveActivationRuntime(contextOf(recorder, definitions, turnStarted), [
      holderWithEffect,
    ]);

    const updatedUnits = runtime.onFactEvent(unitDefeated, [holderWithEffect]).units;

    const updatedHolder = updatedUnits.find((u) => u.battleUnitId === holder.battleUnitId)!;
    expect(updatedHolder.appliedEffects).toHaveLength(0);
    expect(updatedHolder.combatStats.attack).toBe(10);
    expect(recorder.getEvents().some((e) => e.eventType === "EffectExpired")).toBe(true);
  });

  it("UT-R-EFF-08-010: does nothing (no EffectExpired) when no expiration.conditions matches the event", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_A");
    const owner = unit("OWNER", "ALLY", { attack: 10, unitDefinitionId });
    const ownerWithEffect: BattleUnit = {
      ...owner,
      appliedEffects: [
        conditionalEffect(owner.battleUnitId, [
          { kind: "EVENT_PAYLOAD", field: "turnNumber", op: "EQ", value: 999 },
        ]),
      ],
    };
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, unitDefinitionOf(unitDefinitionId, [])]]),
      new Map(),
      new Map([[STAT_MOD_ID, statModDefinition()]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(contextOf(recorder, definitions, turnStarted), [
      ownerWithEffect,
    ]);

    const updatedUnits = runtime.onFactEvent(turnStarted, [ownerWithEffect]).units;

    const updatedOwner = updatedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!;
    expect(updatedOwner.appliedEffects).toHaveLength(1);
    expect(recorder.getEvents().some((e) => e.eventType === "EffectExpired")).toBe(false);
  });

  it("UT-R-EFF-08-011 (PS連鎖内部イベント): expires an effect whose expiration.conditions matches a PassiveActivated event yielded from inside the PS chain itself (not routed through onFactEvent)", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_PS_OWNER");
    const skill = passiveSkillOf("SKL_PS", { ppCost: 0 });
    const owner = unit("OWNER", "ALLY", { attack: 10, unitDefinitionId });
    const ownerWithEffect: BattleUnit = {
      ...owner,
      combatStats: { ...owner.combatStats, attack: 8 },
      appliedEffects: [
        conditionalEffect(owner.battleUnitId, [
          {
            kind: "EVENT_PAYLOAD",
            field: "skillDefinitionId",
            op: "EQ",
            value: skill.skillDefinitionId,
          },
        ]),
      ],
    };
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, unitDefinitionOf(unitDefinitionId, [skill.skillDefinitionId])]]),
      new Map([[skill.skillDefinitionId, skill]]),
      new Map([[STAT_MOD_ID, statModDefinition()]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(contextOf(recorder, definitions, turnStarted), [
      ownerWithEffect,
    ]);

    const updatedUnits = runtime.onFactEvent(turnStarted, [ownerWithEffect]).units;

    // `PassiveActivated`自体は`activatePassiveCandidate`（PS連鎖の内部）が直接
    // yieldするイベントで、`onFactEvent`を経由しない。この効果はその
    // `PassiveActivated`自身のpayload(`skillDefinitionId`)を条件にしているため、
    // 修正前（トップレベルの`onFactEvent`だけがR-EFF-08を評価していた頃）は
    // 一切失効しなかった。
    const updatedOwner = updatedUnits.find((u) => u.battleUnitId === owner.battleUnitId)!;
    expect(updatedOwner.appliedEffects).toHaveLength(0);
    expect(updatedOwner.combatStats.attack).toBe(10);

    const eventTypes = recorder.getEvents().map((e) => e.eventType);
    const passiveActivatedIndex = eventTypes.indexOf("PassiveActivated");
    const expiredIndex = eventTypes.indexOf("EffectExpired");
    expect(passiveActivatedIndex).toBeGreaterThanOrEqual(0);
    expect(expiredIndex).toBeGreaterThan(passiveActivatedIndex);
  });
});

describe("R-EFF-10 removeOnSourceDefeated (MARKER_REMOVAL_ON_SOURCE_DEATH, M7-020)", () => {
  const CRIT_DOWN_ID = createEffectActionDefinitionId("ACT_KOUYOU_CRIT_DOWN");
  const KOUYOU_LINK = "KOUYOU_LINK";

  /** `ACT_AOI_ELEGANT_AS1_MARKER_KOUYOU`と同じ形（`PARENT`・付与者戦闘不能で解除）。 */
  const markerDuration: DurationDefinition = {
    dispellable: false,
    linkedEffectGroupId: KOUYOU_LINK,
    linkedEffectGroupRole: "PARENT",
    timeLimit: { unit: "BATTLE", count: 1 },
    removeOnSourceDefeated: true,
  };

  /** `ACT_AOI_ELEGANT_AS1_KOUYOU_CRIT_DOWN`と同じ形（`CHILD`・`dispellable: false`）。 */
  const childDuration: DurationDefinition = {
    dispellable: false,
    linkedEffectGroupId: KOUYOU_LINK,
    linkedEffectGroupRole: "CHILD",
    timeLimit: { unit: "BATTLE", count: 1 },
  };

  function critDownDefinition(): EffectActionDefinition {
    return {
      effectActionDefinitionId: CRIT_DOWN_ID,
      kind: "APPLY_STAT_MOD",
      payload: {
        stat: "CRITICAL_RATE",
        valueType: "RATIO",
        formula: { kind: "CONSTANT", value: -0.25 },
        stacking: { mode: "STACKABLE", max: null },
        duration: childDuration,
      },
      metadata: { tags: [] },
    };
  }

  function kouyouMarker(
    granterId: ReturnType<typeof createBattleUnitId>,
    holderId: ReturnType<typeof createBattleUnitId>,
  ) {
    return {
      markerInstanceId: createMarkerInstanceId("B_1:marker:1"),
      markerId: createMarkerId("MARKER_KOUYOU"),
      sourceUnitId: granterId,
      targetUnitId: holderId,
      stackCount: 1,
      stackMax: null,
      duration: { definition: markerDuration },
    };
  }

  function critDownEffect(
    granterId: ReturnType<typeof createBattleUnitId>,
    holderId: ReturnType<typeof createBattleUnitId>,
  ): AppliedEffect {
    return {
      effectInstanceId: createEffectInstanceId("effect-crit-down"),
      effectActionDefinitionId: CRIT_DOWN_ID,
      kindKey: effectKindKeyFromDefinitionId(CRIT_DOWN_ID),
      duplicate: true,
      sourceUnitId: granterId,
      targetUnitId: holderId,
      magnitude: -0.25,
      categories: ["DEBUFF"],
      duration: { definition: childDuration },
      appliedTurnNumber: 1,
    };
  }

  const holderUnitDefinitionId = createUnitDefinitionId("UNIT_KOUYOU_HOLDER");

  /** `matchRuntimeCounterUpdates`は生存ユニット全件のUnitDefinitionを要求する。 */
  function definitionsWith(
    ...owners: readonly (readonly [UnitDefinitionId, readonly SkillDefinitionId[]])[]
  ) {
    return new Map(owners.map(([id, passives]) => [id, unitDefinitionOf(id, passives)] as const));
  }

  function recordUnitDefeated(
    recorder: EventRecorder,
    turnStarted: BattleDomainEvent,
    defeatedId: ReturnType<typeof createBattleUnitId>,
  ): BattleDomainEvent {
    return recorder.record({
      eventType: "UnitDefeated",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: turnStarted.resolutionScopeId,
      parentEventId: turnStarted.eventId,
      rootEventId: turnStarted.eventId,
      targetUnitIds: [defeatedId],
      payload: { unitId: defeatedId, causeEventId: turnStarted.eventId },
    });
  }

  it("UT-R-EFF-10-030 [R-EFF-09, R-EFF-10] (R-EFF-10/R-EFF-09 M7-020): a UnitDefeated for the granter removes the declaring Marker (reason SOURCE_DEFEATED) and cascades its CHILD AppliedEffect", () => {
    const granter = unit("GRANTER", "ALLY", { currentHp: 0 });
    const holder = unit("HOLDER", "ENEMY", {
      attack: 10,
      unitDefinitionId: holderUnitDefinitionId,
    });
    const holderWithKouyou: BattleUnit = {
      ...holder,
      combatStats: { ...holder.combatStats, criticalRate: -0.25 },
      markerStates: [kouyouMarker(granter.battleUnitId, holder.battleUnitId)],
      appliedEffects: [critDownEffect(granter.battleUnitId, holder.battleUnitId)],
    };
    const definitions = definitionsOf(
      definitionsWith([holderUnitDefinitionId, []]),
      new Map(),
      new Map([[CRIT_DOWN_ID, critDownDefinition()]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const unitDefeated = recordUnitDefeated(recorder, turnStarted, granter.battleUnitId);
    const runtime = new PassiveActivationRuntime(contextOf(recorder, definitions, turnStarted), [
      granter,
      holderWithKouyou,
    ]);

    const updatedUnits = runtime.onFactEvent(unitDefeated, [granter, holderWithKouyou]).units;

    const updatedHolder = updatedUnits.find((u) => u.battleUnitId === holder.battleUnitId)!;
    expect(updatedHolder.markerStates).toHaveLength(0);
    expect(updatedHolder.appliedEffects).toHaveLength(0);
    expect(updatedHolder.combatStats.criticalRate).toBe(0);

    const events = recorder.getEvents();
    const markerRemoved = events.find((e) => e.eventType === "MarkerRemoved")!;
    expect(markerRemoved.payload).toMatchObject({
      reason: "SOURCE_DEFEATED",
      cascaded: false,
      linkedEffectGroupId: KOUYOU_LINK,
    });
    const effectExpired = events.find((e) => e.eventType === "EffectExpired")!;
    expect(effectExpired.payload).toMatchObject({
      reason: "LINKED_GROUP_CASCADE",
      cascaded: true,
    });
    // R-EFF-09「同時失効では、子効果を先に失効させ、最後に親効果を失効させる」。
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes.indexOf("EffectExpired")).toBeLessThan(eventTypes.indexOf("MarkerRemoved"));
  });

  it("UT-R-EFF-10-031 (R-EFF-10 M7-020): the removal resolves before the UnitDefeated event's own PS candidates (R-EFF-08と同じ評価タイミング)", () => {
    // PS所有者はMarker保持者自身（生存）にする — 付与者は戦闘不能になるため
    // 自身のPSは発動しない。
    const skill = passiveSkillOf("SKL_ON_DEFEAT", {
      ppCost: 0,
      triggers: [
        {
          eventType: "UnitDefeated",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
    });
    const granter = unit("GRANTER", "ALLY", { currentHp: 0 });
    const holder = unit("HOLDER", "ENEMY", {
      attack: 10,
      unitDefinitionId: holderUnitDefinitionId,
    });
    const holderWithKouyou: BattleUnit = {
      ...holder,
      markerStates: [kouyouMarker(granter.battleUnitId, holder.battleUnitId)],
    };
    const definitions = definitionsOf(
      definitionsWith([holderUnitDefinitionId, [skill.skillDefinitionId]]),
      new Map([[skill.skillDefinitionId, skill]]),
      new Map([[CRIT_DOWN_ID, critDownDefinition()]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const unitDefeated = recordUnitDefeated(recorder, turnStarted, granter.battleUnitId);
    const runtime = new PassiveActivationRuntime(contextOf(recorder, definitions, turnStarted), [
      granter,
      holderWithKouyou,
    ]);

    runtime.onFactEvent(unitDefeated, [granter, holderWithKouyou]);

    const eventTypes = recorder.getEvents().map((e) => e.eventType);
    const markerRemovedIndex = eventTypes.indexOf("MarkerRemoved");
    const passiveActivatedIndex = eventTypes.indexOf("PassiveActivated");
    expect(markerRemovedIndex).toBeGreaterThanOrEqual(0);
    expect(passiveActivatedIndex).toBeGreaterThan(markerRemovedIndex);
  });

  it("UT-R-EFF-10-032 (R-EFF-10 M7-020): a Marker granted by a still-standing unit survives another unit's defeat", () => {
    const granterUnitDefinitionId = createUnitDefinitionId("UNIT_KOUYOU_GRANTER");
    const granter = unit("GRANTER", "ALLY", { unitDefinitionId: granterUnitDefinitionId });
    const other = unit("OTHER", "ALLY", { currentHp: 0 });
    const holder = unit("HOLDER", "ENEMY", {
      attack: 10,
      unitDefinitionId: holderUnitDefinitionId,
    });
    const holderWithKouyou: BattleUnit = {
      ...holder,
      markerStates: [kouyouMarker(granter.battleUnitId, holder.battleUnitId)],
    };
    const definitions = definitionsOf(
      definitionsWith([granterUnitDefinitionId, []], [holderUnitDefinitionId, []]),
      new Map(),
      new Map([[CRIT_DOWN_ID, critDownDefinition()]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const unitDefeated = recordUnitDefeated(recorder, turnStarted, other.battleUnitId);
    const runtime = new PassiveActivationRuntime(contextOf(recorder, definitions, turnStarted), [
      granter,
      other,
      holderWithKouyou,
    ]);

    const updatedUnits = runtime.onFactEvent(unitDefeated, [
      granter,
      other,
      holderWithKouyou,
    ]).units;

    const updatedHolder = updatedUnits.find((u) => u.battleUnitId === holder.battleUnitId)!;
    expect(updatedHolder.markerStates).toHaveLength(1);
    expect(recorder.getEvents().some((e) => e.eventType === "MarkerRemoved")).toBe(false);
  });

  it("UT-R-EFF-10-033 (R-EFF-10 M7-020 PS連鎖内部イベント): a UnitDefeated caused by a PS's own EffectSequence (chain-internal, never routed through onFactEvent) still removes the Marker the defeated unit had granted", () => {
    const attackerUnitDefinitionId = createUnitDefinitionId("UNIT_KOUYOU_ATTACKER");
    const victimUnitDefinitionId = createUnitDefinitionId("UNIT_KOUYOU_VICTIM");
    const attackDamage = damageEffectAction("ACT_KOUYOU_ATTACK_DAMAGE");
    const enemyBindingId = createTargetBindingId("TGT_KOUYOU_ENEMY");
    const attackSkill = passiveSkillOf("SKL_PS_KOUYOU_ATTACK", {
      ppCost: 1,
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [
          {
            targetBindingId: enemyBindingId,
            selector: {
              kind: "SELECT",
              side: "ENEMY",
              count: "ALL",
              filters: [],
              order: ["DEFAULT"],
              includeDefeated: false,
            },
          },
        ],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: enemyBindingId },
            actions: [{ effectActionDefinitionId: attackDamage.effectActionDefinitionId }],
          },
        ],
      },
    });
    const attacker = unit("ATTACKER", "ALLY", {
      unitDefinitionId: attackerUnitDefinitionId,
      currentPp: 3,
      attack: 100,
    });
    // 付与者は敵側。PSの一撃で確実に戦闘不能になるHPにする。
    const granter = unit("GRANTER", "ENEMY", {
      unitDefinitionId: victimUnitDefinitionId,
      maximumHp: 1,
      currentHp: 1,
    });
    // Marker保持者は味方側 — PSの`side: ENEMY`選択に巻き込まれないようにする。
    const holder = unit("HOLDER", "ALLY", { unitDefinitionId: holderUnitDefinitionId });
    const holderWithKouyou: BattleUnit = {
      ...holder,
      markerStates: [kouyouMarker(granter.battleUnitId, holder.battleUnitId)],
    };
    const definitions = definitionsOf(
      definitionsWith(
        [attackerUnitDefinitionId, [attackSkill.skillDefinitionId]],
        [victimUnitDefinitionId, []],
        [holderUnitDefinitionId, []],
      ),
      new Map([[attackSkill.skillDefinitionId, attackSkill]]),
      new Map([
        [CRIT_DOWN_ID, critDownDefinition()],
        [attackDamage.effectActionDefinitionId, attackDamage],
      ]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [attacker, granter, holderWithKouyou],
    );

    const updatedUnits = runtime.onFactEvent(turnStarted, [
      attacker,
      granter,
      holderWithKouyou,
    ]).units;

    const events = recorder.getEvents();
    // 前提: `UnitDefeated`はPS連鎖の内部で発行され、`onFactEvent`のトップレベル
    // 経路には現れない（この前提が崩れると本テストは配線を検証しなくなる）。
    expect(events.some((e) => e.eventType === "UnitDefeated")).toBe(true);

    const updatedHolder = updatedUnits.find((u) => u.battleUnitId === holder.battleUnitId)!;
    expect(updatedHolder.markerStates).toHaveLength(0);
    const markerRemoved = events.find((e) => e.eventType === "MarkerRemoved")!;
    expect(markerRemoved.payload).toMatchObject({
      markerId: "MARKER_KOUYOU",
      reason: "SOURCE_DEFEATED",
      cascaded: false,
    });
  });

  it("UT-R-EFF-10-034 [R-ATM-01, R-EFF-09, R-EFF-10] (R-EFF-09 逐次通知 / R-ATM-01 再確認): inside the PS chain too, the cascaded CHILD's EffectExpired is delivered while the parent Marker still exists, but a candidate gated on that Marker is discarded by the R-PS-04 reconfirmation once the pending queue drains", () => {
    const attackerUnitDefinitionId = createUnitDefinitionId("UNIT_KOUYOU_SEQ_ATTACKER");
    const victimUnitDefinitionId = createUnitDefinitionId("UNIT_KOUYOU_SEQ_VICTIM");
    const attackDamage = damageEffectAction("ACT_KOUYOU_SEQ_ATTACK_DAMAGE");
    const enemyBindingId = createTargetBindingId("TGT_KOUYOU_SEQ_ENEMY");
    const attackSkill = passiveSkillOf("SKL_PS_KOUYOU_SEQ_ATTACK", {
      ppCost: 1,
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [
          {
            targetBindingId: enemyBindingId,
            selector: {
              kind: "SELECT",
              side: "ENEMY",
              count: "ALL",
              filters: [],
              order: ["DEFAULT"],
              includeDefeated: false,
            },
          },
        ],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: enemyBindingId },
            actions: [{ effectActionDefinitionId: attackDamage.effectActionDefinitionId }],
          },
        ],
      },
    });
    // Marker保持者自身が持つPS。子効果の`EffectExpired`をtriggerにし、
    // 「その時点で親Markerをまだ持っていること」をactivationConditionにする。
    // 除去をバッチで行うと、この候補解決時にはMarkerが既に消えていて発動しない。
    const watcherSkill: SkillDefinition = {
      ...passiveSkillOf("SKL_PS_KOUYOU_WATCHER", {
        ppCost: 0,
        triggers: [
          {
            eventType: "EffectExpired",
            category: "FACT",
            sourceSelector: "SELF",
            targetSelector: "SELF",
            condition: { kind: "TRUE" },
          },
        ],
      }),
      activationCondition: {
        kind: "TARGET_HAS_MARKER",
        target: { kind: "SELF" },
        markerId: createMarkerId("MARKER_KOUYOU"),
      },
    };
    const attacker = unit("ATTACKER", "ALLY", {
      unitDefinitionId: attackerUnitDefinitionId,
      currentPp: 3,
      attack: 100,
    });
    const granter = unit("GRANTER", "ENEMY", {
      unitDefinitionId: victimUnitDefinitionId,
      maximumHp: 1,
      currentHp: 1,
    });
    const holder = unit("HOLDER", "ALLY", {
      unitDefinitionId: holderUnitDefinitionId,
      currentPp: 3,
    });
    const holderWithKouyou: BattleUnit = {
      ...holder,
      markerStates: [kouyouMarker(granter.battleUnitId, holder.battleUnitId)],
      appliedEffects: [critDownEffect(granter.battleUnitId, holder.battleUnitId)],
    };
    const definitions = definitionsOf(
      definitionsWith(
        [attackerUnitDefinitionId, [attackSkill.skillDefinitionId]],
        [victimUnitDefinitionId, []],
        [holderUnitDefinitionId, [watcherSkill.skillDefinitionId]],
      ),
      new Map([
        [attackSkill.skillDefinitionId, attackSkill],
        [watcherSkill.skillDefinitionId, watcherSkill],
      ]),
      new Map([
        [CRIT_DOWN_ID, critDownDefinition()],
        [attackDamage.effectActionDefinitionId, attackDamage],
      ]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [attacker, granter, holderWithKouyou],
    );

    const updatedUnits = runtime.onFactEvent(turnStarted, [
      attacker,
      granter,
      holderWithKouyou,
    ]).units;

    const events = recorder.getEvents();
    const eventTypes = events.map((e) => e.eventType);
    // 前提: 子効果の`EffectExpired`と親の`MarkerRemoved`がこの順に発行されている。
    const childExpiredIndex = eventTypes.indexOf("EffectExpired");
    const markerRemovedIndex = eventTypes.indexOf("MarkerRemoved");
    expect(childExpiredIndex).toBeGreaterThanOrEqual(0);
    expect(markerRemovedIndex).toBeGreaterThan(childExpiredIndex);

    // 本題: 子の`EffectExpired`は親Marker所持状態でPS/Memoryへ届く（R-EFF-09の
    // 検出粒度）。ただしR-ATM-01により発動は攻撃PSの効果処理完了後まで保留され、
    // その時点では親Markerが既に除去済みのため、`activationCondition`
    // （`TARGET_HAS_MARKER`）を見るR-PS-04の発動直前確認がこの候補を破棄する。
    // 検出粒度の契約（上の`childExpiredIndex < markerRemovedIndex`）は保ったまま、
    // 「保留中に前提が崩れた候補は発動しない」ことをここで固定する。
    const watcherActivated = events.find(
      (e) =>
        e.eventType === "PassiveActivated" &&
        (e.payload as { readonly skillDefinitionId?: string }).skillDefinitionId ===
          watcherSkill.skillDefinitionId,
    );
    expect(watcherActivated).toBeUndefined();
    expect(eventTypes.indexOf("PassiveResolved")).toBeGreaterThan(markerRemovedIndex);

    // 最終状態ではMarkerも子効果も残らない。
    const updatedHolder = updatedUnits.find((u) => u.battleUnitId === holder.battleUnitId)!;
    expect(updatedHolder.markerStates).toHaveLength(0);
    expect(
      updatedHolder.appliedEffects.filter((e) => e.effectActionDefinitionId === CRIT_DOWN_ID),
    ).toHaveLength(0);
  });
});
