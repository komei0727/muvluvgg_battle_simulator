import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
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
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { TargetSelectorDefinition } from "../../domain/catalog/definitions/target-selector-definition.js";
import type { Side } from "../../domain/shared/side.js";
import { applyStateDelta } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import {
  definitionsWith,
  initialSnapshotFor,
  loadProductionSnapshot,
  testBattleUnit,
  testUnitDefinition,
} from "../../testing/fixtures/index.js";

/**
 * DMG-006（Issue #188、R-INT-01〜03、`CAP_TARGET_REDIRECT`／`CAP_COVER_DAMAGE`／
 * `CAP_REFLECT_DAMAGE`／`CAP_DEATH_SURVIVAL`）: production Catalogの防御介入定義を
 * 実カタログから無改変で読み込み、実ライフサイクル（`resolveSkillUse`→
 * `effect-action-group-resolver.ts`の付与→`damage-application-service.ts`の
 * 介入解決）で近似なしに解決できることを検証する。
 *
 * - `ACT_KARINA_DOWNER_PS1_REDIRECT`（引き寄せ、`redirectTo: SELF`、ACTION(1)/BATTLE）
 * - `ACT_EVIE_ECO_PS1_REDIRECT` + `ACT_EVIE_ECO_PS1_COVER`（引き寄せ＋50%ガード肩代わり）
 * - `ACT_LUNA_HUNGRY_PS1_REFLECT`（受けたダメージの75%反射）
 * - `ACT_KOTOHA_REBEL_PS2_DEATH_SURVIVAL`（HP1で耐え、最大HP65%回復）
 *
 * production定義元のPS（`SKL_KARINA_DOWNER_PS1`等）は同じ解決の中で他Taskが担当する
 * 効果も解決するため、`critical-control-production-catalog.test.ts`と同じ方針で、実
 * カタログのEffectActionDefinitionそのものだけを持つ最小限の合成ASで包んで検証する。
 * 引き寄せ・肩代わりの状態はproduction PSと同じく**攻撃側**（`TRIGGER_SOURCE`）が
 * 保持するため、合成ASも敵単体を対象にする。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

const KARINA_UNIT_ID = "UNIT_KARINA_DOWNER";
const EVIE_UNIT_ID = "UNIT_EVIE_ECO";
const LUNA_UNIT_ID = "UNIT_LUNA_HUNGRY";
const KOTOHA_UNIT_ID = "UNIT_KOTOHA_REBEL";
const TEST_UNIT_ID = "UNIT_TEST_INTERVENTION";

const KARINA_REDIRECT_ID = "ACT_KARINA_DOWNER_PS1_REDIRECT";
const EVIE_REDIRECT_ID = "ACT_EVIE_ECO_PS1_REDIRECT";
const EVIE_COVER_ID = "ACT_EVIE_ECO_PS1_COVER";
const LUNA_REFLECT_ID = "ACT_LUNA_HUNGRY_PS1_REFLECT";
const KOTOHA_SURVIVAL_ID = "ACT_KOTOHA_REBEL_PS2_DEATH_SURVIVAL";
const ATTACK_EFFECT_ID = "ACT_TEST_INTERVENTION_ATTACK";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };
// 攻撃力50・防御力0で「素通し50ダメージ」を基準に介入の軽減・反射率を観測する。
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

/** 実production定義を自己対象で順に解決する最小限の合成AS（致死耐え・反射の付与先）。 */
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
    metadata: { displayName: skillId, tags: [] },
  };
}

/**
 * 実production定義を敵単体へ順に付与する最小限の合成AS（引き寄せ・肩代わりの付与先は
 * production PSと同じく攻撃側である）。
 */
function enemyStepsSkill(skillId: string, ...effectActionIds: readonly string[]): SkillDefinition {
  const selector: TargetSelectorDefinition = {
    kind: "SELECT",
    side: "ENEMY",
    count: 1,
    filters: [],
    order: ["DEFAULT"],
    includeDefeated: false,
  };
  return {
    ...selfStepsSkill(skillId),
    skillDefinitionId: createSkillDefinitionId(skillId),
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [{ targetBindingId: createTargetBindingId("TGT_1"), selector }],
      steps: effectActionIds.map((effectActionId) => ({
        kind: "ACTION" as const,
        stepCondition: { kind: "TRUE" as const },
        targetCondition: { kind: "TRUE" as const },
        target: { kind: "BINDING" as const, targetBindingId: createTargetBindingId("TGT_1") },
        actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(effectActionId) }],
      })),
    },
  };
}

/** 前列の敵単体を1ヒットで殴る合成AS。攻撃側（敵陣営）が使う。 */
function frontRowAttackSkill(): SkillDefinition {
  const selector: TargetSelectorDefinition = {
    kind: "SELECT",
    side: "ENEMY",
    count: 1,
    filters: [{ kind: "POSITION_ROW", row: "FRONT" }],
    order: ["DEFAULT"],
    includeDefeated: false,
  };
  return {
    ...selfStepsSkill("SKL_TEST_INTERVENTION_ATTACK"),
    skillDefinitionId: createSkillDefinitionId("SKL_TEST_INTERVENTION_ATTACK"),
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
  };
}

function singleHitAttack(): EffectActionDefinition {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(ATTACK_EFFECT_ID),
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: 1 },
      hitCount: 1,
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "GUARANTEED" },
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

function fixture(unitIds: readonly string[], skills: readonly SkillDefinition[]): Fixture {
  const snapshot = loadProductionSnapshot(CATALOG_DIR, unitIds);
  const attack = singleHitAttack();
  return {
    definitions: definitionsWith(snapshot, {
      units: [testUnitDefinition(TEST_UNIT_ID, { baseStats: COMBAT_STATS })],
      skills,
      overrides: {
        effectActions: new Map([
          ...snapshot.effectActions,
          [attack.effectActionDefinitionId, attack],
        ]),
      },
    }),
    recorder: new EventRecorder(createBattleId("B_1")),
  };
}

function useSkill(
  actor: BattleUnit,
  skill: SkillDefinition,
  units: readonly BattleUnit[],
  definitions: BattleDefinitions,
  recorder: EventRecorder,
  actionSequence: number,
): readonly BattleUnit[] {
  return resolveSkillUse(
    actor,
    skill,
    "AS",
    "AS",
    units,
    definitions,
    new SequenceRandomSource([]),
    recorder,
    1,
    0,
    createActionId(`B_1:action:${actionSequence}`),
    recorder.nextResolutionScopeId(),
  ).units;
}

describe("production Catalog defensive interventions (DMG-006, Issue #188, R-INT-01〜03)", () => {
  it("IT-CAP-TARGET-REDIRECT-PROD-001 (R-INT-01 #1, real lifecycle wiring): the real ACT_KARINA_DOWNER_PS1_REDIRECT grants an AppliedEffect whose redirect destination is the granting unit, matching Domain Event / StateDelta / independent-Reducer expectations", () => {
    const grantSkill = enemyStepsSkill("SKL_TEST_GRANT_REDIRECT", KARINA_REDIRECT_ID);
    const { definitions, recorder } = fixture([KARINA_UNIT_ID], [grantSkill]);
    const karina = readyUnit("ally:karina", KARINA_UNIT_ID, "ALLY", {
      column: "CENTER",
      row: "BACK",
    });
    const attacker = readyUnit("enemy:attacker", TEST_UNIT_ID, "ENEMY", {
      column: "CENTER",
      row: "FRONT",
    });

    const units = useSkill(karina, grantSkill, [karina, attacker], definitions, recorder, 1);

    const holder = units.find((u) => u.battleUnitId === attacker.battleUnitId)!;
    expect(holder.appliedEffects).toHaveLength(1);
    const redirect = holder.appliedEffects[0]!;
    expect(redirect).toMatchObject({
      effectActionDefinitionId: KARINA_REDIRECT_ID,
      duplicate: true,
      magnitude: 0,
    });
    // `redirectTo: SELF`は付与時点で使用者（カリナ）へ解決して焼き込む。
    expect(redirect.targetRedirect).toEqual({
      redirectToUnitId: karina.battleUnitId,
      actionKinds: ["DAMAGE"],
    });
    // R-INT-01/02: 攻撃側が保持する介入状態はデバフに分類する。
    expect([...redirect.categories]).toEqual(["DEBUFF"]);
    expect(redirect.duration.definition).toMatchObject({
      timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" },
      dispellable: true,
    });

    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied") as Extract<
      BattleDomainEvent,
      { eventType: "EffectApplied" }
    >;
    expect(applied.payload).toMatchObject({
      effectKind: "APPLY_TARGET_REDIRECT",
      durationUnit: "ACTION",
      initialRemaining: 1,
      durationOwner: "BATTLE",
    });

    const reduced = applyStateDelta(
      initialSnapshotFor([attacker], { status: "READY" }),
      applied.stateDelta!,
    );
    expect(reduced.units[attacker.battleUnitId]!.effects).toHaveLength(1);
    expect(reduced.units[attacker.battleUnitId]!.effects![0]).toMatchObject({
      effectDefinitionId: KARINA_REDIRECT_ID,
      targetRedirect: { redirectToUnitId: karina.battleUnitId },
    });
  });

  it("IT-CAP-TARGET-REDIRECT-PROD-002 (R-INT-01 #1): an attacker holding the real production redirect hits the taunting unit instead of the ally it selected, and DamageRedirected reports both", () => {
    const grantSkill = enemyStepsSkill("SKL_TEST_GRANT_REDIRECT", KARINA_REDIRECT_ID);
    const attackSkill = frontRowAttackSkill();
    const { definitions, recorder } = fixture([KARINA_UNIT_ID], [grantSkill, attackSkill]);
    const karina = readyUnit("ally:karina", KARINA_UNIT_ID, "ALLY", {
      column: "CENTER",
      row: "BACK",
    });
    const victim = readyUnit("ally:victim", TEST_UNIT_ID, "ALLY", {
      column: "LEFT",
      row: "FRONT",
    });
    const attacker = readyUnit("enemy:attacker", TEST_UNIT_ID, "ENEMY", {
      column: "CENTER",
      row: "FRONT",
    });

    const granted = useSkill(
      karina,
      grantSkill,
      [karina, victim, attacker],
      definitions,
      recorder,
      1,
    );
    const eventsBeforeAttack = recorder.getEvents().length;
    const attacked = useSkill(
      granted.find((u) => u.battleUnitId === attacker.battleUnitId)!,
      attackSkill,
      granted,
      definitions,
      recorder,
      2,
    );

    const redirected = recorder
      .getEvents()
      .slice(eventsBeforeAttack)
      .find((e) => e.eventType === "DamageRedirected")!;
    expect(redirected.payload).toMatchObject({
      reason: "TARGET_REDIRECT",
      originalTargetUnitId: victim.battleUnitId,
      newTargetUnitId: karina.battleUnitId,
      causeEffectActionDefinitionId: KARINA_REDIRECT_ID,
    });
    // 攻撃力50 - 防御力0 = 50が、選ばれた前列の味方ではなくカリナへ入る。
    expect(attacked.find((u) => u.battleUnitId === victim.battleUnitId)!.currentHp).toBe(
      victim.currentHp,
    );
    expect(
      karina.currentHp - attacked.find((u) => u.battleUnitId === karina.battleUnitId)!.currentHp,
    ).toBe(50);
  });

  it("IT-CAP-COVER-DAMAGE-PROD-001 (R-INT-01 #2 / R-INT-02): the real ACT_EVIE_ECO_PS1_REDIRECT + ACT_EVIE_ECO_PS1_COVER pull the attack onto Evie and halve it with the production guardRate", () => {
    const grantSkill = enemyStepsSkill(
      "SKL_TEST_GRANT_EVIE_INTERVENTION",
      EVIE_REDIRECT_ID,
      EVIE_COVER_ID,
    );
    const attackSkill = frontRowAttackSkill();
    const { definitions, recorder } = fixture([EVIE_UNIT_ID], [grantSkill, attackSkill]);
    const evie = readyUnit("ally:evie", EVIE_UNIT_ID, "ALLY", { column: "CENTER", row: "BACK" });
    const victim = readyUnit("ally:victim", TEST_UNIT_ID, "ALLY", {
      column: "LEFT",
      row: "FRONT",
    });
    const attacker = readyUnit("enemy:attacker", TEST_UNIT_ID, "ENEMY", {
      column: "CENTER",
      row: "FRONT",
    });

    const granted = useSkill(evie, grantSkill, [evie, victim, attacker], definitions, recorder, 1);
    const holder = granted.find((u) => u.battleUnitId === attacker.battleUnitId)!;
    expect(holder.appliedEffects.map((effect) => effect.effectActionDefinitionId)).toEqual([
      EVIE_REDIRECT_ID,
      EVIE_COVER_ID,
    ]);
    expect(holder.appliedEffects[1]!.cover).toEqual({
      covererUnitId: evie.battleUnitId,
      damageShareRate: 1,
      guardRate: 0.5,
      actionKinds: ["DAMAGE"],
    });

    const eventsBeforeAttack = recorder.getEvents().length;
    const attacked = useSkill(holder, attackSkill, granted, definitions, recorder, 2);

    // R-INT-01: 引き寄せ→肩代わりの順に評価する。肩代わり者は引き寄せ先と同じ
    // エヴィのため防御側は変わらず、`guardRate: 0.5`の軽減だけが効く。
    const redirects = recorder
      .getEvents()
      .slice(eventsBeforeAttack)
      .filter((e) => e.eventType === "DamageRedirected");
    expect(redirects.map((e) => (e.payload as { readonly reason: string }).reason)).toEqual([
      "TARGET_REDIRECT",
      "COVER",
    ]);
    expect(attacked.find((u) => u.battleUnitId === victim.battleUnitId)!.currentHp).toBe(
      victim.currentHp,
    );
    // 攻撃力50 - 防御力0 = 50を50%ガードして25。
    expect(
      evie.currentHp - attacked.find((u) => u.battleUnitId === evie.battleUnitId)!.currentHp,
    ).toBe(25);
  });

  it("IT-CAP-REFLECT-DAMAGE-PROD-001 (R-INT-01 #4 / R-INT-03): the real ACT_LUNA_HUNGRY_PS1_REFLECT reflects 75% of the damage Luna receives back to the attacker without rolling the original damage back", () => {
    const grantSkill = selfStepsSkill("SKL_TEST_GRANT_REFLECT", LUNA_REFLECT_ID);
    const attackSkill = frontRowAttackSkill();
    const { definitions, recorder } = fixture([LUNA_UNIT_ID], [grantSkill, attackSkill]);
    const luna = readyUnit("ally:luna", LUNA_UNIT_ID, "ALLY", { column: "CENTER", row: "FRONT" });
    const attacker = readyUnit("enemy:attacker", TEST_UNIT_ID, "ENEMY", {
      column: "CENTER",
      row: "FRONT",
    });

    const granted = useSkill(luna, grantSkill, [luna, attacker], definitions, recorder, 1);
    const holder = granted.find((u) => u.battleUnitId === luna.battleUnitId)!;
    expect(holder.appliedEffects[0]!.reflect).toEqual({
      formula: { kind: "DAMAGE_RECEIVED_RATIO", sourceResult: "LAST_DAMAGE_RECEIVED", ratio: 0.75 },
      allowRecursiveReflect: false,
    });

    const eventsBeforeAttack = recorder.getEvents().length;
    const attacked = useSkill(
      granted.find((u) => u.battleUnitId === attacker.battleUnitId)!,
      attackSkill,
      granted,
      definitions,
      recorder,
      2,
    );

    const generated = recorder
      .getEvents()
      .slice(eventsBeforeAttack)
      .find((e) => e.eventType === "ReflectedDamageGenerated")!;
    expect(generated.payload).toMatchObject({
      effectActionDefinitionId: LUNA_REFLECT_ID,
      reflectedByUnitId: luna.battleUnitId,
      reflectToUnitId: attacker.battleUnitId,
      sourceDamage: 50,
      // 50 × 75% = 37.5 → 切り捨てて37。
      reflectedDamage: 37,
      damageType: "PHYSICAL",
    });
    // R-INT-03第1項: 元ダメージは巻き戻さない。
    expect(
      luna.currentHp - attacked.find((u) => u.battleUnitId === luna.battleUnitId)!.currentHp,
    ).toBe(50);
    expect(
      attacker.currentHp -
        attacked.find((u) => u.battleUnitId === attacker.battleUnitId)!.currentHp,
    ).toBe(37);
  });

  it("IT-CAP-DEATH-SURVIVAL-PROD-001 (R-INT-01 #5): the real ACT_KOTOHA_REBEL_PS2_DEATH_SURVIVAL stops a lethal hit at HP1, spends its LETHAL_DAMAGE consumption, and heals the production 65% of max HP", () => {
    const grantSkill = selfStepsSkill("SKL_TEST_GRANT_DEATH_SURVIVAL", KOTOHA_SURVIVAL_ID);
    const attackSkill = frontRowAttackSkill();
    const { definitions, recorder } = fixture([KOTOHA_UNIT_ID], [grantSkill, attackSkill]);
    const kotoha = readyUnit(
      "ally:kotoha",
      KOTOHA_UNIT_ID,
      "ALLY",
      { column: "CENTER", row: "FRONT" },
      { maximumHp: 40 },
    );
    const attacker = readyUnit("enemy:attacker", TEST_UNIT_ID, "ENEMY", {
      column: "CENTER",
      row: "FRONT",
    });

    const granted = useSkill(kotoha, grantSkill, [kotoha, attacker], definitions, recorder, 1);
    const holder = granted.find((u) => u.battleUnitId === kotoha.battleUnitId)!;
    expect(holder.appliedEffects[0]!.deathSurvival).toEqual({
      survivalHp: { kind: "CONSTANT", value: 1 },
      healAfterSurvival: { kind: "MAX_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.65 },
    });
    expect(holder.appliedEffects[0]!.duration.consumptionRemaining).toBe(1);

    const eventsBeforeAttack = recorder.getEvents().length;
    const attacked = useSkill(
      granted.find((u) => u.battleUnitId === attacker.battleUnitId)!,
      attackSkill,
      granted,
      definitions,
      recorder,
      2,
    );
    const attackEvents = recorder.getEvents().slice(eventsBeforeAttack);

    // 攻撃力50 > 最大HP40のため致死。HP1で耐え、`UnitDefeated`は発行されない。
    expect(attackEvents.find((e) => e.eventType === "UnitDefeated")).toBeUndefined();
    const survived = attackEvents.find((e) => e.eventType === "LethalDamageSurvived")!;
    expect(survived.payload).toMatchObject({
      effectActionDefinitionId: KOTOHA_SURVIVAL_ID,
      battleUnitId: kotoha.battleUnitId,
      hpBefore: 40,
      survivalHp: 1,
    });
    // `healAfterSurvival`（最大HP40の65% = 26）をR-HEAL-01の手順で適用する。
    const healed = attackEvents.find((e) => e.eventType === "HealApplied")!;
    expect(healed.payload).toMatchObject({
      effectActionDefinitionId: KOTOHA_SURVIVAL_ID,
      targetUnitId: kotoha.battleUnitId,
      healAmount: 26,
      hpBefore: 1,
      hpAfter: 27,
    });
    const survivor = attacked.find((u) => u.battleUnitId === kotoha.battleUnitId)!;
    expect(survivor.currentHp).toBe(27);
    // R-EFF-07: 耐えたインスタンス自身の`LETHAL_DAMAGE`消費を1消費して失効する。
    expect(survivor.appliedEffects).toEqual([]);
  });
});
