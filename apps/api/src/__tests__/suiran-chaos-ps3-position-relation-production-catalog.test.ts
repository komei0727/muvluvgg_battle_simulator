import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { advanceBattle, createBattle, startBattle } from "../domain/battle/lifecycle/battle.js";
import { createBattleUnit } from "../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../domain/battle/model/battle-party.js";
import { toGlobalCoordinate } from "../domain/battle/model/global-coordinate.js";
import type { FormationPosition } from "../domain/battle/model/formation-input.js";
import type { BattleDefinitions } from "../domain/battle/model/battle-definitions.js";
import { EventRecorder } from "../domain/battle/events/event-recorder.js";
import { createTurnLimit } from "../domain/battle/model/turn-limit.js";
import { SequenceRandomSource } from "../testing/random/sequence-random-source.js";
import { createBattleId, createBattleUnitId } from "../domain/shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
} from "../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../domain/catalog/definitions/effect-action-definition.js";
import type { SkillDefinition } from "../domain/catalog/definitions/skill-definition.js";
import type { TargetSelectorDefinition } from "../domain/catalog/definitions/target-selector-definition.js";
import type { UnitDefinition } from "../domain/catalog/definitions/unit-definition.js";
import type { Side } from "../domain/shared/side.js";
import { detectPassiveCandidates } from "../domain/battle/triggering/passive-trigger-matcher.js";
import { createEmptyPassiveActivationGuard } from "../domain/battle/triggering/passive-activation-guard.js";
import type { TriggerCandidateEvent } from "../domain/battle/triggering/trigger-event.js";
import { loadCatalogFromDirectory } from "../infrastructure/catalog/runtime/catalog-file-loader.js";
import { PassiveActivationRuntime } from "../domain/battle/lifecycle/passive-activation-service.js";
import { applyDamageAction } from "../domain/battle/combat/damage-application-service.js";

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

const CATALOG_DIR = fileURLToPath(new URL("../../catalog", import.meta.url));

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

function member(
  battleUnitId: string,
  unitDefinitionId: string,
  side: Side,
  position: FormationPosition,
): BattlePartyMember {
  return {
    battleUnitId: createBattleUnitId(battleUnitId),
    unitDefinitionId: unitDefinitionId as never,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 50,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
}

function testUnitDefinition(id: string, actionSpeed: number): UnitDefinition {
  return {
    unitDefinitionId: createUnitDefinitionId(id),
    attribute: "AGGRESSIVE",
    unitType: "PHYSICAL",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT", "BACK"],
    baseStats: {
      maximumHp: 100,
      attack: 50,
      defense: 10,
      criticalRate: 0,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
      actionSpeed,
      maximumAp: LIMITS.maximumAp,
      maximumPp: LIMITS.maximumPp,
    },
    extraGaugeMaximum: LIMITS.maximumExtraGauge,
    activeSkillDefinitionIds: [createSkillDefinitionId(ATTACKER_AS_ID)],
    passiveSkillDefinitionIds: [],
    extraSkillDefinitionId: createSkillDefinitionId("SKL_EX_DEFAULT"),
    requiredCapabilities: [],
    metadata: {
      displayName: id,
      characterName: id,
      characterId: `CHAR_${id}`,
      affiliations: [],
      tags: [],
    },
  };
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
          condition: { kind: "TRUE" },
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
  it("IT-CAT-PROD-012: is detected as a candidate through detectPassiveCandidates when the REAL SkillUseStarting event a battle actually emits fires from an ally positioned in front of Suiran", () => {
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
        [createUnitDefinitionId(ATTACKER_UNIT_ID), testUnitDefinition(ATTACKER_UNIT_ID, 20)],
        [createUnitDefinitionId(ENEMY_UNIT_ID), testUnitDefinition(ENEMY_UNIT_ID, 5)],
      ]),
      skillDefinitions: new Map([[createSkillDefinitionId(ATTACKER_AS_ID), attackerSkill()]]),
    };
    const attacker = createBattleUnit(
      member("ally:attacker", ATTACKER_UNIT_ID, "ALLY", { column: "LEFT", row: "FRONT" }),
      "ALLY",
      LIMITS,
    );
    const enemy = createBattleUnit(
      member("enemy:1", ENEMY_UNIT_ID, "ENEMY", { column: "LEFT", row: "FRONT" }),
      "ENEMY",
      LIMITS,
    );
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
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([SUIRAN_UNIT_ID as never], []);
    const suiranUnitDefinition = snapshot.units.get(SUIRAN_UNIT_ID as never);
    expect(suiranUnitDefinition).toBeDefined();
    expect(suiranUnitDefinition!.passiveSkillDefinitionIds).toContain(SUIRAN_PS3_ID);

    const suiran = createBattleUnit(
      member("ally:suiran", SUIRAN_UNIT_ID, "ALLY", { column: "LEFT", row: "BACK" }),
      "ALLY",
      LIMITS,
    );
    const unitDefinitions = new Map(snapshot.units);
    unitDefinitions.set(
      createUnitDefinitionId(ATTACKER_UNIT_ID),
      testUnitDefinition(ATTACKER_UNIT_ID, 20),
    );
    unitDefinitions.set(
      createUnitDefinitionId(ENEMY_UNIT_ID),
      testUnitDefinition(ENEMY_UNIT_ID, 5),
    );

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
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([SUIRAN_UNIT_ID as never], []);

    // `createBattleUnit` always starts PP at 0 (only `startBattle`'s
    // READY→RUNNING resource recovery grants any) — since this test drives
    // `PassiveActivationRuntime` directly rather than a full battle, Suiran
    // needs enough PP for PS3's cost (2) set explicitly, same as
    // `passive-activation-service.test.ts`'s own `unit()` helper does.
    const suiran = {
      ...createBattleUnit(
        member("ally:suiran", SUIRAN_UNIT_ID, "ALLY", { column: "LEFT", row: "BACK" }),
        "ALLY",
        LIMITS,
      ),
      currentPp: LIMITS.maximumPp,
    };
    const attacker = createBattleUnit(
      member("ally:attacker", ATTACKER_UNIT_ID, "ALLY", { column: "LEFT", row: "FRONT" }),
      "ALLY",
      LIMITS,
    );
    const enemy = createBattleUnit(
      member("enemy:1", ENEMY_UNIT_ID, "ENEMY", { column: "LEFT", row: "FRONT" }),
      "ENEMY",
      LIMITS,
    );

    const unitDefinitions = new Map(snapshot.units);
    unitDefinitions.set(
      createUnitDefinitionId(ATTACKER_UNIT_ID),
      testUnitDefinition(ATTACKER_UNIT_ID, 20),
    );
    unitDefinitions.set(
      createUnitDefinitionId(ENEMY_UNIT_ID),
      testUnitDefinition(ENEMY_UNIT_ID, 5),
    );

    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: snapshot.effectActions,
      unitDefinitions,
      skillDefinitions: snapshot.skills,
    };

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

    const updatedUnits = runtime.onFactEvent(skillUseStarting, [suiran, attacker, enemy]);

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

  it("IT-CAP-TRIGGER-CONTEXT-PROD-002 (RES-005, Issue #172): SKL_SUIRAN_CHAOS_PS1 is detected and activates through the real UnitBeingAttacked event, then fails on the separately-unimplemented APPLY_STATUS kind (Issue #183) — not on TRIGGER_TARGET resolution, proving RES-005's part of this row is fixed", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([SUIRAN_UNIT_ID as never], []);

    const suiran = {
      ...createBattleUnit(
        member("ally:suiran", SUIRAN_UNIT_ID, "ALLY", { column: "LEFT", row: "BACK" }),
        "ALLY",
        LIMITS,
      ),
      currentPp: LIMITS.maximumPp,
    };
    // PS1's trigger is `UnitBeingAttacked` with `sourceSelector: "ENEMY"`,
    // `targetSelector: "ALLY"`: an enemy attacks an ally positioned in front
    // of Suiran.
    const attackedAlly = createBattleUnit(
      member("ally:attacked", ATTACKER_UNIT_ID, "ALLY", { column: "LEFT", row: "FRONT" }),
      "ALLY",
      LIMITS,
    );
    const enemyAttacker = createBattleUnit(
      member("enemy:attacker", ENEMY_UNIT_ID, "ENEMY", { column: "LEFT", row: "FRONT" }),
      "ENEMY",
      LIMITS,
    );
    const unitDefinitions = new Map(snapshot.units);
    unitDefinitions.set(
      createUnitDefinitionId(ATTACKER_UNIT_ID),
      testUnitDefinition(ATTACKER_UNIT_ID, 20),
    );
    unitDefinitions.set(
      createUnitDefinitionId(ENEMY_UNIT_ID),
      testUnitDefinition(ENEMY_UNIT_ID, 5),
    );
    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: snapshot.effectActions,
      unitDefinitions,
      skillDefinitions: snapshot.skills,
    };

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

    expect(() =>
      runtime.onFactEvent(unitBeingAttacked, [suiran, attackedAlly, enemyAttacker]),
    ).toThrowError(/EffectAction kind other than .* is not supported/);

    // Candidate detection + activation genuinely started (PP was consumed) —
    // the throw comes from the unimplemented EffectAction kind, not from a
    // TRIGGER_TARGET resolution failure or a missed candidate.
    const passiveActivated = recorder
      .getEvents()
      .find(
        (e) =>
          e.eventType === "PassiveActivated" &&
          (e.payload as { skillDefinitionId: string }).skillDefinitionId === SUIRAN_PS1_ID,
      );
    expect(passiveActivated).toBeDefined();
  });

  it("IT-CAP-TRIGGER-CONTEXT-PROD-003 (RES-005, Issue #172; PR #220 review finding [P2]): SKL_SUIRAN_CHAOS_PS2 is detected and activates through the REAL HitPointReduced event applyDamageAction emits for a genuine enemy attack, then fails on the separately-unimplemented HEAL kind (Issue #184) — not on TRIGGER_TARGET resolution", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([SUIRAN_UNIT_ID as never], []);

    const suiran = {
      ...createBattleUnit(
        member("ally:suiran", SUIRAN_UNIT_ID, "ALLY", { column: "LEFT", row: "BACK" }),
        "ALLY",
        LIMITS,
      ),
      currentPp: LIMITS.maximumPp,
    };
    // PS2's trigger is `HitPointReduced` with `sourceSelector: "ENEMY"`,
    // `targetSelector: "ALLY"` (PR #220 review [P2]: corrected from "ALLY" —
    // the real Damage pipeline always sets `HitPointReduced.sourceUnitId` to
    // the attacker, so a `sourceSelector: "ALLY"` could never match a normal
    // enemy attack; see catalog-src/units/UNIT_SUIRAN_CHAOS/skills.json).
    // The condition additionally requires the target's HP_RATIO<=0.5 and the
    // target positioned in front of Suiran. `woundedAlly.combatStats.maximumHp`
    // is lowered so a single real hit from `enemyAttacker` (attack 50 -
    // defense 10 = 40 damage) crosses the 50% threshold.
    const woundedAlly = {
      ...createBattleUnit(
        member("ally:wounded", ATTACKER_UNIT_ID, "ALLY", { column: "LEFT", row: "FRONT" }),
        "ALLY",
        LIMITS,
      ),
      combatStats: {
        maximumHp: 60,
        attack: 50,
        defense: 10,
        criticalRate: 0,
        actionSpeed: 10,
        criticalDamageBonus: 0.5,
        affinityBonus: 0.25,
      },
      currentHp: 60,
    };
    const enemyAttacker = createBattleUnit(
      member("enemy:attacker", ENEMY_UNIT_ID, "ENEMY", { column: "LEFT", row: "FRONT" }),
      "ENEMY",
      LIMITS,
    );
    const unitDefinitions = new Map(snapshot.units);
    unitDefinitions.set(
      createUnitDefinitionId(ATTACKER_UNIT_ID),
      testUnitDefinition(ATTACKER_UNIT_ID, 20),
    );
    unitDefinitions.set(
      createUnitDefinitionId(ENEMY_UNIT_ID),
      testUnitDefinition(ENEMY_UNIT_ID, 5),
    );
    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: snapshot.effectActions,
      unitDefinitions,
      skillDefinitions: snapshot.skills,
    };

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

    expect(() =>
      runtime.onFactEvent(hitPointReduced, [suiran, updatedWoundedAlly, enemyAttacker]),
    ).toThrowError(/EffectAction kind other than .* is not supported/);

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
