import { describe, expect, it } from "vitest";
import {
  NO_EFFECT_INSTANCE_IDS,
  NO_MARKER_INSTANCE_IDS,
  collectLinkedGroupCascade,
} from "./linked-effect-group.js";
import { createBattleUnit, type BattleUnit } from "./battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "./applied-effect.js";
import type { MarkerState } from "./marker-state.js";
import type { BattlePartyMember } from "./battle-party.js";
import type { FormationPosition } from "./formation-input.js";
import { toGlobalCoordinate } from "./global-coordinate.js";
import { createEffectInstanceId, createMarkerInstanceId } from "../../shared/event-ids.js";
import { createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createMarkerId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type {
  DurationDefinition,
  LinkedEffectGroupRole,
} from "../../catalog/definitions/duration-definition.js";
import { UNUSED_ENHANCED_BASE_STATS } from "../../../testing/fixtures/battle-actors.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 10 };

function unit(id: string): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    enhancedBaseStats: UNUSED_ENHANCED_BASE_STATS,
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate("ALLY", position),
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  return createBattleUnit(member, "ALLY", LIMITS);
}

const EFFECT_ACTION_DEFINITION_ID = createEffectActionDefinitionId("ACT_LINK");

function durationDefinition(
  linkedEffectGroupId: string | null,
  linkedEffectGroupRole?: LinkedEffectGroupRole,
): DurationDefinition {
  return {
    dispellable: true,
    linkedEffectGroupId,
    ...(linkedEffectGroupRole !== undefined ? { linkedEffectGroupRole } : {}),
  };
}

function effect(
  id: string,
  target: BattleUnit,
  linkedEffectGroupId: string | null,
  linkedEffectGroupRole?: LinkedEffectGroupRole,
): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: EFFECT_ACTION_DEFINITION_ID,
    kindKey: effectKindKeyFromDefinitionId(EFFECT_ACTION_DEFINITION_ID),
    duplicate: true,
    sourceUnitId: target.battleUnitId,
    targetUnitId: target.battleUnitId,
    magnitude: 10,
    categories: ["BUFF"],
    duration: { definition: durationDefinition(linkedEffectGroupId, linkedEffectGroupRole) },
    appliedTurnNumber: 1,
  };
}

function marker(
  id: string,
  target: BattleUnit,
  linkedEffectGroupId: string | null,
  linkedEffectGroupRole?: LinkedEffectGroupRole,
): MarkerState {
  return {
    markerInstanceId: createMarkerInstanceId(id),
    markerId: createMarkerId("MARKER_LINK"),
    sourceUnitId: target.battleUnitId,
    targetUnitId: target.battleUnitId,
    stackCount: 1,
    stackMax: null,
    duration: { definition: durationDefinition(linkedEffectGroupId, linkedEffectGroupRole) },
  };
}

function effectSeeds(...effects: readonly AppliedEffect[]) {
  return {
    effectInstanceIds: new Set(effects.map((instance) => instance.effectInstanceId)),
    markerInstanceIds: NO_MARKER_INSTANCE_IDS,
  };
}

function markerSeeds(...markers: readonly MarkerState[]) {
  return {
    effectInstanceIds: NO_EFFECT_INSTANCE_IDS,
    markerInstanceIds: new Set(markers.map((instance) => instance.markerInstanceId)),
  };
}

describe("collectLinkedGroupCascade", () => {
  it("UT-R-EFF-09-001 (R-EFF-09): returns just the initial set when none of its instances share a linkedEffectGroupId", () => {
    const target = unit("target-1");
    const parent = effect("parent", target, null);
    const sibling = effect("sibling", target, null);
    const units = [{ ...target, appliedEffects: [parent, sibling] }];

    const result = collectLinkedGroupCascade(units, effectSeeds(parent));

    expect(result).toEqual({
      effectInstanceIds: new Set([parent.effectInstanceId]),
      markerInstanceIds: new Set(),
    });
  });

  it("UT-R-EFF-09-002 (R-EFF-09): expands to sibling instances sharing the same linkedEffectGroupId on the same unit", () => {
    const target = unit("target-1");
    const parent = effect("parent", target, "GROUP_A");
    const child = effect("child", target, "GROUP_A");
    const unrelated = effect("unrelated", target, "GROUP_B");
    const units = [{ ...target, appliedEffects: [parent, child, unrelated] }];

    const result = collectLinkedGroupCascade(units, effectSeeds(parent));

    expect(result.effectInstanceIds).toEqual(
      new Set([parent.effectInstanceId, child.effectInstanceId]),
    );
  });

  it("UT-R-EFF-09-003 (R-EFF-09): expands across different units holding the same linkedEffectGroupId", () => {
    const targetA = unit("target-a");
    const targetB = unit("target-b");
    const parent = effect("parent", targetA, "GROUP_A");
    const child = effect("child", targetB, "GROUP_A");
    const units = [
      { ...targetA, appliedEffects: [parent] },
      { ...targetB, appliedEffects: [child] },
    ];

    const result = collectLinkedGroupCascade(units, effectSeeds(parent));

    expect(result.effectInstanceIds).toEqual(
      new Set([parent.effectInstanceId, child.effectInstanceId]),
    );
  });

  it("UT-R-EFF-09-004 (R-EFF-09): does not expand through an instance with linkedEffectGroupId null", () => {
    const target = unit("target-1");
    const parent = effect("parent", target, null);
    const other = effect("other", target, null);
    const units = [{ ...target, appliedEffects: [parent, other] }];

    const result = collectLinkedGroupCascade(units, effectSeeds(parent));

    expect(result.effectInstanceIds).toEqual(new Set([parent.effectInstanceId]));
  });

  it("UT-R-EFF-09-009 (R-EFF-09 cross-type): a PARENT MarkerState seed expands to the AppliedEffect children sharing its linkedEffectGroupId", () => {
    const target = unit("target-1");
    const parentMarker = marker("marker-parent", target, "GROUP_A", "PARENT");
    const childEffect = effect("child-effect", target, "GROUP_A", "CHILD");
    const otherChild = effect("other-child", target, "GROUP_A", "CHILD");
    const unrelated = effect("unrelated", target, "GROUP_B");
    const units = [
      {
        ...target,
        appliedEffects: [childEffect, otherChild, unrelated],
        markerStates: [parentMarker],
      },
    ];

    const result = collectLinkedGroupCascade(units, markerSeeds(parentMarker));

    expect(result).toEqual({
      effectInstanceIds: new Set([childEffect.effectInstanceId, otherChild.effectInstanceId]),
      markerInstanceIds: new Set([parentMarker.markerInstanceId]),
    });
  });

  it("UT-R-EFF-09-010 (R-EFF-09 cross-type): a PARENT AppliedEffect seed expands to the MarkerState children sharing its linkedEffectGroupId", () => {
    const target = unit("target-1");
    const parentEffect = effect("parent-effect", target, "GROUP_A", "PARENT");
    const childMarker = marker("marker-child", target, "GROUP_A", "CHILD");
    const units = [{ ...target, appliedEffects: [parentEffect], markerStates: [childMarker] }];

    const result = collectLinkedGroupCascade(units, effectSeeds(parentEffect));

    expect(result).toEqual({
      effectInstanceIds: new Set([parentEffect.effectInstanceId]),
      markerInstanceIds: new Set([childMarker.markerInstanceId]),
    });
  });

  it("UT-R-EFF-09-011 (R-EFF-09 cross-type): a CHILD AppliedEffect seed does not cascade to the PARENT MarkerState of the same group", () => {
    const target = unit("target-1");
    const parentMarker = marker("marker-parent", target, "GROUP_A", "PARENT");
    const childEffect = effect("child-effect", target, "GROUP_A", "CHILD");
    const siblingEffect = effect("sibling-effect", target, "GROUP_A", "CHILD");
    const units = [
      { ...target, appliedEffects: [childEffect, siblingEffect], markerStates: [parentMarker] },
    ];

    const result = collectLinkedGroupCascade(units, effectSeeds(childEffect));

    expect(result).toEqual({
      effectInstanceIds: new Set([childEffect.effectInstanceId]),
      markerInstanceIds: new Set(),
    });
  });

  it("UT-R-EFF-09-012 (R-EFF-09 cross-type): a role-less cross-type group cascades symmetrically from either instance type", () => {
    const target = unit("target-1");
    const legacyMarker = marker("marker-legacy", target, "GROUP_A");
    const legacyEffect = effect("effect-legacy", target, "GROUP_A");
    const units = [{ ...target, appliedEffects: [legacyEffect], markerStates: [legacyMarker] }];

    const fromMarker = collectLinkedGroupCascade(units, markerSeeds(legacyMarker));
    const fromEffect = collectLinkedGroupCascade(units, effectSeeds(legacyEffect));

    const whole = {
      effectInstanceIds: new Set([legacyEffect.effectInstanceId]),
      markerInstanceIds: new Set([legacyMarker.markerInstanceId]),
    };
    expect(fromMarker).toEqual(whole);
    expect(fromEffect).toEqual(whole);
  });

  it("UT-R-EFF-09-013 (R-EFF-09 cross-type): a MarkerState-only group still cascades between MarkerStates across units", () => {
    const targetA = unit("target-a");
    const targetB = unit("target-b");
    const parentMarker = marker("marker-parent", targetA, "GROUP_A", "PARENT");
    const childMarker = marker("marker-child", targetB, "GROUP_A", "CHILD");
    const units = [
      { ...targetA, markerStates: [parentMarker] },
      { ...targetB, markerStates: [childMarker] },
    ];

    const result = collectLinkedGroupCascade(units, markerSeeds(parentMarker));

    expect(result).toEqual({
      effectInstanceIds: new Set(),
      markerInstanceIds: new Set([parentMarker.markerInstanceId, childMarker.markerInstanceId]),
    });
  });
});
