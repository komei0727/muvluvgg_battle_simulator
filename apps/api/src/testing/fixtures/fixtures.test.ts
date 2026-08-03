import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { testBattleUnit, testPartyMember } from "./battle-actors.js";
import { definitionsForSkill, definitionsWith } from "./battle-definitions.js";
import { initialSnapshotFor, reconstruct } from "./battle-state.js";
import { completedTargetIdsOf, effectActionGroupContext } from "./effect-action-context.js";
import { seedRecorder } from "./event-seed.js";
import { testMarker } from "./markers.js";
import {
  effectActionFrom,
  loadProductionSnapshot,
  skillFrom,
  unitFrom,
} from "./production-catalog.js";
import { noMissNoCrit } from "./random.js";
import { testUnitDefinition } from "./unit-definitions.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import { createSkillDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

describe("production catalog snapshot fixtures", () => {
  it("UT-FIXTURE-001: loads a snapshot for plain-string unit ids including the skill closure", () => {
    const snapshot = loadProductionSnapshot(CATALOG_DIR, ["UNIT_KEI_JACKKNIFE"]);
    expect(String(unitFrom(snapshot, "UNIT_KEI_JACKKNIFE").unitDefinitionId)).toBe(
      "UNIT_KEI_JACKKNIFE",
    );
    expect(String(skillFrom(snapshot, "SKL_KEI_JACKKNIFE_AS2").skillDefinitionId)).toBe(
      "SKL_KEI_JACKKNIFE_AS2",
    );
  });

  it("UT-FIXTURE-002: snapshot getters throw a descriptive error for ids missing from the snapshot", () => {
    const snapshot = loadProductionSnapshot(CATALOG_DIR, ["UNIT_KEI_JACKKNIFE"]);
    expect(() => unitFrom(snapshot, "UNIT_UNKNOWN")).toThrow(/UNIT_UNKNOWN/);
    expect(() => skillFrom(snapshot, "SKL_UNKNOWN")).toThrow(/SKL_UNKNOWN/);
    expect(() => effectActionFrom(snapshot, "ACT_UNKNOWN")).toThrow(/ACT_UNKNOWN/);
  });
});

describe("event recorder seeding", () => {
  it("UT-FIXTURE-003: seeds a TurnStarted root event and returns its branded event id", () => {
    const { recorder, rootEventId, seed, resolutionScopeId } = seedRecorder("B_FIXTURE_SEED");
    const events = recorder.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("TurnStarted");
    expect(events[0]!.eventId).toBe(rootEventId);
    expect(seed).toBe(events[0]);
    expect(events[0]!.resolutionScopeId).toBe(resolutionScopeId);
  });
});

describe("testUnitDefinition", () => {
  it("UT-FIXTURE-004: defaults to a deterministic PS-less unit (no crit, no affinity bonus)", () => {
    const definition = testUnitDefinition("UNIT_TEST_FIXTURE");
    expect(String(definition.unitDefinitionId)).toBe("UNIT_TEST_FIXTURE");
    expect(definition.baseStats.criticalRate).toBe(0);
    expect(definition.baseStats.affinityBonus).toBe(0);
    expect(definition.passiveSkillDefinitionIds).toEqual([]);
    expect(String(definition.extraSkillDefinitionId)).toBe("SKL_EX_DEFAULT");
    expect(definition.metadata.characterId).toBe("CHAR_UNIT_TEST_FIXTURE");
  });

  it("UT-FIXTURE-005: merges baseStats and metadata overrides over the defaults", () => {
    const definition = testUnitDefinition("UNIT_TEST_FIXTURE", {
      baseStats: { maximumHp: 5000, attack: 100 },
      metadata: { affiliations: ["AFF_TEST"] },
    });
    expect(definition.baseStats.maximumHp).toBe(5000);
    expect(definition.baseStats.attack).toBe(100);
    expect(definition.baseStats.criticalRate).toBe(0);
    expect(definition.metadata.affiliations).toEqual(["AFF_TEST"]);
    expect(definition.metadata.displayName).toBe("UNIT_TEST_FIXTURE");
  });

  it("UT-FIXTURE-017: always emits the required extraSkillDefinitionId, overridable but never absent", () => {
    expect(testUnitDefinition("UNIT_TEST_FIXTURE").extraSkillDefinitionId).toBeDefined();
    const overridden = testUnitDefinition("UNIT_TEST_FIXTURE", {
      extraSkillDefinitionId: createSkillDefinitionId("SKL_TEST_FIXTURE_EX"),
    });
    expect(String(overridden.extraSkillDefinitionId)).toBe("SKL_TEST_FIXTURE_EX");
  });
});

describe("battle actor builders", () => {
  it("UT-FIXTURE-006: testPartyMember brands plain-string ids and derives the global coordinate", () => {
    const member = testPartyMember({
      battleUnitId: "ally:fixture",
      unitDefinitionId: "UNIT_TEST_FIXTURE",
      side: "ENEMY",
      position: { column: "CENTER", row: "BACK" },
    });
    expect(String(member.battleUnitId)).toBe("ally:fixture");
    expect(String(member.unitDefinitionId)).toBe("UNIT_TEST_FIXTURE");
    expect(member.globalCoordinate).toEqual(
      toGlobalCoordinate("ENEMY", { column: "CENTER", row: "BACK" }),
    );
  });

  it("UT-FIXTURE-007: testPartyMember merges combatStats overrides over deterministic defaults", () => {
    const member = testPartyMember({
      battleUnitId: "ally:fixture",
      unitDefinitionId: "UNIT_TEST_FIXTURE",
      combatStats: { maximumHp: 5000, attack: 100 },
    });
    expect(member.combatStats.maximumHp).toBe(5000);
    expect(member.combatStats.attack).toBe(100);
    expect(member.combatStats.criticalRate).toBe(0);
    expect(member.combatStats.affinityBonus).toBe(0);
  });

  it("UT-FIXTURE-008: testBattleUnit applies resource limits and top-level overrides", () => {
    const unit = testBattleUnit({
      battleUnitId: "enemy:fixture",
      unitDefinitionId: "UNIT_TEST_FIXTURE",
      side: "ENEMY",
      limits: { maximumExtraGauge: 100 },
      overrides: { currentHp: 1 },
    });
    expect(unit.side).toBe("ENEMY");
    expect(unit.maximumExtraGauge).toBe(100);
    expect(unit.currentHp).toBe(1);
    expect(unit.currentAp).toBe(0);
  });
});

describe("definitionsWith", () => {
  it("UT-FIXTURE-009: exposes snapshot definitions and pads extra unit ids with default test units", () => {
    const snapshot = loadProductionSnapshot(CATALOG_DIR, ["UNIT_KEI_JACKKNIFE"]);
    const definitions = definitionsWith(snapshot, { units: ["UNIT_TEST_ENEMY"] });
    expect(definitions.skillDefinitions.size).toBe(snapshot.skills.size);
    expect(definitions.effectActions.size).toBe(snapshot.effectActions.size);
    expect(definitions.unitDefinitions.size).toBe(snapshot.units.size + 1);
    const padded = unitFrom({ ...snapshot, units: definitions.unitDefinitions }, "UNIT_TEST_ENEMY");
    expect(padded.passiveSkillDefinitionIds).toEqual([]);
  });

  it("UT-FIXTURE-010: accepts full definitions, extra skills and BattleDefinitions overrides", () => {
    const snapshot = loadProductionSnapshot(CATALOG_DIR, ["UNIT_KEI_JACKKNIFE"]);
    const custom = testUnitDefinition("UNIT_TEST_ENEMY", { baseStats: { maximumHp: 5000 } });
    const extraSkill = skillFrom(snapshot, "SKL_KEI_JACKKNIFE_AS2");
    const definitions = definitionsWith(snapshot, {
      units: [custom],
      skills: [extraSkill],
      overrides: { memoriesBySide: { ALLY: [], ENEMY: [] } },
    });
    const padded = unitFrom({ ...snapshot, units: definitions.unitDefinitions }, "UNIT_TEST_ENEMY");
    expect(padded.baseStats.maximumHp).toBe(5000);
    expect(definitions.skillDefinitions.get(extraSkill.skillDefinitionId)).toBe(extraSkill);
    expect(definitions.memoriesBySide).toEqual({ ALLY: [], ENEMY: [] });
  });

  it("UT-FIXTURE-013: definitionsForSkill builds the minimal graph for one skill's resolution", () => {
    const snapshot = loadProductionSnapshot(CATALOG_DIR, ["UNIT_KEI_JACKKNIFE"]);
    const skill = skillFrom(snapshot, "SKL_KEI_JACKKNIFE_AS2");
    const definitions = definitionsForSkill(skill, snapshot.effectActions);
    expect(definitions.skillDefinitions.size).toBe(1);
    expect(definitions.skillDefinitions.get(skill.skillDefinitionId)).toBe(skill);
    expect(definitions.unitDefinitions.size).toBe(0);
    expect(definitions.effectActions).toBe(snapshot.effectActions);
  });
});

describe("initialSnapshotFor", () => {
  it("UT-FIXTURE-011: projects unit gauges, limits and combat stats without optional extras", () => {
    const unit = testBattleUnit({
      battleUnitId: "ally:snapshot",
      unitDefinitionId: "UNIT_TEST_FIXTURE",
    });
    const snapshot = initialSnapshotFor([unit]);
    expect(snapshot.status).toBe("RUNNING");
    expect(snapshot.currentTurn).toBe(1);
    const projected = snapshot.units[unit.battleUnitId]!;
    expect(projected.hp).toBe(unit.currentHp);
    expect(projected.maximumAp).toBe(unit.maximumAp);
    expect(projected.combatStats).toEqual(unit.combatStats);
    expect(projected.effects).toBeUndefined();
    expect(projected.markers).toBeUndefined();
  });

  it("UT-FIXTURE-012: opts in to projecting held effects and markers only when present", () => {
    const bare = testBattleUnit({
      battleUnitId: "ally:bare",
      unitDefinitionId: "UNIT_TEST_FIXTURE",
    });
    const marked = testBattleUnit({
      battleUnitId: "ally:marked",
      unitDefinitionId: "UNIT_TEST_FIXTURE",
    });
    const withMarker = { ...marked, markerStates: [testMarker(marked, "MARKER_TEST_FIXTURE")] };
    const snapshot = initialSnapshotFor([bare, withMarker], {
      include: ["effects", "markers"],
      status: "READY",
    });
    expect(snapshot.status).toBe("READY");
    expect(snapshot.units[bare.battleUnitId]!.markers).toBeUndefined();
    expect(snapshot.units[withMarker.battleUnitId]!.markers).toHaveLength(1);
  });

  it("UT-FIXTURE-019: reconstruct without recorded state deltas returns the initial projection", () => {
    const unit = testBattleUnit({
      battleUnitId: "ally:reconstruct",
      unitDefinitionId: "UNIT_TEST_FIXTURE",
    });
    const initial = initialSnapshotFor([unit]);
    const { recorder } = seedRecorder("B_FIXTURE_RECONSTRUCT");
    expect(reconstruct(initial, recorder)).toEqual(initial);
  });
});

describe("effect action group context", () => {
  it("UT-FIXTURE-014: builds the CTX-CORE shape with a no-miss no-crit random source by default", () => {
    const snapshot = loadProductionSnapshot(CATALOG_DIR, ["UNIT_KEI_JACKKNIFE"]);
    const actor = testBattleUnit({
      battleUnitId: "ally:ctx",
      unitDefinitionId: "UNIT_KEI_JACKKNIFE",
    });
    const { recorder, rootEventId } = seedRecorder("B_FIXTURE_CTX");
    const context = effectActionGroupContext({
      actor,
      skillId: "SKL_KEI_JACKKNIFE_AS2",
      definitions: definitionsWith(snapshot),
      recorder,
      rootEventId,
    });
    expect(context.actorId).toBe(actor.battleUnitId);
    expect(context.rootEventId).toBe(rootEventId);
    expect(context.parentEventId).toBe(rootEventId);
    expect(context.turnNumber).toBe(1);
    expect(context.cycleNumber).toBe(0);
    expect(String(context.skillDefinitionId)).toBe("SKL_KEI_JACKKNIFE_AS2");
    expect(context.random.next()).toBe(0.99);
  });

  it("UT-FIXTURE-018: completedTargetIdsOf collects targets of matching EffectActionCompleted events", () => {
    const { recorder } = seedRecorder("B_FIXTURE_TARGETS");
    expect(completedTargetIdsOf(recorder, "ACT_TEST_NONE")).toEqual([]);
  });
});

describe("random fixtures", () => {
  it("UT-FIXTURE-015: noMissNoCrit yields 0.99 draws for the requested length", () => {
    const random = noMissNoCrit(2);
    expect(random.next()).toBe(0.99);
    expect(random.next()).toBe(0.99);
    expect(() => random.next()).toThrow();
  });
});

describe("testMarker", () => {
  it("UT-FIXTURE-016: builds a self-sourced marker state with overridable stack count", () => {
    const unit = testBattleUnit({
      battleUnitId: "ally:marker",
      unitDefinitionId: "UNIT_TEST_FIXTURE",
    });
    const marker = testMarker(unit, "MARKER_TEST_FIXTURE", { stackCount: 3 });
    expect(String(marker.markerId)).toBe("MARKER_TEST_FIXTURE");
    expect(marker.sourceId).toBe(unit.battleUnitId);
    expect(marker.targetId).toBe(unit.battleUnitId);
    expect(marker.stackCount).toBe(3);
    expect(marker.stackMax).toBeNull();
  });
});
