import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import type { CombatStats } from "../../domain/battle/model/starting-combat-stats.js";
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
import type { CriticalMode } from "../../domain/catalog/definitions/catalog-enums.js";
import type { Side } from "../../domain/shared/side.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import { applyStateDelta } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import {
  definitionsWith,
  initialSnapshotFor,
  loadProductionSnapshot,
  testBattleUnit,
  testUnitDefinition,
} from "../../testing/fixtures/index.js";

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
// 攻撃力50・防御力0で「非会心50／会心100ダメージ」を基準に会心制御を観測する。
const COMBAT_STATS = { maximumHp: 1000, attack: 50, defense: 0 };

/** APを満タンにし、合成ASを即時使用できる状態で組む。 */
function readyUnit(
  battleUnitId: string,
  unitDefinitionId: string,
  side: Side,
  position: FormationPosition,
  combatStats: Partial<CombatStats> = {},
): BattleUnit {
  return testBattleUnit({
    battleUnitId,
    unitDefinitionId,
    side,
    position,
    combatStats: { ...COMBAT_STATS, ...combatStats },
    limits: LIMITS,
    overrides: { currentAp: LIMITS.maximumAp },
  });
}

/**
 * 与えたEffectActionDefinitionを順に自己対象で解決する最小限の合成AS。1件なら
 * 実production定義だけを解決し、複数件なら**同じ1行動の中で**続けて解決する
 * （`timeLimit: ACTION(1)`の効果が行動境界で失効するのと、解除で消えるのとを
 * 区別するため — PR #297 レビュー[P1]）。
 */
function selfStepsSkill(skillId: string, ...effectActionIds: readonly string[]): SkillDefinition {
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
      steps: effectActionIds.map((effectActionId) => ({
        kind: "ACTION" as const,
        stepCondition: { kind: "TRUE" as const },
        targetCondition: { kind: "TRUE" as const },
        target: { kind: "SELF" as const },
        actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(effectActionId) }],
      })),
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

/**
 * PR #297 レビュー[P1]: 会心不可のカテゴリ分類を実ライフサイクルで確かめるための、
 * 自己対象の`REMOVE_EFFECTS`／`EFFECT_IMMUNITY`合成定義。
 */
function categoryAction(
  id: string,
  definition: Extract<EffectActionDefinition, { kind: "REMOVE_EFFECTS" | "EFFECT_IMMUNITY" }>,
): EffectActionDefinition {
  return { ...definition, effectActionDefinitionId: createEffectActionDefinitionId(id) };
}

function removeEffectsAction(id: string, category: "BUFF" | "DEBUFF"): EffectActionDefinition {
  return categoryAction(id, {
    kind: "REMOVE_EFFECTS",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: { categories: [category] },
  });
}

function immunityAction(id: string, category: "BUFF" | "DEBUFF"): EffectActionDefinition {
  return categoryAction(id, {
    kind: "EFFECT_IMMUNITY",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      categories: [category],
      duration: {
        timeLimit: { unit: "ACTION", count: 2 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      maxBlocks: null,
    },
  });
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
  extraEffectActions: readonly EffectActionDefinition[] = [],
): Fixture {
  const snapshot = loadProductionSnapshot(CATALOG_DIR, unitIds);
  return {
    definitions: definitionsWith(snapshot, {
      units: [testUnitDefinition(ATTACKER_UNIT_ID, { baseStats: COMBAT_STATS })],
      skills,
      overrides: {
        effectActions: new Map([
          ...snapshot.effectActions,
          ...[singleHitAttack(criticalMode), ...extraEffectActions].map(
            (definition) => [definition.effectActionDefinitionId, definition] as const,
          ),
        ]),
      },
    }),
    recorder: new EventRecorder(createBattleId("B_1")),
  };
}

describe("production Catalog CRITICAL_GUARANTEE / CRITICAL_PREVENTION (DMG-003A, Issue #295, R-CRT-03)", () => {
  it("IT-CAP-CRITICAL-CONTROL-PROD-001 (R-ACTN-03/R-CRT-03, real lifecycle wiring): resolving the real ACT_MIKOTO_SURVIVOR_EX_CRIT_GUARANTEE definition through resolveSkillUse grants a statusKind:CRITICAL_GUARANTEE AppliedEffect with the production-defined ACTION(2) time limit, matching Domain Event / StateDelta / independent-Reducer expectations", () => {
    const grantSkill = selfStepsSkill("SKL_TEST_GRANT_CRIT_GUARANTEE", CRIT_GUARANTEE_EFFECT_ID);
    const { definitions, recorder } = fixture([MIKOTO_UNIT_ID], [grantSkill]);
    const mikoto = readyUnit("ally:mikoto", MIKOTO_UNIT_ID, "ALLY", {
      column: "CENTER",
      row: "FRONT",
    });

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

    const reduced = applyStateDelta(
      initialSnapshotFor([mikoto], { status: "READY" }),
      applied.stateDelta!,
    );
    expect(reduced.units[mikoto.battleUnitId]!.effects).toHaveLength(1);
    expect(reduced.units[mikoto.battleUnitId]!.effects![0]).toMatchObject({
      effectDefinitionId: CRIT_GUARANTEE_EFFECT_ID,
      statusKind: "CRITICAL_GUARANTEE",
      duration: { unit: "ACTION", remaining: 2 },
    });
  });

  it("IT-CAP-CRITICAL-CONTROL-PROD-002 (R-ACTN-03/R-CRT-03, real lifecycle wiring): resolving the real ACT_TARISA_TROUBLEMAKER_AS1_CRIT_PREVENTION definition through resolveSkillUse grants a statusKind:CRITICAL_PREVENTION AppliedEffect with the production-defined ACTION(1) time limit, matching Domain Event / StateDelta / independent-Reducer expectations", () => {
    const grantSkill = selfStepsSkill("SKL_TEST_GRANT_CRIT_PREVENTION", CRIT_PREVENTION_EFFECT_ID);
    const { definitions, recorder } = fixture([TARISA_UNIT_ID], [grantSkill]);
    const tarisa = readyUnit("ally:tarisa", TARISA_UNIT_ID, "ALLY", {
      column: "CENTER",
      row: "FRONT",
    });

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
    // PR #297 レビュー[P1]: 会心不可は保持者を弱化するデバフであり、`STATUS`
    // （定義済み状態異常）ではない。
    expect([...prevention.categories]).toEqual(["DEBUFF"]);
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
    expect([...applied.payload.categories]).toEqual(["DEBUFF"]);

    const reduced = applyStateDelta(
      initialSnapshotFor([tarisa], { status: "READY" }),
      applied.stateDelta!,
    );
    expect(reduced.units[tarisa.battleUnitId]!.effects).toHaveLength(1);
    expect(reduced.units[tarisa.battleUnitId]!.effects![0]).toMatchObject({
      effectDefinitionId: CRIT_PREVENTION_EFFECT_ID,
      statusKind: "CRITICAL_PREVENTION",
      categories: ["DEBUFF"],
      duration: { unit: "ACTION", remaining: 1 },
    });
  });

  it("IT-CAP-CRITICAL-CONTROL-PROD-005 (R-EFF-02/R-EFF-03, PR #297 レビュー[P1]): the real production CRITICAL_PREVENTION is removed by a DEBUFF cleanse, survives a BUFF cleanse, and is blocked outright by a DEBUFF immunity", () => {
    const debuffCleanse = removeEffectsAction("ACT_TEST_CLEANSE_DEBUFF", "DEBUFF");
    const buffCleanse = removeEffectsAction("ACT_TEST_CLEANSE_BUFF", "BUFF");
    const debuffImmunity = immunityAction("ACT_TEST_IMMUNITY_DEBUFF", "DEBUFF");

    /** 1行動の中でstepを順に解決し、解決後のtarisaを返す。 */
    function resolveSteps(skill: SkillDefinition): BattleUnit {
      const { definitions, recorder } = fixture([TARISA_UNIT_ID], [skill], "NORMAL", [
        debuffCleanse,
        buffCleanse,
        debuffImmunity,
      ]);
      const tarisa = readyUnit("ally:tarisa", TARISA_UNIT_ID, "ALLY", {
        column: "CENTER",
        row: "FRONT",
      });
      const result = resolveSkillUse(
        tarisa,
        skill,
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
      return result.units.find((u) => u.battleUnitId === tarisa.battleUnitId)!;
    }

    // デバフ解除で消える。
    const afterDebuffCleanse = resolveSteps(
      selfStepsSkill(
        "SKL_TEST_PREVENTION_THEN_CLEANSE_DEBUFF",
        CRIT_PREVENTION_EFFECT_ID,
        "ACT_TEST_CLEANSE_DEBUFF",
      ),
    );
    expect(afterDebuffCleanse.appliedEffects).toHaveLength(0);

    // バフ解除では消えない（会心不可はバフではない）。
    const afterBuffCleanse = resolveSteps(
      selfStepsSkill(
        "SKL_TEST_PREVENTION_THEN_CLEANSE_BUFF",
        CRIT_PREVENTION_EFFECT_ID,
        "ACT_TEST_CLEANSE_BUFF",
      ),
    );
    expect(afterBuffCleanse.appliedEffects).toHaveLength(1);
    expect(afterBuffCleanse.appliedEffects[0]).toMatchObject({
      effectActionDefinitionId: CRIT_PREVENTION_EFFECT_ID,
      statusKind: "CRITICAL_PREVENTION",
    });

    // デバフ免疫は付与そのものを阻止する（残るのは免疫効果だけ）。
    const afterImmunity = resolveSteps(
      selfStepsSkill(
        "SKL_TEST_IMMUNITY_THEN_PREVENTION",
        "ACT_TEST_IMMUNITY_DEBUFF",
        CRIT_PREVENTION_EFFECT_ID,
      ),
    );
    expect(
      afterImmunity.appliedEffects.filter((effect) => effect.statusKind === "CRITICAL_PREVENTION"),
    ).toHaveLength(0);
    expect(afterImmunity.appliedEffects).toHaveLength(1);
    expect(afterImmunity.appliedEffects[0]!.immunity).toMatchObject({ categories: ["DEBUFF"] });
  });

  it("IT-CAP-CRITICAL-CONTROL-PROD-006 (R-EFF-02, PR #297 レビュー[P1]): the real production CRITICAL_GUARANTEE stays a BUFF — a BUFF cleanse removes it and a DEBUFF cleanse does not", () => {
    const debuffCleanse = removeEffectsAction("ACT_TEST_CLEANSE_DEBUFF", "DEBUFF");
    const buffCleanse = removeEffectsAction("ACT_TEST_CLEANSE_BUFF", "BUFF");

    function resolveSteps(skill: SkillDefinition): BattleUnit {
      const { definitions, recorder } = fixture([MIKOTO_UNIT_ID], [skill], "NORMAL", [
        debuffCleanse,
        buffCleanse,
      ]);
      const mikoto = readyUnit("ally:mikoto", MIKOTO_UNIT_ID, "ALLY", {
        column: "CENTER",
        row: "FRONT",
      });
      const result = resolveSkillUse(
        mikoto,
        skill,
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
      return result.units.find((u) => u.battleUnitId === mikoto.battleUnitId)!;
    }

    expect(
      resolveSteps(
        selfStepsSkill(
          "SKL_TEST_GUARANTEE_THEN_CLEANSE_BUFF",
          CRIT_GUARANTEE_EFFECT_ID,
          "ACT_TEST_CLEANSE_BUFF",
        ),
      ).appliedEffects,
    ).toHaveLength(0);

    const afterDebuffCleanse = resolveSteps(
      selfStepsSkill(
        "SKL_TEST_GUARANTEE_THEN_CLEANSE_DEBUFF",
        CRIT_GUARANTEE_EFFECT_ID,
        "ACT_TEST_CLEANSE_DEBUFF",
      ),
    );
    expect(afterDebuffCleanse.appliedEffects).toHaveLength(1);
    expect(afterDebuffCleanse.appliedEffects[0]).toMatchObject({
      statusKind: "CRITICAL_GUARANTEE",
    });
  });

  it("IT-CAP-CRITICAL-CONTROL-PROD-003 (R-CRT-03 #2, CAP_CRITICAL_CONTROL): an attacker holding the real production CRITICAL_GUARANTEE buff crits a NORMAL-declared attack at 0% criticalRate, without consuming the RandomSource", () => {
    const grantSkill = selfStepsSkill("SKL_TEST_GRANT_CRIT_GUARANTEE", CRIT_GUARANTEE_EFFECT_ID);
    const attackSkill = attackerSkill();
    const { definitions, recorder } = fixture(
      [MIKOTO_UNIT_ID],
      [grantSkill, attackSkill],
      "NORMAL",
    );
    const mikoto = readyUnit("ally:mikoto", MIKOTO_UNIT_ID, "ALLY", {
      column: "CENTER",
      row: "FRONT",
    });
    const enemy = readyUnit("enemy:target", ATTACKER_UNIT_ID, "ENEMY", {
      column: "CENTER",
      row: "FRONT",
    });

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
    const grantSkill = selfStepsSkill("SKL_TEST_GRANT_CRIT_PREVENTION", CRIT_PREVENTION_EFFECT_ID);
    const attackSkill = attackerSkill();

    function attackDamage(preventionOn: "ATTACKER" | "DEFENDER"): number {
      const { definitions, recorder } = fixture(
        [TARISA_UNIT_ID],
        [grantSkill, attackSkill],
        "NORMAL",
      );
      // 攻撃側は会心率100%。会心不可を保持していなければ必ず会心する。
      const attacker = readyUnit(
        "ally:tarisa",
        TARISA_UNIT_ID,
        "ALLY",
        { column: "CENTER", row: "FRONT" },
        { criticalRate: 1 },
      );
      const defender = readyUnit("enemy:target", TARISA_UNIT_ID, "ENEMY", {
        column: "CENTER",
        row: "FRONT",
      });
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
