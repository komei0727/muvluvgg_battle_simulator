import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { createActionId } from "../../domain/shared/event-ids.js";
import { createBattleId } from "../../domain/shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { TargetSelectorDefinition } from "../../domain/catalog/definitions/target-selector-definition.js";
import { applyStateDelta } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import {
  definitionsWith,
  effectActionFrom,
  initialSnapshotFor,
  loadProductionSnapshot,
  testBattleUnit,
  testUnitDefinition,
} from "../../testing/fixtures/index.js";

/**
 * TGT-004フェーズ3（Issue #167、R-TGT-08「ステルス」production Catalog統合）:
 * production Catalogの`ACT_MAO_COMMITTEE_PS2_STEALTH`（`APPLY_STATUS`/
 * `status: STEALTH`、`duration.timeLimit: {unit: SKILL_USE, count: 3}`、
 * `linkedEffectGroupId: MAO_COMMITTEE_PS2_LINK`）を実カタログから読み込み、
 * 実ライフサイクル（`resolveSkillUse`→`resolveEffectSequencePlan`→
 * `grantEffect`のAPPLY_STATUS resolver）経由で実際に付与し、R-TGT-08の
 * リダイレクト・消費（`target-selection-policy.ts`/`expireEffects`）が
 * 近似なしの本番効果に対して機能することを検証する。
 *
 * `SKL_MAO_COMMITTEE_PS2`自身は同じstepでCLEANSE（`REMOVE_EFFECTS`、M7-001で
 * 実装済み）・HEAL（`APPLY_CONTINUOUS_HEAL`、M7-005）・DMG_DOWN
 * （`APPLY_DAMAGE_MOD`、DMG-002）も解決するが、後者2つは`capabilities.json`で
 * 別タスク化された未実装kindのため、そのまま丸ごと実行するとHEAL/DMG_DOWNで
 * 例外になりSTEALTHへ到達できない。
 * そのためこのテストは`SKL_MAO_COMMITTEE_PS2`を丸ごと実行するのではなく、
 * 実カタログから読み込んだ`ACT_MAO_COMMITTEE_PS2_STEALTH`定義そのものだけを
 * 単一actionに持つ最小限の合成AS skillで包み、STEALTH付与単体を実配線経由で
 * 検証する（Phase 1/2が単一EffectActionDefinitionを分離して検証してきたのと
 * 同じ方針）。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const MAO_UNIT_ID = "UNIT_MAO_COMMITTEE";
const STEALTH_EFFECT_ID = "ACT_MAO_COMMITTEE_PS2_STEALTH";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };
const COMBAT_STATS = { maximumHp: 100, attack: 50, defense: 0 };

/** A minimal synthetic AS skill wrapping ONLY the real production STEALTH effect action, self-targeted. */
function grantStealthSkill(): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId("SKL_TEST_GRANT_STEALTH"),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
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
          actions: [
            { effectActionDefinitionId: createEffectActionDefinitionId(STEALTH_EFFECT_ID) },
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
    metadata: { displayName: "TestGrantStealth", tags: [] },
  };
}

function attackerSkill(effectActionId: string): SkillDefinition {
  const selector: TargetSelectorDefinition = {
    kind: "SELECT",
    side: "ENEMY",
    count: 1,
    filters: [],
    order: ["DEFAULT"],
    includeDefeated: false,
  };
  return {
    skillDefinitionId: createSkillDefinitionId("SKL_TEST_ATTACKER"),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [{ targetBindingId: createTargetBindingId("TGT_1"), selector }],
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
    requiredCapabilities: [],
    metadata: { displayName: "TestAttacker", tags: [] },
  };
}

function attackEffectAction(id: string): EffectActionDefinition {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
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

describe("production Catalog ACT_MAO_COMMITTEE_PS2_STEALTH (TGT-004フェーズ3, Issue #167, R-TGT-08)", () => {
  it("IT-CAP-STEALTH-PROD-001 (R-ACTN-03, real lifecycle wiring): resolving the real production ACT_MAO_COMMITTEE_PS2_STEALTH definition through resolveSkillUse grants a statusKind:STEALTH AppliedEffect with the production-defined SKILL_USE(3) duration and linkedEffectGroupId, matching Domain Event / StateDelta / independent-Reducer expectations", () => {
    const snapshot = loadProductionSnapshot(CATALOG_DIR, [MAO_UNIT_ID]);
    const stealthDefinition = effectActionFrom(snapshot, STEALTH_EFFECT_ID);
    expect(stealthDefinition.kind).toBe("APPLY_STATUS");

    const mao = testBattleUnit({
      battleUnitId: "ally:mao",
      unitDefinitionId: MAO_UNIT_ID,
      position: { column: "CENTER", row: "FRONT" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
      overrides: { currentAp: LIMITS.maximumAp },
    });
    const skill = grantStealthSkill();
    const definitions = definitionsWith(snapshot, { skills: [skill] });
    const recorder = new EventRecorder(createBattleId("B_1"));
    const before = recorder.getEvents().length;

    const result = resolveSkillUse(
      mao,
      skill,
      "AS",
      "AS",
      [mao],
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:1"),
      recorder.nextResolutionScopeId(),
    );

    const maoAfter = result.units.find((u) => u.battleUnitId === mao.battleUnitId)!;
    expect(maoAfter.appliedEffects).toHaveLength(1);
    const stealth = maoAfter.appliedEffects[0]!;
    expect(stealth).toMatchObject({
      effectActionDefinitionId: stealthDefinition.effectActionDefinitionId,
      statusKind: "STEALTH",
      duplicate: true,
      magnitude: 0,
    });
    expect(stealth.duration.definition).toMatchObject({
      timeLimit: { unit: "SKILL_USE", count: 3 },
      linkedEffectGroupId: "MAO_COMMITTEE_PS2_LINK",
    });
    expect(stealth.duration.timeLimitRemaining).toBe(3);

    const applied = recorder
      .getEvents()
      .slice(before)
      .find((e) => e.eventType === "EffectApplied") as Extract<
      BattleDomainEvent,
      { eventType: "EffectApplied" }
    >;
    expect(applied).toBeDefined();
    expect(applied.payload).toMatchObject({
      statusKind: "STEALTH",
      durationUnit: "SKILL_USE",
      initialRemaining: 3,
      linkedEffectGroupId: "MAO_COMMITTEE_PS2_LINK",
    });

    // 独立Reducer復元: EffectApplied自身のstateDeltaだけからAppliedEffectを
    // 復元しても、実lifecycle経由で得た値と一致する（statusKindを含む）。
    const emptyState = initialSnapshotFor([mao], { status: "READY" });
    const reduced = applyStateDelta(emptyState, applied.stateDelta!);
    expect(reduced.units[mao.battleUnitId]!.effects).toHaveLength(1);
    expect(reduced.units[mao.battleUnitId]!.effects![0]).toMatchObject({
      effectDefinitionId: stealthDefinition.effectActionDefinitionId,
      statusKind: "STEALTH",
      duration: { unit: "SKILL_USE", remaining: 3 },
    });
  });

  it("IT-CAP-STEALTH-PROD-002 (R-TGT-08, Q-TGT-05): a unit holding the real production Stealth AppliedEffect is redirected away from as first-priority target, and the Stealth is consumed (EffectExpired/CONSUMPTION) on the real production instance", () => {
    const snapshot = loadProductionSnapshot(CATALOG_DIR, [MAO_UNIT_ID]);

    const attackerUnitId = "UNIT_TEST_STEALTH_ATTACKER";
    const otherAllyUnitId = "UNIT_TEST_STEALTH_OTHER_ALLY";
    const attackDefinitionId = "ACT_TEST_STEALTH_ATTACK";

    const mao = testBattleUnit({
      battleUnitId: "ally:mao",
      unitDefinitionId: MAO_UNIT_ID,
      position: { column: "CENTER", row: "FRONT" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
      overrides: { currentAp: LIMITS.maximumAp },
    });
    const otherAlly = testBattleUnit({
      battleUnitId: "ally:other",
      unitDefinitionId: otherAllyUnitId,
      position: { column: "LEFT", row: "BACK" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
    });
    const attacker = testBattleUnit({
      battleUnitId: "enemy:attacker",
      unitDefinitionId: attackerUnitId,
      side: "ENEMY",
      position: { column: "CENTER", row: "FRONT" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
      overrides: { currentAp: LIMITS.maximumAp },
    });

    const grantSkill = grantStealthSkill();
    const attack = attackEffectAction(attackDefinitionId);
    const attackSkill = attackerSkill(attackDefinitionId);
    const effectActions = new Map(snapshot.effectActions);
    effectActions.set(attack.effectActionDefinitionId, attack);
    const definitions = definitionsWith(snapshot, {
      units: [
        testUnitDefinition(attackerUnitId, { baseStats: COMBAT_STATS }),
        testUnitDefinition(otherAllyUnitId, { baseStats: COMBAT_STATS }),
      ],
      skills: [grantSkill, attackSkill],
      overrides: { effectActions },
    });
    const recorder = new EventRecorder(createBattleId("B_1"));

    const grantResult = resolveSkillUse(
      mao,
      grantSkill,
      "AS",
      "AS",
      [mao, otherAlly, attacker],
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:1"),
      recorder.nextResolutionScopeId(),
    );
    const maoAfterGrant = grantResult.units.find((u) => u.battleUnitId === mao.battleUnitId)!;
    expect(maoAfterGrant.appliedEffects).toHaveLength(1);
    const stealthInstance = maoAfterGrant.appliedEffects[0]!;
    const attackerAfterGrant = grantResult.units.find(
      (u) => u.battleUnitId === attacker.battleUnitId,
    )!;
    const eventsBeforeAttack = recorder.getEvents().length;

    const attackResult = resolveSkillUse(
      attackerAfterGrant,
      attackSkill,
      "AS",
      "AS",
      grantResult.units,
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:2"),
      recorder.nextResolutionScopeId(),
    );

    const maoAfterAttack = attackResult.units.find((u) => u.battleUnitId === mao.battleUnitId)!;
    const otherAllyAfterAttack = attackResult.units.find(
      (u) => u.battleUnitId === otherAlly.battleUnitId,
    )!;
    // R-TGT-08 #3: MAO (first-priority, Stealthed) is moved to the end of
    // candidate order, so the DAMAGE lands on otherAlly instead.
    expect(maoAfterAttack.currentHp).toBe(mao.currentHp);
    expect(otherAllyAfterAttack.currentHp).toBeLessThan(otherAlly.currentHp);
    // The real production Stealth instance is consumed.
    expect(maoAfterAttack.appliedEffects).toHaveLength(0);

    const eventsFromAttack = recorder.getEvents().slice(eventsBeforeAttack);
    const expired = eventsFromAttack.find((e) => e.eventType === "EffectExpired") as Extract<
      BattleDomainEvent,
      { eventType: "EffectExpired" }
    >;
    expect(expired).toBeDefined();
    expect(expired.payload).toMatchObject({
      effectInstanceId: stealthInstance.effectInstanceId,
      battleUnitId: mao.battleUnitId,
      reason: "CONSUMPTION",
    });
  });
});
