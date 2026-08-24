import { describe, expect, it } from "vitest";
import {
  DEFAULT_PASSIVE_CHAIN_LIMITS,
  PassiveActivationRuntime,
  type PassiveActivationRuntimeContext,
} from "./passive-activation-service.js";
import type { BattleUnit } from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import type { PassiveChainLimits } from "../model/passive-chain-limits.js";
import { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import { createActionId, createEffectInstanceId } from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createRuntimeCounterId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import {
  createRuntimeCounterUpdateDefinition,
  type RuntimeCounterUpdateDefinition,
} from "../../catalog/definitions/runtime-counter-update-definition.js";
import { applyStateDelta } from "./state-delta-reducer.js";
import type { BattleStateSnapshot } from "./battle-state-snapshot.js";
import { ExecutionGuardExceededError } from "../../shared/errors.js";
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
 * `passive-activation-service.test.ts`（観点分割、REF-050／REF-063 #1）から
 * `RuntimeCounter`（EFF-005 `AppliedEffect`スコープ／EFF-006 `EffectSequence`
 * スコープ）の観点だけを切り出した。実装は
 * `./runtime-counter-update-service.js`へ抽出済みだが、`applyEffectRuntimeCounterUpdates`
 * /`applyEffectSequenceRuntimeCounterUpdates`は`PassiveActivationRuntime`の
 * private methodのままのため、ここでは`PassiveActivationRuntime`の公開APIを
 * 経由して検証する（移動前と同じテスト形）。
 */
describe("RuntimeCounter APPLIED_EFFECT scope (R-EFF-11, EFF-005)", () => {
  const holderUnitDefinitionId = createUnitDefinitionId("UNIT_EFF_HOLDER");
  const enemyUnitDefinitionId = createUnitDefinitionId("UNIT_EFF_ENEMY");
  const hitCounterId = createRuntimeCounterId("RUNTIME_COUNTER_HIT_COUNT");
  const effectActionDefinitionId = createEffectActionDefinitionId("ACT_EFF_CURSE");

  function curseDefinition(threshold = 2): DurationDefinition {
    return {
      dispellable: true,
      linkedEffectGroupId: null,
      counterUpdates: [
        {
          kind: "INCREMENT",
          counter: hitCounterId,
          scope: "APPLIED_EFFECT",
          trigger: {
            eventType: "DamageApplied",
            category: "FACT",
            sourceSelector: "ENEMY",
            targetSelector: "SELF",
            condition: { kind: "TRUE" },
          },
          amount: 1,
        },
      ],
      expiration: {
        conditions: [
          { kind: "RUNTIME_COUNTER", counter: hitCounterId, op: "GTE", value: threshold },
        ],
      },
    };
  }

  function curseEffect(threshold = 2): AppliedEffect {
    return {
      effectInstanceId: createEffectInstanceId("effect-curse"),
      effectActionDefinitionId,
      kindKey: effectKindKeyFromDefinitionId(effectActionDefinitionId),
      duplicate: true,
      sourceUnitId: createBattleUnitId("ENEMY"),
      targetUnitId: createBattleUnitId("HOLDER"),
      magnitude: 0,
      categories: ["BUFF"],
      duration: { definition: curseDefinition(threshold), counters: {} },
      appliedTurnNumber: 1,
    };
  }

  function hitEvent(
    recorder: EventRecorder,
    turnStarted: BattleDomainEvent,
    enemy: BattleUnit,
  ): BattleDomainEvent {
    return recorder.record({
      eventType: "DamageApplied",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      actionId: createActionId("B_1:action:1"),
      resolutionScopeId: turnStarted.resolutionScopeId,
      rootEventId: turnStarted.eventId,
      sourceUnitId: enemy.battleUnitId,
      targetUnitIds: [createBattleUnitId("HOLDER")],
      payload: {
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_EFF_CURSE_HIT"),
        hitIndex: 1,
        targetUnitId: createBattleUnitId("HOLDER"),
        calculatedDamage: 10,
        // DMG-004（R-SHD-02/03）: シールド未所持の対象なので全量がHPへ向かう。
        hpDirectDamage: 0,
        typedShieldAbsorbed: 0,
        untypedShieldAbsorbed: 0,
        subUnitAbsorbed: 0,
        discardedDamage: 0,
        hitPointDamage: 10,
        hpBefore: 100,
        hpAfter: 90,
        defeated: false,
      },
    });
  }

  it("UT-R-EFF-11-014 (EFF-005): increments the effect instance's own counter, emits RuntimeCounterChanged with effectInstanceId (not skillDefinitionId), and does not throw", () => {
    const enemy = unit("ENEMY", "ENEMY", { unitDefinitionId: enemyUnitDefinitionId });
    const holder = { ...unit("HOLDER", "ALLY", { unitDefinitionId: holderUnitDefinitionId }) };
    const holderWithEffect = { ...holder, appliedEffects: [curseEffect()] };
    const definitions = definitionsOf(
      new Map([
        [holderUnitDefinitionId, unitDefinitionOf(holderUnitDefinitionId, [])],
        [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId, [])],
      ]),
      new Map(),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [enemy, holderWithEffect],
    );

    const hit1 = hitEvent(recorder, turnStarted, enemy);
    const units = runtime.onFactEvent(hit1, [enemy, holderWithEffect]).units;

    const updatedHolder = units.find((u) => u.battleUnitId === holder.battleUnitId)!;
    expect(updatedHolder.appliedEffects).toHaveLength(1);
    expect(updatedHolder.appliedEffects[0]!.duration.counters).toEqual({
      [hitCounterId]: { value: 1, carry: 0 },
    });

    // この`hit1`は`onFactEvent`のトップレベル呼び出しと
    // `resolvePassiveChain`が注入する`deps.applyEffectRuntimeCounterUpdates`の
    // 両方から`resolveEvent`経由で到達しうる — `processedEffectRuntimeCounterEventIds`
    // ガードにより二重加算されず、`RuntimeCounterChanged`はちょうど1件だけ
    // 発行されることを明示的に固定する。
    const runtimeCounterChangedEvents = recorder
      .getEvents()
      .filter((e) => e.eventType === "RuntimeCounterChanged");
    expect(runtimeCounterChangedEvents).toHaveLength(1);
    const runtimeCounterChanged = runtimeCounterChangedEvents[0]!;
    expect(runtimeCounterChanged.parentEventId).toBe(hit1.eventId);
    expect(runtimeCounterChanged.payload).toMatchObject({
      ownerUnitId: holder.battleUnitId,
      scope: "APPLIED_EFFECT",
      counter: hitCounterId,
      effectInstanceId: curseEffect().effectInstanceId,
      before: 0,
      after: 1,
      carry: 0,
      valueChanged: true,
    });
    expect(runtimeCounterChanged.payload).not.toHaveProperty("skillDefinitionId");
  });

  it("UT-R-EFF-11-015 (EFF-005): once the counter reaches the expiration.conditions threshold, the effect instance expires (R-EFF-08 evaluates the freshly updated counter)", () => {
    const enemy = unit("ENEMY", "ENEMY", { unitDefinitionId: enemyUnitDefinitionId });
    const holder = unit("HOLDER", "ALLY", { unitDefinitionId: holderUnitDefinitionId });
    const holderWithEffect = { ...holder, appliedEffects: [curseEffect()] };
    const definitions = definitionsOf(
      new Map([
        [holderUnitDefinitionId, unitDefinitionOf(holderUnitDefinitionId, [])],
        [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId, [])],
      ]),
      new Map(),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [enemy, holderWithEffect],
    );

    const hit1 = hitEvent(recorder, turnStarted, enemy);
    let units = runtime.onFactEvent(hit1, [enemy, holderWithEffect]).units;
    expect(units.find((u) => u.battleUnitId === holder.battleUnitId)?.appliedEffects).toHaveLength(
      1,
    );

    const hit2 = hitEvent(recorder, turnStarted, enemy);
    units = runtime.onFactEvent(hit2, units).units;

    const updatedHolder = units.find((u) => u.battleUnitId === holder.battleUnitId)!;
    expect(updatedHolder.appliedEffects).toHaveLength(0);

    const eventTypes = recorder.getEvents().map((e) => e.eventType);
    const secondRuntimeCounterChangedIndex = eventTypes.lastIndexOf("RuntimeCounterChanged");
    const expiredIndex = eventTypes.indexOf("EffectExpired");
    expect(expiredIndex).toBeGreaterThan(secondRuntimeCounterChangedIndex);
  });

  it("UT-R-EFF-11-016 (EFF-005): a RuntimeCounterChanged stateDelta.units[holder].effects[instanceId] before/after round-trips through the independent Reducer", () => {
    const enemy = unit("ENEMY", "ENEMY", { unitDefinitionId: enemyUnitDefinitionId });
    const holder = unit("HOLDER", "ALLY", { unitDefinitionId: holderUnitDefinitionId });
    const holderWithEffect = { ...holder, appliedEffects: [curseEffect()] };
    const definitions = definitionsOf(
      new Map([
        [holderUnitDefinitionId, unitDefinitionOf(holderUnitDefinitionId, [])],
        [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId, [])],
      ]),
      new Map(),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [enemy, holderWithEffect],
    );

    const hit1 = hitEvent(recorder, turnStarted, enemy);
    const units = runtime.onFactEvent(hit1, [enemy, holderWithEffect]).units;
    const updatedHolder = units.find((u) => u.battleUnitId === holder.battleUnitId)!;

    const initialSnapshot: BattleStateSnapshot = {
      status: "RUNNING",
      currentTurn: 1,
      units: {
        [holder.battleUnitId]: {
          hp: holder.currentHp,
          ap: holder.currentAp,
          pp: holder.currentPp,
          extraGauge: holder.currentExtraGauge,
          maximumAp: holder.maximumAp,
          maximumPp: holder.maximumPp,
          maximumExtraGauge: holder.maximumExtraGauge,
          combatStats: holder.combatStats,
          baseCombatStats: holder.combatStats,
          effects: [
            {
              effectInstanceId: curseEffect().effectInstanceId,
              effectDefinitionId: effectActionDefinitionId,
              sourceUnitId: enemy.battleUnitId,
              kindKey: effectKindKeyFromDefinitionId(effectActionDefinitionId),
              duplicate: true,
              isEffective: true,
              magnitude: 0,
              categories: ["BUFF"],
              appliedTurnNumber: 1,
              counters: {},
            },
          ],
        },
      },
    };

    const runtimeCounterChanged = recorder
      .getEvents()
      .find((e) => e.eventType === "RuntimeCounterChanged")!;
    const restored = applyStateDelta(initialSnapshot, runtimeCounterChanged.stateDelta!);

    expect(restored.units[holder.battleUnitId]?.effects?.[0]?.counters).toEqual({
      [hitCounterId]: 1,
    });
    expect(updatedHolder.appliedEffects[0]!.duration.counters).toEqual({
      [hitCounterId]: { value: 1, carry: 0 },
    });
  });

  it("UT-R-EFF-11-017: a DamageApplied event caused by a PS's own EffectSequence (chain-internal, never reaches onFactEvent directly) still updates the target's AppliedEffect counter and its expiration.conditions", () => {
    const attackerUnitDefinitionId = createUnitDefinitionId("UNIT_EFF_ATTACKER");
    const attackDamage = damageEffectAction("ACT_EFF_ATTACK_DAMAGE");
    const enemyBindingId = createTargetBindingId("TGT_ENEMY");
    const attackSkill = passiveSkillOf("SKL_PS_ATTACK", {
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
    const holderWithEffect = {
      ...unit("HOLDER", "ENEMY", { unitDefinitionId: enemyUnitDefinitionId, maximumHp: 1000 }),
      appliedEffects: [curseEffect(1)],
    };
    const definitions = definitionsOf(
      new Map([
        [
          attackerUnitDefinitionId,
          unitDefinitionOf(attackerUnitDefinitionId, [attackSkill.skillDefinitionId]),
        ],
        [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId, [])],
      ]),
      new Map([[attackSkill.skillDefinitionId, attackSkill]]),
      new Map([[attackDamage.effectActionDefinitionId, attackDamage]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [attacker, holderWithEffect],
    );

    const units = runtime.onFactEvent(turnStarted, [attacker, holderWithEffect]).units;

    const events = recorder.getEvents();
    expect(events.some((e) => e.eventType === "DamageApplied")).toBe(true);
    const damageApplied = events.find((e) => e.eventType === "DamageApplied")!;
    const runtimeCounterChangedEvents = events.filter(
      (e) => e.eventType === "RuntimeCounterChanged",
    );
    expect(runtimeCounterChangedEvents).toHaveLength(1);
    const runtimeCounterChanged = runtimeCounterChangedEvents[0]!;
    expect(runtimeCounterChanged.payload).toMatchObject({
      scope: "APPLIED_EFFECT",
      counter: hitCounterId,
      effectInstanceId: curseEffect().effectInstanceId,
      before: 0,
      after: 1,
    });
    expect(runtimeCounterChanged.parentEventId).toBe(damageApplied.eventId);
    // 原因イベント（PS自身のEffectSequenceが発行した
    // DamageApplied）が持つskillUseIdをRuntimeCounterChangedへ引き継ぐこと —
    // 「同じSkillUse解決に属するイベントは同じskillUseIdを持つ」不変条件。
    expect(damageApplied.skillUseId).toBeDefined();
    expect(runtimeCounterChanged.skillUseId).toBe(damageApplied.skillUseId);

    const updatedHolder = units.find((u) => u.battleUnitId === "HOLDER")!;
    expect(updatedHolder.appliedEffects).toHaveLength(0);
    const expired = events.find((e) => e.eventType === "EffectExpired");
    expect(expired).toBeDefined();
  });

  it("UT-R-EFF-11-018: a DurationDefinition.counterUpdates that re-triggers itself from the RuntimeCounterChanged it causes, entirely inside the PS-chain-internal path (never reaching onFactEvent), throws a deterministic ExecutionGuardExceededError instead of recursing forever", () => {
    const attackerUnitDefinitionId = createUnitDefinitionId("UNIT_EFF_SELF_REGEN_ATTACKER");
    const attackDamage = damageEffectAction("ACT_EFF_SELF_REGEN_ATTACK_DAMAGE");
    const enemyBindingId = createTargetBindingId("TGT_ENEMY_SELF_REGEN");
    const attackSkill = passiveSkillOf("SKL_PS_SELF_REGEN_ATTACK", {
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
    const selfRegenCounterId = createRuntimeCounterId("RUNTIME_COUNTER_EFF_SELF_REGEN");
    const selfRegenEffectActionDefinitionId = createEffectActionDefinitionId(
      "ACT_EFF_SELF_REGEN_CURSE",
    );
    const selfRegenEffect: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("effect-self-regen"),
      effectActionDefinitionId: selfRegenEffectActionDefinitionId,
      kindKey: effectKindKeyFromDefinitionId(selfRegenEffectActionDefinitionId),
      duplicate: true,
      sourceUnitId: createBattleUnitId("ATTACKER"),
      targetUnitId: createBattleUnitId("HOLDER"),
      magnitude: 0,
      categories: ["BUFF"],
      duration: {
        definition: {
          dispellable: true,
          linkedEffectGroupId: null,
          counterUpdates: [
            {
              kind: "INCREMENT",
              counter: selfRegenCounterId,
              scope: "APPLIED_EFFECT",
              trigger: {
                eventType: "DamageApplied",
                category: "FACT",
                sourceSelector: "ENEMY",
                targetSelector: "SELF",
                condition: { kind: "TRUE" },
              },
              amount: 1,
            },
            {
              // このcounterの再更新契機が、自身の変化で発行される
              // `RuntimeCounterChanged`自身になっている（誤ったCatalog定義）。
              // PS自身のEffectSequenceが発行した`DamageApplied`（chain内部、
              // `onFactEvent`を経由しない）から誘発されるため、`onFactEvent`の
              // `counterUpdateDepth`は一切増加しない — `resolveEvent`自身の
              // 再帰専用ガード（`ChainState.effectRuntimeCounterDepth`）が
              // 正しく機能しなければ、この再帰は無限に続く。
              kind: "INCREMENT",
              counter: selfRegenCounterId,
              scope: "APPLIED_EFFECT",
              trigger: {
                eventType: "RuntimeCounterChanged",
                category: "FACT",
                sourceSelector: "ANY",
                targetSelector: "ANY",
                condition: {
                  kind: "EVENT_PAYLOAD",
                  field: "counter",
                  op: "EQ",
                  value: selfRegenCounterId,
                },
              },
              amount: 1,
            },
          ],
        },
        counters: {},
      },
      appliedTurnNumber: 1,
    };
    const holderWithEffect = {
      ...unit("HOLDER", "ENEMY", {
        unitDefinitionId: enemyUnitDefinitionId,
        maximumHp: 1000,
      }),
      appliedEffects: [selfRegenEffect],
    };
    const definitions = definitionsOf(
      new Map([
        [
          attackerUnitDefinitionId,
          unitDefinitionOf(attackerUnitDefinitionId, [attackSkill.skillDefinitionId]),
        ],
        [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId, [])],
      ]),
      new Map([[attackSkill.skillDefinitionId, attackSkill]]),
      new Map([[attackDamage.effectActionDefinitionId, attackDamage]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    // A small maxEffectRuntimeCounterDepth keeps this test fast and
    // deterministic instead of looping many rounds before failing.
    const context: PassiveActivationRuntimeContext = {
      ...contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      limits: { ...DEFAULT_PASSIVE_CHAIN_LIMITS, maxEffectRuntimeCounterDepth: 3 },
    };
    const runtime = new PassiveActivationRuntime(context, [attacker, holderWithEffect]);

    let caught: unknown;
    try {
      runtime.onFactEvent(turnStarted, [attacker, holderWithEffect]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExecutionGuardExceededError);

    // 11_インフラストラクチャ設計.md「SimulationExecutionGuard」「上限値は設定
    // から受け取る」: 同じ上限を、単体テスト用の`context.limits`ではなく
    // 運用経路（`SIMULATION_MAX_*`→`BattleDefinitions.executionLimits`）から
    // 与えても、同じガードが同じように働く。上限が無視されれば既定値(10)で
    // いずれ停止してしまい例外の型だけでは判別できないため、停止までに記録
    // されたイベント数が上限に比例して減ることまで確かめる。
    const eventsRecordedUntilGuard = (limits: PassiveChainLimits | undefined): number => {
      const freshRecorder = new EventRecorder(createBattleId("B_1"));
      const freshTurnStarted = recordTurnStarted(freshRecorder);
      const runtimeFromDefinitions = new PassiveActivationRuntime(
        contextOf(
          freshRecorder,
          { ...definitions, ...(limits !== undefined ? { executionLimits: limits } : {}) },
          freshTurnStarted,
          createActionId("B_1:action:1"),
        ),
        [attacker, holderWithEffect],
      );
      expect(() =>
        runtimeFromDefinitions.onFactEvent(freshTurnStarted, [attacker, holderWithEffect]),
      ).toThrow(ExecutionGuardExceededError);
      return freshRecorder.getEvents().length;
    };

    const withInjectedDepth = eventsRecordedUntilGuard({
      ...DEFAULT_PASSIVE_CHAIN_LIMITS,
      maxEffectRuntimeCounterDepth: 3,
    });
    const withCodeDefault = eventsRecordedUntilGuard(undefined);
    expect(withInjectedDepth).toBeLessThan(withCodeDefault);
  });

  it("UT-R-EFF-11-019: a second AppliedEffect counter that matches the same causing event is applied against state updated by the first counter's own candidate chain, not a stale pre-computed value", () => {
    const enemy = unit("ENEMY", "ENEMY", { unitDefinitionId: enemyUnitDefinitionId });
    const counterA = createRuntimeCounterId("RUNTIME_COUNTER_EFF_RACE_A");
    const counterB = createRuntimeCounterId("RUNTIME_COUNTER_EFF_RACE_B");
    const effectA: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("effect-race-a"),
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_EFF_RACE_A"),
      kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId("ACT_EFF_RACE_A")),
      duplicate: true,
      sourceUnitId: enemy.battleUnitId,
      targetUnitId: createBattleUnitId("HOLDER"),
      magnitude: 0,
      categories: ["BUFF"],
      duration: {
        definition: {
          dispellable: true,
          linkedEffectGroupId: null,
          counterUpdates: [
            {
              kind: "INCREMENT",
              counter: counterA,
              scope: "APPLIED_EFFECT",
              trigger: {
                eventType: "DamageApplied",
                category: "FACT",
                sourceSelector: "ENEMY",
                targetSelector: "SELF",
                condition: { kind: "TRUE" },
              },
              amount: 1,
            },
          ],
        },
        counters: {},
      },
      appliedTurnNumber: 1,
    };
    // `effectB`はDamageAppliedへ直接一致するcounterB
    // 更新（+1）に加えて、`effectA`のRuntimeCounterChanged（counterA）に反応して
    // "横から"counterBを大きく書き換える2件目のcounterUpdatesを持つ。修正前は
    // DamageApplied起点で一括計算したcounterBのbefore/after(0->1)を使っていた
    // ため、この横からの書き換え(0->10)を上書きしてしまっていた。
    const effectB: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("effect-race-b"),
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_EFF_RACE_B"),
      kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId("ACT_EFF_RACE_B")),
      duplicate: true,
      sourceUnitId: enemy.battleUnitId,
      targetUnitId: createBattleUnitId("HOLDER"),
      magnitude: 0,
      categories: ["BUFF"],
      duration: {
        definition: {
          dispellable: true,
          linkedEffectGroupId: null,
          counterUpdates: [
            {
              kind: "INCREMENT",
              counter: counterB,
              scope: "APPLIED_EFFECT",
              trigger: {
                eventType: "DamageApplied",
                category: "FACT",
                sourceSelector: "ENEMY",
                targetSelector: "SELF",
                condition: { kind: "TRUE" },
              },
              amount: 1,
            },
            {
              kind: "INCREMENT",
              counter: counterB,
              scope: "APPLIED_EFFECT",
              trigger: {
                eventType: "RuntimeCounterChanged",
                category: "FACT",
                sourceSelector: "SELF",
                targetSelector: "ANY",
                condition: { kind: "EVENT_PAYLOAD", field: "counter", op: "EQ", value: counterA },
              },
              amount: 10,
            },
          ],
        },
        counters: {},
      },
      appliedTurnNumber: 1,
    };
    const holderWithEffects = {
      ...unit("HOLDER", "ALLY", { unitDefinitionId: holderUnitDefinitionId }),
      appliedEffects: [effectA, effectB],
    };
    const definitions = definitionsOf(
      new Map([
        [holderUnitDefinitionId, unitDefinitionOf(holderUnitDefinitionId, [])],
        [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId, [])],
      ]),
      new Map(),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [enemy, holderWithEffects],
    );

    const hit1 = hitEvent(recorder, turnStarted, enemy);
    runtime.onFactEvent(hit1, [enemy, holderWithEffects]);

    const counterBChanges = recorder
      .getEvents()
      .filter((e) => e.eventType === "RuntimeCounterChanged" && e.payload.counter === counterB);
    // First: effectB's RuntimeCounterChanged-triggered "side" write (0 -> 10),
    // resolved as part of counterA's own candidate chain. Second: effectB's
    // DamageApplied-triggered entry, applied against the now-current state
    // (10 -> 11) once the outer loop reaches it — not the stale
    // pre-computed (0 -> 1) snapshot taken before the side write ran.
    expect(counterBChanges.map((e) => e.payload)).toMatchObject([
      { before: 0, after: 10 },
      { before: 10, after: 11 },
    ]);
  });
});

describe("RuntimeCounter EFFECT_SEQUENCE scope (R-EFF-11, EFF-006)", () => {
  const actorUnitDefinitionId = createUnitDefinitionId("UNIT_SEQ_ACTOR");
  const hitCounterId = createRuntimeCounterId("RUNTIME_COUNTER_SEQ_HITS");
  const skillDefinitionId = createSkillDefinitionId("SKL_SEQ_AS");

  function sequenceCounterUpdates(
    eventType = "EffectActionCompleted",
  ): readonly RuntimeCounterUpdateDefinition[] {
    return [
      createRuntimeCounterUpdateDefinition(
        {
          kind: "INCREMENT",
          counter: "RUNTIME_COUNTER_SEQ_HITS",
          scope: "EFFECT_SEQUENCE",
          trigger: {
            eventType,
            category: "FACT",
            sourceSelector: "SELF",
            targetSelector: "ANY",
          },
          amount: 1,
        },
        "counterUpdates[0]",
      ),
    ];
  }

  function actionCompletedEvent(
    recorder: EventRecorder,
    turnStarted: BattleDomainEvent,
    actor: BattleUnit,
    skillUseId: ReturnType<EventRecorder["nextSkillUseId"]>,
  ): BattleDomainEvent {
    return recorder.record({
      eventType: "EffectActionCompleted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      actionId: createActionId("B_1:action:1"),
      skillUseId,
      resolutionScopeId: turnStarted.resolutionScopeId,
      rootEventId: turnStarted.eventId,
      sourceUnitId: actor.battleUnitId,
      targetUnitIds: [actor.battleUnitId],
      payload: {
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_SEQ_HIT"),
        effectActionKind: "DAMAGE",
        targetUnitIds: [actor.battleUnitId],
        resultKind: "APPLIED",
      },
    });
  }

  it("UT-R-EFF-11-020 (EFF-006): increments the active resolution's own counter, emits RuntimeCounterChanged with skillDefinitionId (SkillUseId lives on the envelope), and does not throw", () => {
    const actor = unit("ACTOR", "ALLY", { unitDefinitionId: actorUnitDefinitionId });
    const definitions = definitionsOf(
      new Map([[actorUnitDefinitionId, unitDefinitionOf(actorUnitDefinitionId, [])]]),
      new Map(),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [actor],
    );

    const skillUseId = recorder.nextSkillUseId();
    runtime.beginEffectSequenceResolution(
      skillUseId,
      actor.battleUnitId,
      skillDefinitionId,
      sequenceCounterUpdates(),
    );

    const completed = actionCompletedEvent(recorder, turnStarted, actor, skillUseId);
    const units = runtime.onFactEvent(completed, [actor]).units;

    const updatedActor = units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(updatedActor.effectSequenceCounters).toEqual({
      [skillUseId]: { [hitCounterId]: { value: 1, carry: 0 } },
    });

    const changed = recorder.getEvents().filter((e) => e.eventType === "RuntimeCounterChanged");
    expect(changed).toHaveLength(1);
    expect(changed[0]!.parentEventId).toBe(completed.eventId);
    expect(changed[0]!.skillUseId).toBe(skillUseId);
    expect(changed[0]!.payload).toEqual({
      ownerUnitId: actor.battleUnitId,
      scope: "EFFECT_SEQUENCE",
      counter: hitCounterId,
      skillDefinitionId,
      before: 0,
      after: 1,
      carry: 0,
      valueChanged: true,
    });
  });

  it("UT-R-EFF-11-021 (EFF-006): finalizeEffectSequenceResolution discards the counter, emits RuntimeCounterReset, and its stateDelta round-trips through the independent Reducer", () => {
    const actor = unit("ACTOR", "ALLY", { unitDefinitionId: actorUnitDefinitionId });
    const definitions = definitionsOf(
      new Map([[actorUnitDefinitionId, unitDefinitionOf(actorUnitDefinitionId, [])]]),
      new Map(),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [actor],
    );

    const skillUseId = recorder.nextSkillUseId();
    runtime.beginEffectSequenceResolution(
      skillUseId,
      actor.battleUnitId,
      skillDefinitionId,
      sequenceCounterUpdates(),
    );
    const completed = actionCompletedEvent(recorder, turnStarted, actor, skillUseId);
    runtime.onFactEvent(completed, [actor]);

    const finalUnits = runtime.finalizeEffectSequenceResolution(skillUseId);

    const finalizedActor = finalUnits.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(finalizedActor.effectSequenceCounters).toBeUndefined();

    const resetEvents = recorder.getEvents().filter((e) => e.eventType === "RuntimeCounterReset");
    expect(resetEvents).toHaveLength(1);
    const reset = resetEvents[0]!;
    expect(reset.payload).toEqual({
      ownerUnitId: actor.battleUnitId,
      scope: "EFFECT_SEQUENCE",
      counter: hitCounterId,
      skillDefinitionId,
      before: 1,
    });

    const before: BattleStateSnapshot = {
      status: "RUNNING",
      currentTurn: 1,
      units: {
        [actor.battleUnitId]: {
          hp: actor.currentHp,
          ap: actor.currentAp,
          pp: actor.currentPp,
          extraGauge: actor.currentExtraGauge,
          maximumAp: actor.maximumAp,
          maximumPp: actor.maximumPp,
          maximumExtraGauge: actor.maximumExtraGauge,
          combatStats: actor.combatStats,
          baseCombatStats: actor.combatStats,
          effectSequenceCounters: { [skillUseId]: { [hitCounterId]: 1 } },
        },
      },
    };
    const after = applyStateDelta(before, reset.stateDelta!);
    expect(after.units[actor.battleUnitId]!.effectSequenceCounters).toBeUndefined();
  });

  it("UT-R-EFF-11-022 (EFF-006): a counterUpdates entry that re-triggers off RuntimeCounterReset cannot regenerate the counter, because finalize deletes the active resolution before emitting Reset (single Reset event, no loop, no ExecutionGuardExceededError)", () => {
    const actor = unit("ACTOR", "ALLY", { unitDefinitionId: actorUnitDefinitionId });
    const definitions = definitionsOf(
      new Map([[actorUnitDefinitionId, unitDefinitionOf(actorUnitDefinitionId, [])]]),
      new Map(),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [actor],
    );

    const skillUseId = recorder.nextSkillUseId();
    const selfRetriggeringUpdates: readonly RuntimeCounterUpdateDefinition[] = [
      ...sequenceCounterUpdates("EffectActionCompleted"),
      createRuntimeCounterUpdateDefinition(
        {
          kind: "INCREMENT",
          counter: "RUNTIME_COUNTER_SEQ_HITS",
          scope: "EFFECT_SEQUENCE",
          // Deliberately tries to re-trigger itself off the very
          // RuntimeCounterReset that discards it (Catalog author error).
          trigger: {
            eventType: "RuntimeCounterReset",
            category: "FACT",
            sourceSelector: "SELF",
            targetSelector: "ANY",
          },
          amount: 1,
        },
        "counterUpdates[1]",
      ),
    ];
    runtime.beginEffectSequenceResolution(
      skillUseId,
      actor.battleUnitId,
      skillDefinitionId,
      selfRetriggeringUpdates,
    );
    const completed = actionCompletedEvent(recorder, turnStarted, actor, skillUseId);
    runtime.onFactEvent(completed, [actor]);

    const finalUnits = runtime.finalizeEffectSequenceResolution(skillUseId);

    // The active resolution (and its counterUpdates) is deleted from the
    // registry before RuntimeCounterReset is emitted/resolved, so the
    // self-retriggering entry finds nothing to match against — exactly one
    // Reset fires and the counter stays discarded.
    const finalizedActor = finalUnits.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(finalizedActor.effectSequenceCounters).toBeUndefined();
    const resetEvents = recorder.getEvents().filter((e) => e.eventType === "RuntimeCounterReset");
    expect(resetEvents).toHaveLength(1);
  });

  it("UT-R-EFF-11-023 (EFF-006): a PS's own EffectSequence counterUpdates increments once per EffectActionCompleted, and a second PS whose trigger is RuntimeCounterChanged (scope EFFECT_SEQUENCE) activates as a full PS candidate once the threshold is reached, entirely inside the PS-chain-internal path", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_SEQ_OWNER");
    const parentSkillId = createSkillDefinitionId("SKL_PS_SEQ_PARENT");
    const childSkillId = createSkillDefinitionId("SKL_PS_SEQ_CHILD");
    const stepAction = damageEffectAction("ACT_SEQ_STEP");
    const childAction = damageEffectAction("ACT_SEQ_CHILD");

    const parentSkill: SkillDefinition = {
      skillDefinitionId: parentSkillId,
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "TurnStarted",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
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
            actions: [{ effectActionDefinitionId: stepAction.effectActionDefinitionId }],
          },
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: stepAction.effectActionDefinitionId }],
          },
        ],
        counterUpdates: [
          createRuntimeCounterUpdateDefinition(
            {
              kind: "INCREMENT",
              counter: "RUNTIME_COUNTER_SEQ_STEPS",
              scope: "EFFECT_SEQUENCE",
              trigger: {
                eventType: "EffectActionCompleted",
                category: "FACT",
                sourceSelector: "SELF",
                targetSelector: "ANY",
                // Scoped to this EffectSequence's own step action, not any
                // EffectActionCompleted sourced from the owner (the child
                // PS's own action would otherwise also match, since it
                // fires while this resolution is still active).
                condition: {
                  kind: "EVENT_PAYLOAD",
                  field: "effectActionDefinitionId",
                  op: "EQ",
                  value: stepAction.effectActionDefinitionId,
                },
              },
              amount: 1,
            },
            "counterUpdates[0]",
          ),
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
      metadata: { displayName: "SKL_PS_SEQ_PARENT", tags: [] },
    };

    const childSkill: SkillDefinition = {
      skillDefinitionId: childSkillId,
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "RuntimeCounterChanged",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: {
            kind: "AND",
            conditions: [
              {
                kind: "EVENT_PAYLOAD",
                field: "counter",
                op: "EQ",
                value: "RUNTIME_COUNTER_SEQ_STEPS",
              },
              { kind: "EVENT_PAYLOAD", field: "after", op: "EQ", value: 2 },
            ],
          },
        },
      ],
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
            actions: [{ effectActionDefinitionId: childAction.effectActionDefinitionId }],
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
      metadata: { displayName: "SKL_PS_SEQ_CHILD", tags: [] },
    };

    const owner = unit("OWNER", "ALLY", {
      unitDefinitionId,
      currentHp: 100,
      maximumHp: 100,
      currentPp: 3,
      maximumPp: 3,
    });
    const definitions = definitionsOf(
      new Map([
        [unitDefinitionId, unitDefinitionOf(unitDefinitionId, [parentSkillId, childSkillId])],
      ]),
      new Map([
        [parentSkillId, parentSkill],
        [childSkillId, childSkill],
      ]),
      new Map([
        [stepAction.effectActionDefinitionId, stepAction],
        [childAction.effectActionDefinitionId, childAction],
      ]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_1:action:1")),
      [owner],
    );

    const finalUnits = runtime.onFactEvent(turnStarted, [owner]).units;

    const counterChanges = recorder
      .getEvents()
      .filter(
        (e) =>
          e.eventType === "RuntimeCounterChanged" &&
          (e.payload as { scope?: string }).scope === "EFFECT_SEQUENCE",
      );
    expect(counterChanges.map((e) => e.payload)).toMatchObject([
      { before: 0, after: 1, skillDefinitionId: parentSkillId },
      { before: 1, after: 2, skillDefinitionId: parentSkillId },
    ]);

    // The child PS's own trigger (RuntimeCounterChanged, EFFECT_SEQUENCE
    // scope, after === 2) must have detected + activated as a full PS
    // candidate — proving candidate-resolution parity with the
    // AppliedEffect scope, not just a bare counter update.
    const childActivated = recorder
      .getEvents()
      .find(
        (e) =>
          e.eventType === "PassiveActivated" &&
          (e.payload as { skillDefinitionId?: string }).skillDefinitionId === childSkillId,
      );
    expect(childActivated).toBeDefined();

    // R-ATM-01: the child's candidate is detected at the second
    // RuntimeCounterChanged (mid effect processing) but only activates in the
    // post phase — after the parent's PassiveResolved. The ordering the chain
    // guarantees is therefore "parent effect A -> parent effect B ->
    // PassiveResolved -> child PS".
    const secondChange = counterChanges[1]!;
    const parentResolved = recorder
      .getEvents()
      .find(
        (e) =>
          e.eventType === "PassiveResolved" &&
          (e.payload as { skillDefinitionId?: string }).skillDefinitionId === parentSkillId,
      )!;
    expect(childActivated!.sequence).toBeGreaterThan(secondChange.sequence);
    expect(childActivated!.sequence).toBeGreaterThan(parentResolved.sequence);

    // Once the parent's EffectSequence resolution completes, its own
    // EFFECT_SEQUENCE counter is discarded exactly once (skillDefinitionId
    // identifies the parent, not the child).
    const resetEvents = recorder
      .getEvents()
      .filter(
        (e) =>
          e.eventType === "RuntimeCounterReset" &&
          (e.payload as { scope?: string }).scope === "EFFECT_SEQUENCE",
      );
    expect(resetEvents).toHaveLength(1);
    expect(resetEvents[0]!.payload).toMatchObject({ skillDefinitionId: parentSkillId });

    const ownerFinal = finalUnits.find((u) => u.battleUnitId === owner.battleUnitId)!;
    expect(ownerFinal.effectSequenceCounters).toBeUndefined();
  });
});
