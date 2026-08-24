import { describe, expect, it } from "vitest";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { TargetSelectorDefinition } from "../../domain/catalog/definitions/target-selector-definition.js";
import { reduceStateDeltas } from "../../domain/battle/events/state-delta-reducer.js";
import { createBattleUnitId } from "../../domain/shared/ids.js";
import { CatalogBuilder } from "../../testing/scenario/catalog-builder.js";
import {
  attackSkill,
  battleCommand,
  chargeSkill,
  damageEffectAction,
  ENEMY_ALL,
  formationSlot,
  hpCostEffectAction,
  hpScaledStatModEffectAction,
  OTHER_ALLY_ONE,
  selfEffectSkill,
  statModEffectAction,
  statusEffectAction,
  tacticalExerciseCommand,
  unitDefinition,
} from "../../testing/scenario/definition-builders.js";
import {
  assertBattleInvariants,
  runExerciseScenario,
  runExerciseScenarioRaw,
  runScenario,
} from "../../testing/scenario/run-scenario.js";

/**
 * harness ベースの Battle シナリオ（`12_テスト戦略.md`「基準シナリオ」）。散在する既存の
 * `SCN-BTL-*` とは別に、`runScenario` + `CatalogBuilder` を実運用へ載せる集約先。
 * SCN-BTL-015〜017（シールド/サブユニット・リンク・継続ダメージ）は `DMG-011`
 * （Issue #186、M8完了監査）が該当ルールの実装完了を確認して追加した。残っていた
 * SCN-BTL-004・005・009〜014・018 の9件は `REL-003`（Issue #200、M9）が追加し、
 * 主要22シナリオが揃った。M10の戦術演習分は SCN-BTL-024 だけをここに置き、
 * 025〜028（ブレイク・復活・味方全滅）は Domain 側の `battle.exercise.test.ts`
 * が持つ — 演習状態と復活の観測点が Battle 集約の内側にあるため。
 */
describe("battle scenarios (harness)", () => {
  it("SCN-BTL-001 (Issue #10 acceptance): a full battle's event log satisfies sequence/parent/root determinism, and the independent StateDelta Reducer restores finalState from initialState + transitions", async () => {
    const { reduceStateDeltas } = await import("../../domain/battle/events/state-delta-reducer.js");
    const skillId = "SKL_ATTACK";
    const effectActionId = "ACT_ATTACK";
    // UNIT_001 (activeSkillDefinitionIds: []) always WAITs, exercising both
    // ActionStarted effectiveActionType values ("AS" and "WAIT") in one battle.
    const catalog = new CatalogBuilder()
      .withUnit(
        unitDefinition("UNIT_ATK", {
          baseStats: { maximumAp: 1 },
          activeSkillDefinitionIds: [createSkillDefinitionId(skillId)],
        }),
        unitDefinition("UNIT_001"),
      )
      .withSkill(attackSkill(skillId, effectActionId))
      .withEffectAction(damageEffectAction(effectActionId))
      .build();

    const result = runScenario({
      catalog,
      command: battleCommand({
        allyFormation: { slots: [formationSlot("UNIT_ATK", 0)], memoryDefinitionIds: [] },
        enemyFormation: { slots: [formationSlot("UNIT_001", 0)], memoryDefinitionIds: [] },
        turnLimit: 1,
      }),
      randomValues: [0.99],
      battleIds: ["B_1"],
    });

    // Non-lethal attack (UNIT_ATK attack 10 - UNIT_001 defense 10 -> 1 damage
    // floor, 100 HP survives) that stays RUNNING through TURN_ENDING, then
    // resolves on the turn-limit boundary — exercising the full M3 event set.
    expect(result.outcome).toBe("ALLY_LOSE");
    expect(result.completionReason).toBe("TURN_LIMIT_REACHED");

    const { events, stateTransitions, initialState, finalState } = result;

    // Event ordering (invariant list #1): sequence is 1..N with no gaps or duplicates.
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, index) => index + 1));

    // sequence is unique within the battle (BattleLogEvent has no eventId; it
    // is the public identifier).
    expect(new Set(events.map((e) => e.sequence)).size).toBe(events.length);

    // Parent/root determinism (10_API設計.md BattleLogEventResponse):
    // a child's sequence exceeds its resolved parentSequence, a root event is
    // its own rootSequence, and a child shares its parent's rootSequence.
    const bySequence = new Map(events.map((e) => [e.sequence, e]));
    for (const event of events) {
      if (event.parentSequence === undefined) {
        expect(event.rootSequence).toBe(event.sequence);
        continue;
      }
      const parent = bySequence.get(event.parentSequence);
      expect(parent).toBeDefined();
      expect(event.sequence).toBeGreaterThan(event.parentSequence);
      expect(event.rootSequence).toBe(parent!.rootSequence);
    }

    // The full M3 event catalog plus ActionWaited (M5/issue #20) except
    // UnitDefeated (this attack is non-lethal by design, to also exercise
    // TurnCompleting/TurnCompleted/turn-limit completion in the same run) is
    // exercised by this one non-lethal-attack + mandatory-WAIT +
    // turn-limit-completion battle. UnitDefeated is covered separately below
    // by the lethal-path test.
    // `type` is the design's UPPER_SNAKE_CASE public form of the internal eventType.
    expect(new Set(events.map((e) => e.type))).toEqual(
      new Set([
        "BATTLE_STARTED",
        "TURN_STARTED",
        "RESOURCES_RECOVERED",
        "ACTION_QUEUE_CREATED",
        "ACTION_STARTED",
        "ACTION_WAITED",
        "RESOURCE_CHANGED",
        "TARGETS_SELECTED",
        "SKILL_USE_STARTING",
        "SKILL_USE_STARTED",
        "EFFECT_STEP_STARTING",
        "EFFECT_ACTION_STARTING",
        "UNIT_BEING_ATTACKED",
        "HIT_CONFIRMED",
        "CRITICAL_CHECK_RESOLVED",
        "DAMAGE_WILL_BE_APPLIED",
        "DAMAGE_CALCULATED",
        "HIT_POINT_REDUCED",
        "DAMAGE_APPLIED",
        "EFFECT_ACTION_COMPLETED",
        "EFFECT_STEP_COMPLETED",
        "SKILL_USE_COMPLETED",
        "ACTION_COMPLETING",
        "ACTION_COMPLETED",
        "TURN_COMPLETING",
        "TURN_COMPLETED",
        "BATTLE_COMPLETED",
      ]),
    );

    // Events carrying a stateDelta reference their StateTransition by its
    // 0-based position in stateTransitions (10_API設計.md
    // 「stateTransitionIndex」), and never duplicate the delta content on the
    // event itself.
    for (const event of events) {
      expect(event).not.toHaveProperty("stateDelta");
      if (event.stateTransitionIndex !== undefined) {
        expect(stateTransitions[event.stateTransitionIndex]?.causedBySequence).toBe(event.sequence);
      }
    }

    // SCN-BTL-001/SCN-BTL-021: initialState + stateTransitions = finalState,
    // verified through an independent Reducer (not Battle's own advance/resolve
    // logic). This includes the battle outcome itself (`result`), which is real
    // Battle aggregate state (`Battle.result`), not just status/turn/units.
    const restored = reduceStateDeltas(
      initialState,
      stateTransitions.map((t) => t.stateDelta),
    );
    expect(restored).toEqual(finalState);
    expect(finalState.status).toBe("COMPLETED");
    expect(finalState.result).toEqual({
      outcome: "ALLY_LOSE",
      completionReason: "TURN_LIMIT_REACHED",
      completedTurn: 1,
    });
  });

  it("SCN-BTL-001 (Issue #10 acceptance, lethal path): a lethal AS attack emits DamageApplied -> UnitDefeated -> BattleCompleted in causal order, with UnitDefeated's payload naming the defeated unit and the causing DamageApplied event", () => {
    const skillId = "SKL_LETHAL";
    const effectActionId = "ACT_LETHAL";
    const catalog = new CatalogBuilder()
      .withUnit(
        unitDefinition("UNIT_ATK", {
          baseStats: { maximumAp: 1, attack: 999 },
          activeSkillDefinitionIds: [createSkillDefinitionId(skillId)],
        }),
        unitDefinition("UNIT_DEF", { baseStats: { maximumHp: 10, defense: 0 } }),
      )
      .withSkill(attackSkill(skillId, effectActionId))
      .withEffectAction(damageEffectAction(effectActionId))
      .build();

    const result = runScenario({
      catalog,
      command: battleCommand({
        allyFormation: { slots: [formationSlot("UNIT_ATK", 0)], memoryDefinitionIds: [] },
        enemyFormation: { slots: [formationSlot("UNIT_DEF", 0)], memoryDefinitionIds: [] },
        turnLimit: 5,
      }),
      randomValues: [0.99],
      battleIds: ["B_1"],
    });

    expect(result.outcome).toBe("ALLY_WIN");
    expect(result.completionReason).toBe("ENEMY_DEFEATED");

    const { events } = result;
    const eventTypes = events.map((e) => e.type);
    const damageAppliedIndex = eventTypes.indexOf("DAMAGE_APPLIED");
    const unitDefeatedIndex = eventTypes.indexOf("UNIT_DEFEATED");
    const battleCompletedIndex = eventTypes.indexOf("BATTLE_COMPLETED");

    expect(damageAppliedIndex).toBeGreaterThanOrEqual(0);
    expect(unitDefeatedIndex).toBeGreaterThan(damageAppliedIndex);
    expect(battleCompletedIndex).toBeGreaterThan(unitDefeatedIndex);

    const damageApplied = events[damageAppliedIndex]!;
    const unitDefeated = events[unitDefeatedIndex]!;
    expect(damageApplied.details).toMatchObject({ defeated: true });
    // Causal link at the public level: UnitDefeated's parentSequence points
    // back to the DamageApplied event that caused it.
    expect(unitDefeated.parentSequence).toBe(damageApplied.sequence);
    expect(unitDefeated.details).toMatchObject({ unitId: createBattleUnitId("enemy:1") });
  });

  it("SCN-BTL-008 (Issue #34 acceptance): a defender's PS triggered by DamageApplied consumes PP and increases the EX gauge by the same amount, recorded via ResourceChanged/PassiveActivated/PassiveResolved", () => {
    const skillId = "SKL_ATTACK";
    const effectActionId = "ACT_ATTACK";
    const passiveSkillId = "SKL_PS_ON_DAMAGED";
    const passiveSkill: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId(passiveSkillId),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "DamageApplied",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "SELF",
          condition: { kind: "TRUE" },
        },
      ],
      counterUpdates: [],
      resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
      cooldown: { unit: "ACTION", count: 0 },
      traits: {
        priorityAttack: false,
        simultaneousActivationLimited: false,
        exclusiveActivationGroupId: null,
        accuracy: { guaranteedHit: false },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      },
      metadata: { displayName: passiveSkillId, tags: [] },
    };
    const catalog = new CatalogBuilder()
      .withUnit(
        unitDefinition("UNIT_ATK", {
          baseStats: { maximumAp: 1 },
          activeSkillDefinitionIds: [createSkillDefinitionId(skillId)],
        }),
        unitDefinition("UNIT_PS_DEF", {
          baseStats: { maximumHp: 1000, maximumPp: 3 },
          extraGaugeMaximum: 10,
          passiveSkillDefinitionIds: [createSkillDefinitionId(passiveSkillId)],
        }),
      )
      .withSkill(attackSkill(skillId, effectActionId), passiveSkill)
      .withEffectAction(damageEffectAction(effectActionId))
      .build();

    const result = runScenario({
      catalog,
      command: battleCommand({
        allyFormation: { slots: [formationSlot("UNIT_ATK", 0)], memoryDefinitionIds: [] },
        enemyFormation: { slots: [formationSlot("UNIT_PS_DEF", 0)], memoryDefinitionIds: [] },
        turnLimit: 1,
      }),
      randomValues: [0.99],
      battleIds: ["B_1"],
    });

    const { events, finalState } = result;
    const defenderUnitId = createBattleUnitId("enemy:1");

    // Non-lethal attack (UNIT_ATK attack 10 - UNIT_PS_DEF defense 10 -> 1
    // damage floor, 1000 HP survives) so the PS resolves without interruption.
    const eventTypes = events.map((e) => e.type);
    const damageAppliedIndex = eventTypes.indexOf("DAMAGE_APPLIED");
    const passiveActivatedIndex = eventTypes.indexOf("PASSIVE_ACTIVATED");
    const passiveResolvedIndex = eventTypes.indexOf("PASSIVE_RESOLVED");
    expect(damageAppliedIndex).toBeGreaterThanOrEqual(0);
    // R-SKL-01/02: the PS resolves immediately, before the attacker's action completes.
    expect(passiveActivatedIndex).toBeGreaterThan(damageAppliedIndex);
    expect(passiveResolvedIndex).toBeGreaterThan(passiveActivatedIndex);

    const passiveActivated = events[passiveActivatedIndex]!;
    expect(passiveActivated.details).toMatchObject({
      actorUnitId: defenderUnitId,
      skillDefinitionId: createSkillDefinitionId(passiveSkillId),
      // TURN_STARTING recovers PP to maximumPp (3) before the action phase.
      ppBefore: 3,
      ppAfter: 2,
      exBefore: 0,
      exAfter: 1,
    });

    // Restrict to the window between DamageApplied and PassiveActivated so the
    // defender's own later WAIT action (which also emits AP/EX ResourceChanged
    // for itself, R-ACT-03) doesn't get mixed into the PS's own resource change.
    const resourceChangedForDefender = events
      .slice(damageAppliedIndex, passiveActivatedIndex)
      .filter(
        (e) =>
          e.type === "RESOURCE_CHANGED" &&
          (e.details as { battleUnitId: string }).battleUnitId === defenderUnitId,
      );
    expect(
      resourceChangedForDefender.map((e) => (e.details as { resource: string }).resource),
    ).toEqual(["PP", "EX_GAUGE"]);
    expect(resourceChangedForDefender[0]!.details).toMatchObject({
      before: 3,
      after: 2,
      delta: -1,
      reason: "SKILL_COST",
    });
    expect(resourceChangedForDefender[1]!.details).toMatchObject({
      before: 0,
      after: 1,
      delta: 1,
      reason: "EX_GAIN",
    });

    expect(finalState.units[defenderUnitId]!.pp).toBe(2);
    // +1 from the PS's own activation, then +1 per subsequent mandatory WAIT
    // in the defender's own action phase (maximumAp 3, no active skill, R-ACT-03).
    expect(finalState.units[defenderUnitId]!.extraGauge).toBe(4);
  });

  it("SCN-BTL-023 [R-ORD-01] (Issue #251 acceptance): a same-cycle DEFEATED reservation removal, whose own PS reaction chain further changes state, still satisfies the full-battle invariants (parent/root determinism, independent StateDelta reapplication) enforced end-to-end by the public use case", () => {
    const skillId = "SKL_KILL_NEAREST";
    const effectActionId = "ACT_KILL_NEAREST";
    const passiveSkillId = "SKL_PS_ON_RESERVATION_REMOVED";
    const nearestEnemy: TargetSelectorDefinition = {
      kind: "SELECT",
      side: "ENEMY",
      count: 1,
      filters: [],
      order: ["DEFAULT"],
      includeDefeated: false,
    };
    const killSkill: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId(skillId),
      skillType: "AS",
      cost: { resource: "AP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [],
      counterUpdates: [],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [
          { targetBindingId: createTargetBindingId("TGT_1"), selector: nearestEnemy },
        ],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
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
      metadata: { displayName: "Kill nearest", tags: [] },
    };
    // Issue #251: reacts to ActionReservationRemoved (the DEFEATED removal of
    // the doomed enemy, decided and recorded by the dedicated
    // action-reservation-removal-resolver before the doomed unit's own turn
    // is ever reached) — its own PP/EX ResourceChanged changes are exactly
    // the kind of reaction-chain StateDelta whose independent reapplication
    // `assembleSimulationResult` verifies unconditionally for every battle.
    const passiveSkill: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId(passiveSkillId),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "ActionReservationRemoved",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
      counterUpdates: [],
      resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
      cooldown: { unit: "ACTION", count: 0 },
      traits: {
        priorityAttack: false,
        simultaneousActivationLimited: false,
        exclusiveActivationGroupId: null,
        accuracy: { guaranteedHit: false },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      },
      metadata: { displayName: passiveSkillId, tags: [] },
    };
    const catalog = new CatalogBuilder()
      .withUnit(
        unitDefinition("UNIT_ATK", {
          baseStats: { maximumAp: 1, attack: 999, actionSpeed: 20, maximumPp: 3 },
          extraGaugeMaximum: 10,
          activeSkillDefinitionIds: [createSkillDefinitionId(skillId)],
          passiveSkillDefinitionIds: [createSkillDefinitionId(passiveSkillId)],
        }),
        unitDefinition("UNIT_DOOMED", {
          baseStats: { maximumHp: 10, defense: 0, actionSpeed: 10 },
        }),
        unitDefinition("UNIT_SURVIVOR", { baseStats: { actionSpeed: 5 } }),
      )
      .withSkill(killSkill, passiveSkill)
      .withEffectAction(damageEffectAction(effectActionId, 1, "PREVENTED"))
      .build();

    const result = runScenario({
      catalog,
      command: battleCommand({
        allyFormation: { slots: [formationSlot("UNIT_ATK", 0)], memoryDefinitionIds: [] },
        enemyFormation: {
          slots: [formationSlot("UNIT_DOOMED", 0), formationSlot("UNIT_SURVIVOR", 1)],
          memoryDefinitionIds: [],
        },
        turnLimit: 1,
      }),
      randomValues: [],
      battleIds: ["B_1"],
    });

    const { events, stateTransitions, initialState, finalState } = result;
    const doomedUnitId = createBattleUnitId("enemy:1");

    // The doomed enemy is defeated before its own reservation is reached and
    // never acts — the reservation-removal fixed-point resolver discarded it
    // outright, DEFEATED, rather than letting it execute a stale reservation.
    expect(
      events.some(
        (e) =>
          e.type === "ACTION_STARTED" &&
          (e.details as { actorUnitId: string }).actorUnitId === doomedUnitId,
      ),
    ).toBe(false);
    const removed = events.find(
      (e) =>
        e.type === "ACTION_RESERVATION_REMOVED" &&
        (e.details as { battleUnitId: string }).battleUnitId === doomedUnitId,
    )!;
    expect(removed.details).toMatchObject({ reason: "DEFEATED" });
    // The attacker's PS, triggered by that removal, activates within the
    // same battle — proving ActionReservationRemoved reaches PS/Memory
    // candidate resolution end-to-end (not just at the internal-API level
    // the UT-R-ORD-01-* suite already covers).
    const passiveActivated = events.find((e) => e.type === "PASSIVE_ACTIVATED")!;
    expect(passiveActivated.details).toMatchObject({
      skillDefinitionId: createSkillDefinitionId(passiveSkillId),
    });
    expect(passiveActivated.sequence).toBeGreaterThan(removed.sequence);

    // Parent/root determinism (10_API設計.md BattleLogEventResponse), same
    // invariant SCN-BTL-001 checks generally — verified here specifically
    // across a chain that includes ActionReservationRemoved and its own PS
    // reaction (Issue #251's causal-cursor contract).
    const bySequence = new Map(events.map((e) => [e.sequence, e]));
    for (const event of events) {
      if (event.parentSequence === undefined) {
        expect(event.rootSequence).toBe(event.sequence);
        continue;
      }
      const parent = bySequence.get(event.parentSequence);
      expect(parent).toBeDefined();
      expect(event.sequence).toBeGreaterThan(event.parentSequence);
      expect(event.rootSequence).toBe(parent!.rootSequence);
    }
    // The PS activation's ancestor chain traces back to the removal that
    // triggered it (walking parentSequence, since PassiveActivated's direct
    // parent may be an intermediate step of its own activation rather than
    // the trigger event itself).
    let ancestor = passiveActivated;
    while (ancestor.parentSequence !== undefined && ancestor.sequence !== removed.sequence) {
      ancestor = bySequence.get(ancestor.parentSequence)!;
    }
    expect(ancestor.sequence).toBe(removed.sequence);

    // Independent StateDelta Reducer restores finalState from
    // initialState + stateTransitions — `assembleSimulationResult` already
    // enforces this unconditionally (throwing INTERNAL_INVARIANT_VIOLATION
    // otherwise), so merely completing without throwing already proves it
    // for this removal-heavy path; re-asserted directly here per
    // `12_テスト戦略.md`「独立した差分Reducer」.
    const restored = reduceStateDeltas(
      initialState,
      stateTransitions.map((t) => t.stateDelta),
    );
    expect(restored).toEqual(finalState);
  });

  /**
   * `DMG-011`（Issue #186、M8完了監査）が追加した M8 の基準シナリオ。
   * `12_テスト戦略.md`「基準シナリオ」は `SCN-BTL-015`〜`017` を M8 の重点確認
   * （物理/EN→無属性→サブユニット→HP、全対象同量・個別吸収・再リンクなし、
   * 付与時攻撃力のsnapshot）として定義していたが、ルール未実装を理由に保留され、
   * 個々の実装Task（`DMG-004`〜`DMG-008`）はいずれもunit levelとproduction定義
   * 単位の検証で完了していた。完了監査の一部としてここで harness へ載せる。
   */
  describe("M9 action queue and resources (REL-003)", () => {
    /** 敵をキュー生成対象から外す（AP0・EXゲージ上限で満タンにならない）。行動者を1体に絞る。 */
    const inertEnemy = (id: string) =>
      unitDefinition(id, { baseStats: { maximumHp: 100000, maximumAp: 0 }, extraGaugeMaximum: 99 });

    it("SCN-BTL-004 (R-ORD-01/R-ACT-01): filling the EX gauge during a cycle does not rewrite the reservation already made — the current queue stays AS and only the next queue reserves EX", () => {
      // `06_戦闘状態遷移.md`「キュー生成」#3 は**生成時点の**EXゲージを読む。ASの
      // 使用でゲージが満タンになっても、その周回の予約はASのまま実行される。
      const catalog = new CatalogBuilder()
        .withUnit(
          unitDefinition("UNIT_FILLER", {
            // AS1回でちょうど満タンになる大きさにして、周回ごとにAS→EXが交互になる。
            baseStats: { maximumAp: 2 },
            extraGaugeMaximum: 1,
            activeSkillDefinitionIds: [createSkillDefinitionId("SKL_ATTACK")],
          }),
          inertEnemy("UNIT_WALL"),
        )
        .withSkill(attackSkill("SKL_ATTACK", "ACT_ATTACK"))
        .withEffectAction(damageEffectAction("ACT_ATTACK", 1, "PREVENTED"))
        .build();

      const result = runScenario({
        catalog,
        command: battleCommand({
          allyFormation: { slots: [formationSlot("UNIT_FILLER", 0)], memoryDefinitionIds: [] },
          enemyFormation: { slots: [formationSlot("UNIT_WALL", 0)], memoryDefinitionIds: [] },
          turnLimit: 1,
        }),
      });

      const actor = createBattleUnitId("ally:1");
      // 周回ごとの予約種別。AP2で始まりASのたびにゲージが満タンになるため、
      // AS（AP消費・ゲージ充填）→ EX（ゲージ全量消費）が交互に並ぶ。
      expect(
        result.events
          .filter((event) => event.type === "ACTION_QUEUE_CREATED")
          .map((event) => {
            const details = event.details as {
              cycleNumber: number;
              reservations: readonly { battleUnitId: string; reservedActionKind: string }[];
            };
            return {
              cycle: details.cycleNumber,
              reserved: details.reservations.map((entry) => entry.reservedActionKind),
            };
          }),
      ).toEqual([
        { cycle: 1, reserved: ["AS"] },
        { cycle: 2, reserved: ["EX"] },
        { cycle: 3, reserved: ["AS"] },
        { cycle: 4, reserved: ["EX"] },
      ]);

      // 予約どおりの実効行動が実行され、AS周回ではゲージが満タンへ、EX周回では
      // 全量消費で0へ戻る（`R-ACT-03`「EX: EXゲージ全量、APは消費しない」）。
      expect(
        result.events
          .filter((event) => event.type === "ACTION_STARTED")
          .map((event) => event.details as Record<string, unknown>)
          .map((details) => ({
            reserved: details["reservedActionType"],
            effective: details["effectiveActionType"],
            apBefore: details["apBefore"],
            apAfter: details["apAfter"],
            exBefore: details["exBefore"],
            exAfter: details["exAfter"],
          })),
      ).toEqual([
        { reserved: "AS", effective: "AS", apBefore: 2, apAfter: 1, exBefore: 0, exAfter: 1 },
        { reserved: "EX", effective: "EX", apBefore: 1, apAfter: 1, exBefore: 1, exAfter: 0 },
        { reserved: "AS", effective: "AS", apBefore: 1, apAfter: 0, exBefore: 0, exAfter: 1 },
        { reserved: "EX", effective: "EX", apBefore: 0, apAfter: 0, exBefore: 1, exAfter: 0 },
      ]);

      expect(result.finalState.units[actor]!.extraGauge).toBe(0);
      expect(result.completionReason).toBe("TURN_LIMIT_REACHED");
      assertBattleInvariants(result);
    });

    it("SCN-BTL-005 (Q-BTL-06/R-ACT-03): a unit that is out of AP with a full EX gauge but no usable action drains the whole gauge to WAIT and gains nothing back", () => {
      // 通常の待機はAP1消費＋EXゲージ+1。AP0・EX満タンで行動不能になった待機だけが
      // 「EXゲージ全量消費・増加なし」へ切り替わる（`R-ACT-03` 最終行）。
      const catalog = new CatalogBuilder()
        .withUnit(
          // ASを持たないため常に待機する。EXは「自分以外の味方」を要求するので、
          // 単騎編成では対象候補0体（`R-TGT-01` #4）となり使用できない。
          unitDefinition("UNIT_IDLER", {
            baseStats: { maximumAp: 2 },
            extraGaugeMaximum: 2,
            extraSkillDefinitionId: createSkillDefinitionId("SKL_EX_NEEDS_ALLY"),
          }),
          inertEnemy("UNIT_WALL"),
        )
        .withSkill({
          ...selfEffectSkill("SKL_EX_NEEDS_ALLY", []),
          skillType: "EX",
          cost: { resource: "EX_GAUGE", amount: 2 },
          resolution: {
            kind: "IMMEDIATE",
            targetBindings: [
              { targetBindingId: createTargetBindingId("TGT_ALLY"), selector: OTHER_ALLY_ONE },
            ],
            steps: [],
          },
        })
        .build();

      const result = runScenario({
        catalog,
        command: battleCommand({
          allyFormation: { slots: [formationSlot("UNIT_IDLER", 0)], memoryDefinitionIds: [] },
          enemyFormation: { slots: [formationSlot("UNIT_WALL", 0)], memoryDefinitionIds: [] },
          turnLimit: 1,
        }),
      });

      expect(
        result.events
          .filter((event) => event.type === "ACTION_WAITED")
          .map((event) => event.details as Record<string, unknown>)
          .map((details) => ({
            waitReason: details["waitReason"],
            consumedResource: details["consumedResource"],
            consumedAmount: details["consumedAmount"],
          })),
      ).toEqual([
        // AP が残っている間は通常の待機（AP1消費）。
        { waitReason: "NO_USABLE_ACTIVE_SKILL", consumedResource: "AP", consumedAmount: 1 },
        { waitReason: "NO_USABLE_ACTIVE_SKILL", consumedResource: "AP", consumedAmount: 1 },
        // AP0・EX満タン。予約はEXになるが使用できないため、ゲージ全量を消費して待機する。
        { waitReason: "EX_UNUSABLE", consumedResource: "EX_GAUGE", consumedAmount: 2 },
      ]);

      // 通常の待機はEXゲージを+1し、全量消費の待機は増やさない（`R-ACT-03`）。
      expect(
        result.events
          .filter((event) => event.type === "ACTION_STARTED")
          .map((event) => event.details as Record<string, unknown>)
          .map((details) => ({
            effective: details["effectiveActionType"],
            apBefore: details["apBefore"],
            apAfter: details["apAfter"],
            exBefore: details["exBefore"],
            exAfter: details["exAfter"],
          })),
      ).toEqual([
        { effective: "WAIT", apBefore: 2, apAfter: 1, exBefore: 0, exAfter: 1 },
        { effective: "WAIT", apBefore: 1, apAfter: 0, exBefore: 1, exAfter: 2 },
        { effective: "WAIT", apBefore: 0, apAfter: 0, exBefore: 2, exAfter: 0 },
      ]);

      const actor = createBattleUnitId("ally:1");
      expect(result.finalState.units[actor]!.ap).toBe(0);
      expect(result.finalState.units[actor]!.extraGauge).toBe(0);
      assertBattleInvariants(result);
    });
  });

  describe("M9 effect duration and stacking (REL-003)", () => {
    /**
     * 効果期間のシナリオは「誰の行動／どのターンで減るか」だけを見たい。バフを配る
     * ASはクールタイムで1回に限定し、以降の行動機会は待機へ落とす（待機も1行動として
     * `R-EFF-04` の減算契機になるため、対照として必要）。
     */
    const buffSkill = (id: string, effectActionIds: readonly string[]): SkillDefinition => ({
      ...selfEffectSkill(id, effectActionIds),
      cooldown: { unit: "TURN", count: 9 },
    });

    /**
     * 期間・重複の観測に必要な公開イベントだけを、発生順の読める形へ落とす。
     * `EFFECT_DURATION_REDUCED` は効果インスタンスIDしか持たないため、`EFFECT_APPLIED`
     * が公開する対応関係で由来定義へ引き直す（インスタンスIDは発番順に依存し、
     * 期待値には書けない）。
     */
    const durationTimeline = (result: ReturnType<typeof runScenario>) => {
      const definitionOfInstance = new Map<string, string>();
      for (const event of result.events) {
        if (event.type !== "EFFECT_APPLIED") {
          continue;
        }
        const details = event.details as Record<string, unknown>;
        definitionOfInstance.set(
          String(details["effectInstanceId"]),
          String(details["effectActionDefinitionId"]),
        );
      }
      return result.events
        .filter((event) =>
          [
            "ACTION_STARTED",
            "TURN_COMPLETING",
            "EFFECT_APPLIED",
            "EFFECT_DURATION_REDUCED",
            "EFFECT_EXPIRED",
          ].includes(event.type),
        )
        .map((event) => {
          const details = event.details as Record<string, unknown>;
          switch (event.type) {
            case "ACTION_STARTED":
              return `ACTION(${String(details["actorUnitId"])}, ${String(details["effectiveActionType"])})`;
            case "TURN_COMPLETING":
              return `TURN_COMPLETING(${String(details["turnNumber"])})`;
            case "EFFECT_DURATION_REDUCED": {
              const definitionId =
                definitionOfInstance.get(String(details["effectInstanceId"])) ??
                String(details["effectInstanceId"]);
              return `REDUCED(${definitionId}, ${String(details["before"])}->${String(details["after"])})`;
            }
            case "EFFECT_EXPIRED":
              return `EXPIRED(${String(details["effectActionDefinitionId"])}, ${String(details["reason"])})`;
            default:
              return `APPLIED(${String(details["effectActionDefinitionId"])})`;
          }
        });
    };

    it("SCN-BTL-011 (R-EFF-04): an ACTION-scoped effect is not decremented by the action that granted it, nor by anyone else's action — only the holder's own next action end reduces it to zero and expires it", () => {
      const catalog = new CatalogBuilder()
        .withUnit(
          unitDefinition("UNIT_BUFFER", {
            // 2周回だけ行動させる（1周目でバフ付与、2周目の待機で失効させる）。
            baseStats: { maximumAp: 2 },
            activeSkillDefinitionIds: [createSkillDefinitionId("SKL_SELF_BUFF")],
          }),
          // ASを持たない敵。待機するだけで、保持者以外の行動が減算しないことの対照になる。
          unitDefinition("UNIT_BYSTANDER", { baseStats: { maximumHp: 1000, maximumAp: 2 } }),
        )
        .withSkill(buffSkill("SKL_SELF_BUFF", ["ACT_ATK_UP"]))
        .withEffectAction(
          statModEffectAction("ACT_ATK_UP", { value: 5, timeLimit: { unit: "ACTION", count: 1 } }),
        )
        .build();

      const result = runScenario({
        catalog,
        command: battleCommand({
          allyFormation: { slots: [formationSlot("UNIT_BUFFER", 0)], memoryDefinitionIds: [] },
          enemyFormation: { slots: [formationSlot("UNIT_BYSTANDER", 0)], memoryDefinitionIds: [] },
          turnLimit: 1,
        }),
      });

      expect(durationTimeline(result)).toEqual([
        // #2 付与した当の行動では減らさない。
        "ACTION(ally:1, AS)",
        "APPLIED(ACT_ATK_UP)",
        // #4 対象以外のユニットの行動では減らさない。
        "ACTION(enemy:1, WAIT)",
        // #3/#5 保持者自身の次の行動終了で1減り、0になった時点で即時失効する。
        "ACTION(ally:1, WAIT)",
        "REDUCED(ACT_ATK_UP, 1->0)",
        "EXPIRED(ACT_ATK_UP, TIME_LIMIT)",
        "ACTION(enemy:1, WAIT)",
        "TURN_COMPLETING(1)",
      ]);

      // #6 失効後に実効ステータスが戻る（付与中は15、戦闘終了時点では基礎値10）。
      expect(
        result.events
          .filter((event) => event.type === "COMBAT_STAT_CHANGED")
          .map((event) => {
            const details = event.details as Record<string, unknown>;
            return { stat: details["stat"], before: details["before"], after: details["after"] };
          }),
      ).toEqual([
        { stat: "ATTACK", before: 10, after: 15 },
        { stat: "ATTACK", before: 15, after: 10 },
      ]);
      expect(result.finalState.units[createBattleUnitId("ally:1")]!.combatStats.attack).toBe(10);
      assertBattleInvariants(result);
    });

    it("SCN-BTL-012 (R-EFF-06): a TURN-scoped effect is not decremented by the turn that granted it — it survives every action of that turn and expires at the end of the following turn", () => {
      const catalog = new CatalogBuilder()
        .withUnit(
          unitDefinition("UNIT_BUFFER", {
            baseStats: { maximumAp: 1 },
            activeSkillDefinitionIds: [createSkillDefinitionId("SKL_SELF_BUFF")],
          }),
          unitDefinition("UNIT_BYSTANDER", { baseStats: { maximumHp: 1000, maximumAp: 1 } }),
        )
        .withSkill(buffSkill("SKL_SELF_BUFF", ["ACT_ATK_UP"]))
        .withEffectAction(
          statModEffectAction("ACT_ATK_UP", { value: 5, timeLimit: { unit: "TURN", count: 1 } }),
        )
        .build();

      const result = runScenario({
        catalog,
        command: battleCommand({
          allyFormation: { slots: [formationSlot("UNIT_BUFFER", 0)], memoryDefinitionIds: [] },
          enemyFormation: { slots: [formationSlot("UNIT_BYSTANDER", 0)], memoryDefinitionIds: [] },
          turnLimit: 2,
        }),
      });

      expect(durationTimeline(result)).toEqual([
        "ACTION(ally:1, AS)",
        "APPLIED(ACT_ATK_UP)",
        "ACTION(enemy:1, WAIT)",
        // #2 付与ターンの終了では減らさない（行動単位と違い、保持者の行動でも減らない）。
        "TURN_COMPLETING(1)",
        "ACTION(ally:1, WAIT)",
        "ACTION(enemy:1, WAIT)",
        // #3/#4 次のターン終了から減り、0で即時失効する。
        "TURN_COMPLETING(2)",
        "REDUCED(ACT_ATK_UP, 1->0)",
        "EXPIRED(ACT_ATK_UP, TIME_LIMIT)",
      ]);
      expect(result.finalState.units[createBattleUnitId("ally:1")]!.combatStats.attack).toBe(10);
      assertBattleInvariants(result);
    });

    it("SCN-BTL-013 (R-EFF-05): two STACKABLE instances of the same effect kind are held separately with their own remaining counts, both contribute to the effective stat at once, and each expires on its own schedule", () => {
      // このシナリオの定義は `kindKey` を宣言しないため `EffectKindKey` は定義IDそのもの
      // になり（`applied-effect.ts`）、**同じ定義を2回**適用しないと「同種」にならない。別定義2件では `stacking.mode` を
      // `NON_STACKABLE` へ取り違えても両方が加算されてしまい、重複ありの検証にならない。
      //
      // 盤面・スキル・行動列は `SCN-BTL-014` と同一で、違いは `stacking.mode` だけに
      // してある。2つのシナリオが互いの対照になり、モードの取り違えはどちらかで必ず落ちる。
      const catalog = new CatalogBuilder()
        .withUnit(
          unitDefinition("UNIT_BUFFER", {
            // 4行動ぶんのAP。クールタイム1行動と合わせて「付与 → 待機 → 付与 → 待機」になる。
            baseStats: { maximumHp: 100, maximumAp: 4 },
            activeSkillDefinitionIds: [createSkillDefinitionId("SKL_SELF_BUFF")],
          }),
          unitDefinition("UNIT_BYSTANDER", { baseStats: { maximumHp: 1000, maximumAp: 0 } }),
        )
        .withSkill({
          ...selfEffectSkill("SKL_SELF_BUFF", ["ACT_ATK_UP", "ACT_HP_COST"]),
          cooldown: { unit: "ACTION", count: 1 },
        })
        .withEffectAction(
          // 効果量に差を付けるため、付与額を使用者の現在HPに比例させ、同じスキルの
          // 中でHPを半分支払わせる（付与 → 支払いの順）。1件目は+10、2件目は+5。
          hpScaledStatModEffectAction("ACT_ATK_UP", {
            ratio: 0.1,
            count: 2,
            stackingMode: "STACKABLE",
          }),
          hpCostEffectAction("ACT_HP_COST", 0.5),
        )
        .build();

      const result = runScenario({
        catalog,
        command: battleCommand({
          allyFormation: { slots: [formationSlot("UNIT_BUFFER", 0)], memoryDefinitionIds: [] },
          enemyFormation: { slots: [formationSlot("UNIT_BYSTANDER", 0)], memoryDefinitionIds: [] },
          turnLimit: 1,
        }),
      });

      expect(durationTimeline(result)).toEqual([
        // HP100で1件目（+10）。付与後にHPを50へ落とす。
        "ACTION(ally:1, AS)",
        "APPLIED(ACT_ATK_UP)",
        // 残り回数はインスタンスごとに独立して減る。
        "ACTION(ally:1, WAIT)",
        "REDUCED(ACT_ATK_UP, 2->1)",
        // HP50で2件目（+5）。同種2件を同時に保持する。
        "ACTION(ally:1, AS)",
        "APPLIED(ACT_ATK_UP)",
        "REDUCED(ACT_ATK_UP, 1->0)",
        "EXPIRED(ACT_ATK_UP, TIME_LIMIT)",
        // 残った2件目だけが自分の予定で減り続ける。
        "ACTION(ally:1, WAIT)",
        "REDUCED(ACT_ATK_UP, 2->1)",
        "TURN_COMPLETING(1)",
      ]);

      // 重複ありは保持中の全インスタンスが加算される。2件を同時に持つ間だけ+15になり
      // （10 → 20 → 25）、1件目が失効すると2件目のぶんだけが残る（→ 15）。
      // 同じ行動列を `NON_STACKABLE` で回す `SCN-BTL-014` は 20 → 15 にしかならない。
      expect(
        result.events
          .filter((event) => event.type === "COMBAT_STAT_CHANGED")
          .map((event) => (event.details as Record<string, unknown>)["after"]),
      ).toEqual([20, 25, 15]);
      expect(result.finalState.units[createBattleUnitId("ally:1")]!.combatStats.attack).toBe(15);
      assertBattleInvariants(result);
    });

    it("SCN-BTL-014 (R-EFF-05): NON_STACKABLE instances of the same effect kind are all held individually but only the strongest counts — the dormant one keeps ticking, and it is promoted the moment the strongest expires", () => {
      // このシナリオの定義は `kindKey` を宣言しないため `EffectKindKey` は定義IDそのもの
      // になり（`applied-effect.ts`）、「同種」を作るには**同じ定義を2回**適用するしかない。効果量に差を付けるため、付与額を使用者の
      // 現在HPに比例させ、同じスキルの中でHPを半分支払わせる（付与 → 支払いの順）。
      const catalog = new CatalogBuilder()
        .withUnit(
          unitDefinition("UNIT_BUFFER", {
            // 4行動ぶんのAP。クールタイム1行動と合わせて「付与 → 待機 → 付与 → 待機」になる。
            baseStats: { maximumHp: 100, maximumAp: 4 },
            activeSkillDefinitionIds: [createSkillDefinitionId("SKL_SELF_BUFF")],
          }),
          unitDefinition("UNIT_BYSTANDER", { baseStats: { maximumHp: 1000, maximumAp: 0 } }),
        )
        .withSkill({
          ...selfEffectSkill("SKL_SELF_BUFF", ["ACT_ATK_UP", "ACT_HP_COST"]),
          cooldown: { unit: "ACTION", count: 1 },
        })
        .withEffectAction(
          hpScaledStatModEffectAction("ACT_ATK_UP", { ratio: 0.1, count: 2 }),
          hpCostEffectAction("ACT_HP_COST", 0.5),
        )
        .build();

      const result = runScenario({
        catalog,
        command: battleCommand({
          allyFormation: { slots: [formationSlot("UNIT_BUFFER", 0)], memoryDefinitionIds: [] },
          enemyFormation: { slots: [formationSlot("UNIT_BYSTANDER", 0)], memoryDefinitionIds: [] },
          turnLimit: 1,
        }),
      });

      expect(durationTimeline(result)).toEqual([
        // HP100で1件目（+10）。付与後にHPを50へ落とす。
        "ACTION(ally:1, AS)",
        "APPLIED(ACT_ATK_UP)",
        // クールタイム中の待機。非採用インスタンスはまだ無く、1件目だけが減る。
        "ACTION(ally:1, WAIT)",
        "REDUCED(ACT_ATK_UP, 2->1)",
        // HP50で2件目（+5）。同種なので保持は2件になるが、採用は依然として+10の方。
        // 減算・失効はこの行動の**終了時**なので、付与の後に並ぶ。
        "ACTION(ally:1, AS)",
        "APPLIED(ACT_ATK_UP)",
        "REDUCED(ACT_ATK_UP, 1->0)",
        "EXPIRED(ACT_ATK_UP, TIME_LIMIT)",
        // 「次点効果の残り期間は、非採用中も通常どおり個別に減算する」。
        "ACTION(ally:1, WAIT)",
        "REDUCED(ACT_ATK_UP, 2->1)",
        "TURN_COMPLETING(1)",
      ]);

      // 重複なしは最強1件だけを計算へ採用する。2件保持しても+10と+5は加算されず、
      // 最強が失効した瞬間に次点（+5）へ繰り上がって15になる（基礎値10へは戻らない）。
      expect(
        result.events
          .filter((event) => event.type === "COMBAT_STAT_CHANGED")
          .map((event) => (event.details as Record<string, unknown>)["after"]),
      ).toEqual([20, 15]);
      expect(result.finalState.units[createBattleUnitId("ally:1")]!.combatStats.attack).toBe(15);
      assertBattleInvariants(result);
    });
  });

  describe("M9 interruption, charge and status ailments (REL-003)", () => {
    /**
     * 実効行動の並び（誰が・何をしたか・待機理由）。行動レベルの契約を1行で読む。
     * `ACTION_WAITED` は同じ行動の中で `ACTION_STARTED` の後に出るため、直前の
     * `ACTION_STARTED` へ結び付ける（親子関係は解決スコープ側を指すので使えない）。
     */
    const actionTimeline = (result: ReturnType<typeof runScenario>) => {
      const timeline: string[] = [];
      for (const event of result.events) {
        if (event.type === "ACTION_STARTED") {
          const details = event.details as Record<string, unknown>;
          timeline.push(
            `${String(details["actorUnitId"])}:${String(details["effectiveActionType"])}`,
          );
        } else if (event.type === "ACTION_WAITED" && timeline.length > 0) {
          const reason = String((event.details as Record<string, unknown>)["waitReason"]);
          timeline[timeline.length - 1] = `${timeline[timeline.length - 1]!}(${reason})`;
        }
      }
      return timeline;
    };

    it("SCN-BTL-009 (R-SKL-01): when the user is defeated in the middle of its own skill, the remaining steps are interrupted — the later step's EffectAction never runs and SkillUseInterrupted is emitted instead of SkillUseCompleted", () => {
      // R-ATM-01により、効果処理中のFACTイベントを契機とするPSは効果処理の完了後
      // まで発動しない。したがって使用者がスキル解決の途中で倒れる経路は、PS連鎖
      // ではなく効果処理自身が使用者のHPを削る形（自傷コスト・反射・リンク）に
      // 限られる。ここではHPコスト（`MODIFY_RESOURCE`）で決定的に作る。
      const threeStepSkill: SkillDefinition = {
        ...selfEffectSkill("SKL_TWO_STEPS", []),
        resolution: {
          kind: "IMMEDIATE",
          targetBindings: [
            { targetBindingId: createTargetBindingId("TGT_1"), selector: ENEMY_ALL },
          ],
          steps: [
            {
              kind: "ACTION",
              stepCondition: { kind: "TRUE" },
              targetCondition: { kind: "TRUE" },
              target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
              actions: [{ effectActionDefinitionId: createEffectActionDefinitionId("ACT_POKE") }],
            },
            // 2番目のstepで使用者自身のHPを全額支払い、戦闘不能になる。
            {
              kind: "ACTION",
              stepCondition: { kind: "TRUE" },
              targetCondition: { kind: "TRUE" },
              target: { kind: "SELF" },
              actions: [
                { effectActionDefinitionId: createEffectActionDefinitionId("ACT_SELF_COST") },
              ],
            },
            // 3番目のstepは使用者自身へのバフ。中断されれば `EFFECT_APPLIED` が
            // 1件も出ないため、「走らなかった」ことを不在で固定できる。
            {
              kind: "ACTION",
              stepCondition: { kind: "TRUE" },
              targetCondition: { kind: "TRUE" },
              target: { kind: "SELF" },
              actions: [{ effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATK_UP") }],
            },
          ],
        },
      };
      const catalog = new CatalogBuilder()
        .withUnit(
          unitDefinition("UNIT_FRAGILE", {
            baseStats: { maximumHp: 10, defense: 0, maximumAp: 1 },
            activeSkillDefinitionIds: [createSkillDefinitionId("SKL_TWO_STEPS")],
          }),
          unitDefinition("UNIT_COUNTER", {
            baseStats: { maximumHp: 1000, attack: 999, defense: 0, maximumAp: 0 },
          }),
        )
        .withSkill(threeStepSkill)
        .withEffectAction(
          damageEffectAction("ACT_POKE", 1, "PREVENTED"),
          hpCostEffectAction("ACT_SELF_COST", 1),
          statModEffectAction("ACT_ATK_UP"),
        )
        .build();

      const result = runScenario({
        catalog,
        command: battleCommand({
          allyFormation: { slots: [formationSlot("UNIT_FRAGILE", 0)], memoryDefinitionIds: [] },
          enemyFormation: { slots: [formationSlot("UNIT_COUNTER", 0)], memoryDefinitionIds: [] },
          turnLimit: 3,
        }),
        randomValues: Array.from({ length: 20 }, () => 0.99),
      });

      const types = result.events.map((event) => event.type);
      // 使用者は自分のスキル解決の途中で倒れる。
      expect(
        result.events
          .filter((event) => event.type === "SKILL_USE_INTERRUPTED")
          .map((event) => (event.details as Record<string, unknown>)["skillDefinitionId"]),
      ).toEqual(["SKL_TWO_STEPS"]);
      expect(types).not.toContain("SKILL_USE_COMPLETED");
      // 実行されたEffectActionは1・2番目のstepだけで、3番目のstepの
      // `ACT_ATK_UP` は一度も走らない。
      expect(
        result.events
          .filter((event) => event.type === "EFFECT_ACTION_COMPLETED")
          .map((event) => (event.details as Record<string, unknown>)["effectActionDefinitionId"]),
      ).toEqual(["ACT_POKE", "ACT_SELF_COST"]);
      expect(types).not.toContain("EFFECT_APPLIED");

      // 解決済みの効果は巻き戻さない（1番目のstepのダメージは残る）。
      expect(result.finalState.units[createBattleUnitId("enemy:1")]!.hp).toBe(990);
      expect(result.outcome).toBe("ALLY_LOSE");
      expect(result.completionReason).toBe("ALLY_DEFEATED");
      assertBattleInvariants(result);
    });

    it("SCN-BTL-010 (R-SKL-05/R-ACT-01): a charge occupies two actions, a STUN applied while charging cancels it, and a FREEZE keeps it so the release lands on the action after the freeze ends", () => {
      // 3つの分岐を同じ定義から作り、違いを「チャージ中に何が飛んでくるか」だけにする。
      /** 妨害は1回だけにする（毎周回の再付与でチャージ側の観測が埋まらないように）。 */
      const ONCE_PER_BATTLE = { unit: "TURN", count: 9 } as const;
      const chargeBattle = (
        interrupt: readonly EffectActionDefinition[],
        enemySkills: readonly SkillDefinition[],
        enemyActiveSkillIds: readonly string[],
      ) => {
        const catalog = new CatalogBuilder()
          .withUnit(
            unitDefinition("UNIT_CHARGER", {
              // 先手でチャージを始め、次の行動機会に妨害が届いている形を作る。
              // AP2で「開始 → （妨害があれば待機／無ければ発動）」まで届く。
              baseStats: { maximumHp: 1000, defense: 0, maximumAp: 2, actionSpeed: 99 },
              activeSkillDefinitionIds: [createSkillDefinitionId("SKL_CHARGE")],
            }),
            unitDefinition("UNIT_HECKLER", {
              baseStats: { maximumHp: 1000, defense: 0, maximumAp: 3, actionSpeed: 1 },
              activeSkillDefinitionIds: enemyActiveSkillIds.map((id) =>
                createSkillDefinitionId(id),
              ),
            }),
          )
          .withSkill(
            // チャージは戦闘中1回だけにして、周回ごとの再チャージを観測から外す。
            { ...chargeSkill("SKL_CHARGE", "ACT_BLAST"), cooldown: { unit: "TURN", count: 9 } },
            ...enemySkills,
          )
          .withEffectAction(damageEffectAction("ACT_BLAST", 5, "PREVENTED"), ...interrupt)
          .build();
        return runScenario({
          catalog,
          command: battleCommand({
            allyFormation: { slots: [formationSlot("UNIT_CHARGER", 0)], memoryDefinitionIds: [] },
            enemyFormation: { slots: [formationSlot("UNIT_HECKLER", 0)], memoryDefinitionIds: [] },
            turnLimit: 1,
          }),
          randomValues: Array.from({ length: 20 }, () => 0.99),
        });
      };

      // (a) 妨害なし: チャージ開始と発動は別々の行動になり、発動側でAPを消費しない。
      const plain = chargeBattle([], [], []);
      expect(actionTimeline(plain)).toEqual([
        "ally:1:AS",
        "enemy:1:WAIT(NO_USABLE_ACTIVE_SKILL)",
        // 次の行動機会でAS/EX予約より優先してチャージ効果を発動する。
        "ally:1:CHARGE_RELEASE",
        "enemy:1:WAIT(NO_USABLE_ACTIVE_SKILL)",
        "ally:1:WAIT(NO_USABLE_ACTIVE_SKILL)",
        "enemy:1:WAIT(NO_USABLE_ACTIVE_SKILL)",
      ]);
      const plainCharger = plain.events
        .filter((event) => event.type === "ACTION_STARTED")
        .map((event) => event.details as Record<string, unknown>)
        .filter((details) => details["actorUnitId"] === createBattleUnitId("ally:1"));
      // 開始側でASのコスト（AP1）を払い、発動側では払わない（`R-ACT-03`）。
      expect(plainCharger[0]).toMatchObject({ apBefore: 2, apAfter: 1 });
      expect(plainCharger[1]).toMatchObject({ apBefore: 1, apAfter: 1 });
      // 発動側だけがダメージを出す（開始側の `steps` は空）。
      expect(plain.finalState.units[createBattleUnitId("enemy:1")]!.hp).toBe(950);

      // (b) 気絶: チャージ中に付与されるとチャージをキャンセルする（`R-STS-02`）。
      const stunned = chargeBattle(
        [statusEffectAction("ACT_STUN", "STUN", 1)],
        [
          {
            ...attackSkill("SKL_STUN", "ACT_STUN", { guaranteedHit: true }),
            cooldown: ONCE_PER_BATTLE,
          },
        ],
        ["SKL_STUN"],
      );
      expect(stunned.events.map((event) => event.type)).toContain("CHARGE_CANCELLED");
      // キャンセル後は解放が起きず、敵はダメージを受けない。
      expect(stunned.finalState.units[createBattleUnitId("enemy:1")]!.hp).toBe(1000);
      expect(actionTimeline(stunned)).toEqual([
        "ally:1:AS",
        "enemy:1:AS",
        // 気絶付与でチャージはキャンセル済み。気絶中の行動機会は待機になる。
        "ally:1:WAIT(STUNNED)",
        "enemy:1:WAIT(NO_USABLE_ACTIVE_SKILL)",
        // チャージが残っていないため、気絶が明けても発動する行動は無い。
        "enemy:1:WAIT(NO_USABLE_ACTIVE_SKILL)",
      ]);

      // (c) 凍結: チャージを維持し、解除後の次の行動機会に発動する（`R-STS-03`）。
      const frozen = chargeBattle(
        [statusEffectAction("ACT_FREEZE", "FREEZE", 1)],
        [
          {
            ...attackSkill("SKL_FREEZE", "ACT_FREEZE", { guaranteedHit: true }),
            cooldown: ONCE_PER_BATTLE,
          },
        ],
        ["SKL_FREEZE"],
      );
      expect(frozen.events.map((event) => event.type)).not.toContain("CHARGE_CANCELLED");
      expect(actionTimeline(frozen)).toEqual([
        "ally:1:AS",
        "enemy:1:AS",
        // 凍結中は待機。チャージは保持されたままである（`R-ACT-01` #2）。
        "ally:1:WAIT(FROZEN)",
        "enemy:1:WAIT(NO_USABLE_ACTIVE_SKILL)",
        // 凍結が明けた次の行動機会でチャージ効果を発動する。APは残っていない。
        "ally:1:CHARGE_RELEASE",
        "enemy:1:WAIT(NO_USABLE_ACTIVE_SKILL)",
      ]);
      expect(frozen.finalState.units[createBattleUnitId("enemy:1")]!.hp).toBe(950);
    });

    it("SCN-BTL-018 (R-STS-02/03/04): STUN and FREEZE both force a WAIT with their own reason, an attack thaws FREEZE with the +50% amplification, and BLIND makes even a guaranteed-hit skill MISS", () => {
      // 状態異常を配る側は先手・1回だけ。以降の行動機会は素の攻撃（`SKL_STRIKE`）へ回り、
      // 「状態異常を受けた側がその行動機会に何をするか」だけが観測に残る。
      const ailmentBattle = (
        statusActionId: string,
        status: "STUN" | "FREEZE" | "BLIND",
        count: number,
      ) => {
        const catalog = new CatalogBuilder()
          .withUnit(
            unitDefinition("UNIT_AILER", {
              baseStats: { maximumHp: 1000, defense: 0, maximumAp: 2, actionSpeed: 99 },
              activeSkillDefinitionIds: [
                createSkillDefinitionId("SKL_AIL"),
                createSkillDefinitionId("SKL_STRIKE"),
              ],
            }),
            unitDefinition("UNIT_VICTIM", {
              baseStats: { maximumHp: 1000, defense: 0, maximumAp: 2, actionSpeed: 1 },
              activeSkillDefinitionIds: [createSkillDefinitionId("SKL_STRIKE")],
            }),
          )
          .withSkill(
            {
              ...attackSkill("SKL_AIL", statusActionId, { guaranteedHit: true }),
              cooldown: { unit: "TURN", count: 9 },
            },
            attackSkill("SKL_STRIKE", "ACT_STRIKE", { guaranteedHit: true }),
          )
          .withEffectAction(
            statusEffectAction(statusActionId, status, count),
            damageEffectAction("ACT_STRIKE", 1, "PREVENTED"),
          )
          .build();
        return runScenario({
          catalog,
          command: battleCommand({
            allyFormation: { slots: [formationSlot("UNIT_AILER", 0)], memoryDefinitionIds: [] },
            enemyFormation: { slots: [formationSlot("UNIT_VICTIM", 0)], memoryDefinitionIds: [] },
            turnLimit: 1,
          }),
          randomValues: Array.from({ length: 40 }, () => 0.99),
        });
      };

      // R-STS-02: 気絶中はAS/PS/EXを新たに使用できず、行動機会を待機で消化する。
      // 1行動ぶんの気絶なので、その待機自体が残り回数を消化して次の機会には戻る。
      const stun = ailmentBattle("ACT_STUN", "STUN", 1);
      expect(actionTimeline(stun)).toEqual([
        "ally:1:AS",
        "enemy:1:WAIT(STUNNED)",
        "ally:1:AS",
        "enemy:1:AS",
      ]);

      // R-STS-03: 凍結も行動機会を待機させるが、待機理由が別であること、そして
      // 「新たな攻撃スキルによるダメージで解除する」ことが気絶との違いになる。
      const freeze = ailmentBattle("ACT_FREEZE", "FREEZE", 2);
      expect(actionTimeline(freeze)).toEqual([
        "ally:1:AS",
        "enemy:1:WAIT(FROZEN)",
        // 2行動ぶんの凍結なので待機1回では明けない。ここで攻撃が届いて解除される。
        "ally:1:AS",
        "enemy:1:AS",
      ]);
      // 解除契機となったダメージは凍結の増幅率（既定 +50%）だけ増える。
      // 攻撃力10 - 防御力0 = 10 が 15 になる。
      expect(
        freeze.events
          .filter((event) => event.type === "DAMAGE_APPLIED")
          .map((event) => (event.details as Record<string, unknown>)["calculatedDamage"]),
      ).toEqual([15, 10]);
      // 解除そのものは `FreezeRemoved` が単独で持つ（期間切れの `EffectExpired` とは別）。
      expect(
        freeze.events
          .filter((event) => event.type === "FREEZE_REMOVED")
          .map((event) => (event.details as Record<string, unknown>)["battleUnitId"]),
      ).toEqual([createBattleUnitId("enemy:1")]);

      // R-STS-04: 暗闇は必中（`traits.accuracy.guaranteedHit: true`）を無視してMISSさせる。
      const blind = ailmentBattle("ACT_BLIND", "BLIND", 2);
      // 暗闇の保持者が使ったスキルだけが、`EffectSequence` を一切解決せずMISSになる。
      expect(
        blind.events
          .filter((event) => event.type === "SKILL_MISSED")
          .map((event) => ({
            skill: (event.details as Record<string, unknown>)["skillDefinitionId"],
            actor: event.sourceUnitId,
          })),
      ).toEqual([
        { skill: "SKL_STRIKE", actor: createBattleUnitId("enemy:1") },
        { skill: "SKL_STRIKE", actor: createBattleUnitId("enemy:1") },
      ]);
      // MISSした攻撃はダメージを一切通さない（暗闇の保持者だけが外す）。
      expect(blind.finalState.units[createBattleUnitId("ally:1")]!.hp).toBe(1000);
      // 対照: 暗闇を持たない側（暗闇を配った当人）の攻撃は通常どおり命中している。
      expect(blind.finalState.units[createBattleUnitId("enemy:1")]!.hp).toBe(990);
    });
  });

  describe("M8 advanced damage (DMG-011)", () => {
    const untypedShield = (id: string, amount: number): EffectActionDefinition => ({
      kind: "APPLY_SHIELD",
      effectActionDefinitionId: createEffectActionDefinitionId(id),
      metadata: { tags: [] },
      payload: {
        formula: { kind: "CONSTANT", value: amount },
        duration: { dispellable: true, linkedEffectGroupId: null },
      },
    });

    const typedShield = (
      id: string,
      amount: number,
      shieldType: "PHYSICAL" | "EN",
    ): EffectActionDefinition => ({
      kind: "APPLY_SHIELD",
      effectActionDefinitionId: createEffectActionDefinitionId(id),
      metadata: { tags: [] },
      payload: {
        formula: { kind: "CONSTANT", value: amount },
        shieldType,
        duration: { dispellable: true, linkedEffectGroupId: null },
      },
    });

    const subUnit = (id: string, durability: number): EffectActionDefinition => ({
      kind: "APPLY_SUBUNIT",
      effectActionDefinitionId: createEffectActionDefinitionId(id),
      metadata: { tags: [] },
      payload: {
        durability: { formula: { kind: "CONSTANT", value: durability } },
        additionalDamage: {
          formula: {
            kind: "SUBUNIT_ADDITIONAL_DAMAGE",
            ownerAttack: "CURRENT_ATTACK",
            providerAttack: "SOURCE_SNAPSHOT_ATTACK",
            skillMultiplier: 0.1,
            targetDefense: "TARGET_CURRENT_DEFENSE",
          },
        },
        duration: { dispellable: true, linkedEffectGroupId: null },
      },
    });

    /**
     * 指定した順の ACTION step だけを持つ AS。各stepは1つのbindingを対象にする
     * （`bindingId: "SELF"` だけは使用者自身を指す）。`cooldownTurns` を渡すと
     * 複数ターンのシナリオでも初回1回だけ使われる。
     */
    const stagedSkill = (
      id: string,
      bindings: readonly {
        readonly bindingId: string;
        readonly selector: TargetSelectorDefinition;
      }[],
      steps: readonly { readonly bindingId: string; readonly actionIds: readonly string[] }[],
      cooldownTurns = 0,
    ): SkillDefinition => ({
      skillDefinitionId: createSkillDefinitionId(id),
      skillType: "AS",
      cost: { resource: "AP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [],
      counterUpdates: [],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: bindings.map((binding) => ({
          targetBindingId: createTargetBindingId(binding.bindingId),
          selector: binding.selector,
        })),
        steps: steps.map((step) => ({
          kind: "ACTION" as const,
          stepCondition: { kind: "TRUE" as const },
          targetCondition: { kind: "TRUE" as const },
          // `"SELF"` は binding ではなく使用者自身を指す `TargetReference`。
          target:
            step.bindingId === "SELF"
              ? ({ kind: "SELF" } as const)
              : ({
                  kind: "BINDING" as const,
                  targetBindingId: createTargetBindingId(step.bindingId),
                } as const),
          actions: step.actionIds.map((actionId) => ({
            effectActionDefinitionId: createEffectActionDefinitionId(actionId),
          })),
        })),
      },
      cooldown:
        cooldownTurns > 0 ? { unit: "TURN", count: cooldownTurns } : { unit: "ACTION", count: 0 },
      traits: {
        priorityAttack: false,
        simultaneousActivationLimited: false,
        exclusiveActivationGroupId: null,
        accuracy: { guaranteedHit: true },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      },
      metadata: { displayName: id, tags: [] },
    });

    const enemyAtColumn = (column: "LEFT" | "CENTER" | "RIGHT"): TargetSelectorDefinition => ({
      kind: "SELECT",
      side: "ENEMY",
      count: 1,
      filters: [{ kind: "POSITION_COLUMN", column }],
      order: ["DEFAULT"],
      includeDefeated: false,
    });

    // `12_テスト戦略.md`の`SCN-BTL-015`は重点確認を「物理／EN→無属性→サブユニット→HP」
    // と定めているため、物理・ENの両経路を同じ編成で対称に確認する。
    // どちらの向きでも、対応するタイプありシールドだけが消費され、対応しない側は
    // 無傷で残らなければならない（`R-SHD-02`末尾）。
    it.each([
      { damageType: "PHYSICAL" as const, untouched: "EN" as const },
      { damageType: "EN" as const, untouched: "PHYSICAL" as const },
    ])(
      "SCN-BTL-015 [R-ACTN-02, R-DMG-05] (R-SHD-01〜03/R-SUB-01, $damageType damage): one hit drains the matching typed shield, then the untyped shield, then the sub unit, and only the remainder reaches HP — while the $untouched shield is untouched",
      ({ damageType, untouched }) => {
        // 攻撃力100 - 防御力20 = 計算ダメージ80（会心PREVENTED・属性相性1・貫通なし）。
        // 対応シールド10 → 無属性10 → サブユニット10 → HP50 の順で振り分けられる。
        // 非対応のタイプありシールド10は適用先ではないため残る（R-SHD-02「対応しない
        // タイプありシールドへダメージを適用しない」）。
        const catalog = new CatalogBuilder()
          .withUnit(
            unitDefinition("UNIT_ATK", {
              baseStats: { maximumAp: 1, attack: 100 },
              activeSkillDefinitionIds: [createSkillDefinitionId("SKL_SHIELD_THEN_HIT")],
            }),
            unitDefinition("UNIT_DEF", { baseStats: { maximumHp: 200, defense: 20 } }),
          )
          .withSkill(
            stagedSkill(
              "SKL_SHIELD_THEN_HIT",
              [{ bindingId: "TGT_1", selector: ENEMY_ALL }],
              [
                {
                  bindingId: "TGT_1",
                  actionIds: [
                    "ACT_SHIELD_PHYSICAL",
                    "ACT_SHIELD_EN",
                    "ACT_SHIELD_UNTYPED",
                    "ACT_SUBUNIT",
                  ],
                },
                { bindingId: "TGT_1", actionIds: ["ACT_HIT"] },
              ],
            ),
          )
          .withEffectAction(
            typedShield("ACT_SHIELD_PHYSICAL", 10, "PHYSICAL"),
            typedShield("ACT_SHIELD_EN", 10, "EN"),
            untypedShield("ACT_SHIELD_UNTYPED", 10),
            subUnit("ACT_SUBUNIT", 10),
            damageEffectAction("ACT_HIT", 1, "PREVENTED", damageType),
          )
          .build();

        const result = runScenario({
          catalog,
          command: battleCommand({
            allyFormation: { slots: [formationSlot("UNIT_ATK", 0)], memoryDefinitionIds: [] },
            enemyFormation: { slots: [formationSlot("UNIT_DEF", 0)], memoryDefinitionIds: [] },
            turnLimit: 1,
          }),
          randomValues: Array.from({ length: 20 }, () => 0.99),
        });

        const applied = result.events.filter((event) => event.type === "DAMAGE_APPLIED");
        expect(applied).toHaveLength(1);
        expect(applied[0]!.details).toMatchObject({
          calculatedDamage: 80,
          typedShieldAbsorbed: 10,
          untypedShieldAbsorbed: 10,
          subUnitAbsorbed: 10,
          hitPointDamage: 50,
          discardedDamage: 0,
        });

        // R-SHD-02の適用順が吸収イベントの発行順としても観測できる。対応する
        // タイプありシールドが先頭で、非対応の側は一度も現れない。
        const absorptions = result.events
          .filter((event) => event.type === "SHIELD_CONSUMED" || event.type === "SUB_UNIT_DAMAGED")
          .map((event) => ({
            type: event.type,
            shieldType: (event.details as { shieldType?: string | null }).shieldType,
          }));
        expect(absorptions).toEqual([
          { type: "SHIELD_CONSUMED", shieldType: damageType },
          { type: "SHIELD_CONSUMED", shieldType: null },
          { type: "SUB_UNIT_DAMAGED", shieldType: undefined },
        ]);
        expect(absorptions.map((absorption) => absorption.shieldType)).not.toContain(untouched);

        const restored = reduceStateDeltas(
          result.initialState,
          result.stateTransitions.map((transition) => transition.stateDelta),
        );
        expect(restored).toEqual(result.finalState);
      },
    );

    it("SCN-BTL-016 [R-DMG-05] (R-LNK-01〜03): both link destinations take the same undivided amount, absorb it with their own shields, and generate no further link", () => {
      // リンク元（LEFT）への1ヒットが、CENTER と RIGHT の2つのリンク先へ
      // それぞれ 元ダメージ×50% を発生させる（対象数で分割しない）。CENTER だけが
      // 自前のシールドを持ち、そのシールドでリンクダメージを吸収する。
      // リンクダメージからさらにリンクは発生しない。
      const linkTo = (id: string, bindingId: string): EffectActionDefinition => ({
        kind: "APPLY_DAMAGE_LINK",
        effectActionDefinitionId: createEffectActionDefinitionId(id),
        metadata: { tags: [] },
        payload: {
          linkTo: { kind: "BINDING", targetBindingId: createTargetBindingId(bindingId) },
          polarity: "DEBUFF",
          linkRate: 0.5,
          duration: { dispellable: false, linkedEffectGroupId: null },
        },
      });

      const catalog = new CatalogBuilder()
        .withUnit(
          unitDefinition("UNIT_ATK", {
            baseStats: { maximumAp: 1, attack: 100 },
            activeSkillDefinitionIds: [createSkillDefinitionId("SKL_LINK_THEN_HIT")],
          }),
          unitDefinition("UNIT_DEF", { baseStats: { maximumHp: 200, defense: 20 } }),
        )
        .withSkill(
          stagedSkill(
            "SKL_LINK_THEN_HIT",
            [
              { bindingId: "TGT_HOLDER", selector: enemyAtColumn("LEFT") },
              { bindingId: "TGT_DEST_SHIELDED", selector: enemyAtColumn("CENTER") },
              { bindingId: "TGT_DEST_BARE", selector: enemyAtColumn("RIGHT") },
            ],
            [
              { bindingId: "TGT_DEST_SHIELDED", actionIds: ["ACT_SHIELD_UNTYPED"] },
              { bindingId: "TGT_HOLDER", actionIds: ["ACT_LINK_SHIELDED", "ACT_LINK_BARE"] },
              { bindingId: "TGT_HOLDER", actionIds: ["ACT_HIT"] },
            ],
          ),
        )
        .withEffectAction(
          untypedShield("ACT_SHIELD_UNTYPED", 1000),
          linkTo("ACT_LINK_SHIELDED", "TGT_DEST_SHIELDED"),
          linkTo("ACT_LINK_BARE", "TGT_DEST_BARE"),
          damageEffectAction("ACT_HIT", 1, "PREVENTED"),
        )
        .build();

      const result = runScenario({
        catalog,
        command: battleCommand({
          allyFormation: { slots: [formationSlot("UNIT_ATK", 0)], memoryDefinitionIds: [] },
          enemyFormation: {
            slots: [
              formationSlot("UNIT_DEF", 0),
              formationSlot("UNIT_DEF", 1),
              formationSlot("UNIT_DEF", 2),
            ],
            memoryDefinitionIds: [],
          },
          turnLimit: 1,
        }),
        randomValues: Array.from({ length: 40 }, () => 0.99),
      });

      const generated = result.events.filter((event) => event.type === "LINKED_DAMAGE_GENERATED");
      // 再リンク禁止（R-LNK-03 #2）: リンクダメージの適用が新しいリンクを生まない。
      expect(generated).toHaveLength(2);
      const amounts = generated.map(
        (event) => (event.details as { linkedDamage: number }).linkedDamage,
      );
      // R-LNK-02 #1/#2: リンク先が2体でも各リンク先が同量を受け、件数で割らない。
      expect(amounts).toEqual([40, 40]);

      // R-LNK-02 #4: リンク先ごとに、そのリンク先自身のシールドとHPへ適用する。
      const linkedApplications = result.events
        .filter(
          (event) =>
            event.type === "DAMAGE_APPLIED" &&
            (event.details as { isLinkedDamage?: boolean }).isLinkedDamage === true,
        )
        .map((event) => event.details as Record<string, number>);
      expect(linkedApplications).toHaveLength(2);
      expect(linkedApplications[0]).toMatchObject({
        calculatedDamage: 40,
        untypedShieldAbsorbed: 40,
        hitPointDamage: 0,
      });
      expect(linkedApplications[1]).toMatchObject({
        calculatedDamage: 40,
        untypedShieldAbsorbed: 0,
        hitPointDamage: 40,
      });

      const restored = reduceStateDeltas(
        result.initialState,
        result.stateTransitions.map((transition) => transition.stateDelta),
      );
      expect(restored).toEqual(result.finalState);
    });

    it("SCN-BTL-017 (R-DOT-01/R-DOT-02): a fixed continuous damage keeps using the attack snapshotted at grant time, even after the granter's attack changes", () => {
      // 付与時の攻撃力100 → 固定継続ダメージは毎回 floor(100 × 40%) = 40。
      // 付与直後に付与者自身の攻撃力を半減させても（R-DOT-01 #2「付与後の攻撃力
      // 変化……は計算へ影響しない」）、以降のtickは40のまま変わらない。
      const continuousDamage: EffectActionDefinition = {
        kind: "APPLY_CONTINUOUS_DAMAGE",
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_DOT"),
        metadata: { tags: [] },
        payload: {
          continuousDamageKind: "FIXED",
          damageType: "PHYSICAL",
          formula: {
            kind: "STAT_RATIO",
            source: { kind: "SKILL_SOURCE" },
            stat: "ATTACK",
            ratio: 0.4,
          },
          timing: { eventType: "ActionStarted", targetSelector: "EFFECT_OWNER" },
          duration: {
            timeLimit: { unit: "TURN", count: 5 },
            dispellable: true,
            linkedEffectGroupId: null,
          },
        },
      };
      const halveOwnAttack: EffectActionDefinition = {
        kind: "APPLY_STAT_MOD",
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_SELF_ATTACK_DOWN"),
        metadata: { tags: [] },
        payload: {
          stat: "ATTACK",
          valueType: "RATIO",
          formula: { kind: "CONSTANT", value: -0.5 },
          stacking: { mode: "STACKABLE", max: null },
          duration: {
            timeLimit: { unit: "TURN", count: 5 },
            dispellable: true,
            linkedEffectGroupId: null,
          },
        },
      };

      const catalog = new CatalogBuilder()
        .withUnit(
          unitDefinition("UNIT_ATK", {
            baseStats: { maximumAp: 1, attack: 100, actionSpeed: 20 },
            activeSkillDefinitionIds: [createSkillDefinitionId("SKL_DOT_THEN_WEAKEN")],
          }),
          unitDefinition("UNIT_DEF", { baseStats: { maximumHp: 500, defense: 20 } }),
        )
        .withSkill(
          stagedSkill(
            "SKL_DOT_THEN_WEAKEN",
            [{ bindingId: "TGT_1", selector: ENEMY_ALL }],
            [
              { bindingId: "TGT_1", actionIds: ["ACT_DOT"] },
              { bindingId: "SELF", actionIds: ["ACT_SELF_ATTACK_DOWN"] },
            ],
            9,
          ),
        )
        .withEffectAction(continuousDamage, halveOwnAttack)
        .build();

      const result = runScenario({
        catalog,
        command: battleCommand({
          allyFormation: { slots: [formationSlot("UNIT_ATK", 0)], memoryDefinitionIds: [] },
          enemyFormation: { slots: [formationSlot("UNIT_DEF", 0)], memoryDefinitionIds: [] },
          turnLimit: 3,
        }),
        randomValues: Array.from({ length: 40 }, () => 0.99),
      });

      const ticks = result.events
        .filter((event) => event.type === "CONTINUOUS_DAMAGE_APPLIED")
        .map((event) => event.details as Record<string, unknown>);
      // 付与ターンを含めて複数回発火し、そのすべてが付与時攻撃力ベースのまま。
      expect(ticks.length).toBeGreaterThan(1);
      for (const tick of ticks) {
        expect(tick).toMatchObject({ continuousDamageKind: "FIXED", calculatedDamage: 40 });
      }
      // 対照条件: 付与者の攻撃力が実際に100→50へ下がっている。ここが変わらない
      // ままだと「snapshotだから40のまま」ではなく「そもそも何も変えていない」
      // ことの確認になってしまう。
      const attacker = result.finalState.units[createBattleUnitId("ally:1")];
      expect(attacker?.combatStats.attack).toBe(50);

      const restored = reduceStateDeltas(
        result.initialState,
        result.stateTransitions.map((transition) => transition.stateDelta),
      );
      expect(restored).toEqual(result.finalState);
    });
  });
  describe("M11 base stat enhancement (ENH-003)", () => {
    it("IT-ENH-001 [R-ENH-01, R-ENH-06] (R-ENH-01/06): an enhanced side's starting combatStats are computed from the enhanced base stats, while the other side keeps its Unit definition's baseStats", () => {
      const catalog = new CatalogBuilder()
        .withUnit(
          unitDefinition("UNIT_ALLY", {
            levelGrowth: { hp: 255, attack: 209, defense: 106, actionSpeed: 2 },
          }),
          unitDefinition("UNIT_ENEMY"),
        )
        .build();

      const result = runScenario({
        catalog,
        command: battleCommand({
          allyFormation: {
            slots: [
              {
                ...formationSlot("UNIT_ALLY", 0),
                enhancement: {
                  level: 210,
                  gears: [{ stat: "CRITICAL_RATE", tier: "II", grade: "S" }],
                },
              },
            ],
            memoryDefinitionIds: [],
            enhancement: {
              academyLevels: { unitTypes: { PHYSICAL: 50 }, attributes: { AGGRESSIVE: 50 } },
            },
          },
          enemyFormation: {
            slots: [formationSlot("UNIT_ENEMY", 0)],
            memoryDefinitionIds: [],
          },
          turnLimit: 1,
        }),
      });

      const ally = result.initialState.units[createBattleUnitId("ally:1")]!;
      // HP     (100 + 2040 + 4080 + 21600 + 3628 + 10×255) × 1.09
      // 攻撃力 (10 + 1440 + 2880 + 16020 + 2721 + 10×209) × 1.09
      expect(ally.combatStats.maximumHp).toBeCloseTo(37057.82, 4);
      expect(ally.combatStats.attack).toBeCloseTo(27425.49, 4);
      // 会心率はギア合計割合の単純加算、行動速度はレベル増加のみ（R-ENH-06）。
      expect(ally.combatStats.criticalRate).toBeCloseTo(0.1525, 12);
      expect(ally.combatStats.actionSpeed).toBeCloseTo(30, 6);
      // R-NUM-02: HPゲージの現在値は整数へ切り捨てる。
      expect(ally.hp).toBe(37057);

      // R-ENH-01 #6: 敵陣営は強化指定を持たないため従来どおり。
      const enemy = result.initialState.units[createBattleUnitId("enemy:1")]!;
      expect(enemy.combatStats.maximumHp).toBe(100);
      expect(enemy.combatStats.attack).toBe(10);
      expect(enemy.combatStats.criticalRate).toBeCloseTo(0.1, 12);
      expect(enemy.hp).toBe(100);
    });

    it("IT-ENH-002 [R-ENH-01] (backward compatibility): a request with no enhancement produces exactly the same battle as before the M11 fields existed", () => {
      const catalog = new CatalogBuilder()
        .withUnit(unitDefinition("UNIT_ALLY"), unitDefinition("UNIT_ENEMY"))
        .build();
      const command = battleCommand({ turnLimit: 2 });

      const result = runScenario({ catalog, command });

      const ally = result.initialState.units[createBattleUnitId("ally:1")]!;
      expect(ally.combatStats).toMatchObject({
        maximumHp: 100,
        attack: 10,
        defense: 10,
        actionSpeed: 10,
      });
      // 対照条件: 同じ編成へ空の陣営強化を足すだけで結果が変わる。つまり上の
      // 同一性は「強化経路が存在しない」からではなく「指定が無い」からである。
      const enhanced = runScenario({
        catalog,
        command: {
          ...command,
          allyFormation: { ...command.allyFormation, enhancement: {} },
        },
      });
      expect(
        enhanced.initialState.units[createBattleUnitId("ally:1")]!.combatStats.attack,
      ).toBeCloseTo(20438.59, 4);
    });
  });
  describe("M10 tactical exercise (TEX-006)", () => {
    const EXERCISE_ATTACK_SKILL = "SKL_EXERCISE_ATTACK";
    const EXERCISE_ATTACK_ACTION = "ACT_EXERCISE_ATTACK";

    /** 味方1体が毎ターン敵1体を殴るだけの、ブレイクを起こさない最小の演習Catalog。 */
    function exerciseCatalog(enemyMaximumHp: number) {
      return new CatalogBuilder()
        .withUnit(
          unitDefinition("UNIT_ALLY", {
            baseStats: { maximumAp: 1, attack: 100 },
            activeSkillDefinitionIds: [createSkillDefinitionId(EXERCISE_ATTACK_SKILL)],
          }),
          unitDefinition("UNIT_ENEMY", {
            category: "EXERCISE_ENEMY",
            exerciseActive: true,
            baseStats: { maximumHp: enemyMaximumHp, defense: 0 },
          }),
        )
        .withSkill(attackSkill(EXERCISE_ATTACK_SKILL, EXERCISE_ATTACK_ACTION))
        .withEffectAction(damageEffectAction(EXERCISE_ATTACK_ACTION))
        .build();
    }

    const EXERCISE_SELF_HARM_SKILL = "SKL_EXERCISE_SELF_HARM";
    const EXERCISE_SELF_HARM_ACTION = "ACT_EXERCISE_SELF_HARM";

    /**
     * 上のCatalogに、敵が自分自身へダメージを与えるASを足したもの。R-TEX-02 #3が
     * スコアへ計上する「敵の自傷」を、`sourceUnitId`が敵自身になる最小の形で作る。
     */
    function selfHarmingExerciseCatalog(enemyMaximumHp: number) {
      return new CatalogBuilder()
        .withUnit(
          unitDefinition("UNIT_ALLY", {
            baseStats: { maximumAp: 1, attack: 100 },
            activeSkillDefinitionIds: [createSkillDefinitionId(EXERCISE_ATTACK_SKILL)],
          }),
          unitDefinition("UNIT_ENEMY", {
            category: "EXERCISE_ENEMY",
            exerciseActive: true,
            baseStats: { maximumHp: enemyMaximumHp, defense: 0, attack: 50, maximumAp: 1 },
            activeSkillDefinitionIds: [createSkillDefinitionId(EXERCISE_SELF_HARM_SKILL)],
          }),
        )
        .withSkill(
          attackSkill(EXERCISE_ATTACK_SKILL, EXERCISE_ATTACK_ACTION),
          selfEffectSkill(EXERCISE_SELF_HARM_SKILL, [EXERCISE_SELF_HARM_ACTION]),
        )
        .withEffectAction(
          damageEffectAction(EXERCISE_ATTACK_ACTION),
          damageEffectAction(EXERCISE_SELF_HARM_ACTION, 1, "PREVENTED"),
        )
        .build();
    }

    it("SCN-BTL-024 [R-TEX-01, R-TEX-09, R-TEX-10] (R-TEX-01 #4 / R-TEX-09 #1 / R-TEX-10): a tactical exercise runs the full five turns, ends with TURN_LIMIT_REACHED and no outcome, and its totalScore equals the sum of every accumulated amount", () => {
      const result = runExerciseScenario({
        catalog: exerciseCatalog(100_000),
        command: tacticalExerciseCommand(),
        randomValues: Array.from({ length: 200 }, () => 0.99),
        battleIds: ["B_EXERCISE"],
      });

      assertBattleInvariants(result);

      // 5ターン完走・TURN_LIMIT_REACHED・勝敗なし（R-TEX-09 #1、R-TEX-10 #1）。
      expect(result.completionReason).toBe("TURN_LIMIT_REACHED");
      expect(result.completedTurn).toBe(5);
      expect(result).not.toHaveProperty("outcome");
      expect(result.finalState.result).not.toHaveProperty("outcome");

      // スコア＝計上量合計 − 減算量合計（R-TEX-10 #3）。最終状態の累計スコアとも一致する。
      // この敵は回復手段を持たないため減算は1件も起きず、計上量合計がそのまま総スコアになる。
      const amounts = result.events
        .filter((event) => event.type === "EXERCISE_SCORE_ACCUMULATED")
        .map((event) => (event.details as { readonly amount: number }).amount);
      expect(amounts.length).toBeGreaterThan(0);
      expect(result.events.filter((event) => event.type === "EXERCISE_SCORE_DEDUCTED")).toEqual([]);
      expect(result.totalScore).toBe(amounts.reduce((sum, amount) => sum + amount, 0));
      expect(result.finalState.exercise?.totalScore).toBe(result.totalScore);

      // 敵HPは削れているが、ブレイクは一度も起きていない。
      const enemy = result.finalState.units[createBattleUnitId("enemy:1")]!;
      expect(enemy.hp).toBe(100_000 - result.totalScore);
      expect(result.breakCount).toBe(0);
      expect(result.breaks).toEqual([]);

      // SCN-BTL-021と同じ状態復元検証を、演習の差分種別を含めて成立させる。
      expect(
        reduceStateDeltas(
          result.initialState,
          result.stateTransitions.map((transition) => transition.stateDelta),
        ),
      ).toEqual(result.finalState);
    });

    it("IT-TEX-001 [R-TEX-10] (R-TEX-10 #2, break history through the use case): the projected breaks match breakCount and stay in occurrence order with the cumulative score at each break", () => {
      const result = runExerciseScenario({
        catalog: exerciseCatalog(100),
        command: tacticalExerciseCommand(),
        randomValues: Array.from({ length: 200 }, () => 0.99),
        battleIds: ["B_EXERCISE"],
      });

      assertBattleInvariants(result);

      expect(result.breakCount).toBeGreaterThan(0);
      expect(result.breaks).toHaveLength(result.breakCount);
      expect(result.breaks.map((entry) => entry.breakNumber)).toEqual(
        result.breaks.map((_, index) => index + 1),
      );
      for (let index = 1; index < result.breaks.length; index++) {
        expect(result.breaks[index]!.turnNumber).toBeGreaterThanOrEqual(
          result.breaks[index - 1]!.turnNumber,
        );
        expect(result.breaks[index]!.cumulativeScoreAtBreak).toBeGreaterThanOrEqual(
          result.breaks[index - 1]!.cumulativeScoreAtBreak,
        );
      }
      expect(result.breaks.at(-1)!.cumulativeScoreAtBreak).toBeLessThanOrEqual(result.totalScore);
    });

    it("IT-TEX-002 [R-TEX-10] (R-TEX-10 #2, break history under SUMMARY): a SUMMARY exercise keeps the full break history even though score events are filtered out of the public log", () => {
      const command = tacticalExerciseCommand({ logLevel: "SUMMARY" });
      const detailed = runExerciseScenario({
        catalog: exerciseCatalog(100),
        command: tacticalExerciseCommand(),
        randomValues: Array.from({ length: 200 }, () => 0.99),
      });
      // `SUMMARY`は`finalState`を返さないため、narrowingしないraw版を使う。
      const summary = runExerciseScenarioRaw({
        catalog: exerciseCatalog(100),
        command,
        randomValues: Array.from({ length: 200 }, () => 0.99),
      });

      // SUMMARYはイベントを1件も公開しない。それでもブレイク履歴は完全である。
      expect(summary.events).toEqual([]);
      expect(summary.stateTransitions).toEqual([]);
      expect(summary.breaks).toEqual(detailed.breaks);
      expect(summary.breaks).toHaveLength(summary.breakCount);
      expect(summary.totalScore).toBe(detailed.totalScore);
    });

    it("IT-TEX-003 [R-TEX-10] (R-TEX-10 #2 / R-TEX-03 #2, break source through the use case): every break attributes the attacking ally's unit definition id, matching the UNIT_BROKEN envelope", () => {
      const result = runExerciseScenario({
        catalog: exerciseCatalog(100),
        command: tacticalExerciseCommand(),
        randomValues: Array.from({ length: 200 }, () => 0.99),
        battleIds: ["B_EXERCISE"],
      });

      assertBattleInvariants(result);

      // この編成では味方のASだけが敵のHPを削るため、全ブレイクの発生源が味方になる。
      expect(result.breaks.length).toBeGreaterThan(0);
      for (const entry of result.breaks) {
        expect(entry.sourceUnitDefinitionId).toBe("UNIT_ALLY");
      }

      // 投影（payload由来）と公開ログのエンベロープが同じ発生源を指す。
      const brokenEvents = result.events.filter((event) => event.type === "UNIT_BROKEN");
      expect(brokenEvents).toHaveLength(result.breaks.length);
      for (const event of brokenEvents) {
        expect(event.sourceUnitId).toBe(createBattleUnitId("ally:1"));
      }
    });

    it("IT-UNIT-SUMMARY-001 [R-TEX-02] (10_API設計.md「集計セマンティクス」/ R-TEX-02 #2): in an exercise that breaks the enemy repeatedly, the allies' damageDealt adds up to the whole score because the overkill discarded at each break is counted", () => {
      const result = runExerciseScenario({
        catalog: exerciseCatalog(100),
        command: tacticalExerciseCommand(),
        randomValues: Array.from({ length: 200 }, () => 0.99),
        battleIds: ["B_EXERCISE"],
      });

      assertBattleInvariants(result);

      // 前提: ブレイクが起き、実際にオーバーキルが破棄されている。これが無いと
      // 以下の一致は「破棄分を含めている」ことの証跡にならない。
      expect(result.breakCount).toBeGreaterThan(0);
      const applied = result.events
        .filter((event) => event.type === "DAMAGE_APPLIED")
        .map(
          (event) =>
            event.details as { readonly hitPointDamage: number; readonly discardedDamage: number },
        );
      const discarded = applied.reduce((sum, details) => sum + details.discardedDamage, 0);
      expect(discarded).toBeGreaterThan(0);

      const dealtByAllies = result.unitSummaries
        .filter((summary) => summary.side === "ALLY")
        .reduce((sum, summary) => sum + summary.damageDealt, 0);
      const enemy = result.unitSummaries.find((summary) => summary.side === "ENEMY")!;

      // 与ダメージの総和＝スコア。R-TEX-02 #2の計上量とまったく同じ量を数えている。
      // 一致するのはこの敵が回復手段も自傷手段も持たないためであり、どちらかがあると
      // 味方の`damageDealt`合計はスコアから外れる（IT-UNIT-SUMMARY-002）。
      expect(result.events.filter((event) => event.type === "EXERCISE_SCORE_DEDUCTED")).toEqual([]);
      expect(dealtByAllies).toBe(result.totalScore);
      expect(enemy.damageTaken).toBe(result.totalScore);
      // 実HP減少量だけを数えていた頃の値との差が、まさに破棄されたオーバーキルである。
      const hpReduced = applied.reduce((sum, details) => sum + details.hitPointDamage, 0);
      expect(dealtByAllies - hpReduced).toBe(discarded);
    });

    it("IT-UNIT-SUMMARY-002 [R-TEX-02] (10_API設計.md「集計セマンティクス」/ R-TEX-02 #3): when the enemy damages itself, the score follows the enemy's damageTaken — the allies' damageDealt alone falls short by exactly the self-inflicted amount", () => {
      const result = runExerciseScenario({
        catalog: selfHarmingExerciseCatalog(100_000),
        command: tacticalExerciseCommand(),
        randomValues: Array.from({ length: 200 }, () => 0.99),
        battleIds: ["B_EXERCISE"],
      });

      assertBattleInvariants(result);

      const enemyUnitId = createBattleUnitId("enemy:1");
      // 前提: 敵が実際に自傷している。これが無いと以下の不一致は空振りになる。
      const selfInflicted = result.events
        .filter(
          (event) =>
            event.type === "DAMAGE_APPLIED" &&
            event.sourceUnitId === enemyUnitId &&
            (event.details as { readonly targetUnitId: string }).targetUnitId === enemyUnitId,
        )
        .reduce((sum, event) => {
          const details = event.details as {
            readonly hitPointDamage: number;
            readonly discardedDamage: number;
          };
          return sum + details.hitPointDamage + details.discardedDamage;
        }, 0);
      expect(selfInflicted).toBeGreaterThan(0);

      const accumulated = result.events
        .filter((event) => event.type === "EXERCISE_SCORE_ACCUMULATED")
        .reduce((sum, event) => sum + (event.details as { readonly amount: number }).amount, 0);
      const dealtByAllies = result.unitSummaries
        .filter((summary) => summary.side === "ALLY")
        .reduce((sum, summary) => sum + summary.damageDealt, 0);
      const enemy = result.unitSummaries.find((summary) => summary.side === "ENEMY")!;

      // 常に成立するのは被ダメージ側の等式だけである（`damageTaken`は`targetUnitId`へ
      // 帰属するため、自傷分も敵の被ダメージに入る）。
      expect(enemy.damageTaken).toBe(accumulated);
      expect(result.totalScore).toBe(accumulated);

      // 一方、自傷分は敵自身の`damageDealt`へ帰属するため味方の合計からは抜け落ちる。
      // 差がちょうど自傷量であることまで見て、「たまたま少ない」ではないことを固定する。
      expect(dealtByAllies).toBeLessThan(enemy.damageTaken);
      expect(enemy.damageTaken - dealtByAllies).toBe(selfInflicted);
      expect(enemy.damageDealt).toBe(selfInflicted);
    });
  });
});
