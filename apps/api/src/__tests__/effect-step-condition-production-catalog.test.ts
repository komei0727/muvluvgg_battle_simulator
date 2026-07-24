import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyEffectActionGroups,
  type EffectActionGroupContext,
} from "../domain/battle/lifecycle/effect-action-group-resolver.js";
import { resolveSkillOrder } from "../domain/battle/skill/skill-resolution-service.js";
import { createBattleUnit, type BattleUnit } from "../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../domain/battle/model/battle-party.js";
import type { BattleDefinitions } from "../domain/battle/model/battle-definitions.js";
import { toGlobalCoordinate } from "../domain/battle/model/global-coordinate.js";
import type { MarkerState } from "../domain/battle/model/marker-state.js";
import type { UnitDefinition } from "../domain/catalog/definitions/unit-definition.js";
import type { UnitDefinitionId } from "../domain/catalog/definitions/catalog-ids.js";
import { EventRecorder } from "../domain/battle/events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../domain/shared/ids.js";
import {
  createMarkerId,
  createSkillDefinitionId,
} from "../domain/catalog/definitions/catalog-ids.js";
import { createMarkerInstanceId } from "../domain/shared/event-ids.js";
import type { Side } from "../domain/shared/side.js";
import type { FormationPosition } from "../domain/battle/model/formation-input.js";
import { loadCatalogFromDirectory } from "../infrastructure/catalog/runtime/catalog-file-loader.js";
import { SequenceRandomSource } from "../testing/random/sequence-random-source.js";

/**
 * RES-004（Issue #171後半、`CAP_EFFECT_STEP_CONDITION`）: ACTION stepの
 * `condition`が自身の`target`を参照する`TARGET_STATE`/`TARGET_HAS_MARKER`を、
 * 対象ごとに個別評価する（`effect-step-condition-evaluator.ts`の
 * `EffectStepTargetContext`、`skill-resolution-service.ts`の
 * `buildEffectStepPerTargetFilter`）production代表定義4件の検証証跡。各テストは
 * `catalog/`から実際にロードした未改変の`resolution.steps`を対象に、条件を満たす
 * 対象だけが条件付きactionsを受け取ることを検証する。
 *
 * capability検証は「EffectStepの対象別条件」というこのcapability自身の境界
 * （`docs/ddd/14_Catalog定義スキーマ.md`のCAP_EFFECT_STEP_CONDITION行）に留める。
 * `ACT_AOI_ELEGANT_EX_ATK_DOWN`（`APPLY_STAT_MOD`）は他に必須Capabilityを持たず
 * 完全に解決できるため、`resolveSkillOrder`→`applyEffectActionGroups`で実
 * ライフサイクル（Domain Event `EffectActionCompleted.targetUnitIds`）まで検証
 * する。`ACT_LUCIE_MAID_AS1_STUN`（`APPLY_STATUS`）・`ACT_LUCIE_MAID_PS2_PP_DOWN`
 * （`MODIFY_RESOURCE`、`CAP_RESOURCE_MUTATION`/M7-002待ち）・
 * `ACT_ROSIE_ARTIST_PS2_HEALING_UP`系（`APPLY_HEALING_MOD`、`CAP_HEAL`/M7-005待ち）
 * は、基本のturn action resolver（`effect-action-group-resolver.ts`の
 * `resolveOneEffectActionApplication`）自体がまだ実行できないため、
 * `resolveSkillOrder`が計画した`EffectSequencePlan.applications`（この
 * capability自身が対象ごとにフィルタした結果）を直接検証する — `applications`
 * への反映は`applyEffectActionGroups`による実行より前の計画段階で確定しており、
 * CAP_EFFECT_STEP_CONDITIONの境界はここで閉じる。`SKL_CHIYURU_MAZE_EX`/
 * `SKL_TATIANA_SAGE_EX`/`SKL_LYDIA_GENIUS_AS1`など残るAOE_PER_TARGET_CONDITION行は
 * 別Capability（`HAS_STATUS`の状態異常追跡、集合条件など）にも依存するため、
 * この検証範囲には含めない。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../catalog", import.meta.url));
const NO_MISS_NO_CRIT = new SequenceRandomSource(new Array(64).fill(0.99));

function enemyUnit(
  id: string,
  unitDefinitionId: UnitDefinitionId,
  position: FormationPosition,
  overrides: Partial<BattleUnit> = {},
): BattleUnit {
  const side: Side = "ENEMY";
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 20,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  return {
    ...createBattleUnit(member, side, { maximumAp: 4, maximumPp: 4, maximumExtraGauge: 10 }),
    ...overrides,
  };
}

function allyUnit(
  id: string,
  unitDefinitionId: UnitDefinitionId,
  position: FormationPosition,
  overrides: Partial<BattleUnit> = {},
): BattleUnit {
  const side: Side = "ALLY";
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 20,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  return {
    ...createBattleUnit(member, side, { maximumAp: 4, maximumPp: 4, maximumExtraGauge: 10 }),
    ...overrides,
  };
}

function markerOf(unit: BattleUnit, markerIdValue: string): MarkerState {
  return {
    markerInstanceId: createMarkerInstanceId("MARKER_INSTANCE_1"),
    markerId: createMarkerId(markerIdValue),
    sourceId: unit.battleUnitId,
    targetId: unit.battleUnitId,
    stackCount: 1,
    stackMax: null,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
  };
}

function contextFor(
  actor: BattleUnit,
  skillId: string,
  definitions: BattleDefinitions,
  recorder: EventRecorder,
  rootEventId: string,
): EffectActionGroupContext {
  return {
    definitions,
    actorId: actor.battleUnitId,
    random: NO_MISS_NO_CRIT,
    recorder,
    turnNumber: 1,
    cycleNumber: 0,
    skillUseId: recorder.nextSkillUseId(),
    actionScope: recorder.nextResolutionScopeId(),
    rootEventId: rootEventId as never,
    parentEventId: rootEventId as never,
    skillDefinitionId: createSkillDefinitionId(skillId),
  };
}

function seedRecorder(): { recorder: EventRecorder; rootEventId: string } {
  const recorder = new EventRecorder(createBattleId("B_CAP_EFFSTEP"));
  const seed = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber: 1 },
  });
  return { recorder, rootEventId: seed.eventId };
}

function completedTargetsFor(
  recorder: EventRecorder,
  effectActionDefinitionId: string,
): readonly string[] {
  return recorder
    .getEvents()
    .filter(
      (e) =>
        e.eventType === "EffectActionCompleted" &&
        (e.payload as { effectActionDefinitionId: string }).effectActionDefinitionId ===
          effectActionDefinitionId,
    )
    .flatMap((e) => (e.payload as { targetUnitIds: readonly string[] }).targetUnitIds);
}

/**
 * `APPLY_STATUS`/`MODIFY_RESOURCE`/`APPLY_HEALING_MOD`は「基本のturn action
 * resolver」（`effect-action-group-resolver.ts`の`resolveOneEffectActionApplication`）
 * がまだ実行できない（それぞれ別Capability、M6/M7/M8 scope）ため、これらを
 * actionsに持つstepは`applyEffectActionGroups`まで進めず、`resolveSkillOrder`が
 * 計画した`EffectSequencePlan`の`applications`（対象ごとのCAP_EFFECT_STEP_CONDITION
 * フィルタ結果）だけを直接検証する。
 */
function planTargetsFor(
  plan: ReturnType<typeof resolveSkillOrder>,
  effectActionDefinitionId: string,
): readonly string[] {
  return plan.steps
    .filter((s) => s.planKind === "ACTION_PLAN")
    .flatMap((s) =>
      s.planKind === "ACTION_PLAN"
        ? s.applications.filter((a) => a.effectActionDefinitionId === effectActionDefinitionId)
        : [],
    )
    .map((a) => a.targetBattleUnitId);
}

describe("production Catalog CAP_EFFECT_STEP_CONDITION (RES-004, Issue #171後半)", () => {
  it("IT-CAP-EFFSTEP-001: SKL_AOI_ELEGANT_EX's real TARGET_HAS_MARKER(MARKER_AOI_ELEGANT_UKIASHI) per-target condition only applies the ATK debuff to column members holding the marker", () => {
    const unitId = "UNIT_AOI_ELEGANT";
    const skillId = "SKL_AOI_ELEGANT_EX";
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([unitId as never], []);
    const skill = snapshot.skills.get(skillId as never)!;
    expect(skill.requiredCapabilities).toContain("CAP_EFFECT_STEP_CONDITION");
    const atkDownStep = (skill.resolution.kind === "IMMEDIATE" ? skill.resolution.steps : []).find(
      (s) =>
        s.kind === "ACTION" &&
        s.actions[0]?.effectActionDefinitionId === "ACT_AOI_ELEGANT_EX_ATK_DOWN",
    );
    expect(atkDownStep).toMatchObject({
      condition: { kind: "TARGET_HAS_MARKER", markerId: "MARKER_AOI_ELEGANT_UKIASHI" },
    });

    const actor = allyUnit(unitId, unitId as never, { column: "LEFT", row: "FRONT" });
    const marked = enemyUnit("enemy-marked", "UNIT_TEST_ENEMY" as never, {
      column: "LEFT",
      row: "FRONT",
    });
    const withMarker = {
      ...marked,
      markerStates: [markerOf(marked, "MARKER_AOI_ELEGANT_UKIASHI")],
    };
    const unmarked = enemyUnit("enemy-unmarked", "UNIT_TEST_ENEMY" as never, {
      column: "LEFT",
      row: "BACK",
    });
    const allUnits = [actor, withMarker, unmarked];

    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: snapshot.effectActions,
      unitDefinitions: new Map(),
      skillDefinitions: new Map([[skillId as never, skill]]),
    };
    const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, skillId, definitions, recorder, rootEventId);
    applyEffectActionGroups(plan, allUnits, context);

    expect(completedTargetsFor(recorder, "ACT_AOI_ELEGANT_EX_ATK_DOWN")).toEqual([
      withMarker.battleUnitId,
    ]);
    expect([...completedTargetsFor(recorder, "ACT_AOI_ELEGANT_EX_DAMAGE")].sort()).toEqual(
      [withMarker.battleUnitId, unmarked.battleUnitId].sort(),
    );
  });

  it("IT-CAP-EFFSTEP-002: SKL_LUCIE_MAID_AS1's real TARGET_STATE(UNIT_TYPE IN {PHYSICAL, AGILE}) per-target condition only stuns column members of a matching unitType", () => {
    const unitId = "UNIT_LUCIE_MAID";
    const skillId = "SKL_LUCIE_MAID_AS1";
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([unitId as never], []);
    const unitDefinition = snapshot.units.get(unitId as never)!;
    const skill = snapshot.skills.get(skillId as never)!;
    expect(skill.requiredCapabilities).toEqual([
      "CAP_TARGET_DERIVED_AREA",
      "CAP_EFFECT_STEP_CONDITION",
    ]);
    const stunStep = (skill.resolution.kind === "IMMEDIATE" ? skill.resolution.steps : []).find(
      (s) =>
        s.kind === "ACTION" && s.actions[0]?.effectActionDefinitionId === "ACT_LUCIE_MAID_AS1_STUN",
    );
    expect(stunStep).toMatchObject({
      condition: {
        kind: "OR",
        conditions: [
          { kind: "TARGET_STATE", field: "UNIT_TYPE", op: "EQ", value: "PHYSICAL" },
          { kind: "TARGET_STATE", field: "UNIT_TYPE", op: "EQ", value: "AGILE" },
        ],
      },
    });

    const physicalUnitDefinitionId = "UNIT_TEST_PHYSICAL" as never;
    const energyUnitDefinitionId = "UNIT_TEST_ENERGY" as never;
    const unitDefinitions = new Map<UnitDefinitionId, UnitDefinition>([
      [
        physicalUnitDefinitionId,
        { ...unitDefinition, unitDefinitionId: physicalUnitDefinitionId, unitType: "PHYSICAL" },
      ],
      [
        energyUnitDefinitionId,
        { ...unitDefinition, unitDefinitionId: energyUnitDefinitionId, unitType: "ENERGY" },
      ],
    ]);

    const actor = allyUnit(unitId, unitId as never, { column: "LEFT", row: "FRONT" });
    const physical = enemyUnit("enemy-physical", physicalUnitDefinitionId, {
      column: "LEFT",
      row: "FRONT",
    });
    const energy = enemyUnit("enemy-energy", energyUnitDefinitionId, {
      column: "LEFT",
      row: "BACK",
    });
    const allUnits = [actor, physical, energy];

    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: snapshot.effectActions,
      unitDefinitions,
      skillDefinitions: new Map([[skillId as never, skill]]),
    };
    // `ACT_LUCIE_MAID_AS1_STUN`（`APPLY_STATUS`）は基本のturn action resolverが
    // まだ実行できない（M6/M7/M8 scope、別Capability）ため、`applyEffectActionGroups`
    // ではなく`resolveSkillOrder`が計画した`EffectSequencePlan.applications`
    // （CAP_EFFECT_STEP_CONDITIONの対象別フィルタ結果）を直接検証する。
    const plan = resolveSkillOrder(
      skill,
      actor,
      allUnits,
      definitions.effectActions,
      undefined,
      unitDefinitions,
    );

    expect(planTargetsFor(plan, "ACT_LUCIE_MAID_AS1_STUN")).toEqual([physical.battleUnitId]);
    expect([...planTargetsFor(plan, "ACT_LUCIE_MAID_AS1_DAMAGE")].sort()).toEqual(
      [physical.battleUnitId, energy.battleUnitId].sort(),
    );
  });

  it("IT-CAP-EFFSTEP-003: SKL_LUCIE_MAID_PS2's real TARGET_STATE(UNIT_TYPE IN {PHYSICAL, AGILE}) per-target condition only reduces PP for column members of a matching unitType", () => {
    const unitId = "UNIT_LUCIE_MAID";
    const skillId = "SKL_LUCIE_MAID_PS2";
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([unitId as never], []);
    const unitDefinition = snapshot.units.get(unitId as never)!;
    const skill = snapshot.skills.get(skillId as never)!;
    expect(skill.requiredCapabilities).toContain("CAP_EFFECT_STEP_CONDITION");
    const ppDownStep = (skill.resolution.kind === "IMMEDIATE" ? skill.resolution.steps : []).find(
      (s) =>
        s.kind === "ACTION" &&
        s.actions[0]?.effectActionDefinitionId === "ACT_LUCIE_MAID_PS2_PP_DOWN",
    );
    expect(ppDownStep).toMatchObject({
      condition: {
        kind: "OR",
        conditions: [
          { kind: "TARGET_STATE", field: "UNIT_TYPE", op: "EQ", value: "PHYSICAL" },
          { kind: "TARGET_STATE", field: "UNIT_TYPE", op: "EQ", value: "AGILE" },
        ],
      },
    });

    const agileUnitDefinitionId = "UNIT_TEST_AGILE" as never;
    const energyUnitDefinitionId = "UNIT_TEST_ENERGY" as never;
    const unitDefinitions = new Map<UnitDefinitionId, UnitDefinition>([
      [
        agileUnitDefinitionId,
        { ...unitDefinition, unitDefinitionId: agileUnitDefinitionId, unitType: "AGILE" },
      ],
      [
        energyUnitDefinitionId,
        { ...unitDefinition, unitDefinitionId: energyUnitDefinitionId, unitType: "ENERGY" },
      ],
    ]);

    const actor = allyUnit(unitId, unitId as never, { column: "LEFT", row: "FRONT" });
    const agile = enemyUnit("enemy-agile", agileUnitDefinitionId, { column: "LEFT", row: "FRONT" });
    const energy = enemyUnit("enemy-energy", energyUnitDefinitionId, {
      column: "LEFT",
      row: "BACK",
    });
    const allUnits = [actor, agile, energy];

    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: snapshot.effectActions,
      unitDefinitions,
      skillDefinitions: new Map([[skillId as never, skill]]),
    };
    // `ACT_LUCIE_MAID_PS2_PP_DOWN`（`MODIFY_RESOURCE`）は`CAP_RESOURCE_MUTATION`
    // （M7-002、別Capability、PLANNEDのまま）が未実装で基本のturn action resolver
    // が実行できないため、`resolveSkillOrder`が計画した`EffectSequencePlan.applications`
    // （CAP_EFFECT_STEP_CONDITIONの対象別フィルタ結果）を直接検証する。
    const plan = resolveSkillOrder(
      skill,
      actor,
      allUnits,
      definitions.effectActions,
      undefined,
      unitDefinitions,
    );

    expect(planTargetsFor(plan, "ACT_LUCIE_MAID_PS2_PP_DOWN")).toEqual([agile.battleUnitId]);
    expect([...planTargetsFor(plan, "ACT_LUCIE_MAID_PS2_DAMAGE")].sort()).toEqual(
      [agile.battleUnitId, energy.battleUnitId].sort(),
    );
  });

  it("IT-CAP-EFFSTEP-004: SKL_ROSIE_ARTIST_PS2's real TARGET_STATE(UNIT_TYPE EQ PHYSICAL)/NOT(...) complementary per-target conditions give physical-type allies the doubled healing buff and everyone else the base buff", () => {
    const unitId = "UNIT_ROSIE_ARTIST";
    const skillId = "SKL_ROSIE_ARTIST_PS2";
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([unitId as never], []);
    const unitDefinition = snapshot.units.get(unitId as never)!;
    const skill = snapshot.skills.get(skillId as never)!;
    expect(skill.requiredCapabilities).toEqual(["CAP_HEAL", "CAP_EFFECT_STEP_CONDITION"]);
    const steps = skill.resolution.kind === "IMMEDIATE" ? skill.resolution.steps : [];
    expect(
      steps.find(
        (s) =>
          s.kind === "ACTION" &&
          s.actions[0]?.effectActionDefinitionId === "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
      ),
    ).toMatchObject({
      condition: { kind: "TARGET_STATE", field: "UNIT_TYPE", op: "EQ", value: "PHYSICAL" },
    });
    expect(
      steps.find(
        (s) =>
          s.kind === "ACTION" &&
          s.actions[0]?.effectActionDefinitionId === "ACT_ROSIE_ARTIST_PS2_HEALING_UP",
      ),
    ).toMatchObject({
      condition: {
        kind: "NOT",
        condition: { kind: "TARGET_STATE", field: "UNIT_TYPE", op: "EQ", value: "PHYSICAL" },
      },
    });

    const physicalUnitDefinitionId = "UNIT_TEST_PHYSICAL_ALLY" as never;
    const energyUnitDefinitionId = "UNIT_TEST_ENERGY_ALLY" as never;
    expect(unitDefinition.unitType).toBe("PHYSICAL");
    const unitDefinitions = new Map<UnitDefinitionId, UnitDefinition>([
      // UNIT_ROSIE_ARTIST自身もTGT_ALL_ALLIES（side: ALLY, count: ALL）に含まれる
      // （`matchesRelativeSide`はactor自身を除外しない）ため、実unitDefinition
      // （unitType: PHYSICAL）をそのまま含める。
      [unitDefinition.unitDefinitionId, unitDefinition],
      [
        physicalUnitDefinitionId,
        { ...unitDefinition, unitDefinitionId: physicalUnitDefinitionId, unitType: "PHYSICAL" },
      ],
      [
        energyUnitDefinitionId,
        { ...unitDefinition, unitDefinitionId: energyUnitDefinitionId, unitType: "ENERGY" },
      ],
    ]);

    const actor = allyUnit(unitId, unitId as never, { column: "LEFT", row: "FRONT" });
    const physicalAlly = allyUnit("ally-physical", physicalUnitDefinitionId, {
      column: "CENTER",
      row: "FRONT",
    });
    const energyAlly = allyUnit("ally-energy", energyUnitDefinitionId, {
      column: "RIGHT",
      row: "FRONT",
    });
    const allUnits = [actor, physicalAlly, energyAlly];

    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: snapshot.effectActions,
      unitDefinitions,
      skillDefinitions: new Map([[skillId as never, skill]]),
    };
    // `ACT_ROSIE_ARTIST_PS2_HEALING_UP`/`_PHYSICAL`（`APPLY_HEALING_MOD`）は
    // `CAP_HEAL`（M7-005、別Capability、PLANNEDのまま）が未実装で基本のturn action
    // resolverが実行できないため、`resolveSkillOrder`が計画した
    // `EffectSequencePlan.applications`（CAP_EFFECT_STEP_CONDITIONの対象別
    // フィルタ結果）を直接検証する。
    const plan = resolveSkillOrder(
      skill,
      actor,
      allUnits,
      definitions.effectActions,
      undefined,
      unitDefinitions,
    );

    expect([...planTargetsFor(plan, "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL")].sort()).toEqual(
      [actor.battleUnitId, physicalAlly.battleUnitId].sort(),
    );
    expect(planTargetsFor(plan, "ACT_ROSIE_ARTIST_PS2_HEALING_UP")).toEqual([
      energyAlly.battleUnitId,
    ]);
  });
});
