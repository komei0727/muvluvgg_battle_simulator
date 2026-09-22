import { describe, expect, it } from "vitest";
import {
  findEffectsRemovedOnSourceDefeat,
  findMarkersRemovedOnSourceDefeat,
} from "./marker-source-defeat-service.js";
import { applyMarker } from "../effects/marker-apply-service.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createEffectInstanceId, type DomainEventId } from "../../shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createMarkerId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
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
      subAffinityBonus: 0,
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

  it("UT-R-TEX-07-002 (R-TEX-07 #3): a UnitBroken seeds the source-defeat removal too, so a removeOnSourceDefeated Marker the broken enemy granted to an ally (e.g. UNIT_LAYLA_NURSE_TEXの「観察」) is cleared on break", () => {
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

    // R-TEX-07 #3: removeOnSourceDefeatedを宣言したMarkerは、原文「付与者が倒れると
    // 解除される」の「倒れる」を戦術演習ではブレイクと解釈し、UnitDefeatedと同じ
    // 契機(R-EFF-10)として解除する。保持者が味方でも対象になる。
    expect(
      findMarkersRemovedOnSourceDefeat(granted.units, {
        eventType: "UnitBroken",
        payload: { unitId: createBattleUnitId("enemy-1"), breakNumber: 1 },
      }),
    ).toEqual([
      {
        battleUnitId: ally.battleUnitId,
        markerInstanceId: granted.markerInstanceId,
        reason: "SOURCE_DEFEATED",
      },
    ]);
  });

  it("UT-R-TEX-07-004 (R-TEX-07 #1, unaffected by #3): a UnitBroken does not seed a Marker that omits removeOnSourceDefeated, so the general 'enemy-granted ally effects survive break' rule still holds", () => {
    const ally = unit("ally-1");
    const { recorder, rootEventId } = seedRecorder();
    const granted = grantMarker({
      sourceUnitId: "enemy-1",
      targetUnitId: "ally-1",
      durationDefinition: PLAIN_DURATION,
      units: [ally],
      recorder,
      rootEventId,
    });

    expect(
      findMarkersRemovedOnSourceDefeat(granted.units, {
        eventType: "UnitBroken",
        payload: { unitId: createBattleUnitId("enemy-1"), breakNumber: 1 },
      }),
    ).toEqual([]);
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

const SHIELD_ACTION_ID = createEffectActionDefinitionId("ACT_TEST_SHIELD");

/** `APPLY_SHIELD`が付与する`AppliedEffect`。`sourceUnitId`／`durationDefinition`だけを差し替える。 */
function shieldEffect(options: {
  readonly instanceId: string;
  readonly sourceUnitId?: string;
  readonly sourceSide?: "ALLY" | "ENEMY";
  readonly targetUnitId: string;
  readonly durationDefinition: DurationDefinition;
}): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(options.instanceId),
    effectActionDefinitionId: SHIELD_ACTION_ID,
    kindKey: effectKindKeyFromDefinitionId(SHIELD_ACTION_ID),
    duplicate: true,
    ...(options.sourceUnitId !== undefined
      ? { sourceUnitId: createBattleUnitId(options.sourceUnitId) }
      : { sourceSide: options.sourceSide! }),
    targetUnitId: createBattleUnitId(options.targetUnitId),
    magnitude: 100,
    categories: ["SHIELD"],
    duration: { definition: options.durationDefinition },
    appliedTurnNumber: 1,
  };
}

describe("findEffectsRemovedOnSourceDefeat", () => {
  it("UT-R-EFF-10-049 (R-EFF-10 APPLY_SHIELD拡張、Issue #660): seeds a SOURCE_DEFEATED removal for a Shield AppliedEffect whose granter is the defeated unit", () => {
    const source = unit("source-1");
    const target: BattleUnit = {
      ...unit("target-1"),
      appliedEffects: [
        shieldEffect({
          instanceId: "effect-1",
          sourceUnitId: "source-1",
          targetUnitId: "target-1",
          durationDefinition: REMOVE_ON_SOURCE_DEFEATED,
        }),
      ],
    };

    const seeds = findEffectsRemovedOnSourceDefeat([source, target], defeatedEvent("source-1"));

    expect(seeds).toEqual([
      {
        battleUnitId: target.battleUnitId,
        effectInstanceId: target.appliedEffects[0]!.effectInstanceId,
        reason: "SOURCE_DEFEATED",
      },
    ]);
  });

  it("UT-R-EFF-10-050 (R-EFF-10 APPLY_SHIELD拡張): does not seed a Shield that omits removeOnSourceDefeated even when its granter is defeated", () => {
    const source = unit("source-1");
    const target: BattleUnit = {
      ...unit("target-1"),
      appliedEffects: [
        shieldEffect({
          instanceId: "effect-1",
          sourceUnitId: "source-1",
          targetUnitId: "target-1",
          durationDefinition: PLAIN_DURATION,
        }),
      ],
    };

    expect(findEffectsRemovedOnSourceDefeat([source, target], defeatedEvent("source-1"))).toEqual(
      [],
    );
  });

  it("UT-R-EFF-10-051 (R-EFF-10 APPLY_SHIELD拡張): does not seed a declaring Shield when a unit other than its granter is defeated", () => {
    const source = unit("source-1");
    const bystander = unit("bystander-1");
    const target: BattleUnit = {
      ...unit("target-1"),
      appliedEffects: [
        shieldEffect({
          instanceId: "effect-1",
          sourceUnitId: "source-1",
          targetUnitId: "target-1",
          durationDefinition: REMOVE_ON_SOURCE_DEFEATED,
        }),
      ],
    };

    expect(
      findEffectsRemovedOnSourceDefeat([source, target, bystander], defeatedEvent("bystander-1")),
    ).toEqual([]);
  });

  it("UT-R-EFF-10-052 (R-EFF-10 APPLY_SHIELD拡張): ignores events other than UnitDefeated", () => {
    const source = unit("source-1");
    const target: BattleUnit = {
      ...unit("target-1"),
      appliedEffects: [
        shieldEffect({
          instanceId: "effect-1",
          sourceUnitId: "source-1",
          targetUnitId: "target-1",
          durationDefinition: REMOVE_ON_SOURCE_DEFEATED,
        }),
      ],
    };

    expect(
      findEffectsRemovedOnSourceDefeat([source, target], {
        eventType: "HitPointReduced",
        payload: { unitId: createBattleUnitId("source-1") },
      }),
    ).toEqual([]);
  });

  it("UT-R-EFF-10-053 (R-EFF-10 APPLY_SHIELD拡張、R-MEM-04): a Memory-granted Shield has no granter unit (sourceSide only) and is never seeded", () => {
    const target: BattleUnit = {
      ...unit("target-1"),
      appliedEffects: [
        shieldEffect({
          instanceId: "effect-1",
          sourceSide: "ALLY",
          targetUnitId: "target-1",
          durationDefinition: REMOVE_ON_SOURCE_DEFEATED,
        }),
      ],
    };

    expect(findEffectsRemovedOnSourceDefeat([target], defeatedEvent("target-1"))).toEqual([]);
  });

  it("UT-R-EFF-10-043 (R-EFF-10 APPLY_SHIELD拡張): seeds every holder when the same granter applied the Shield to several targets", () => {
    const source = unit("source-1");
    const first: BattleUnit = {
      ...unit("target-1"),
      appliedEffects: [
        shieldEffect({
          instanceId: "effect-1",
          sourceUnitId: "source-1",
          targetUnitId: "target-1",
          durationDefinition: REMOVE_ON_SOURCE_DEFEATED,
        }),
      ],
    };
    const second: BattleUnit = {
      ...unit("target-2"),
      appliedEffects: [
        shieldEffect({
          instanceId: "effect-2",
          sourceUnitId: "source-1",
          targetUnitId: "target-2",
          durationDefinition: REMOVE_ON_SOURCE_DEFEATED,
        }),
      ],
    };

    expect(
      findEffectsRemovedOnSourceDefeat([source, first, second], defeatedEvent("source-1")),
    ).toEqual([
      {
        battleUnitId: first.battleUnitId,
        effectInstanceId: first.appliedEffects[0]!.effectInstanceId,
        reason: "SOURCE_DEFEATED",
      },
      {
        battleUnitId: second.battleUnitId,
        effectInstanceId: second.appliedEffects[0]!.effectInstanceId,
        reason: "SOURCE_DEFEATED",
      },
    ]);
  });

  it("UT-R-TEX-07-003 (R-TEX-07 #3): a UnitBroken seeds the source-defeat removal too, so a removeOnSourceDefeated Shield the broken enemy granted to an ally is cleared on break", () => {
    const target: BattleUnit = {
      ...unit("target-1"),
      appliedEffects: [
        shieldEffect({
          instanceId: "effect-1",
          sourceUnitId: "enemy-1",
          targetUnitId: "target-1",
          durationDefinition: REMOVE_ON_SOURCE_DEFEATED,
        }),
      ],
    };

    expect(
      findEffectsRemovedOnSourceDefeat([target], {
        eventType: "UnitBroken",
        payload: { unitId: createBattleUnitId("enemy-1"), breakNumber: 1 },
      }),
    ).toEqual([
      {
        battleUnitId: target.battleUnitId,
        effectInstanceId: target.appliedEffects[0]!.effectInstanceId,
        reason: "SOURCE_DEFEATED",
      },
    ]);
  });
});
