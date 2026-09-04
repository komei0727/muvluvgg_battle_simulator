import { describe, expect, it } from "vitest";
import { projectSkillTimeline } from "./skill-timeline-projector.js";
import type { BattleLogEventResponse } from "../../shared/api/api-contract.js";

const ATTACKER = "bu-ally-1";
const CASTER = "bu-ally-2";

interface EventSeed {
  readonly sequence: number;
  readonly type: string;
  readonly turnNumber?: number;
  readonly cycleNumber?: number;
  readonly parentSequence?: number;
  readonly skillUseId?: string;
  readonly sourceUnitId?: string;
  readonly sourceSide?: string;
  readonly details?: Record<string, unknown>;
}

function event(seed: EventSeed): BattleLogEventResponse {
  return {
    schemaVersion: 1,
    sequence: seed.sequence,
    type: seed.type,
    category: "FACT",
    turnNumber: seed.turnNumber ?? 1,
    cycleNumber: seed.cycleNumber ?? 1,
    rootSequence: 1,
    targetUnitIds: [],
    stateVersionBefore: seed.sequence,
    stateVersionAfter: seed.sequence + 1,
    ...(seed.parentSequence !== undefined ? { parentSequence: seed.parentSequence } : {}),
    ...(seed.skillUseId !== undefined ? { skillUseId: seed.skillUseId } : {}),
    ...(seed.sourceUnitId !== undefined ? { sourceUnitId: seed.sourceUnitId } : {}),
    ...(seed.sourceSide !== undefined ? { sourceSide: seed.sourceSide } : {}),
    details: seed.details ?? {},
  };
}

describe("projectSkillTimeline", () => {
  it("UI-UT-SKT-001: groups events sharing a skillUseId into one instance, keeping events sequence-ascending", () => {
    const events = [
      event({
        sequence: 20,
        type: "SKILL_USE_COMPLETED",
        skillUseId: "su-attack",
        sourceUnitId: ATTACKER,
        parentSequence: 11,
      }),
      event({
        sequence: 10,
        type: "TARGETS_SELECTED",
        skillUseId: "su-attack",
        sourceUnitId: ATTACKER,
        details: { skillDefinitionId: "SKL_ATTACK", bindings: [] },
      }),
      event({
        sequence: 11,
        type: "SKILL_USE_STARTING",
        skillUseId: "su-attack",
        parentSequence: 10,
        details: {
          skillDefinitionId: "SKL_ATTACK",
          skillType: "AS",
          actorUnitId: ATTACKER,
          targetUnitIds: [],
          costResource: "AP",
          costAmount: 1,
        },
      }),
    ];

    const view = projectSkillTimeline(events);

    expect(view.instances).toHaveLength(1);
    const instance = view.instances[0]!;
    expect(instance.events.map((e) => e.sequence)).toEqual([10, 11, 20]);
    expect(instance.startSequence).toBe(10);
  });

  it("UI-UT-SKT-002: excludes events without a skillUseId from every instance", () => {
    const events = [
      event({
        sequence: 1,
        type: "TARGETS_SELECTED",
        skillUseId: "su-1",
        sourceUnitId: ATTACKER,
        details: { skillDefinitionId: "SKL_ATTACK", bindings: [] },
      }),
      event({ sequence: 2, type: "RESOURCE_CHANGED", parentSequence: 1 }),
      event({ sequence: 3, type: "TURN_STARTED", details: { turnNumber: 2 } }),
    ];

    const view = projectSkillTimeline(events);

    expect(view.instances).toHaveLength(1);
    expect(view.instances[0]!.events.map((e) => e.sequence)).toEqual([1]);
  });

  it("UI-UT-SKT-003: splits multiple skillUseId groups into separate instances ordered by startSequence", () => {
    const events = [
      event({
        sequence: 30,
        type: "TARGETS_SELECTED",
        skillUseId: "su-later",
        sourceUnitId: CASTER,
        details: { skillDefinitionId: "SKL_LATER", bindings: [] },
      }),
      event({
        sequence: 10,
        type: "TARGETS_SELECTED",
        skillUseId: "su-earlier",
        sourceUnitId: ATTACKER,
        details: { skillDefinitionId: "SKL_EARLIER", bindings: [] },
      }),
    ];

    const view = projectSkillTimeline(events);

    expect(view.instances.map((instance) => instance.skillUseId)).toEqual([
      "su-earlier",
      "su-later",
    ]);
    expect(view.instances.map((instance) => instance.startSequence)).toEqual([10, 30]);
  });

  it("UI-UT-SKT-004: resolves AS actorUnitId from the envelope sourceUnitId when TARGETS_SELECTED lacks it in details", () => {
    const events = [
      event({
        sequence: 1,
        type: "TARGETS_SELECTED",
        skillUseId: "su-1",
        sourceUnitId: ATTACKER,
        details: { skillDefinitionId: "SKL_ATTACK", bindings: [] },
      }),
    ];

    const view = projectSkillTimeline(events);

    expect(view.instances[0]).toMatchObject({
      actorUnitId: ATTACKER,
      skillDefinitionId: "SKL_ATTACK",
    });
  });

  it("UI-UT-SKT-005: aggregates a PS activation correctly even when PASSIVE_POINT_CONSUMED precedes PASSIVE_ACTIVATED", () => {
    const events = [
      event({
        sequence: 10,
        type: "PASSIVE_POINT_CONSUMED",
        skillUseId: "su-ps",
        details: {
          actorUnitId: CASTER,
          skillDefinitionId: "SKL_PS_1",
          before: 5,
          after: 3,
          consumedAmount: 2,
        },
      }),
      event({
        sequence: 11,
        type: "PASSIVE_ACTIVATED",
        skillUseId: "su-ps",
        parentSequence: 10,
        details: {
          actorUnitId: CASTER,
          skillDefinitionId: "SKL_PS_1",
          ppBefore: 3,
          ppAfter: 3,
          exBefore: 0,
          exAfter: 0,
          triggerEventId: "evt-1",
        },
      }),
    ];

    const view = projectSkillTimeline(events);

    expect(view.instances).toHaveLength(1);
    expect(view.instances[0]).toMatchObject({
      actorUnitId: CASTER,
      skillDefinitionId: "SKL_PS_1",
      startSequence: 10,
    });
  });

  it("UI-UT-SKT-006: excludes a Memory activation entirely, since it is not attributable to any unit's skill", () => {
    const events = [
      event({
        sequence: 1,
        type: "MEMORY_TRIGGERED",
        skillUseId: "su-memory",
        sourceSide: "ALLY",
        details: {
          memoryDefinitionId: "MEM_X",
          triggeredEffectIndex: 0,
          sourceSide: "ALLY",
          triggerEventId: "evt-1",
        },
      }),
      event({
        sequence: 2,
        type: "TARGETS_SELECTED",
        skillUseId: "su-attack",
        sourceUnitId: ATTACKER,
        details: { skillDefinitionId: "SKL_ATTACK", bindings: [] },
      }),
    ];

    const view = projectSkillTimeline(events);

    expect(view.instances).toHaveLength(1);
    expect(view.instances[0]!.skillUseId).toBe("su-attack");
    expect(view.skillDefinitionIds).toEqual(["SKL_ATTACK"]);
  });

  it("UI-UT-SKT-007: outcome is INTERRUPTED when the group ends with SKILL_USE_INTERRUPTED", () => {
    const events = [
      event({
        sequence: 1,
        type: "TARGETS_SELECTED",
        skillUseId: "su-1",
        sourceUnitId: ATTACKER,
        details: { skillDefinitionId: "SKL_ATTACK", bindings: [] },
      }),
      event({
        sequence: 2,
        type: "SKILL_USE_INTERRUPTED",
        skillUseId: "su-1",
        parentSequence: 1,
        details: { reason: "UNIT_DEFEATED" },
      }),
    ];

    const view = projectSkillTimeline(events);

    expect(view.instances[0]).toMatchObject({ outcome: "INTERRUPTED", endedSequence: 2 });
  });

  it("UI-UT-SKT-008: outcome is IN_PROGRESS when the log ends before a completion or interruption event", () => {
    const events = [
      event({
        sequence: 1,
        type: "TARGETS_SELECTED",
        skillUseId: "su-1",
        sourceUnitId: ATTACKER,
        details: { skillDefinitionId: "SKL_ATTACK", bindings: [] },
      }),
    ];

    const view = projectSkillTimeline(events);

    expect(view.instances[0]).toMatchObject({ outcome: "IN_PROGRESS" });
    expect(view.instances[0]!.endedSequence).toBeUndefined();
  });

  it("UI-UT-SKT-009: actorUnitIds and skillDefinitionIds are deduplicated", () => {
    const events = [
      event({
        sequence: 1,
        type: "TARGETS_SELECTED",
        skillUseId: "su-1",
        sourceUnitId: ATTACKER,
        details: { skillDefinitionId: "SKL_ATTACK", bindings: [] },
      }),
      event({
        sequence: 2,
        type: "TARGETS_SELECTED",
        skillUseId: "su-2",
        sourceUnitId: ATTACKER,
        details: { skillDefinitionId: "SKL_ATTACK", bindings: [] },
      }),
    ];

    const view = projectSkillTimeline(events);

    expect(view.actorUnitIds).toEqual([ATTACKER]);
    expect(view.skillDefinitionIds).toEqual(["SKL_ATTACK"]);
  });
});
