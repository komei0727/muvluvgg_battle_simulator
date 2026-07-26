import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { selectAsCandidate } from "../../domain/battle/action/action-selection-policy.js";
import { createBattleUnit, type BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import type { MarkerState } from "../../domain/battle/model/marker-state.js";
import { createMarkerId } from "../../domain/catalog/definitions/catalog-ids.js";
import { createMarkerInstanceId } from "../../domain/shared/event-ids.js";
import { createBattleUnitId } from "../../domain/shared/ids.js";
import type { Side } from "../../domain/shared/side.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * CAP_ACTION_ACTIVATION_CONDITION（Issue #180、M7-003）: AS/EXの`activationCondition`
 * を行動選択（`selectAsCandidate`/`isUsable`、`action-selection-policy.ts`）が
 * 実際に評価する production代表定義5件の検証証跡。各テストは`catalog/`から実際に
 * ロードした未改変の`activationCondition`/`resolution.targetBindings`を対象に、
 * 条件が不成立の場合はそのASを候補から除外して次候補または`WAIT`へ進み（R-ACT-02）、
 * 条件成立時は選択されることを確認する。
 *
 * SKL_ELENA_MOODMAKER_AS1/SKL_LYDIA_GENIUS_AS1は`ConditionDefinition.kind:
 * TARGET_SET_COUNT`（CAP_EFFECT_STEP_SET_CONDITION、Issue #227）をactivationCondition
 * から評価する新しい経路の代表例（`docs/ddd/15_Unit_Memory変換台帳.md`のSET_
 * THRESHOLD_ACTIVATION_CONDITIONテーマ）。SKL_LYDIA_GENIUS_AS1はTARGET_SET_COUNTの
 * `target`が実際の攻撃対象bindingと同一のため、この不成立ケースはR-TGT-01 #4
 * （空bindingは常にAS発動不能）とも重なるが、requiredCapabilities宣言と
 * activationCondition評価パイプライン自体がスローせず正しく機能することの証跡と
 * して残す。SKL_LILY_HERO_AS1/SKL_MAO_COMMITTEE_AS1/SKL_TATIANA_SAGE_AS2は
 * 既存の`TARGET_STATE`/`TARGET_HAS_MARKER`（SELF参照）を評価するランタイム配線
 * だけが不足していた3件。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const LIMITS = { maximumAp: 4, maximumPp: 4, maximumExtraGauge: 100 };

function unitOf(
  id: string,
  unitDefinitionId: string,
  side: Side,
  position: FormationPosition,
  overrides: Partial<BattleUnit> = {},
): BattleUnit {
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: unitDefinitionId as never,
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
  return { ...createBattleUnit(member, side, LIMITS), ...overrides };
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

describe("production Catalog CAP_ACTION_ACTIVATION_CONDITION (Issue #180, M7-003)", () => {
  it("IT-CAP-ACTION-ACTIVATION-CONDITION-001: SKL_ELENA_MOODMAKER_AS1's real TARGET_SET_COUNT/TARGET_STATE AND activationCondition selects the skill only when a below-70%-HP ally, another living ally, and self HP>=40% all hold", () => {
    const unitId = "UNIT_ELENA_MOODMAKER";
    const skillId = "SKL_ELENA_MOODMAKER_AS1";
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([unitId as never], []);
    const skill = snapshot.skills.get(skillId as never)!;
    expect(skill.requiredCapabilities).toContain("CAP_ACTION_ACTIVATION_CONDITION");
    expect(skill.activationCondition).toMatchObject({
      kind: "AND",
      conditions: [
        { kind: "TARGET_SET_COUNT", op: "GTE", value: 1 },
        { kind: "TARGET_SET_COUNT", op: "GTE", value: 1 },
        { kind: "TARGET_STATE", field: "HP_RATIO", op: "GTE", value: 0.4 },
      ],
    });

    const actor = unitOf("ACTOR", unitId, "ALLY", { column: "LEFT", row: "BACK" }, { currentAp: 3, currentHp: 100 });
    const enemy = unitOf("ENEMY_1", "UNIT_TEST_ENEMY", "ENEMY", { column: "LEFT", row: "FRONT" });

    // All three conditions hold: a wounded ally exists, she isn't alone, and her own HP is fine.
    const woundedAlly = unitOf(
      "ALLY_WOUNDED",
      "UNIT_TEST_ALLY",
      "ALLY",
      { column: "RIGHT", row: "FRONT" },
      { currentHp: 50 },
    );
    expect(
      selectAsCandidate([skill], actor, [actor, woundedAlly, enemy], snapshot.units),
    ).toEqual({ kind: "SKILL", skill });

    // No ally below 70% HP: the SET_THRESHOLD gate fails.
    const healthyAlly = unitOf(
      "ALLY_HEALTHY",
      "UNIT_TEST_ALLY",
      "ALLY",
      { column: "RIGHT", row: "FRONT" },
      { currentHp: 100 },
    );
    expect(
      selectAsCandidate([skill], actor, [actor, healthyAlly, enemy], snapshot.units),
    ).toEqual({ kind: "WAIT" });

    // No living ally besides herself.
    expect(selectAsCandidate([skill], actor, [actor, enemy], snapshot.units)).toEqual({
      kind: "WAIT",
    });

    // Her own HP is below 40%.
    const lowSelfHp = { ...actor, currentHp: 30 };
    expect(
      selectAsCandidate([skill], lowSelfHp, [lowSelfHp, woundedAlly, enemy], snapshot.units),
    ).toEqual({ kind: "WAIT" });
  });

  it("IT-CAP-ACTION-ACTIVATION-CONDITION-002: SKL_LYDIA_GENIUS_AS1's real TARGET_SET_COUNT activationCondition selects the skill only when an enemy exists in the right or left column", () => {
    const unitId = "UNIT_LYDIA_GENIUS";
    const skillId = "SKL_LYDIA_GENIUS_AS1";
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([unitId as never], []);
    const skill = snapshot.skills.get(skillId as never)!;
    expect(skill.requiredCapabilities).toContain("CAP_ACTION_ACTIVATION_CONDITION");
    expect(skill.activationCondition).toMatchObject({
      kind: "TARGET_SET_COUNT",
      op: "GTE",
      value: 1,
    });

    const actor = unitOf("ACTOR", unitId, "ALLY", { column: "CENTER", row: "BACK" }, { currentAp: 3 });
    const rightEnemy = unitOf("ENEMY_RIGHT", "UNIT_TEST_ENEMY", "ENEMY", {
      column: "RIGHT",
      row: "FRONT",
    });
    expect(selectAsCandidate([skill], actor, [actor, rightEnemy], snapshot.units)).toEqual({
      kind: "SKILL",
      skill,
    });

    const centerOnlyEnemy = unitOf("ENEMY_CENTER", "UNIT_TEST_ENEMY", "ENEMY", {
      column: "CENTER",
      row: "FRONT",
    });
    expect(selectAsCandidate([skill], actor, [actor, centerOnlyEnemy], snapshot.units)).toEqual({
      kind: "WAIT",
    });
  });

  it("IT-CAP-ACTION-ACTIVATION-CONDITION-003: SKL_LILY_HERO_AS1's real NOT(TARGET_STATE) activationCondition selects the skill unless her own HP ratio is below 20%", () => {
    const unitId = "UNIT_LILY_HERO";
    const skillId = "SKL_LILY_HERO_AS1";
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([unitId as never], []);
    const skill = snapshot.skills.get(skillId as never)!;
    expect(skill.requiredCapabilities).toContain("CAP_ACTION_ACTIVATION_CONDITION");

    // TGT_ADJACENT (BINDING_DERIVED, ADJACENT_ORTHOGONAL of TGT_BASE) needs a
    // second enemy orthogonally adjacent to the nearest one, or the skill is
    // globally unresolvable (R-TGT-01 #4) independent of activationCondition.
    const baseEnemy = unitOf("ENEMY_BASE", "UNIT_TEST_ENEMY", "ENEMY", {
      column: "LEFT",
      row: "FRONT",
    });
    const adjacentEnemy = unitOf("ENEMY_ADJACENT", "UNIT_TEST_ENEMY", "ENEMY", {
      column: "CENTER",
      row: "FRONT",
    });

    const healthyActor = unitOf("ACTOR", unitId, "ALLY", { column: "LEFT", row: "BACK" }, {
      currentAp: 3,
      currentHp: 50,
    });
    expect(
      selectAsCandidate([skill], healthyActor, [healthyActor, baseEnemy, adjacentEnemy]),
    ).toEqual({
      kind: "SKILL",
      skill,
    });

    const lowHpActor = unitOf("ACTOR", unitId, "ALLY", { column: "LEFT", row: "BACK" }, {
      currentAp: 3,
      currentHp: 15,
    });
    expect(
      selectAsCandidate([skill], lowHpActor, [lowHpActor, baseEnemy, adjacentEnemy]),
    ).toEqual({ kind: "WAIT" });
  });

  it("IT-CAP-ACTION-ACTIVATION-CONDITION-004: SKL_MAO_COMMITTEE_AS1's real TARGET_STATE activationCondition selects the skill only when her own HP ratio is at least 60%", () => {
    const unitId = "UNIT_MAO_COMMITTEE";
    const skillId = "SKL_MAO_COMMITTEE_AS1";
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([unitId as never], []);
    const skill = snapshot.skills.get(skillId as never)!;
    expect(skill.requiredCapabilities).toContain("CAP_ACTION_ACTIVATION_CONDITION");

    const enemy = unitOf("ENEMY_1", "UNIT_TEST_ENEMY", "ENEMY", { column: "LEFT", row: "FRONT" });
    const ally = unitOf("ALLY_1", "UNIT_TEST_ALLY", "ALLY", { column: "RIGHT", row: "FRONT" });

    const highHpActor = unitOf("ACTOR", unitId, "ALLY", { column: "LEFT", row: "BACK" }, {
      currentAp: 3,
      currentHp: 70,
    });
    expect(
      selectAsCandidate([skill], highHpActor, [highHpActor, ally, enemy]),
    ).toEqual({ kind: "SKILL", skill });

    const lowHpActor = unitOf("ACTOR", unitId, "ALLY", { column: "LEFT", row: "BACK" }, {
      currentAp: 3,
      currentHp: 50,
    });
    expect(selectAsCandidate([skill], lowHpActor, [lowHpActor, ally, enemy])).toEqual({
      kind: "WAIT",
    });
  });

  it("IT-CAP-ACTION-ACTIVATION-CONDITION-005: SKL_TATIANA_SAGE_AS2's real NOT(TARGET_HAS_MARKER) activationCondition selects the skill unless she currently holds MARKER_TATIANA_SAGE_PRUDENCE", () => {
    const unitId = "UNIT_TATIANA_SAGE";
    const skillId = "SKL_TATIANA_SAGE_AS2";
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([unitId as never], []);
    const skill = snapshot.skills.get(skillId as never)!;
    expect(skill.requiredCapabilities).toContain("CAP_ACTION_ACTIVATION_CONDITION");
    expect(skill.activationCondition).toMatchObject({
      kind: "NOT",
      condition: { kind: "TARGET_HAS_MARKER", markerId: "MARKER_TATIANA_SAGE_PRUDENCE" },
    });

    const enemy = unitOf("ENEMY_1", "UNIT_TEST_ENEMY", "ENEMY", { column: "LEFT", row: "FRONT" });
    const actor = unitOf("ACTOR", unitId, "ALLY", { column: "LEFT", row: "BACK" }, { currentAp: 3 });
    expect(selectAsCandidate([skill], actor, [actor, enemy])).toEqual({ kind: "SKILL", skill });

    const markedActor = {
      ...actor,
      markerStates: [markerOf(actor, "MARKER_TATIANA_SAGE_PRUDENCE")],
    };
    expect(selectAsCandidate([skill], markedActor, [markedActor, enemy])).toEqual({
      kind: "WAIT",
    });
  });
});
