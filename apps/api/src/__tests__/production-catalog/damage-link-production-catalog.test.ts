import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { createBattleUnit, type BattleUnit } from "../../domain/battle/model/battle-unit.js";
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
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { TargetSelectorDefinition } from "../../domain/catalog/definitions/target-selector-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import type { Side } from "../../domain/shared/side.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { applyStateDelta } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import type { BattleStateSnapshot } from "../../domain/battle/lifecycle/battle-state-snapshot.js";

/**
 * DMG-007（Issue #187、R-INT-01 #3／R-LNK-01〜03、`CAP_DAMAGE_LINK_STATE`）:
 * production Catalogのリンクダメージ定義を実カタログから無改変で読み込み、実
 * ライフサイクル（`resolveSkillUse`→`effect-action-group-resolver.ts`の付与→
 * `damage-application-service.ts`のリンク解決）で近似なしに解決できることを検証する。
 *
 * - `ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK`（`linkTo: SELF`、50%、解除不可）
 * - `ACT_CHIZURU_DOMESTIC_PS1_DAMAGE_LINK`（`linkTo: BINDING`、35%）
 *
 * production定義元のスキル（`SKL_SUIRAN_CASINO_AS1`等）は同じ解決の中で他Taskが
 * 担当する効果（シールド・DAMAGE）も解決するため、
 * `defensive-intervention-production-catalog.test.ts`と同じ方針で、実カタログの
 * EffectActionDefinitionそのものだけを持つ最小限の合成ASで包んで検証する。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

const SUIRAN_UNIT_ID = "UNIT_SUIRAN_CASINO";
const CHIZURU_UNIT_ID = "UNIT_CHIZURU_DOMESTIC";
const TEST_UNIT_ID = "UNIT_TEST_DAMAGE_LINK";

const SUIRAN_LINK_ID = "ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK";
const CHIZURU_LINK_ID = "ACT_CHIZURU_DOMESTIC_PS1_DAMAGE_LINK";
const ATTACK_EFFECT_ID = "ACT_TEST_DAMAGE_LINK_ATTACK";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function member(
  battleUnitId: string,
  unitDefinitionId: string,
  side: Side,
  position: FormationPosition,
  overrides: { attack?: number; maximumHp?: number } = {},
): BattlePartyMember {
  return {
    battleUnitId: createBattleUnitId(battleUnitId),
    unitDefinitionId: unitDefinitionId as never,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: overrides.maximumHp ?? 1000,
      attack: overrides.attack ?? 50,
      defense: 0,
      criticalRate: 0,
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

function baseSkill(skillId: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(skillId),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
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
    requiredCapabilities: [],
    metadata: { displayName: skillId, tags: [] },
  };
}

/**
 * 実production定義を味方全体へ付与する最小限の合成AS
 * （`ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK`の`linkTo: SELF`は使用者へ解決される）。
 */
function allyLinkGrantSkill(skillId: string, effectActionId: string): SkillDefinition {
  const selector: TargetSelectorDefinition = {
    kind: "SELECT",
    side: "ALLY",
    count: "ALL",
    filters: [],
    order: ["DEFAULT"],
    includeDefeated: false,
  };
  return {
    ...baseSkill(skillId),
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [{ targetBindingId: createTargetBindingId("TGT_ALLIES"), selector }],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_ALLIES") },
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(effectActionId) }],
        },
      ],
    },
  };
}

/**
 * `ACT_CHIZURU_DOMESTIC_PS1_DAMAGE_LINK`は`linkTo: BINDING(TGT_LOWEST_MAXHP)`を持つ。
 * production `SKL_CHIZURU_DOMESTIC_PS1`と同じbinding IDを宣言した合成ASで包む
 * （`DAMAGE_LINK_UNBOUNDED_BINDING`が要求するとおり、bindingは使う側が宣言する）。
 */
function selfLinkToBindingSkill(skillId: string, effectActionId: string): SkillDefinition {
  const selector: TargetSelectorDefinition = {
    kind: "SELECT",
    side: "ENEMY",
    count: 1,
    filters: [],
    order: ["LOWEST_MAX_HP"],
    includeDefeated: false,
  };
  return {
    ...baseSkill(skillId),
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [{ targetBindingId: createTargetBindingId("TGT_LOWEST_MAXHP"), selector }],
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
    requiredCapabilities: ["CAP_TARGET_FILTER_ORDER"] as never,
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
    ...baseSkill("SKL_TEST_DAMAGE_LINK_ATTACK"),
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
    requiredCapabilities: ["CAP_TARGET_FILTER_ORDER"] as never,
  };
}

function singleHitAttack(): EffectActionDefinition {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(ATTACK_EFFECT_ID),
    requiredCapabilities: [],
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
  const catalog = loadCatalogFromDirectory(CATALOG_DIR);
  const snapshot = catalog.loadSnapshot(unitIds as never[], []);
  const attack = singleHitAttack();
  const effectActions = new Map(snapshot.effectActions);
  effectActions.set(attack.effectActionDefinitionId, attack);
  const skillDefinitions = new Map(snapshot.skills);
  for (const skill of skills) {
    skillDefinitions.set(skill.skillDefinitionId, skill);
  }
  const unitDefinitions = new Map(snapshot.units);
  unitDefinitions.set(createUnitDefinitionId(TEST_UNIT_ID), testUnitDefinition(TEST_UNIT_ID));
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

function emptyStateFor(...units: readonly BattleUnit[]): BattleStateSnapshot {
  return {
    status: "READY",
    currentTurn: 1,
    units: Object.fromEntries(
      units.map((unit) => [
        unit.battleUnitId,
        {
          hp: unit.currentHp,
          ap: unit.currentAp,
          pp: unit.currentPp,
          extraGauge: unit.currentExtraGauge,
          maximumAp: unit.maximumAp,
          maximumPp: unit.maximumPp,
          maximumExtraGauge: unit.maximumExtraGauge,
          combatStats: unit.combatStats,
        },
      ]),
    ),
  };
}

function ready(unit: BattleUnit): BattleUnit {
  return { ...unit, currentAp: LIMITS.maximumAp };
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

describe("production Catalog damage links (DMG-007, Issue #187, R-INT-01 #3 / R-LNK-01〜03)", () => {
  it("IT-CAP-DAMAGE-LINK-STATE-PROD-001 (R-LNK-01/02, real lifecycle wiring): the real ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK links an ally's incoming damage to the granter, matching Domain Event / StateDelta / independent-Reducer expectations", () => {
    const grantSkill = allyLinkGrantSkill("SKL_TEST_GRANT_DAMAGE_LINK", SUIRAN_LINK_ID);
    const attackSkill = frontRowAttackSkill();
    const { definitions, recorder } = fixture([SUIRAN_UNIT_ID], [grantSkill, attackSkill]);
    const suiran = ready(
      createBattleUnit(
        member("ally:suiran", SUIRAN_UNIT_ID, "ALLY", { column: "CENTER", row: "BACK" }),
        "ALLY",
        LIMITS,
      ),
    );
    const ally = ready(
      createBattleUnit(
        member("ally:front", TEST_UNIT_ID, "ALLY", { column: "LEFT", row: "FRONT" }),
        "ALLY",
        LIMITS,
      ),
    );
    const attacker = ready(
      createBattleUnit(
        member("enemy:attacker", TEST_UNIT_ID, "ENEMY", { column: "CENTER", row: "FRONT" }),
        "ENEMY",
        LIMITS,
      ),
    );

    const granted = useSkill(
      suiran,
      grantSkill,
      [suiran, ally, attacker],
      definitions,
      recorder,
      1,
    );

    // 付与時点で`linkTo: SELF`は使用者（劉翠蘭）へ解決して焼き込む。
    const holder = granted.find((u) => u.battleUnitId === ally.battleUnitId)!;
    expect(holder.appliedEffects).toHaveLength(1);
    const link = holder.appliedEffects[0]!;
    expect(link).toMatchObject({
      effectActionDefinitionId: SUIRAN_LINK_ID,
      duplicate: true,
      magnitude: 0.5,
    });
    expect(link.damageLink).toEqual({ linkToUnitId: suiran.battleUnitId, linkRate: 0.5 });
    // R-EFF-02/03: リンクは保持者の被弾を波及させる不利な状態のためデバフに分類する。
    expect([...link.categories]).toEqual(["DEBUFF"]);
    // raw原文「（解除不可）」。
    expect(link.duration.definition).toMatchObject({ dispellable: false });

    // raw原文「自身と自身以外の味方全体にダメージリンクを付与し」のとおり、劉翠蘭自身も
    // リンクを受け取る（自己リンクは恒等でありダメージを発生させない）。ここで検証するのは
    // 転送が実際に起きる味方側のインスタンスである。
    const applied = recorder
      .getEvents()
      .find(
        (e) =>
          e.eventType === "EffectApplied" &&
          (e.payload as { targetUnitId: string }).targetUnitId === ally.battleUnitId,
      ) as Extract<BattleDomainEvent, { eventType: "EffectApplied" }>;
    expect(applied.payload).toMatchObject({ effectKind: "APPLY_DAMAGE_LINK" });
    const reduced = applyStateDelta(emptyStateFor(ally, suiran), applied.stateDelta!);
    expect(reduced.units[ally.battleUnitId]!.effects![0]).toMatchObject({
      effectDefinitionId: SUIRAN_LINK_ID,
      damageLink: { linkToUnitId: suiran.battleUnitId, linkRate: 0.5 },
    });

    // R-LNK-01/02: 前列の味方が受けた50ダメージの50%が、リンク先（劉翠蘭）へ
    // **追加で**発生する（元ダメージは減らない）。
    const eventsBeforeAttack = recorder.getEvents().length;
    const attacked = useSkill(
      granted.find((u) => u.battleUnitId === attacker.battleUnitId)!,
      attackSkill,
      granted,
      definitions,
      recorder,
      2,
    );

    const afterAttack = recorder.getEvents().slice(eventsBeforeAttack);
    const generated = afterAttack.find((e) => e.eventType === "LinkedDamageGenerated")!;
    expect(generated.payload).toMatchObject({
      effectActionDefinitionId: SUIRAN_LINK_ID,
      linkedFromUnitId: ally.battleUnitId,
      linkToUnitId: suiran.battleUnitId,
      sourceDamage: 50,
      linkRate: 0.5,
      linkedDamage: 25,
      damageType: "PHYSICAL",
      shieldApplicable: true,
    });
    // R-LNK-03第1項: リンクで生じた適用だけが`isLinkedDamage`を持つ。
    const linkedApplied = afterAttack.find(
      (e) =>
        e.eventType === "DamageApplied" &&
        (e.payload as { isLinkedDamage?: true }).isLinkedDamage === true,
    )!;
    expect(linkedApplied.payload).toMatchObject({
      targetUnitId: suiran.battleUnitId,
      calculatedDamage: 25,
      hitPointDamage: 25,
    });
    expect(attacked.find((u) => u.battleUnitId === ally.battleUnitId)!.currentHp).toBe(1000 - 50);
    expect(attacked.find((u) => u.battleUnitId === suiran.battleUnitId)!.currentHp).toBe(1000 - 25);
  });

  it("IT-CAP-DAMAGE-LINK-STATE-PROD-002 (R-LNK-01, linkTo BINDING): the real ACT_CHIZURU_DOMESTIC_PS1_DAMAGE_LINK burns the binding-selected enemy as its destination and sends 35% of the holder's own incoming damage there", () => {
    const grantSkill = selfLinkToBindingSkill("SKL_TEST_GRANT_LINK_BINDING", CHIZURU_LINK_ID);
    const attackSkill = frontRowAttackSkill();
    const { definitions, recorder } = fixture([CHIZURU_UNIT_ID], [grantSkill, attackSkill]);
    const chizuru = ready(
      createBattleUnit(
        member("ally:chizuru", CHIZURU_UNIT_ID, "ALLY", { column: "CENTER", row: "FRONT" }),
        "ALLY",
        LIMITS,
      ),
    );
    // 最大HPが最も低い敵がリンク先になる。
    const frail = ready(
      createBattleUnit(
        member(
          "enemy:frail",
          TEST_UNIT_ID,
          "ENEMY",
          { column: "LEFT", row: "BACK" },
          {
            maximumHp: 400,
          },
        ),
        "ENEMY",
        LIMITS,
      ),
    );
    const attacker = ready(
      createBattleUnit(
        member("enemy:attacker", TEST_UNIT_ID, "ENEMY", { column: "CENTER", row: "FRONT" }),
        "ENEMY",
        LIMITS,
      ),
    );

    const granted = useSkill(
      chizuru,
      grantSkill,
      [chizuru, frail, attacker],
      definitions,
      recorder,
      1,
    );

    const holder = granted.find((u) => u.battleUnitId === chizuru.battleUnitId)!;
    expect(holder.appliedEffects[0]!.damageLink).toEqual({
      linkToUnitId: frail.battleUnitId,
      linkRate: 0.35,
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
      .find((e) => e.eventType === "LinkedDamageGenerated")!;
    expect(generated.payload).toMatchObject({
      linkedFromUnitId: chizuru.battleUnitId,
      linkToUnitId: frail.battleUnitId,
      sourceDamage: 50,
      linkRate: 0.35,
      // 50 × 35% = 17.5 → R-DMG-02の切り捨てで17。
      linkedDamage: 17,
    });
    expect(attacked.find((u) => u.battleUnitId === frail.battleUnitId)!.currentHp).toBe(400 - 17);
  });
});
