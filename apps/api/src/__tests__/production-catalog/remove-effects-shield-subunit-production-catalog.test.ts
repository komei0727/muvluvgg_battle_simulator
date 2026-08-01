import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { applyEffectActionGroups } from "../../domain/battle/lifecycle/effect-action-group-resolver.js";
import { resolveSkillOrder } from "../../domain/battle/skill/skill-resolution-service.js";
import { shieldPoolsOf } from "../../domain/battle/combat/shield-policy.js";
import { subUnitDurabilityTotal } from "../../domain/battle/combat/sub-unit-policy.js";
import { createBattleUnit, type BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";
import { createEffectInstanceId } from "../../domain/shared/event-ids.js";
import { createUnitDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import type { Side } from "../../domain/shared/side.js";
import {
  effectKindKeyFromDefinitionId,
  SUBUNIT_PROVIDER_ATTACK_KEY,
  type AppliedEffect,
} from "../../domain/battle/model/applied-effect.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * M7-001A (Issue #242, `REMOVE_EFFECTS_CATEGORY_GAP`, R-EFF-02): drives the REAL,
 * unmodified production `SHIELD`/`SUBUNIT` removal definitions through the REAL
 * resolvers, proving the two ledger rows converted here are no longer
 * approximations.
 *
 * - `SKL_YUI_HEIR_EX`「敵単体のシールドを全て解除し、……威力243.8で攻撃する」:
 *   removal must happen BEFORE the damage of the same skill, so the attack lands
 *   on HP instead of being absorbed. Asserting only "the shield instances are
 *   gone" would still pass if the actions were ordered the other way around.
 * - `SKL_OLGA_VETERAN_PS1`「自身に付与されているシールドとサブユニットをすべて解除し、
 *   ……サブユニット『カムラッドⅡ』を3つ付与する」: removal must happen BEFORE the
 *   three grants of the same step, so exactly the 3 new sub-units survive.
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 10 };

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
      maximumHp: 1000,
      attack: 100,
      defense: 50,
      criticalRate: 0,
      actionSpeed: 100,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
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
      attack: 100,
      defense: 50,
      criticalRate: 0,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
      actionSpeed: 100,
      maximumAp: LIMITS.maximumAp,
      maximumPp: LIMITS.maximumPp,
    },
    extraGaugeMaximum: LIMITS.maximumExtraGauge,
    activeSkillDefinitionIds: [],
    passiveSkillDefinitionIds: [],
    extraSkillDefinitionId: undefined as never,
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

/**
 * `AppliedEffect` fixtures for the PRE-EXISTING shields/sub-units the production
 * skill has to strip, plus the synthetic `APPLY_SHIELD` definitions they point
 * at. The instances are built directly (rather than granted through a
 * production `APPLY_SHIELD`/`APPLY_SUBUNIT` definition) because what is under
 * test is the removal, not the grant — `IT-CAP-SHIELD-PROD-*`/
 * `IT-CAP-SUBUNIT-PROD-*` already cover the grant side against production data.
 * The definitions must still be reachable from `BattleDefinitions.effectActions`
 * because R-EFF-02 #2 classifies each candidate from its definition kind
 * (`effect-category-classifier.ts`).
 */
function shieldDefinitionOf(
  definitionId: string,
  shieldType: "PHYSICAL" | "EN" | null,
): EffectActionDefinition {
  return {
    kind: "APPLY_SHIELD",
    effectActionDefinitionId: definitionId as EffectActionDefinition["effectActionDefinitionId"],
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      formula: { kind: "CONSTANT", value: 0 },
      ...(shieldType !== null ? { shieldType } : {}),
      duration: { dispellable: true, linkedEffectGroupId: null },
    },
  };
}

function shieldEffect(
  holder: BattleUnit,
  instanceId: string,
  definitionId: string,
  remaining: number,
  shieldType: "PHYSICAL" | "EN" | null,
): AppliedEffect {
  const id = definitionId as EffectActionDefinition["effectActionDefinitionId"];
  return {
    effectInstanceId: createEffectInstanceId(instanceId),
    effectActionDefinitionId: id,
    kindKey: effectKindKeyFromDefinitionId(id),
    categories: ["SHIELD"],
    duplicate: true,
    sourceId: holder.battleUnitId,
    targetId: holder.battleUnitId,
    magnitude: remaining,
    shield: { shieldType, remaining },
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 0,
  };
}

function subUnitEffect(
  holder: BattleUnit,
  instanceId: string,
  definitionId: string,
  durability: number,
): AppliedEffect {
  const id = definitionId as EffectActionDefinition["effectActionDefinitionId"];
  return {
    effectInstanceId: createEffectInstanceId(instanceId),
    effectActionDefinitionId: id,
    kindKey: effectKindKeyFromDefinitionId(id),
    categories: ["SUBUNIT"],
    duplicate: true,
    sourceId: holder.battleUnitId,
    targetId: holder.battleUnitId,
    magnitude: durability,
    subUnit: {
      durability,
      additionalDamage: {
        formula: {
          kind: "SUBUNIT_ADDITIONAL_DAMAGE",
          ownerAttack: "CURRENT_ATTACK",
          providerAttack: "SOURCE_SNAPSHOT_ATTACK",
          skillMultiplier: 0.106,
          targetDefense: "TARGET_CURRENT_DEFENSE",
        },
        damageType: "EN",
      },
    },
    snapshot: { [SUBUNIT_PROVIDER_ATTACK_KEY]: 100 },
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 0,
  };
}

function seedRecorder() {
  const recorder = new EventRecorder(createBattleId("B_1"));
  const resolutionScopeId = recorder.nextResolutionScopeId();
  const seed = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId,
    payload: { turnNumber: 1 },
  });
  return { recorder, resolutionScopeId, rootEventId: seed.eventId };
}

describe("production Catalog SHIELD/SUBUNIT removal (M7-001A, Issue #242)", () => {
  const YUI_ENEMY_UNIT_ID = "UNIT_TEST_YUI_ENEMY";

  it("IT-REMOVE-EFFECTS-PROD-008: SKL_YUI_HEIR_EX strips every shield pool of the enemy target before its own damage lands, so the hit goes to HP with no shield absorption", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot(["UNIT_YUI_HEIR" as never], []);

    // raw原文「敵単体のシールドを全て解除し、……」: 件数上限なしのSHIELDカテゴリ解除。
    const removal = snapshot.effectActions.get("ACT_YUI_HEIR_EX_REMOVE_SHIELD" as never);
    expect(removal?.kind).toBe("REMOVE_EFFECTS");
    if (removal?.kind !== "REMOVE_EFFECTS") {
      return;
    }
    expect([...removal.payload.categories]).toEqual(["SHIELD"]);
    expect(removal.payload.maxRemovals).toBeUndefined();
    expect([...removal.requiredCapabilities].sort()).toEqual(["CAP_REMOVE_EFFECTS", "CAP_SHIELD"]);

    // 「解除し、さらに……防御力を低下させて、威力243.8で攻撃する」の順序。
    const skill = snapshot.skills.get("SKL_YUI_HEIR_EX" as never)!;
    const actions =
      skill.resolution.kind === "IMMEDIATE"
        ? skill.resolution.steps.flatMap((step) =>
            step.kind === "ACTION" ? step.actions.map((a) => a.effectActionDefinitionId) : [],
          )
        : [];
    expect(actions).toEqual([
      "ACT_YUI_HEIR_EX_REMOVE_SHIELD",
      "ACT_YUI_HEIR_EX_DEF_DOWN",
      "ACT_YUI_HEIR_EX_DAMAGE",
    ]);

    const yui = {
      ...createBattleUnit(
        member("ally:yui", "UNIT_YUI_HEIR", "ALLY", { column: "CENTER", row: "FRONT" }),
        "ALLY",
        LIMITS,
      ),
      currentAp: LIMITS.maximumAp,
      currentExtraGauge: LIMITS.maximumExtraGauge,
    };
    const enemyBase = createBattleUnit(
      member("enemy:1", YUI_ENEMY_UNIT_ID, "ENEMY", { column: "CENTER", row: "FRONT" }),
      "ENEMY",
      LIMITS,
    );
    // 物理攻撃（`ACT_YUI_HEIR_EX_DAMAGE`は`damageType: PHYSICAL`）に対して、
    // 解除されなければR-SHD-02の吸収順で必ず食われる2プールを積む。
    const enemy: BattleUnit = {
      ...enemyBase,
      appliedEffects: [
        shieldEffect(enemyBase, "pre-physical", "ACT_TEST_PHYSICAL_SHIELD", 500, "PHYSICAL"),
        shieldEffect(enemyBase, "pre-untyped", "ACT_TEST_UNTYPED_SHIELD", 500, null),
      ],
    };

    const unitDefinitions = new Map(snapshot.units);
    unitDefinitions.set(
      createUnitDefinitionId(YUI_ENEMY_UNIT_ID),
      testUnitDefinition(YUI_ENEMY_UNIT_ID),
    );
    const effectActions = new Map(snapshot.effectActions);
    effectActions.set(
      "ACT_TEST_PHYSICAL_SHIELD" as never,
      shieldDefinitionOf("ACT_TEST_PHYSICAL_SHIELD", "PHYSICAL"),
    );
    effectActions.set(
      "ACT_TEST_UNTYPED_SHIELD" as never,
      shieldDefinitionOf("ACT_TEST_UNTYPED_SHIELD", null),
    );
    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions,
      unitDefinitions,
      skillDefinitions: snapshot.skills,
    };

    const { recorder, resolutionScopeId } = seedRecorder();
    const result = resolveSkillUse(
      yui,
      skill,
      "EX",
      "EX",
      [yui, enemy],
      definitions,
      new SequenceRandomSource([0.99, 0.99, 0.99, 0.99, 0.99]),
      recorder,
      1,
      1,
      recorder.nextActionId(),
      resolutionScopeId,
    );

    const finalEnemy = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(finalEnemy.appliedEffects.filter((e) => e.shield !== undefined)).toHaveLength(0);
    expect(shieldPoolsOf(finalEnemy.appliedEffects)).toEqual({
      physical: 0,
      energy: 0,
      untyped: 0,
    });

    const damages = recorder
      .getEvents()
      .filter((e) => e.eventType === "DamageApplied")
      .map((e) => e.payload);
    expect(damages.length).toBeGreaterThan(0);
    for (const damage of damages) {
      expect(damage.typedShieldAbsorbed).toBe(0);
      expect(damage.untypedShieldAbsorbed).toBe(0);
      expect(damage.hitPointDamage).toBeGreaterThan(0);
    }
  });

  it("IT-REMOVE-EFFECTS-PROD-009: SKL_OLGA_VETERAN_PS1 strips Olga's own shields and sub-units before granting the three カムラッドⅡ of the same step", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot(["UNIT_OLGA_VETERAN" as never], []);

    const removal = snapshot.effectActions.get(
      "ACT_OLGA_VETERAN_PS1_REMOVE_SHIELD_SUBUNIT" as never,
    );
    expect(removal?.kind).toBe("REMOVE_EFFECTS");
    if (removal?.kind !== "REMOVE_EFFECTS") {
      return;
    }
    expect([...removal.payload.categories].sort()).toEqual(["SHIELD", "SUBUNIT"]);
    expect(removal.payload.maxRemovals).toBeUndefined();
    expect([...removal.requiredCapabilities].sort()).toEqual([
      "CAP_REMOVE_EFFECTS",
      "CAP_SHIELD",
      "CAP_SUBUNIT",
    ]);

    const skill = snapshot.skills.get("SKL_OLGA_VETERAN_PS1" as never)!;
    const actions =
      skill.resolution.kind === "IMMEDIATE"
        ? skill.resolution.steps.flatMap((step) =>
            step.kind === "ACTION" ? step.actions.map((a) => a.effectActionDefinitionId) : [],
          )
        : [];
    expect(actions).toEqual([
      "ACT_OLGA_VETERAN_PS1_REMOVE_SHIELD_SUBUNIT",
      "ACT_OLGA_VETERAN_PS1_ATK_UP",
      "ACT_OLGA_VETERAN_PS1_SUBUNIT",
      "ACT_OLGA_VETERAN_PS1_SUBUNIT",
      "ACT_OLGA_VETERAN_PS1_SUBUNIT",
    ]);

    const olgaBase = createBattleUnit(
      member("ally:olga", "UNIT_OLGA_VETERAN", "ALLY", { column: "CENTER", row: "FRONT" }),
      "ALLY",
      LIMITS,
    );
    // 直前のPS2（カムラッドⅠ）とシールドが残っている状態から発動する。
    const olga: BattleUnit = {
      ...olgaBase,
      currentAp: LIMITS.maximumAp,
      appliedEffects: [
        shieldEffect(olgaBase, "old-shield", "ACT_TEST_OLGA_SHIELD", 300, "EN"),
        subUnitEffect(olgaBase, "old-sub-1", "ACT_OLGA_VETERAN_PS2_SUBUNIT", 150),
        subUnitEffect(olgaBase, "old-sub-2", "ACT_OLGA_VETERAN_PS2_SUBUNIT", 150),
      ],
    };

    const unitDefinitions = new Map(snapshot.units);
    const effectActions = new Map(snapshot.effectActions);
    effectActions.set(
      "ACT_TEST_OLGA_SHIELD" as never,
      shieldDefinitionOf("ACT_TEST_OLGA_SHIELD", "EN"),
    );
    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions,
      unitDefinitions,
      skillDefinitions: snapshot.skills,
    };

    const { recorder, resolutionScopeId, rootEventId } = seedRecorder();
    const plan = resolveSkillOrder(skill, olga, [olga], effectActions);
    const result = applyEffectActionGroups(plan, [olga], {
      recorder,
      definitions,
      random: new SequenceRandomSource([0.99, 0.99, 0.99, 0.99, 0.99]),
      turnNumber: 1,
      cycleNumber: 1,
      actionId: recorder.nextActionId(),
      actionScope: resolutionScopeId,
      rootEventId,
      parentEventId: rootEventId,
      actorId: olga.battleUnitId,
      skillUseId: recorder.nextSkillUseId(),
      sourceSide: "ALLY",
    });

    const finalOlga = result.units.find((u) => u.battleUnitId === olga.battleUnitId)!;
    // 旧シールド・旧サブユニットは1件も残らない。
    expect(shieldPoolsOf(finalOlga.appliedEffects)).toEqual({
      physical: 0,
      energy: 0,
      untyped: 0,
    });
    expect(
      finalOlga.appliedEffects.filter(
        (e) => e.effectActionDefinitionId === "ACT_OLGA_VETERAN_PS2_SUBUNIT",
      ),
    ).toHaveLength(0);
    // 同じstepで付与される新しいカムラッドⅡ3体は解除の巻き添えにならない。
    const granted = finalOlga.appliedEffects.filter(
      (e) => e.effectActionDefinitionId === "ACT_OLGA_VETERAN_PS1_SUBUNIT",
    );
    expect(granted).toHaveLength(3);
    expect(subUnitDurabilityTotal(finalOlga.appliedEffects)).toBe(
      granted.reduce((sum, e) => sum + e.subUnit!.durability, 0),
    );
    expect(
      finalOlga.appliedEffects.some(
        (e) => e.effectActionDefinitionId === "ACT_OLGA_VETERAN_PS1_ATK_UP",
      ),
    ).toBe(true);
  });
});
