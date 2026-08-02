import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { createBattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { createActionId } from "../../domain/shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";
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
import type { CriticalMode } from "../../domain/catalog/definitions/catalog-enums.js";
import type { Side } from "../../domain/shared/side.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { applyStateDelta } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import type { BattleStateSnapshot } from "../../domain/battle/lifecycle/battle-state-snapshot.js";

/**
 * DMG-003A（Issue #295、R-CRT-03「会心保証・会心不可」、`CAP_CRITICAL_CONTROL`）:
 * production Catalogの`ACT_MIKOTO_SURVIVOR_EX_CRIT_GUARANTEE`
 * （`APPLY_STATUS`/`status: CRITICAL_GUARANTEE`、`timeLimit: ACTION(2)`）と
 * `ACT_TARISA_TROUBLEMAKER_AS1_CRIT_PREVENTION`
 * （`status: CRITICAL_PREVENTION`、`probability: 1`、`timeLimit: ACTION(1)`）を
 * 実カタログから読み込み、実ライフサイクル（`resolveSkillUse`→
 * `resolveEffectSequencePlan`→`grantEffect`のAPPLY_STATUS resolver→
 * `damage-application-service.ts`の会心判定）経由で近似なしに解決できることを
 * 検証する。
 *
 * 定義元スキル（`SKL_MIKOTO_SURVIVOR_EX`/`SKL_TARISA_TROUBLEMAKER_AS1`）自身は
 * 同じ解決の中で別Taskが担当する未実装kind（`APPLY_SHIELD`＝`CAP_SHIELD`/DMG-004等）
 * も解決するため、`hit-evasion-guaranteed-hit-production-catalog.test.ts`と同じ方針で、
 * 実カタログのEffectActionDefinitionそのものだけを単一actionに持つ最小限の合成AS
 * skillで包んで検証する。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const MIKOTO_UNIT_ID = "UNIT_MIKOTO_SURVIVOR";
const TARISA_UNIT_ID = "UNIT_TARISA_TROUBLEMAKER";
const CRIT_GUARANTEE_EFFECT_ID = "ACT_MIKOTO_SURVIVOR_EX_CRIT_GUARANTEE";
const CRIT_PREVENTION_EFFECT_ID = "ACT_TARISA_TROUBLEMAKER_AS1_CRIT_PREVENTION";
const ATTACKER_UNIT_ID = "UNIT_TEST_CRIT_ATTACKER";
const ATTACK_EFFECT_ID = "ACT_TEST_CRIT_ATTACK";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function member(
  battleUnitId: string,
  unitDefinitionId: string,
  side: Side,
  position: FormationPosition,
  overrides: { criticalRate?: number; maximumHp?: number } = {},
): BattlePartyMember {
  return {
    battleUnitId: createBattleUnitId(battleUnitId),
    unitDefinitionId: unitDefinitionId as never,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: overrides.maximumHp ?? 1000,
      attack: 50,
      defense: 0,
      criticalRate: overrides.criticalRate ?? 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
}

function testUnitDefinition(id: string): UnitDefinition {
  return {
    unitDefinitionId: createUnitDefinitionId(id),
    attribute: "AGGRESSIVE",
    unitType: "PHYSICAL",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT", "BACK"],
    baseStats: {
      maximumHp: 1000,
      attack: 50,
      defense: 0,
      criticalRate: 0,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
      actionSpeed: 10,
      maximumAp: LIMITS.maximumAp,
      maximumPp: LIMITS.maximumPp,
    },
    extraGaugeMaximum: LIMITS.maximumExtraGauge,
    activeSkillDefinitionIds: [],
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

/** 実production EffectActionDefinitionだけを自己対象で解決する最小限の合成AS。 */
function selfGrantSkill(skillId: string, effectActionId: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(skillId),
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
    metadata: { displayName: skillId, tags: [] },
  };
}

function attackerSkill(): SkillDefinition {
  const selector: TargetSelectorDefinition = {
    kind: "SELECT",
    side: "ENEMY",
    count: 1,
    filters: [],
    order: ["DEFAULT"],
    includeDefeated: false,
  };
  return {
    skillDefinitionId: createSkillDefinitionId("SKL_TEST_CRIT_ATTACKER"),
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
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(ATTACK_EFFECT_ID) }],
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
    metadata: { displayName: "TestCritAttacker", tags: [] },
  };
}

/** 1ヒットの通常命中攻撃。`critical.mode`だけをテストごとに差し替える。 */
function singleHitAttack(criticalMode: CriticalMode): EffectActionDefinition {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(ATTACK_EFFECT_ID),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: 1 },
      hitCount: 1,
      critical: { mode: criticalMode },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

interface Fixture {
  readonly definitions: BattleDefinitions;
  readonly recorder: EventRecorder;
}

function fixture(
  unitIds: readonly string[],
  skills: readonly SkillDefinition[],
  criticalMode: CriticalMode = "NORMAL",
): Fixture {
  const catalog = loadCatalogFromDirectory(CATALOG_DIR);
  const snapshot = catalog.loadSnapshot(unitIds as never[], []);
  const attack = singleHitAttack(criticalMode);
  const effectActions = new Map(snapshot.effectActions);
  effectActions.set(attack.effectActionDefinitionId, attack);
  const skillDefinitions = new Map(snapshot.skills);
  for (const skill of skills) {
    skillDefinitions.set(skill.skillDefinitionId, skill);
  }
  const unitDefinitions = new Map(snapshot.units);
  unitDefinitions.set(
    createUnitDefinitionId(ATTACKER_UNIT_ID),
    testUnitDefinition(ATTACKER_UNIT_ID),
  );
  return {
    definitions: {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions,
      unitDefinitions,
      skillDefinitions,
    },
    recorder: new EventRecorder(createBattleId("B_1")),
  };
}

function emptyStateFor(unit: ReturnType<typeof createBattleUnit>): BattleStateSnapshot {
  return {
    status: "READY",
    currentTurn: 1,
    units: {
      [unit.battleUnitId]: {
        hp: unit.currentHp,
        ap: unit.currentAp,
        pp: unit.currentPp,
        extraGauge: unit.currentExtraGauge,
        maximumAp: unit.maximumAp,
        maximumPp: unit.maximumPp,
        maximumExtraGauge: unit.maximumExtraGauge,
        combatStats: unit.combatStats,
      },
    },
  };
}

describe("production Catalog CRITICAL_GUARANTEE / CRITICAL_PREVENTION (DMG-003A, Issue #295, R-CRT-03)", () => {
  it("IT-CAP-CRITICAL-CONTROL-PROD-001 (R-ACTN-03/R-CRT-03, real lifecycle wiring): resolving the real ACT_MIKOTO_SURVIVOR_EX_CRIT_GUARANTEE definition through resolveSkillUse grants a statusKind:CRITICAL_GUARANTEE AppliedEffect with the production-defined ACTION(2) time limit, matching Domain Event / StateDelta / independent-Reducer expectations", () => {
    const grantSkill = selfGrantSkill("SKL_TEST_GRANT_CRIT_GUARANTEE", CRIT_GUARANTEE_EFFECT_ID);
    const { definitions, recorder } = fixture([MIKOTO_UNIT_ID], [grantSkill]);
    const mikoto = {
      ...createBattleUnit(
        member("ally:mikoto", MIKOTO_UNIT_ID, "ALLY", { column: "CENTER", row: "FRONT" }),
        "ALLY",
        LIMITS,
      ),
      currentAp: LIMITS.maximumAp,
    };

    const result = resolveSkillUse(
      mikoto,
      grantSkill,
      "AS",
      "AS",
      [mikoto],
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:1"),
      recorder.nextResolutionScopeId(),
    );

    const mikotoAfter = result.units.find((u) => u.battleUnitId === mikoto.battleUnitId)!;
    expect(mikotoAfter.appliedEffects).toHaveLength(1);
    const guarantee = mikotoAfter.appliedEffects[0]!;
    expect(guarantee).toMatchObject({
      effectActionDefinitionId: CRIT_GUARANTEE_EFFECT_ID,
      statusKind: "CRITICAL_GUARANTEE",
      duplicate: true,
      magnitude: 0,
    });
    expect(guarantee.duration.definition).toMatchObject({
      timeLimit: { unit: "ACTION", count: 2 },
      dispellable: true,
    });
    expect(guarantee.duration.timeLimitRemaining).toBe(2);

    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied") as Extract<
      BattleDomainEvent,
      { eventType: "EffectApplied" }
    >;
    expect(applied).toBeDefined();
    expect(applied.payload).toMatchObject({
      statusKind: "CRITICAL_GUARANTEE",
      durationUnit: "ACTION",
      initialRemaining: 2,
    });

    const reduced = applyStateDelta(emptyStateFor(mikoto), applied.stateDelta!);
    expect(reduced.units[mikoto.battleUnitId]!.effects).toHaveLength(1);
    expect(reduced.units[mikoto.battleUnitId]!.effects![0]).toMatchObject({
      effectDefinitionId: CRIT_GUARANTEE_EFFECT_ID,
      statusKind: "CRITICAL_GUARANTEE",
      duration: { unit: "ACTION", remaining: 2 },
    });
  });

  it("IT-CAP-CRITICAL-CONTROL-PROD-002 (R-ACTN-03/R-CRT-03, real lifecycle wiring): resolving the real ACT_TARISA_TROUBLEMAKER_AS1_CRIT_PREVENTION definition through resolveSkillUse grants a statusKind:CRITICAL_PREVENTION AppliedEffect with the production-defined ACTION(1) time limit, matching Domain Event / StateDelta / independent-Reducer expectations", () => {
    const grantSkill = selfGrantSkill("SKL_TEST_GRANT_CRIT_PREVENTION", CRIT_PREVENTION_EFFECT_ID);
    const { definitions, recorder } = fixture([TARISA_UNIT_ID], [grantSkill]);
    const tarisa = {
      ...createBattleUnit(
        member("ally:tarisa", TARISA_UNIT_ID, "ALLY", { column: "CENTER", row: "FRONT" }),
        "ALLY",
        LIMITS,
      ),
      currentAp: LIMITS.maximumAp,
    };

    const result = resolveSkillUse(
      tarisa,
      grantSkill,
      "AS",
      "AS",
      [tarisa],
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:1"),
      recorder.nextResolutionScopeId(),
    );

    const tarisaAfter = result.units.find((u) => u.battleUnitId === tarisa.battleUnitId)!;
    expect(tarisaAfter.appliedEffects).toHaveLength(1);
    const prevention = tarisaAfter.appliedEffects[0]!;
    expect(prevention).toMatchObject({
      effectActionDefinitionId: CRIT_PREVENTION_EFFECT_ID,
      statusKind: "CRITICAL_PREVENTION",
      statusDetails: { probability: 1 },
      duplicate: true,
      magnitude: 0,
    });
    expect(prevention.duration.definition).toMatchObject({
      timeLimit: { unit: "ACTION", count: 1 },
      dispellable: true,
    });
    expect(prevention.duration.timeLimitRemaining).toBe(1);

    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied") as Extract<
      BattleDomainEvent,
      { eventType: "EffectApplied" }
    >;
    expect(applied).toBeDefined();
    expect(applied.payload).toMatchObject({
      statusKind: "CRITICAL_PREVENTION",
      durationUnit: "ACTION",
      initialRemaining: 1,
    });

    const reduced = applyStateDelta(emptyStateFor(tarisa), applied.stateDelta!);
    expect(reduced.units[tarisa.battleUnitId]!.effects).toHaveLength(1);
    expect(reduced.units[tarisa.battleUnitId]!.effects![0]).toMatchObject({
      effectDefinitionId: CRIT_PREVENTION_EFFECT_ID,
      statusKind: "CRITICAL_PREVENTION",
      duration: { unit: "ACTION", remaining: 1 },
    });
  });

  it("IT-CAP-CRITICAL-CONTROL-PROD-003 (R-CRT-03 #2, CAP_CRITICAL_CONTROL): an attacker holding the real production CRITICAL_GUARANTEE buff crits a NORMAL-declared attack at 0% criticalRate, without consuming the RandomSource", () => {
    const grantSkill = selfGrantSkill("SKL_TEST_GRANT_CRIT_GUARANTEE", CRIT_GUARANTEE_EFFECT_ID);
    const attackSkill = attackerSkill();
    const { definitions, recorder } = fixture(
      [MIKOTO_UNIT_ID],
      [grantSkill, attackSkill],
      "NORMAL",
    );
    const mikoto = {
      ...createBattleUnit(
        member("ally:mikoto", MIKOTO_UNIT_ID, "ALLY", { column: "CENTER", row: "FRONT" }),
        "ALLY",
        LIMITS,
      ),
      currentAp: LIMITS.maximumAp,
    };
    const enemy = {
      ...createBattleUnit(
        member("enemy:target", ATTACKER_UNIT_ID, "ENEMY", { column: "CENTER", row: "FRONT" }),
        "ENEMY",
        LIMITS,
      ),
      currentAp: LIMITS.maximumAp,
    };

    const granted = resolveSkillUse(
      mikoto,
      grantSkill,
      "AS",
      "AS",
      [mikoto, enemy],
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:1"),
      recorder.nextResolutionScopeId(),
    );
    const eventsBeforeAttack = recorder.getEvents().length;
    // 会心保証が効いていれば実効モードはGUARANTEEDになり、R-CRT-01の確率判定
    // （RandomSource 1消費）は行われない。
    const random = new SequenceRandomSource([]);

    const attacked = resolveSkillUse(
      granted.units.find((u) => u.battleUnitId === mikoto.battleUnitId)!,
      attackSkill,
      "AS",
      "AS",
      granted.units,
      definitions,
      random,
      recorder,
      1,
      0,
      createActionId("B_1:action:2"),
      recorder.nextResolutionScopeId(),
    );

    random.assertFullyConsumed();
    const criticalCheck = recorder
      .getEvents()
      .slice(eventsBeforeAttack)
      .find((e) => e.eventType === "CriticalCheckResolved")!;
    expect(criticalCheck.payload).toMatchObject({
      mode: "GUARANTEED",
      baseCriticalRate: 0,
      effectiveCriticalRate: 0,
      result: true,
    });
    // 攻撃力50 - 防御力0 = 50、会心倍率2.0（150% + 会心ダメージボーナス50%）。
    const enemyAfter = attacked.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(enemy.currentHp - enemyAfter.currentHp).toBe(100);
  });

  it("IT-CAP-CRITICAL-CONTROL-PROD-004 (R-CRT-03 #1 / direction, CAP_CRITICAL_CONTROL): the real production CRITICAL_PREVENTION debuff stops the critical of the unit holding it, while the same debuff on the defender leaves the attacker's 100% critical untouched", () => {
    const grantSkill = selfGrantSkill("SKL_TEST_GRANT_CRIT_PREVENTION", CRIT_PREVENTION_EFFECT_ID);
    const attackSkill = attackerSkill();

    function attackDamage(preventionOn: "ATTACKER" | "DEFENDER"): number {
      const { definitions, recorder } = fixture(
        [TARISA_UNIT_ID],
        [grantSkill, attackSkill],
        "NORMAL",
      );
      // 攻撃側は会心率100%。会心不可を保持していなければ必ず会心する。
      const attacker = {
        ...createBattleUnit(
          member(
            "ally:tarisa",
            TARISA_UNIT_ID,
            "ALLY",
            { column: "CENTER", row: "FRONT" },
            {
              criticalRate: 1,
            },
          ),
          "ALLY",
          LIMITS,
        ),
        currentAp: LIMITS.maximumAp,
      };
      const defender = {
        ...createBattleUnit(
          member("enemy:target", TARISA_UNIT_ID, "ENEMY", { column: "CENTER", row: "FRONT" }),
          "ENEMY",
          LIMITS,
        ),
        currentAp: LIMITS.maximumAp,
      };
      const holder = preventionOn === "ATTACKER" ? attacker : defender;

      const granted = resolveSkillUse(
        holder,
        grantSkill,
        "AS",
        "AS",
        [attacker, defender],
        definitions,
        new SequenceRandomSource([]),
        recorder,
        1,
        0,
        createActionId("B_1:action:1"),
        recorder.nextResolutionScopeId(),
      );
      // 会心不可が攻撃側に乗っていればRandomSourceを消費せず、防御側にしか
      // 乗っていなければ実効モードはNORMALのままで1消費する。
      const random = new SequenceRandomSource(preventionOn === "ATTACKER" ? [] : [0.999999]);

      const attacked = resolveSkillUse(
        granted.units.find((u) => u.battleUnitId === attacker.battleUnitId)!,
        attackSkill,
        "AS",
        "AS",
        granted.units,
        definitions,
        random,
        recorder,
        1,
        0,
        createActionId("B_1:action:2"),
        recorder.nextResolutionScopeId(),
      );

      random.assertFullyConsumed();
      const defenderAfter = attacked.units.find((u) => u.battleUnitId === defender.battleUnitId)!;
      const before = granted.units.find((u) => u.battleUnitId === defender.battleUnitId)!;
      return before.currentHp - defenderAfter.currentHp;
    }

    // 保持者自身の攻撃は会心しない（50 × 1.0）。
    expect(attackDamage("ATTACKER")).toBe(50);
    // 防御側の保持は攻撃側の会心へ影響しない（50 × 2.0）。
    expect(attackDamage("DEFENDER")).toBe(100);
  });
});
