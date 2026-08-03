import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { advanceBattle, createBattle, startBattle } from "../../domain/battle/lifecycle/battle.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { createTurnLimit } from "../../domain/battle/model/turn-limit.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { createBattleId } from "../../domain/shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { TargetSelectorDefinition } from "../../domain/catalog/definitions/target-selector-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import { detectPassiveCandidates } from "../../domain/battle/triggering/passive-trigger-matcher.js";
import { createEmptyPassiveActivationGuard } from "../../domain/battle/triggering/passive-activation-guard.js";
import type { TriggerCandidateEvent } from "../../domain/battle/triggering/trigger-event.js";
import { PassiveActivationRuntime } from "../../domain/battle/lifecycle/passive-activation-service.js";
import { applyDamageAction } from "../../domain/battle/combat/damage-application-service.js";
import {
  definitionsWith,
  loadProductionSnapshot,
  testBattleUnit,
  testUnitDefinition,
  unitFrom,
} from "../../testing/fixtures/index.js";

/**
 * Issue #144 follow-up (docs/ddd/15_Unit_Memory変換台帳.md 該当行):
 * `SKL_SUIRAN_CHAOS_PS3`が参照する`SkillUseStarting`はBattle Engineが実行時に
 * 発行するが、実ライフサイクル経由で候補検出（trigger一致）を確認する統合
 * テストがまだ無かった。
 *
 * RES-005（Issue #172）: `SKL_SUIRAN_CHAOS_PS3`のEffectSequence stepが参照する
 * `target: { kind: "TRIGGER_TARGET" }` / `{ kind: "TRIGGER_SOURCE" }` を
 * `skill-resolution-service.ts`/`target-selection-policy.ts`が解決できるように
 * なったため、2つ目のテスト（IT-CAP-TRIGGER-CONTEXT-PROD-001）で候補検出から
 * PS発動・EffectSequence解決・ダメージ/APPLY_STAT_MOD適用までの完全な経路を
 * 実際のSuiran production Catalog定義（未改変）で検証する。PS1
 * （`APPLY_STATUS`、Issue #183）・PS2（`HEAL`、Issue #184）は、この経路とは
 * 独立に未実装のEffectActionDefinition kindへ依存するため、完全な発動までは
 * このIssueのスコープ外のまま — 台帳の該当行を参照。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

const SUIRAN_UNIT_ID = "UNIT_SUIRAN_CHAOS";
const SUIRAN_PS1_ID = "SKL_SUIRAN_CHAOS_PS1";
const SUIRAN_PS2_ID = "SKL_SUIRAN_CHAOS_PS2";
const SUIRAN_PS3_ID = "SKL_SUIRAN_CHAOS_PS3";

const ATTACKER_UNIT_ID = "UNIT_TEST_PS3_ATTACKER";
const ATTACKER_AS_ID = "SKL_TEST_PS3_ATTACKER_AS";
const ATTACKER_EFFECT_ID = "ACT_TEST_PS3_ATTACKER_HIT";
const ENEMY_UNIT_ID = "UNIT_TEST_PS3_ENEMY";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

const ENEMY_ALL: TargetSelectorDefinition = {
  kind: "SELECT",
  side: "ENEMY",
  count: "ALL",
  filters: [],
  order: ["DEFAULT"],
  includeDefeated: false,
};

const COMBAT_STATS = { maximumHp: 100, attack: 50, defense: 10, affinityBonus: 0.25 };

/** Suiranの前後に並べる相手役。行動順を決める actionSpeed だけ呼び出し側が変える。 */
function standInUnitDefinition(id: string, actionSpeed: number): UnitDefinition {
  return testUnitDefinition(id, {
    baseStats: { ...COMBAT_STATS, actionSpeed },
    activeSkillDefinitionIds: [createSkillDefinitionId(ATTACKER_AS_ID)],
  });
}

function attackerSkill(): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(ATTACKER_AS_ID),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [{ targetBindingId: createTargetBindingId("TGT_1"), selector: ENEMY_ALL }],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [
            { effectActionDefinitionId: createEffectActionDefinitionId(ATTACKER_EFFECT_ID) },
          ],
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
    requiredCapabilities: [],
    metadata: { displayName: "TestAttack", tags: [] },
  };
}

function attackerEffectAction(): Extract<EffectActionDefinition, { kind: "DAMAGE" }> {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(ATTACKER_EFFECT_ID),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: 1 },
      hitCount: 1,
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

describe("production Catalog SKL_SUIRAN_CHAOS_PS3 (Issue #144 follow-up, TRIGGER_POSITION_RELATION)", () => {
  it("IT-CAT-PROD-015: is detected as a candidate through detectPassiveCandidates when the REAL SkillUseStarting event a battle actually emits fires from an ally positioned in front of Suiran", () => {
    // Step 1: run a real ally-vs-enemy battle (without Suiran) so
    // `action-skill-use-resolver.ts` emits a genuine `SkillUseStarting`
    // event, proving this Issue's `skillType` payload fix at its real
    // emission site (not a hand-authored stand-in).
    const attackerOnlyDefinitions: BattleDefinitions = {
      activeSkillsByUnit: new Map([[createUnitDefinitionId(ATTACKER_UNIT_ID), [attackerSkill()]]]),
      exSkillByUnit: new Map(),
      effectActions: new Map([
        [createEffectActionDefinitionId(ATTACKER_EFFECT_ID), attackerEffectAction()],
      ]),
      unitDefinitions: new Map([
        [createUnitDefinitionId(ATTACKER_UNIT_ID), standInUnitDefinition(ATTACKER_UNIT_ID, 20)],
        [createUnitDefinitionId(ENEMY_UNIT_ID), standInUnitDefinition(ENEMY_UNIT_ID, 5)],
      ]),
      skillDefinitions: new Map([[createSkillDefinitionId(ATTACKER_AS_ID), attackerSkill()]]),
    };
    const attacker = testBattleUnit({
      battleUnitId: "ally:attacker",
      unitDefinitionId: ATTACKER_UNIT_ID,
      position: { column: "LEFT", row: "FRONT" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
    });
    const enemy = testBattleUnit({
      battleUnitId: "enemy:1",
      unitDefinitionId: ENEMY_UNIT_ID,
      side: "ENEMY",
      position: { column: "LEFT", row: "FRONT" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
    });
    const battle = startBattle(
      createBattle(
        createBattleId("B_1"),
        [attacker],
        [enemy],
        createTurnLimit(1),
        attackerOnlyDefinitions,
      ),
      new SequenceRandomSource([]),
      new EventRecorder(createBattleId("B_1")),
    );
    const turnRecorder = new EventRecorder(createBattleId("B_1"));
    advanceBattle(battle, new SequenceRandomSource([]), turnRecorder);

    const skillUseStarting = turnRecorder
      .getEvents()
      .find(
        (e) =>
          e.eventType === "SkillUseStarting" &&
          (e.payload as { skillDefinitionId: string }).skillDefinitionId === ATTACKER_AS_ID,
      );
    expect(skillUseStarting).toBeDefined();
    expect((skillUseStarting!.payload as { skillType: string }).skillType).toBe("AS");

    // Step 2: feed that REAL emitted event into `detectPassiveCandidates`
    // (R-PS-01) together with Suiran's REAL, unmodified `UnitDefinition`/
    // `SkillDefinition` loaded from production `catalog/`, positioned so the
    // attacker is "in front of" Suiran (R-POS-02, POSITION_RELATION).
    const snapshot = loadProductionSnapshot(CATALOG_DIR, [SUIRAN_UNIT_ID]);
    const suiranUnitDefinition = unitFrom(snapshot, SUIRAN_UNIT_ID);
    expect(suiranUnitDefinition).toBeDefined();
    expect(suiranUnitDefinition.passiveSkillDefinitionIds).toContain(SUIRAN_PS3_ID);

    const suiran = testBattleUnit({
      battleUnitId: "ally:suiran",
      unitDefinitionId: SUIRAN_UNIT_ID,
      position: { column: "LEFT", row: "BACK" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
    });
    const { unitDefinitions } = definitionsWith(snapshot, {
      units: [standInUnitDefinition(ATTACKER_UNIT_ID, 20), standInUnitDefinition(ENEMY_UNIT_ID, 5)],
    });

    const triggerEvent: TriggerCandidateEvent = {
      eventType: skillUseStarting!.eventType,
      category: skillUseStarting!.category === "DIAGNOSTIC" ? "FACT" : skillUseStarting!.category,
      ...(skillUseStarting!.sourceUnitId !== undefined
        ? { sourceUnitId: skillUseStarting!.sourceUnitId }
        : {}),
      ...(skillUseStarting!.targetUnitIds !== undefined
        ? { targetUnitIds: skillUseStarting!.targetUnitIds }
        : {}),
      payload: skillUseStarting!.payload,
    };

    const candidates = detectPassiveCandidates({
      event: triggerEvent,
      units: [suiran, attacker, enemy],
      unitDefinitions,
      skillDefinitions: snapshot.skills,
      activationGuard: createEmptyPassiveActivationGuard(),
    });

    const ps3Candidate = candidates.find(
      (candidate) => candidate.skillDefinition.skillDefinitionId === SUIRAN_PS3_ID,
    );
    expect(ps3Candidate).toBeDefined();
    expect(ps3Candidate!.unit.battleUnitId).toBe(suiran.battleUnitId);
  });

  it("IT-CAP-TRIGGER-CONTEXT-PROD-001 (RES-005, Issue #172): PassiveActivationRuntime fully activates SKL_SUIRAN_CHAOS_PS3 from a real SkillUseStarting event — TRIGGER_TARGET resolves to the real attacker's real enemy target (DAMAGE + speed-down), TRIGGER_SOURCE resolves to the real attacker (crit-up), using unmodified production Catalog definitions", () => {
    const snapshot = loadProductionSnapshot(CATALOG_DIR, [SUIRAN_UNIT_ID]);

    // `createBattleUnit` always starts PP at 0 (only `startBattle`'s
    // READY→RUNNING resource recovery grants any) — since this test drives
    // `PassiveActivationRuntime` directly rather than a full battle, Suiran
    // needs enough PP for PS3's cost (2) set explicitly, same as
    // `passive-activation-service.test.ts`'s own `unit()` helper does.
    const suiran = testBattleUnit({
      battleUnitId: "ally:suiran",
      unitDefinitionId: SUIRAN_UNIT_ID,
      position: { column: "LEFT", row: "BACK" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
      overrides: { currentPp: LIMITS.maximumPp },
    });
    const attacker = testBattleUnit({
      battleUnitId: "ally:attacker",
      unitDefinitionId: ATTACKER_UNIT_ID,
      position: { column: "LEFT", row: "FRONT" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
    });
    const enemy = testBattleUnit({
      battleUnitId: "enemy:1",
      unitDefinitionId: ENEMY_UNIT_ID,
      side: "ENEMY",
      position: { column: "LEFT", row: "FRONT" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
    });

    const definitions = definitionsWith(snapshot, {
      units: [standInUnitDefinition(ATTACKER_UNIT_ID, 20), standInUnitDefinition(ENEMY_UNIT_ID, 5)],
    });

    // Build the exact `SkillUseStarting` event `action-skill-use-resolver.ts`
    // emits for an AS use (same envelope proven for real by Step 1 of the
    // preceding test), driving `PassiveActivationRuntime` directly — this is
    // the same production candidate-detection + activation path
    // `resolvePassiveChain`/`battle.ts` use, without needing Suiran to also
    // take her own turn (her AS1/EX use unrelated `EffectActionDefinition`
    // kinds not yet implemented, see Issue #183/#184 — orthogonal to RES-005).
    const recorder = new EventRecorder(createBattleId("B_2"));
    const resolutionScopeId = recorder.nextResolutionScopeId();
    const actionId = recorder.nextActionId();
    const actionStarted = recorder.record({
      eventType: "ActionStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      actionId,
      resolutionScopeId,
      payload: {
        actorUnitId: attacker.battleUnitId,
        reservedActionType: "AS",
        effectiveActionType: "AS",
        apBefore: 1,
        apAfter: 0,
        exBefore: 0,
        exAfter: 0,
      },
    });
    const skillUseStarting = recorder.record({
      eventType: "SkillUseStarting",
      category: "TIMING",
      turnNumber: 1,
      cycleNumber: 1,
      actionId,
      resolutionScopeId,
      parentEventId: actionStarted.eventId,
      rootEventId: actionStarted.eventId,
      sourceUnitId: attacker.battleUnitId,
      targetUnitIds: [enemy.battleUnitId],
      payload: {
        skillDefinitionId: createSkillDefinitionId(ATTACKER_AS_ID),
        skillType: "AS",
        actorUnitId: attacker.battleUnitId,
        targetUnitIds: [enemy.battleUnitId],
        costResource: "AP",
        costAmount: 1,
      },
    });

    const runtime = new PassiveActivationRuntime(
      {
        definitions,
        // DAMAGE_ADD's critical.mode built from the production Catalog
        // resolves via a RandomSource draw (R-CRT-01); a high value avoids a
        // critical roll without affecting which units get targeted.
        random: new SequenceRandomSource([0.99, 0.99, 0.99, 0.99, 0.99]),
        recorder,
        turnNumber: 1,
        cycleNumber: 1,
        resolutionScopeId,
        rootEventId: actionStarted.eventId,
        actionId,
      },
      [suiran, attacker, enemy],
    );

    const updatedUnits = runtime.onFactEvent(skillUseStarting, [suiran, attacker, enemy]).units;

    const events = recorder.getEvents();
    const passiveActivated = events.find(
      (e) =>
        e.eventType === "PassiveActivated" &&
        (e.payload as { skillDefinitionId: string }).skillDefinitionId === SUIRAN_PS3_ID,
    );
    expect(passiveActivated).toBeDefined();

    // ACT_SUIRAN_CHAOS_PS3_DAMAGE_ADD (target: TRIGGER_TARGET) actually
    // damaged the enemy the attacker's AS targeted, not Suiran or the
    // attacker.
    const damageApplied = events.find(
      (e) => e.eventType === "DamageApplied" && e.targetUnitIds?.includes(enemy.battleUnitId),
    );
    expect(damageApplied).toBeDefined();

    // ACT_SUIRAN_CHAOS_PS3_SPEED_DOWN (target: TRIGGER_TARGET) applied to the
    // same enemy.
    const speedDownApplied = events.find(
      (e) =>
        e.eventType === "EffectApplied" &&
        (e.payload as { effectActionDefinitionId: string }).effectActionDefinitionId ===
          "ACT_SUIRAN_CHAOS_PS3_SPEED_DOWN" &&
        e.targetUnitIds?.includes(enemy.battleUnitId),
    );
    expect(speedDownApplied).toBeDefined();

    // ACT_SUIRAN_CHAOS_PS3_CRIT_UP (target: TRIGGER_SOURCE) applied to the
    // attacker instead — proving TRIGGER_SOURCE and TRIGGER_TARGET resolve to
    // different, correct real units within the same EffectSequence.
    const critUpApplied = events.find(
      (e) =>
        e.eventType === "EffectApplied" &&
        (e.payload as { effectActionDefinitionId: string }).effectActionDefinitionId ===
          "ACT_SUIRAN_CHAOS_PS3_CRIT_UP",
    );
    expect(critUpApplied).toBeDefined();
    expect(critUpApplied!.targetUnitIds).toEqual([attacker.battleUnitId]);

    const passiveResolved = events.find(
      (e) =>
        e.eventType === "PassiveResolved" &&
        (e.payload as { skillDefinitionId: string }).skillDefinitionId === SUIRAN_PS3_ID,
    );
    expect(passiveResolved).toBeDefined();

    const updatedEnemy = updatedUnits.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(updatedEnemy.currentHp).toBeLessThan(enemy.currentHp);
  });

  it("IT-CAP-TRIGGER-CONTEXT-PROD-002 (RES-005/Issue #172, M7-004/Issue #183, CAP_HIT_COUNT_EVASION): SKL_SUIRAN_CHAOS_PS1 is detected and activates through the real UnitBeingAttacked event, and now genuinely grants an EVASION AppliedEffect to the TRIGGER_TARGET (the attacked ally), through the real Catalog -> EffectSequence -> AppliedEffect pipeline", () => {
    const snapshot = loadProductionSnapshot(CATALOG_DIR, [SUIRAN_UNIT_ID]);

    const suiran = testBattleUnit({
      battleUnitId: "ally:suiran",
      unitDefinitionId: SUIRAN_UNIT_ID,
      position: { column: "LEFT", row: "BACK" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
      overrides: { currentPp: LIMITS.maximumPp },
    });
    // PS1's trigger is `UnitBeingAttacked` with `sourceSelector: "ENEMY"`,
    // `targetSelector: "ALLY"`: an enemy attacks an ally positioned in front
    // of Suiran.
    const attackedAlly = testBattleUnit({
      battleUnitId: "ally:attacked",
      unitDefinitionId: ATTACKER_UNIT_ID,
      position: { column: "LEFT", row: "FRONT" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
    });
    const enemyAttacker = testBattleUnit({
      battleUnitId: "enemy:attacker",
      unitDefinitionId: ENEMY_UNIT_ID,
      side: "ENEMY",
      position: { column: "LEFT", row: "FRONT" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
    });
    const definitions = definitionsWith(snapshot, {
      units: [standInUnitDefinition(ATTACKER_UNIT_ID, 20), standInUnitDefinition(ENEMY_UNIT_ID, 5)],
    });

    const recorder = new EventRecorder(createBattleId("B_3"));
    const resolutionScopeId = recorder.nextResolutionScopeId();
    const actionId = recorder.nextActionId();
    const actionStarted = recorder.record({
      eventType: "ActionStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      actionId,
      resolutionScopeId,
      payload: {
        actorUnitId: enemyAttacker.battleUnitId,
        reservedActionType: "AS",
        effectiveActionType: "AS",
        apBefore: 1,
        apAfter: 0,
        exBefore: 0,
        exAfter: 0,
      },
    });
    const unitBeingAttacked = recorder.record({
      eventType: "UnitBeingAttacked",
      category: "TIMING",
      turnNumber: 1,
      cycleNumber: 1,
      actionId,
      resolutionScopeId,
      parentEventId: actionStarted.eventId,
      rootEventId: actionStarted.eventId,
      sourceUnitId: enemyAttacker.battleUnitId,
      targetUnitIds: [attackedAlly.battleUnitId],
      payload: {
        skillDefinitionId: createSkillDefinitionId(ATTACKER_AS_ID),
        effectActionDefinitionId: createEffectActionDefinitionId(ATTACKER_EFFECT_ID),
        hitIndex: 1,
        targetUnitId: attackedAlly.battleUnitId,
      },
    });

    const runtime = new PassiveActivationRuntime(
      {
        definitions,
        random: new SequenceRandomSource([]),
        recorder,
        turnNumber: 1,
        cycleNumber: 1,
        resolutionScopeId,
        rootEventId: actionStarted.eventId,
        actionId,
      },
      [suiran, attackedAlly, enemyAttacker],
    );

    // M7-004（Issue #183、CAP_HIT_COUNT_EVASION）でAPPLY_STATUS(EVASION)の実効
    // resolverが実装され、`ACT_SUIRAN_CHAOS_PS1_EVASION`（probability: 1,
    // appliesTo: DAMAGE, duration: ACTION 1 + consumption INCOMING_HIT 1）が
    // TRIGGER_TARGET（攻撃された味方自身）へ実際にAppliedEffectを付与する。
    const { units: updatedUnits } = runtime.onFactEvent(unitBeingAttacked, [
      suiran,
      attackedAlly,
      enemyAttacker,
    ]);

    const passiveActivated = recorder
      .getEvents()
      .find(
        (e) =>
          e.eventType === "PassiveActivated" &&
          (e.payload as { skillDefinitionId: string }).skillDefinitionId === SUIRAN_PS1_ID,
      );
    expect(passiveActivated).toBeDefined();

    const updatedAlly = updatedUnits.find((u) => u.battleUnitId === attackedAlly.battleUnitId)!;
    expect(updatedAlly.appliedEffects).toHaveLength(1);
    expect(updatedAlly.appliedEffects[0]).toMatchObject({
      statusKind: "EVASION",
      sourceId: suiran.battleUnitId,
      targetId: attackedAlly.battleUnitId,
      statusDetails: {
        probability: 1,
        appliesTo: { incomingActionKinds: ["DAMAGE"] },
      },
    });
  });

  it("IT-CAP-TRIGGER-CONTEXT-PROD-003 (RES-005, Issue #172; PR #220 review finding [P2]): SKL_SUIRAN_CHAOS_PS2 is detected and activates through the REAL HitPointReduced event applyDamageAction emits for a genuine enemy attack, and its ACT_SUIRAN_CHAOS_PS2_HEAL now resolves end-to-end (M7-005, Issue #184)", () => {
    const snapshot = loadProductionSnapshot(CATALOG_DIR, [SUIRAN_UNIT_ID]);

    const suiran = testBattleUnit({
      battleUnitId: "ally:suiran",
      unitDefinitionId: SUIRAN_UNIT_ID,
      position: { column: "LEFT", row: "BACK" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
      overrides: { currentPp: LIMITS.maximumPp },
    });
    // PS2's trigger is `HitPointReduced` with `sourceSelector: "ANY"`,
    // `targetSelector: "ALLY"` (PR #220 review [P2] re-review: the raw source
    // doesn't limit "自身の目の前に編成されている味方のHPが半分以下" to any
    // particular cause, so `ANY` is the accurate conversion — an earlier fix
    // to `"ENEMY"` in this same PR was itself too narrow, since it would have
    // silently excluded ally-caused/self-inflicted HP loss; see
    // catalog-src/units/UNIT_SUIRAN_CHAOS/skills.json). This test covers the
    // ordinary case (an enemy attack); `IT-CAP-TRIGGER-CONTEXT-PROD-004`
    // below covers the boundary case (an ally-caused `HitPointReduced` must
    // also candidate-ize). The condition additionally requires the target's
    // HP_RATIO<=0.5 and the target positioned in front of Suiran.
    // `woundedAlly.combatStats.maximumHp` is lowered so a single real hit
    // from `enemyAttacker` (attack 50 - defense 10 = 40 damage) crosses the
    // 50% threshold.
    const woundedAlly = testBattleUnit({
      battleUnitId: "ally:wounded",
      unitDefinitionId: ATTACKER_UNIT_ID,
      position: { column: "LEFT", row: "FRONT" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
      // `baseCombatStats` は据え置いたまま実効HP上限だけ下げ、実攻撃1発でHP割合が
      // 50%を割るようにする。
      overrides: {
        combatStats: {
          ...COMBAT_STATS,
          maximumHp: 60,
          criticalRate: 0,
          actionSpeed: 10,
          criticalDamageBonus: 0.5,
        },
        currentHp: 60,
      },
    });
    const enemyAttacker = testBattleUnit({
      battleUnitId: "enemy:attacker",
      unitDefinitionId: ENEMY_UNIT_ID,
      side: "ENEMY",
      position: { column: "LEFT", row: "FRONT" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
    });
    const definitions = definitionsWith(snapshot, {
      units: [standInUnitDefinition(ATTACKER_UNIT_ID, 20), standInUnitDefinition(ENEMY_UNIT_ID, 5)],
    });

    // Step 1: drive the REAL `applyDamageAction` (the actual production
    // Damage pipeline, not a hand-authored stand-in) so the `HitPointReduced`
    // event fed into the PS runtime below is byte-for-byte what a real enemy
    // attack produces — including `sourceUnitId` being the attacker.
    const recorder = new EventRecorder(createBattleId("B_4"));
    const resolutionScopeId = recorder.nextResolutionScopeId();
    const actionId = recorder.nextActionId();
    const actionStarted = recorder.record({
      eventType: "ActionStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      actionId,
      resolutionScopeId,
      payload: {
        actorUnitId: enemyAttacker.battleUnitId,
        reservedActionType: "AS",
        effectiveActionType: "AS",
        apBefore: 1,
        apAfter: 0,
        exBefore: 0,
        exAfter: 0,
      },
    });
    const attackEffectAction = attackerEffectAction();
    const damageResult = applyDamageAction(
      enemyAttacker,
      [
        {
          targetBattleUnitId: woundedAlly.battleUnitId,
          effectActionDefinitionId: attackEffectAction.effectActionDefinitionId,
          hitIndex: 1,
        },
      ],
      attackEffectAction,
      [enemyAttacker, woundedAlly],
      new SequenceRandomSource([]),
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 1,
        actionId,
        skillUseId: recorder.nextSkillUseId(),
        resolutionScopeId,
        rootEventId: actionStarted.eventId,
        parentEventId: actionStarted.eventId,
        skillDefinitionId: createSkillDefinitionId(ATTACKER_AS_ID),
      },
    );
    const updatedWoundedAlly = damageResult.units.find(
      (u) => u.battleUnitId === woundedAlly.battleUnitId,
    )!;
    // Sanity-check the real pipeline actually produced the intended state
    // before trusting it to drive candidate detection below.
    expect(updatedWoundedAlly.currentHp).toBe(20);

    const hitPointReduced = recorder.getEvents().find((e) => e.eventType === "HitPointReduced")!;
    expect(hitPointReduced.sourceUnitId).toBe(enemyAttacker.battleUnitId);

    // Step 2: feed that REAL emitted event into the PS runtime, together with
    // Suiran's REAL, unmodified `UnitDefinition`/`SkillDefinition`.
    const runtime = new PassiveActivationRuntime(
      {
        definitions,
        random: new SequenceRandomSource([]),
        recorder,
        turnNumber: 1,
        cycleNumber: 1,
        resolutionScopeId,
        rootEventId: actionStarted.eventId,
        actionId,
      },
      [suiran, updatedWoundedAlly, enemyAttacker],
    );

    // M7-005（Issue #184）でHEALが実装されたため、この連鎖は例外にならず最後まで
    // 解決し、`ACT_SUIRAN_CHAOS_PS2_HEAL`が実際に対象を回復する
    // （変換テーマ`HEAL_KIND_UNIMPLEMENTED`の解消、`15_Unit_Memory変換台帳.md`）。
    const chained = runtime.onFactEvent(hitPointReduced, [
      suiran,
      updatedWoundedAlly,
      enemyAttacker,
    ]);
    const healedAlly = chained.units.find(
      (u) => u.battleUnitId === updatedWoundedAlly.battleUnitId,
    )!;
    expect(healedAlly.currentHp).toBeGreaterThan(updatedWoundedAlly.currentHp);
    expect(recorder.getEvents().some((e) => e.eventType === "HealApplied")).toBe(true);

    const passiveActivated = recorder
      .getEvents()
      .find(
        (e) =>
          e.eventType === "PassiveActivated" &&
          (e.payload as { skillDefinitionId: string }).skillDefinitionId === SUIRAN_PS2_ID,
      );
    expect(passiveActivated).toBeDefined();
  });

  it("IT-CAP-TRIGGER-CONTEXT-PROD-004 (PR #220 review finding [P2] re-review): SKL_SUIRAN_CHAOS_PS2 also candidate-izes for a REAL HitPointReduced whose source is an ALLY, not just an enemy — sourceSelector: ANY must not silently exclude ally-caused/self-inflicted HP loss", () => {
    const snapshot = loadProductionSnapshot(CATALOG_DIR, [SUIRAN_UNIT_ID]);

    const suiran = testBattleUnit({
      battleUnitId: "ally:suiran",
      unitDefinitionId: SUIRAN_UNIT_ID,
      position: { column: "LEFT", row: "BACK" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
      overrides: { currentPp: LIMITS.maximumPp },
    });
    const woundedAlly = testBattleUnit({
      battleUnitId: "ally:wounded",
      unitDefinitionId: ATTACKER_UNIT_ID,
      position: { column: "LEFT", row: "FRONT" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
      // `baseCombatStats` は据え置いたまま実効HP上限だけ下げ、実攻撃1発でHP割合が
      // 50%を割るようにする。
      overrides: {
        combatStats: {
          ...COMBAT_STATS,
          maximumHp: 60,
          criticalRate: 0,
          actionSpeed: 10,
          criticalDamageBonus: 0.5,
        },
        currentHp: 60,
      },
    });
    // The attacker is an ALLY this time (e.g. a future self-damaging-cost or
    // friendly-fire mechanic) — same side as Suiran and the wounded target.
    const allyAttacker = testBattleUnit({
      battleUnitId: "ally:attacker",
      unitDefinitionId: ENEMY_UNIT_ID,
      position: { column: "RIGHT", row: "FRONT" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
    });
    const definitions = definitionsWith(snapshot, {
      units: [standInUnitDefinition(ATTACKER_UNIT_ID, 20), standInUnitDefinition(ENEMY_UNIT_ID, 5)],
    });

    const recorder = new EventRecorder(createBattleId("B_5"));
    const resolutionScopeId = recorder.nextResolutionScopeId();
    const actionId = recorder.nextActionId();
    const actionStarted = recorder.record({
      eventType: "ActionStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      actionId,
      resolutionScopeId,
      payload: {
        actorUnitId: allyAttacker.battleUnitId,
        reservedActionType: "AS",
        effectiveActionType: "AS",
        apBefore: 1,
        apAfter: 0,
        exBefore: 0,
        exAfter: 0,
      },
    });
    const attackEffectAction = attackerEffectAction();
    const damageResult = applyDamageAction(
      allyAttacker,
      [
        {
          targetBattleUnitId: woundedAlly.battleUnitId,
          effectActionDefinitionId: attackEffectAction.effectActionDefinitionId,
          hitIndex: 1,
        },
      ],
      attackEffectAction,
      [allyAttacker, woundedAlly],
      new SequenceRandomSource([]),
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 1,
        actionId,
        skillUseId: recorder.nextSkillUseId(),
        resolutionScopeId,
        rootEventId: actionStarted.eventId,
        parentEventId: actionStarted.eventId,
        skillDefinitionId: createSkillDefinitionId(ATTACKER_AS_ID),
      },
    );
    const updatedWoundedAlly = damageResult.units.find(
      (u) => u.battleUnitId === woundedAlly.battleUnitId,
    )!;
    expect(updatedWoundedAlly.currentHp).toBe(20);

    const hitPointReduced = recorder.getEvents().find((e) => e.eventType === "HitPointReduced")!;
    expect(hitPointReduced.sourceUnitId).toBe(allyAttacker.battleUnitId);

    const runtime = new PassiveActivationRuntime(
      {
        definitions,
        random: new SequenceRandomSource([]),
        recorder,
        turnNumber: 1,
        cycleNumber: 1,
        resolutionScopeId,
        rootEventId: actionStarted.eventId,
        actionId,
      },
      [suiran, updatedWoundedAlly, allyAttacker],
    );

    // The candidate must still be detected and the PS resolve fully (proving
    // `sourceSelector: "ANY"` doesn't require an enemy source) — since M7-005
    // (Issue #184) the HEAL kind resolves instead of throwing.
    const chained = runtime.onFactEvent(hitPointReduced, [
      suiran,
      updatedWoundedAlly,
      allyAttacker,
    ]);
    expect(
      chained.units.find((u) => u.battleUnitId === updatedWoundedAlly.battleUnitId)!.currentHp,
    ).toBeGreaterThan(updatedWoundedAlly.currentHp);

    const passiveActivated = recorder
      .getEvents()
      .find(
        (e) =>
          e.eventType === "PassiveActivated" &&
          (e.payload as { skillDefinitionId: string }).skillDefinitionId === SUIRAN_PS2_ID,
      );
    expect(passiveActivated).toBeDefined();
  });
});
