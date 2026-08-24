import { describe, expect, it } from "vitest";
import { findMarkersRemovedOnSourceDefeat } from "./marker-source-defeat-service.js";
import { applyMarker } from "../effects/marker-apply-service.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { EventRecorder } from "../events/event-recorder.js";
import type { DomainEventId } from "../../shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import { createMarkerId, createUnitDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";
import { UNUSED_ENHANCED_BASE_STATS } from "../../../testing/fixtures/battle-actors.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 10 };

/** `ACT_AOI_ELEGANT_AS1_MARKER_KOUYOU`と同じ形（BATTLE期間・付与者戦闘不能で解除）。 */
const REMOVE_ON_SOURCE_DEFEATED: DurationDefinition = {
  dispellable: false,
  linkedEffectGroupId: null,
  timeLimit: { unit: "BATTLE", count: 1 },
  removeOnSourceDefeated: true,
};

const PLAIN_DURATION: DurationDefinition = {
  dispellable: true,
  linkedEffectGroupId: null,
  timeLimit: { unit: "BATTLE", count: 1 },
};

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

function seedRecorder(): { recorder: EventRecorder; rootEventId: DomainEventId } {
  const recorder = new EventRecorder(createBattleId("B_1"));
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

function baseContext(recorder: EventRecorder, rootEventId: DomainEventId) {
  return {
    recorder,
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    rootEventId,
  };
}

function defeatedEvent(unitId: string) {
  return {
    eventType: "UnitDefeated",
    payload: { unitId: createBattleUnitId(unitId) },
  };
}

/** `sourceUnitId`／`durationDefinition`だけを差し替えて1件のMarkerを付与する。 */
function grantMarker(options: {
  readonly sourceUnitId?: string;
  readonly sourceSide?: "ALLY" | "ENEMY";
  readonly targetUnitId: string;
  readonly durationDefinition: DurationDefinition;
  readonly units: readonly BattleUnit[];
  readonly recorder: EventRecorder;
  readonly rootEventId: DomainEventId;
}): { readonly units: readonly BattleUnit[]; readonly markerInstanceId: string } {
  const context = baseContext(options.recorder, options.rootEventId);
  const granted = applyMarker(
    context,
    options.units,
    {
      markerId: createMarkerId("MARKER_KOUYOU"),
      ...(options.sourceUnitId !== undefined
        ? { sourceUnitId: createBattleUnitId(options.sourceUnitId) }
        : { sourceSide: options.sourceSide! }),
      targetUnitId: createBattleUnitId(options.targetUnitId),
      stackPolicy: "ADD",
      stackMax: null,
      durationDefinition: options.durationDefinition,
    },
    options.rootEventId,
  );
  return { units: granted.units, markerInstanceId: granted.markerState.markerInstanceId };
}

describe("findMarkersRemovedOnSourceDefeat", () => {
  it("UT-R-EFF-10-023 (R-EFF-10 M7-020 Issue #279): seeds a SOURCE_DEFEATED removal for a Marker whose granter is the defeated unit", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const granted = grantMarker({
      sourceUnitId: "source-1",
      targetUnitId: "target-1",
      durationDefinition: REMOVE_ON_SOURCE_DEFEATED,
      units: [source, target],
      recorder,
      rootEventId,
    });

    const seeds = findMarkersRemovedOnSourceDefeat(granted.units, defeatedEvent("source-1"));

    expect(seeds).toEqual([
      {
        battleUnitId: target.battleUnitId,
        markerInstanceId: granted.markerInstanceId,
        reason: "SOURCE_DEFEATED",
      },
    ]);
  });

  it("UT-R-EFF-10-024 (R-EFF-10 M7-020 Issue #279): does not seed a Marker that omits removeOnSourceDefeated even when its granter is defeated", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const granted = grantMarker({
      sourceUnitId: "source-1",
      targetUnitId: "target-1",
      durationDefinition: PLAIN_DURATION,
      units: [source, target],
      recorder,
      rootEventId,
    });

    expect(findMarkersRemovedOnSourceDefeat(granted.units, defeatedEvent("source-1"))).toEqual([]);
  });

  it("UT-R-EFF-10-025 (R-EFF-10 M7-020 Issue #279): does not seed a declaring Marker when a unit other than its granter is defeated", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const bystander = unit("bystander-1");
    const { recorder, rootEventId } = seedRecorder();
    const granted = grantMarker({
      sourceUnitId: "source-1",
      targetUnitId: "target-1",
      durationDefinition: REMOVE_ON_SOURCE_DEFEATED,
      units: [source, target, bystander],
      recorder,
      rootEventId,
    });

    expect(findMarkersRemovedOnSourceDefeat(granted.units, defeatedEvent("bystander-1"))).toEqual(
      [],
    );
  });

  it("UT-R-EFF-10-026 (R-EFF-10 M7-020 Issue #279): ignores events other than UnitDefeated", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const granted = grantMarker({
      sourceUnitId: "source-1",
      targetUnitId: "target-1",
      durationDefinition: REMOVE_ON_SOURCE_DEFEATED,
      units: [source, target],
      recorder,
      rootEventId,
    });

    expect(
      findMarkersRemovedOnSourceDefeat(granted.units, {
        eventType: "HitPointReduced",
        payload: { unitId: createBattleUnitId("source-1") },
      }),
    ).toEqual([]);
  });

  it("UT-R-EFF-10-027 (R-EFF-10 M7-020 Issue #279, R-MEM-04): a Memory-granted Marker has no granter unit (sourceSide only) and is never seeded", () => {
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const granted = grantMarker({
      sourceSide: "ALLY",
      targetUnitId: "target-1",
      durationDefinition: REMOVE_ON_SOURCE_DEFEATED,
      units: [target],
      recorder,
      rootEventId,
    });

    expect(findMarkersRemovedOnSourceDefeat(granted.units, defeatedEvent("target-1"))).toEqual([]);
  });

  it("UT-R-EFF-10-028 (R-EFF-10 M7-020 Issue #279): seeds every holder when the same granter applied the Marker to several targets", () => {
    const source = unit("source-1");
    const first = unit("target-1");
    const second = unit("target-2");
    const { recorder, rootEventId } = seedRecorder();
    const firstGrant = grantMarker({
      sourceUnitId: "source-1",
      targetUnitId: "target-1",
      durationDefinition: REMOVE_ON_SOURCE_DEFEATED,
      units: [source, first, second],
      recorder,
      rootEventId,
    });
    const secondGrant = grantMarker({
      sourceUnitId: "source-1",
      targetUnitId: "target-2",
      durationDefinition: REMOVE_ON_SOURCE_DEFEATED,
      units: firstGrant.units,
      recorder,
      rootEventId,
    });

    expect(findMarkersRemovedOnSourceDefeat(secondGrant.units, defeatedEvent("source-1"))).toEqual([
      {
        battleUnitId: first.battleUnitId,
        markerInstanceId: firstGrant.markerInstanceId,
        reason: "SOURCE_DEFEATED",
      },
      {
        battleUnitId: second.battleUnitId,
        markerInstanceId: secondGrant.markerInstanceId,
        reason: "SOURCE_DEFEATED",
      },
    ]);
  });

  it("UT-R-TEX-07-002: a UnitBroken does not seed the source-defeat removal, so Markers the broken enemy granted to allies survive the break", () => {
    const ally = unit("ally-1");
    const { recorder, rootEventId } = seedRecorder();
    const granted = grantMarker({
      sourceUnitId: "enemy-1",
      targetUnitId: "ally-1",
      durationDefinition: REMOVE_ON_SOURCE_DEFEATED,
      units: [ally],
      recorder,
      rootEventId,
    });

    // R-TEX-07 #2: 発生源の戦闘不能を契機とする既存の解除規則はブレイクでは作動しない。
    // ブレイクは`UnitDefeated`を発行しないため、この抽出器はそもそも成立しない
    // （撃破トリガーの照合だけが`UnitBroken`を撃破として扱う、R-TEX-03 #2）。
    expect(
      findMarkersRemovedOnSourceDefeat(granted.units, {
        eventType: "UnitBroken",
        payload: { unitId: createBattleUnitId("enemy-1"), breakNumber: 1 },
      }),
    ).toEqual([]);
    // 同じ状態で`UnitDefeated`なら従来どおり解除対象になる（対比）。
    expect(findMarkersRemovedOnSourceDefeat(granted.units, defeatedEvent("enemy-1"))).toHaveLength(
      1,
    );
  });

  it("UT-R-EFF-10-029 (R-EFF-10 M7-020 Issue #279): a self-applied Marker is seeded when its holder is the defeated granter", () => {
    const self = unit("self-1");
    const { recorder, rootEventId } = seedRecorder();
    const granted = grantMarker({
      sourceUnitId: "self-1",
      targetUnitId: "self-1",
      durationDefinition: REMOVE_ON_SOURCE_DEFEATED,
      units: [self],
      recorder,
      rootEventId,
    });

    expect(findMarkersRemovedOnSourceDefeat(granted.units, defeatedEvent("self-1"))).toEqual([
      {
        battleUnitId: self.battleUnitId,
        markerInstanceId: granted.markerInstanceId,
        reason: "SOURCE_DEFEATED",
      },
    ]);
  });
});
