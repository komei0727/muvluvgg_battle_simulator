import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "./action-skill-use-resolver.js";
import { EventRecorder } from "../events/event-recorder.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { MarkerState } from "../model/marker-state.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import {
  createActionId,
  createEffectInstanceId,
  createMarkerInstanceId,
} from "../../shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createMarkerId,
  createSkillDefinitionId,
  createTargetBindingId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import { testBattleUnit } from "../../../testing/fixtures/battle-actors.js";
import { testUnitDefinition } from "../../../testing/fixtures/unit-definitions.js";

/**
 * R-SKL-03: `DAMAGE.bonusHits`のヒット数は攻撃開始時点の所持マーカー数で決まり、
 * 攻撃の途中でマーカー数が変わっても変えない。`resolveSkillUse`の実経路で固定する。
 */
describe("DAMAGE bonusHits via resolveSkillUse (R-SKL-03)", () => {
  const SKILL_ID = "SKL_TEST_BONUS_HITS";
  const DAMAGE_ID = "ACT_TEST_BONUS_HITS_DAMAGE";
  const SHIELD_ID = "ACT_TEST_BONUS_HITS_SHIELD";
  const MARKER_ID = createMarkerId("MARKER_TEST_SCAR");
  const GROUP_ID = "TEST_BONUS_HITS_SHIELD_LINK";
  const ENEMY = createBattleUnitId("enemy:1");

  const damageAction: EffectActionDefinition = {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(DAMAGE_ID),
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: 1 },
      hitCount: 1,
      bonusHits: { markerId: MARKER_ID, perStack: 1, max: 9 },
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "GUARANTEED" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };

  const shieldAction: EffectActionDefinition = {
    kind: "APPLY_SHIELD",
    effectActionDefinitionId: createEffectActionDefinitionId(SHIELD_ID),
    metadata: { tags: [] },
    payload: {
      formula: { kind: "CONSTANT", value: 1 },
      duration: {
        timeLimit: { unit: "BATTLE", count: 1 },
        dispellable: true,
        linkedEffectGroupId: GROUP_ID,
        linkedEffectGroupRole: "PARENT",
      },
    },
  };

  const skill: SkillDefinition = {
    skillDefinitionId: createSkillDefinitionId(SKILL_ID),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [
        {
          targetBindingId: createTargetBindingId("TGT_TEST_BONUS_HITS"),
          selector: {
            kind: "SELECT",
            side: "ENEMY",
            count: 1,
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
          target: {
            kind: "BINDING",
            targetBindingId: createTargetBindingId("TGT_TEST_BONUS_HITS"),
          },
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(DAMAGE_ID) }],
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
    metadata: { displayName: SKILL_ID, tags: [] },
  };

  function definitions(): BattleDefinitions {
    const attackerDefinition = testUnitDefinition("UNIT_TEST_ATTACKER");
    const enemyDefinition = testUnitDefinition("UNIT_TEST_ENEMY");
    return {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: new Map(
        [damageAction, shieldAction].map((action) => [action.effectActionDefinitionId, action]),
      ),
      unitDefinitions: new Map([
        [attackerDefinition.unitDefinitionId, attackerDefinition],
        [enemyDefinition.unitDefinitionId, enemyDefinition],
      ]),
      skillDefinitions: new Map([[skill.skillDefinitionId, skill]]),
    };
  }

  it("UT-R-SKL-03-005 [R-SKL-03, R-EFF-09]: keeps the hit count decided at the start of the attack even when the counted marker is removed after the first hit", () => {
    // 1ヒット目でシールド（PARENT）が枯渇・失効し、R-EFF-09のカスケードで同じグループの
    // マーカー（CHILD、3スタック）が攻撃の途中で消える。ヒット数は開始時点の 1 + 3 = 4。
    const shield: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("shield-1"),
      effectActionDefinitionId: createEffectActionDefinitionId(SHIELD_ID),
      kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId(SHIELD_ID)),
      duplicate: true,
      sourceUnitId: ENEMY,
      targetUnitId: ENEMY,
      magnitude: 1,
      categories: ["SHIELD"],
      shield: { shieldType: null, remaining: 1 },
      duration: {
        definition: {
          timeLimit: { unit: "BATTLE", count: 1 },
          dispellable: true,
          linkedEffectGroupId: GROUP_ID,
          linkedEffectGroupRole: "PARENT",
        },
        timeLimitRemaining: 1,
      },
      appliedTurnNumber: 1,
    };
    const scar: MarkerState = {
      markerInstanceId: createMarkerInstanceId("scar-1"),
      markerId: MARKER_ID,
      sourceUnitId: createBattleUnitId("ally:attacker"),
      targetUnitId: ENEMY,
      stackCount: 3,
      stackMax: null,
      decayingStackCount: 0,
      duration: {
        definition: {
          dispellable: true,
          linkedEffectGroupId: GROUP_ID,
          linkedEffectGroupRole: "CHILD",
        },
      },
    };
    const attacker: BattleUnit = {
      ...testBattleUnit({
        battleUnitId: "ally:attacker",
        unitDefinitionId: "UNIT_TEST_ATTACKER",
        combatStats: { attack: 100, defense: 10, maximumHp: 1000, criticalRate: 0 },
        overrides: {},
      }),
      currentAp: 2,
    };
    const enemy: BattleUnit = {
      ...testBattleUnit({
        battleUnitId: "enemy:1",
        unitDefinitionId: "UNIT_TEST_ENEMY",
        side: "ENEMY",
        combatStats: { attack: 50, defense: 20, maximumHp: 10_000 },
      }),
      appliedEffects: [shield],
      markerStates: [scar],
    };
    const battleDefinitions = definitions();
    const recorder = new EventRecorder(createBattleId("B_BONUS_HITS"));

    const result = resolveSkillUse(
      attacker,
      skill,
      "AS",
      "AS",
      [attacker, enemy],
      battleDefinitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_BONUS_HITS:action:1"),
      recorder.nextResolutionScopeId(),
    );

    const events = recorder.getEvents();
    const hitStartIndices = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.eventType === "HitConfirmed")
      .map(({ index }) => index);
    const markerRemovedIndex = events.findIndex((event) => event.eventType === "MarkerRemoved");

    expect(hitStartIndices).toHaveLength(4);
    expect(events.filter((event) => event.eventType === "DamageApplied")).toHaveLength(4);
    // マーカーは1ヒット目の解決中（シールド枯渇の失効カスケード）に消える。それでも
    // 攻撃開始時に決めた残り3ヒットを完走する。
    expect(markerRemovedIndex).toBeGreaterThan(hitStartIndices[0]!);
    expect(markerRemovedIndex).toBeLessThan(hitStartIndices[1]!);
    const enemyAfter = result.units.find((unit) => unit.battleUnitId === ENEMY)!;
    expect(enemyAfter.markerStates).toHaveLength(0);
  });
});
