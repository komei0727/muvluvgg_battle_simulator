import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyEffectActionGroups } from "../../domain/battle/lifecycle/effect-action-group-resolver.js";
import {
  buildEffectStepPerTargetFilter,
  resolveActionStepApplications,
  resolveSkillOrder,
} from "../../domain/battle/skill/skill-resolution-service.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import {
  createUnitDefinitionId,
  type UnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import {
  completedTargetIdsOf,
  definitionsForSkill,
  effectActionGroupContext,
  loadProductionSnapshot,
  seedRecorder,
  skillFrom,
  testBattleUnit,
  testMarker,
  unitFrom,
} from "../../testing/fixtures/index.js";

/**
 * RES-004（Issue #171後半、`CAP_EFFECT_STEP_CONDITION`）: ACTION stepの
 * `condition`が自身の`target`を参照する`TARGET_STATE`/`TARGET_HAS_MARKER`を、
 * 対象ごとに個別評価する（`effect-step-condition-evaluator.ts`の
 * `EffectStepTargetContext`、`skill-resolution-service.ts`の
 * `buildEffectStepPerTargetFilter`）production代表定義4件の検証証跡。各テストは
 * `catalog/`から実際にロードした未改変の`resolution.steps`を対象に、条件を満たす
 * 対象だけが条件付きactionsを受け取ることを検証する。
 *
 * PRレビュー[P1]（Issue #171）: この種のconditionは`isEagerActionStep`
 * （`skill-resolution-service.ts`）により常に`DeferredStepPlan`へ回り、実行が
 * その位置まで進んだ時点で（先行stepの副作用を反映した`box.units`を使って）
 * JIT評価される — `resolveSkillOrder`が返す`EffectSequencePlan`の時点では
 * まだ確定しない。そのため`ACT_AOI_ELEGANT_EX_ATK_DOWN`（他に必須Capabilityを
 * 持たず完全に解決できる）は`applyEffectActionGroups`で実ライフサイクル
 * （Domain Event `EffectActionCompleted.targetUnitIds`）まで検証する。
 * `ACT_LUCIE_MAID_AS1_STUN`（`APPLY_STATUS`）・`ACT_LUCIE_MAID_PS2_PP_DOWN`
 * （`MODIFY_RESOURCE`、`CAP_RESOURCE_MUTATION`/M7-002待ち）・
 * `ACT_ROSIE_ARTIST_PS2_HEALING_UP`系（`APPLY_HEALING_MOD`、`CAP_HEAL`/M7-005待ち）
 * は、基本のturn action resolver（`effect-action-group-resolver.ts`の
 * `resolveOneEffectActionApplication`）自体がまだ実行できないため、
 * `DeferredStepPlan`が持つ実際のstep定義と`resolveSkillOrder`が解決した
 * `resolvedBindings`を使って`buildEffectStepPerTargetFilter`/
 * `resolveActionStepApplications`を直接呼び出し、対象ごとのフィルタ結果
 * だけを検証する（`effect-action-group-resolver.ts`の`resolveRawStep`が
 * 実行時に呼ぶのと同じ関数・同じ`resolvedBindings`）。
 *
 * capability検証は「EffectStepの対象別条件」というこのcapability自身の境界
 * （`docs/ddd/14_Catalog定義スキーマ.md`のCAP_EFFECT_STEP_CONDITION行 —
 * PRレビュー[P2]で「集合条件」をこの境界から明示的に除外した）に留める。
 * `SKL_CHIYURU_MAZE_EX`/`SKL_TATIANA_SAGE_EX`/`SKL_LYDIA_GENIUS_AS1`など残る
 * AOE_PER_TARGET_CONDITION行は別の未設計スコープ（`HAS_STATUS`の状態異常追跡、
 * 集合条件用ConditionKindなど）にも依存するため、この検証範囲には含めない。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

const enemyUnit = (id: string, unitDefinitionId: string, position: FormationPosition): BattleUnit =>
  testBattleUnit({ battleUnitId: id, unitDefinitionId, side: "ENEMY", position });

const allyUnit = (id: string, unitDefinitionId: string, position: FormationPosition): BattleUnit =>
  testBattleUnit({ battleUnitId: id, unitDefinitionId, side: "ALLY", position });

/**
 * `APPLY_STATUS`/`MODIFY_RESOURCE`/`APPLY_HEALING_MOD`は「基本のturn action
 * resolver」（`effect-action-group-resolver.ts`の`resolveOneEffectActionApplication`）
 * がまだ実行できない（それぞれ別Capability、M6/M7/M8 scope）ため、これらを
 * actionsに持つstepを`applyEffectActionGroups`まで進めない。対象別条件を持つ
 * ACTIONは常に`DeferredStepPlan`（`isEagerActionStep`、PRレビュー[P1]）のため、
 * `resolveSkillOrder`が解決した`resolvedBindings`と、そのstepの生の定義を使って
 * `buildEffectStepPerTargetFilter`/`resolveActionStepApplications`を直接呼び出し
 * （`resolveRawStep`が実行時に呼ぶのと同じ関数）、対象ごとのフィルタ結果だけを
 * 検証する。
 */
function applicationsFor(
  plan: ReturnType<typeof resolveSkillOrder>,
  actor: BattleUnit,
  allUnits: readonly BattleUnit[],
  effectActions: BattleDefinitions["effectActions"],
  unitDefinitions: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
  effectActionDefinitionId: string,
): readonly string[] {
  const matching = plan.steps.find((s) => {
    if (s.planKind === "ACTION_PLAN") {
      return s.actions.some((a) => a.effectActionDefinitionId === effectActionDefinitionId);
    }
    return (
      s.definition.kind === "ACTION" &&
      s.definition.actions.some((a) => a.effectActionDefinitionId === effectActionDefinitionId)
    );
  });
  if (matching === undefined) {
    throw new Error(`no ACTION step found for "${effectActionDefinitionId}"`);
  }
  if (matching.planKind === "ACTION_PLAN") {
    return matching.applications
      .filter((a) => a.effectActionDefinitionId === effectActionDefinitionId)
      .map((a) => a.targetBattleUnitId);
  }
  if (matching.definition.kind !== "ACTION") {
    throw new Error(`DEFERRED step for "${effectActionDefinitionId}" is not an ACTION step`);
  }
  const step = matching.definition;
  const perTargetFilter = buildEffectStepPerTargetFilter(
    step,
    plan.resolvedBindings,
    actor,
    allUnits,
    unitDefinitions,
  );
  return resolveActionStepApplications(
    step,
    plan.resolvedBindings,
    actor,
    allUnits,
    effectActions,
    undefined,
    undefined,
    perTargetFilter,
  )
    .filter((a) => a.effectActionDefinitionId === effectActionDefinitionId)
    .map((a) => a.targetBattleUnitId);
}

describe("production Catalog CAP_EFFECT_STEP_CONDITION (RES-004, Issue #171後半)", () => {
  it("IT-CAP-EFFSTEP-001: SKL_AOI_ELEGANT_EX's real TARGET_HAS_MARKER(MARKER_AOI_ELEGANT_UKIASHI) per-target condition only applies the ATK debuff to column members holding the marker", () => {
    const unitId = "UNIT_AOI_ELEGANT";
    const skillId = "SKL_AOI_ELEGANT_EX";
    const snapshot = loadProductionSnapshot(CATALOG_DIR, [unitId]);
    const skill = skillFrom(snapshot, skillId);
    expect(skill.requiredCapabilities).toContain("CAP_EFFECT_STEP_CONDITION");
    const atkDownStep = (skill.resolution.kind === "IMMEDIATE" ? skill.resolution.steps : []).find(
      (s) =>
        s.kind === "ACTION" &&
        s.actions[0]?.effectActionDefinitionId === "ACT_AOI_ELEGANT_EX_ATK_DOWN",
    );
    expect(atkDownStep).toMatchObject({
      targetCondition: { kind: "TARGET_HAS_MARKER", markerId: "MARKER_AOI_ELEGANT_UKIASHI" },
    });

    const actor = allyUnit(unitId, unitId, { column: "LEFT", row: "FRONT" });
    const marked = enemyUnit("enemy-marked", "UNIT_TEST_ENEMY", {
      column: "LEFT",
      row: "FRONT",
    });
    const withMarker = {
      ...marked,
      markerStates: [testMarker(marked, "MARKER_AOI_ELEGANT_UKIASHI")],
    };
    const unmarked = enemyUnit("enemy-unmarked", "UNIT_TEST_ENEMY", {
      column: "LEFT",
      row: "BACK",
    });
    const allUnits = [actor, withMarker, unmarked];

    const definitions = definitionsForSkill(skill, snapshot.effectActions);
    const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);
    const { recorder, rootEventId } = seedRecorder("B_CAP_EFFSTEP");
    const context = effectActionGroupContext({
      actor,
      skillId,
      definitions,
      recorder,
      rootEventId,
    });
    applyEffectActionGroups(plan, allUnits, context);

    expect(completedTargetIdsOf(recorder, "ACT_AOI_ELEGANT_EX_ATK_DOWN")).toEqual([
      withMarker.battleUnitId,
    ]);
    expect([...completedTargetIdsOf(recorder, "ACT_AOI_ELEGANT_EX_DAMAGE")].sort()).toEqual(
      [withMarker.battleUnitId, unmarked.battleUnitId].sort(),
    );
  });

  it("IT-CAP-EFFSTEP-002: SKL_LUCIE_MAID_AS1's real TARGET_STATE(UNIT_TYPE IN {PHYSICAL, AGILE}) per-target condition only stuns column members of a matching unitType", () => {
    const unitId = "UNIT_LUCIE_MAID";
    const skillId = "SKL_LUCIE_MAID_AS1";
    const snapshot = loadProductionSnapshot(CATALOG_DIR, [unitId]);
    const unitDefinition = unitFrom(snapshot, unitId);
    const skill = skillFrom(snapshot, skillId);
    expect(skill.requiredCapabilities).toEqual([
      "CAP_TARGET_DERIVED_AREA",
      "CAP_EFFECT_STEP_CONDITION",
    ]);
    const stunStep = (skill.resolution.kind === "IMMEDIATE" ? skill.resolution.steps : []).find(
      (s) =>
        s.kind === "ACTION" && s.actions[0]?.effectActionDefinitionId === "ACT_LUCIE_MAID_AS1_STUN",
    );
    expect(stunStep).toMatchObject({
      targetCondition: {
        kind: "OR",
        conditions: [
          { kind: "TARGET_STATE", field: "UNIT_TYPE", op: "EQ", value: "PHYSICAL" },
          { kind: "TARGET_STATE", field: "UNIT_TYPE", op: "EQ", value: "AGILE" },
        ],
      },
    });

    const physicalUnitDefinitionId = createUnitDefinitionId("UNIT_TEST_PHYSICAL");
    const energyUnitDefinitionId = createUnitDefinitionId("UNIT_TEST_ENERGY");
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

    const actor = allyUnit(unitId, unitId, { column: "LEFT", row: "FRONT" });
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
      ...definitionsForSkill(skill, snapshot.effectActions),
      unitDefinitions,
    };
    // `ACT_LUCIE_MAID_AS1_STUN`（`APPLY_STATUS`）は基本のturn action resolverが
    // まだ実行できない（M6/M7/M8 scope、別Capability）ため、`applyEffectActionGroups`
    // ではなく`resolveSkillOrder`が返す`EffectSequencePlan`（対象別条件を持つ
    // stepは常にDeferredへ回るため`applicationsFor`が実行時と同じ関数で
    // フィルタ結果を再現する）を直接検証する。
    const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);

    expect(
      applicationsFor(
        plan,
        actor,
        allUnits,
        definitions.effectActions,
        unitDefinitions,
        "ACT_LUCIE_MAID_AS1_STUN",
      ),
    ).toEqual([physical.battleUnitId]);
    expect(
      [
        ...applicationsFor(
          plan,
          actor,
          allUnits,
          definitions.effectActions,
          unitDefinitions,
          "ACT_LUCIE_MAID_AS1_DAMAGE",
        ),
      ].sort(),
    ).toEqual([physical.battleUnitId, energy.battleUnitId].sort());
  });

  it("IT-CAP-EFFSTEP-003: SKL_LUCIE_MAID_PS2's real TARGET_STATE(UNIT_TYPE IN {PHYSICAL, AGILE}) per-target condition only reduces PP for column members of a matching unitType", () => {
    const unitId = "UNIT_LUCIE_MAID";
    const skillId = "SKL_LUCIE_MAID_PS2";
    const snapshot = loadProductionSnapshot(CATALOG_DIR, [unitId]);
    const unitDefinition = unitFrom(snapshot, unitId);
    const skill = skillFrom(snapshot, skillId);
    expect(skill.requiredCapabilities).toContain("CAP_EFFECT_STEP_CONDITION");
    const ppDownStep = (skill.resolution.kind === "IMMEDIATE" ? skill.resolution.steps : []).find(
      (s) =>
        s.kind === "ACTION" &&
        s.actions[0]?.effectActionDefinitionId === "ACT_LUCIE_MAID_PS2_PP_DOWN",
    );
    expect(ppDownStep).toMatchObject({
      targetCondition: {
        kind: "OR",
        conditions: [
          { kind: "TARGET_STATE", field: "UNIT_TYPE", op: "EQ", value: "PHYSICAL" },
          { kind: "TARGET_STATE", field: "UNIT_TYPE", op: "EQ", value: "AGILE" },
        ],
      },
    });

    const agileUnitDefinitionId = createUnitDefinitionId("UNIT_TEST_AGILE");
    const energyUnitDefinitionId = createUnitDefinitionId("UNIT_TEST_ENERGY");
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

    const actor = allyUnit(unitId, unitId, { column: "LEFT", row: "FRONT" });
    const agile = enemyUnit("enemy-agile", agileUnitDefinitionId, { column: "LEFT", row: "FRONT" });
    const energy = enemyUnit("enemy-energy", energyUnitDefinitionId, {
      column: "LEFT",
      row: "BACK",
    });
    const allUnits = [actor, agile, energy];

    const definitions: BattleDefinitions = {
      ...definitionsForSkill(skill, snapshot.effectActions),
      unitDefinitions,
    };
    // `ACT_LUCIE_MAID_PS2_PP_DOWN`（`MODIFY_RESOURCE`）は`CAP_RESOURCE_MUTATION`
    // （M7-002、別Capability、PLANNEDのまま）が未実装で基本のturn action resolver
    // が実行できないため、`resolveSkillOrder`が返す`EffectSequencePlan`
    // （対象別条件を持つstepは常にDeferredへ回るため`applicationsFor`が実行時と
    // 同じ関数でフィルタ結果を再現する）を直接検証する。
    const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);

    expect(
      applicationsFor(
        plan,
        actor,
        allUnits,
        definitions.effectActions,
        unitDefinitions,
        "ACT_LUCIE_MAID_PS2_PP_DOWN",
      ),
    ).toEqual([agile.battleUnitId]);
    expect(
      [
        ...applicationsFor(
          plan,
          actor,
          allUnits,
          definitions.effectActions,
          unitDefinitions,
          "ACT_LUCIE_MAID_PS2_DAMAGE",
        ),
      ].sort(),
    ).toEqual([agile.battleUnitId, energy.battleUnitId].sort());
  });

  it("IT-CAP-EFFSTEP-004: SKL_ROSIE_ARTIST_PS2's real TARGET_STATE(UNIT_TYPE EQ PHYSICAL)/NOT(...) complementary per-target conditions give physical-type allies the doubled healing buff and everyone else the base buff", () => {
    const unitId = "UNIT_ROSIE_ARTIST";
    const skillId = "SKL_ROSIE_ARTIST_PS2";
    const snapshot = loadProductionSnapshot(CATALOG_DIR, [unitId]);
    const unitDefinition = unitFrom(snapshot, unitId);
    const skill = skillFrom(snapshot, skillId);
    expect(skill.requiredCapabilities).toEqual(["CAP_HEAL", "CAP_EFFECT_STEP_CONDITION"]);
    const steps = skill.resolution.kind === "IMMEDIATE" ? skill.resolution.steps : [];
    expect(
      steps.find(
        (s) =>
          s.kind === "ACTION" &&
          s.actions[0]?.effectActionDefinitionId === "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
      ),
    ).toMatchObject({
      targetCondition: { kind: "TARGET_STATE", field: "UNIT_TYPE", op: "EQ", value: "PHYSICAL" },
    });
    expect(
      steps.find(
        (s) =>
          s.kind === "ACTION" &&
          s.actions[0]?.effectActionDefinitionId === "ACT_ROSIE_ARTIST_PS2_HEALING_UP",
      ),
    ).toMatchObject({
      targetCondition: {
        kind: "NOT",
        condition: { kind: "TARGET_STATE", field: "UNIT_TYPE", op: "EQ", value: "PHYSICAL" },
      },
    });

    const physicalUnitDefinitionId = createUnitDefinitionId("UNIT_TEST_PHYSICAL_ALLY");
    const energyUnitDefinitionId = createUnitDefinitionId("UNIT_TEST_ENERGY_ALLY");
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

    const actor = allyUnit(unitId, unitId, { column: "LEFT", row: "FRONT" });
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
      ...definitionsForSkill(skill, snapshot.effectActions),
      unitDefinitions,
    };
    // `ACT_ROSIE_ARTIST_PS2_HEALING_UP`/`_PHYSICAL`（`APPLY_HEALING_MOD`）は
    // `CAP_HEAL`（M7-005、別Capability、PLANNEDのまま）が未実装で基本のturn action
    // resolverが実行できないため、`resolveSkillOrder`が返す`EffectSequencePlan`
    // （対象別条件を持つstepは常にDeferredへ回るため`applicationsFor`が実行時と
    // 同じ関数でフィルタ結果を再現する）を直接検証する。
    const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);

    expect(
      [
        ...applicationsFor(
          plan,
          actor,
          allUnits,
          definitions.effectActions,
          unitDefinitions,
          "ACT_ROSIE_ARTIST_PS2_HEALING_UP_PHYSICAL",
        ),
      ].sort(),
    ).toEqual([actor.battleUnitId, physicalAlly.battleUnitId].sort());
    expect(
      applicationsFor(
        plan,
        actor,
        allUnits,
        definitions.effectActions,
        unitDefinitions,
        "ACT_ROSIE_ARTIST_PS2_HEALING_UP",
      ),
    ).toEqual([energyAlly.battleUnitId]);
  });

  it("IT-CAP-EFFSTEP-005: SKL_TATIANA_SAGE_EX's real TARGET_HAS_MARKER(MARKER_TATIANA_SAGE_OMEN GTE 2)/NOT(...) complementary per-target conditions apply the dealt-damage-nullify debuff to targets with 2+ Omen stacks and grant an Omen stack to the rest", () => {
    const unitId = "UNIT_TATIANA_SAGE";
    const skillId = "SKL_TATIANA_SAGE_EX";
    const snapshot = loadProductionSnapshot(CATALOG_DIR, [unitId]);
    const skill = skillFrom(snapshot, skillId);
    expect(skill.requiredCapabilities).toEqual(
      expect.arrayContaining(["CAP_MARKER", "CAP_DAMAGE_MOD", "CAP_EFFECT_STEP_CONDITION"]),
    );
    const steps = skill.resolution.kind === "IMMEDIATE" ? skill.resolution.steps : [];
    expect(
      steps.find(
        (s) =>
          s.kind === "ACTION" &&
          s.actions[0]?.effectActionDefinitionId === "ACT_TATIANA_SAGE_EX_DEBUFF",
      ),
    ).toMatchObject({
      targetCondition: {
        kind: "TARGET_HAS_MARKER",
        markerId: "MARKER_TATIANA_SAGE_OMEN",
        countCondition: { op: "GTE", value: 2 },
      },
    });
    expect(
      steps.find(
        (s) =>
          s.kind === "ACTION" &&
          s.actions[0]?.effectActionDefinitionId === "ACT_TATIANA_SAGE_EX_MARK",
      ),
    ).toMatchObject({
      targetCondition: {
        kind: "NOT",
        condition: {
          kind: "TARGET_HAS_MARKER",
          markerId: "MARKER_TATIANA_SAGE_OMEN",
          countCondition: { op: "GTE", value: 2 },
        },
      },
    });

    const actor = allyUnit(unitId, unitId, { column: "LEFT", row: "FRONT" });
    const noOmen = enemyUnit("enemy-no-omen", "UNIT_TEST_ENEMY", {
      column: "LEFT",
      row: "FRONT",
    });
    const belowThreshold = enemyUnit("enemy-below-threshold", "UNIT_TEST_ENEMY", {
      column: "LEFT",
      row: "BACK",
    });
    const atThreshold = enemyUnit("enemy-at-threshold", "UNIT_TEST_ENEMY", {
      column: "RIGHT",
      row: "FRONT",
    });
    const aboveThreshold = enemyUnit("enemy-above-threshold", "UNIT_TEST_ENEMY", {
      column: "RIGHT",
      row: "BACK",
    });
    const withBelow = {
      ...belowThreshold,
      markerStates: [testMarker(belowThreshold, "MARKER_TATIANA_SAGE_OMEN", { stackCount: 1 })],
    };
    const withAt = {
      ...atThreshold,
      markerStates: [testMarker(atThreshold, "MARKER_TATIANA_SAGE_OMEN", { stackCount: 2 })],
    };
    const withAbove = {
      ...aboveThreshold,
      markerStates: [testMarker(aboveThreshold, "MARKER_TATIANA_SAGE_OMEN", { stackCount: 3 })],
    };
    const allUnits = [actor, noOmen, withBelow, withAt, withAbove];

    const definitions = definitionsForSkill(skill, snapshot.effectActions);
    // `ACT_TATIANA_SAGE_EX_DEBUFF`（`APPLY_DAMAGE_MOD`）は`CAP_DAMAGE_MOD`
    // （DMG-002/Issue #192、別Capability、PLANNEDのまま）が未実装で基本のturn
    // action resolverが実行できないため、`resolveSkillOrder`が返す
    // `EffectSequencePlan`（対象別条件を持つstepは常にDeferredへ回るため
    // `applicationsFor`が実行時と同じ関数でフィルタ結果を再現する）を直接
    // 検証する。`ACT_TATIANA_SAGE_EX_MARK`（`APPLY_MARKER`）と
    // `ACT_TATIANA_SAGE_EX_DAMAGE`は同じ理由で揃えるため同じ経路で検証する。
    const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);

    expect(
      [
        ...applicationsFor(
          plan,
          actor,
          allUnits,
          definitions.effectActions,
          definitions.unitDefinitions,
          "ACT_TATIANA_SAGE_EX_DEBUFF",
        ),
      ].sort(),
    ).toEqual([withAt.battleUnitId, withAbove.battleUnitId].sort());
    expect(
      [
        ...applicationsFor(
          plan,
          actor,
          allUnits,
          definitions.effectActions,
          definitions.unitDefinitions,
          "ACT_TATIANA_SAGE_EX_MARK",
        ),
      ].sort(),
    ).toEqual([noOmen.battleUnitId, withBelow.battleUnitId].sort());
    expect(
      [
        ...applicationsFor(
          plan,
          actor,
          allUnits,
          definitions.effectActions,
          definitions.unitDefinitions,
          "ACT_TATIANA_SAGE_EX_DAMAGE",
        ),
      ].sort(),
    ).toEqual(
      [
        noOmen.battleUnitId,
        withBelow.battleUnitId,
        withAt.battleUnitId,
        withAbove.battleUnitId,
      ].sort(),
    );
  });
});
