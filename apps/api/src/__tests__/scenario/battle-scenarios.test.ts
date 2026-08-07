import { describe, expect, it } from "vitest";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { TargetSelectorDefinition } from "../../domain/catalog/definitions/target-selector-definition.js";
import { reduceStateDeltas } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import { createBattleUnitId } from "../../domain/shared/ids.js";
import { CatalogBuilder } from "../../testing/scenario/catalog-builder.js";
import {
  attackSkill,
  battleCommand,
  damageEffectAction,
  ENEMY_ALL,
  formationSlot,
  unitDefinition,
} from "../../testing/scenario/definition-builders.js";
import { runScenario } from "../../testing/scenario/run-scenario.js";

/**
 * harness ベースの Battle シナリオ（`12_テスト戦略.md`「基準シナリオ」）。散在する既存の
 * `SCN-BTL-*` とは別に、`runScenario` + `CatalogBuilder` を実運用へ載せる集約先。
 * SCN-BTL-015〜017（シールド/サブユニット・リンク・継続ダメージ）は `DMG-011`
 * （Issue #186、M8完了監査）が該当ルールの実装完了を確認して追加した。SCN-BTL-018
 * （状態異常）は R-STS-01〜04 完了済みのため実装可能であり、REL-003（Issue #200、M9）
 * で追加する。
 */
describe("battle scenarios (harness)", () => {
  it("SCN-BTL-001 (Issue #10 acceptance): a full battle's event log satisfies sequence/parent/root determinism, and the independent StateDelta Reducer restores finalState from initialState + transitions", async () => {
    const { reduceStateDeltas } =
      await import("../../domain/battle/lifecycle/state-delta-reducer.js");
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

  it("SCN-BTL-023 (Issue #251 acceptance): a same-cycle DEFEATED reservation removal, whose own PS reaction chain further changes state, still satisfies the full-battle invariants (parent/root determinism, independent StateDelta reapplication) enforced end-to-end by the public use case", () => {
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
      "SCN-BTL-015 (R-SHD-01〜03/R-SUB-01, $damageType damage): one hit drains the matching typed shield, then the untyped shield, then the sub unit, and only the remainder reaches HP — while the $untouched shield is untouched",
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

    it("SCN-BTL-016 (R-LNK-01〜03): both link destinations take the same undivided amount, absorb it with their own shields, and generate no further link", () => {
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
});
