import { describe, expect, it } from "vitest";
import { expireEffects } from "./effect-expiration-service.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { AppliedEffect, EffectKindKey } from "../model/applied-effect.js";
import type { MarkerState } from "../model/marker-state.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import { createMarkerId } from "../../catalog/definitions/catalog-ids.js";

const BATTLE_ID = createBattleId("battle-1");
const SOURCE = createBattleUnitId("enemy:1");
const TARGET = createBattleUnitId("ally:1");
const KIND = "ACT_BUFF_ATTACK" as EffectKindKey;
const MARKER_A = createMarkerId("MARKER_A");
const MARKER_B = createMarkerId("MARKER_B");

function effect(overrides: {
  readonly id: string;
  readonly magnitude: number;
  readonly duplicate: boolean;
  readonly active: boolean;
  readonly linkedEffectGroupId?: string | null;
}): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(overrides.id),
    effectActionDefinitionId: KIND as unknown as AppliedEffect["effectActionDefinitionId"],
    kindKey: KIND,
    duplicate: overrides.duplicate,
    sourceId: SOURCE,
    targetId: TARGET,
    magnitude: overrides.magnitude,
    duration: {
      definition: {
        dispellable: true,
        linkedEffectGroupId: overrides.linkedEffectGroupId ?? null,
      },
    },
    active: overrides.active,
    appliedTurnNumber: 1,
  };
}

function marker(overrides: {
  readonly markerId: ReturnType<typeof createMarkerId>;
  readonly linkedEffectGroupId?: string | null;
}): MarkerState {
  return {
    markerId: overrides.markerId,
    sourceId: SOURCE,
    targetId: TARGET,
    stackCount: 1,
    stackMax: null,
    duration: {
      definition: { dispellable: true, linkedEffectGroupId: overrides.linkedEffectGroupId ?? null },
    },
    dispellable: true,
    linkedEffectGroupId: overrides.linkedEffectGroupId ?? null,
  };
}

function unitWith(
  appliedEffects: readonly AppliedEffect[],
  markers: readonly MarkerState[] = [],
): BattleUnit {
  return {
    battleUnitId: TARGET,
    unitDefinitionId: "UNIT_X" as never,
    attribute: "CUTE",
    side: "ALLY",
    position: { column: "LEFT", row: "FRONT" } as never,
    globalCoordinate: { x: 0, y: 2 },
    combatStats: {} as never,
    currentHp: 100,
    currentAp: 0,
    currentPp: 0,
    currentExtraGauge: 0,
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 100,
    cooldowns: {},
    appliedEffects,
    markers,
  };
}

function makeContext(recorder: EventRecorder) {
  const resolutionScopeId = recorder.nextResolutionScopeId();
  const root = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    resolutionScopeId,
    payload: { turnNumber: 1 },
  });
  return {
    recorder,
    turnNumber: 1,
    cycleNumber: 1,
    resolutionScopeId,
    rootEventId: root.eventId,
    rootEvent: root,
  };
}

describe("expireEffects (R-EFF-04/06/07/08/09)", () => {
  it("UT-EFF-EXPIRE-SVC-001: removes the expiring effect from appliedEffects and records EffectExpired", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const ctx = makeContext(recorder);
    const units = [unitWith([effect({ id: "e1", magnitude: 10, duplicate: true, active: true })])];

    const result = expireEffects(
      ctx,
      units,
      TARGET,
      [{ kind: "EFFECT", effectInstanceId: createEffectInstanceId("e1"), reason: "TIME_LIMIT" }],
      ctx.rootEvent.eventId,
    );

    const targetAfter = result.units.find((u) => u.battleUnitId === TARGET)!;
    expect(targetAfter.appliedEffects).toEqual([]);
    const expired = recorder.getEvents().find((e) => e.eventType === "EffectExpired");
    expect(expired?.payload).toMatchObject({ effectInstanceId: "e1", reason: "TIME_LIMIT" });
  });

  it("UT-EFF-EXPIRE-SVC-002: promotes the next-strongest effect and records EffectiveEffectChanged when the active one expires", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const ctx = makeContext(recorder);
    const units = [
      unitWith([
        effect({ id: "e1", magnitude: 30, duplicate: false, active: true }),
        effect({ id: "e2", magnitude: 15, duplicate: false, active: false }),
      ]),
    ];

    const result = expireEffects(
      ctx,
      units,
      TARGET,
      [{ kind: "EFFECT", effectInstanceId: createEffectInstanceId("e1"), reason: "TIME_LIMIT" }],
      ctx.rootEvent.eventId,
    );

    const targetAfter = result.units.find((u) => u.battleUnitId === TARGET)!;
    expect(targetAfter.appliedEffects.find((e) => e.effectInstanceId === "e2")?.active).toBe(true);
    const changed = recorder.getEvents().find((e) => e.eventType === "EffectiveEffectChanged");
    expect(changed?.payload).toMatchObject({
      beforeEffectInstanceId: "e1",
      afterEffectInstanceId: "e2",
    });
  });

  it("UT-EFF-EXPIRE-SVC-003: does not record EffectiveEffectChanged when a non-active (dethroned) instance expires", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const ctx = makeContext(recorder);
    const units = [
      unitWith([
        effect({ id: "e1", magnitude: 30, duplicate: false, active: true }),
        effect({ id: "e2", magnitude: 15, duplicate: false, active: false }),
      ]),
    ];

    const result = expireEffects(
      ctx,
      units,
      TARGET,
      [{ kind: "EFFECT", effectInstanceId: createEffectInstanceId("e2"), reason: "CONSUMPTION" }],
      ctx.rootEvent.eventId,
    );

    const targetAfter = result.units.find((u) => u.battleUnitId === TARGET)!;
    expect(targetAfter.appliedEffects.find((e) => e.effectInstanceId === "e1")?.active).toBe(true);
    expect(recorder.getEvents().some((e) => e.eventType === "EffectiveEffectChanged")).toBe(false);
  });

  it("UT-EFF-EXPIRE-SVC-004: cascades a linkedEffectGroup parent's expiry to its children, children before parent (R-EFF-09)", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const ctx = makeContext(recorder);
    const units = [
      unitWith([
        effect({
          id: "parent",
          magnitude: 10,
          duplicate: true,
          active: true,
          linkedEffectGroupId: "GROUP_A",
        }),
        effect({
          id: "child",
          magnitude: 5,
          duplicate: true,
          active: true,
          linkedEffectGroupId: "GROUP_A",
        }),
      ]),
    ];

    const result = expireEffects(
      ctx,
      units,
      TARGET,
      [
        {
          kind: "EFFECT",
          effectInstanceId: createEffectInstanceId("parent"),
          reason: "TIME_LIMIT",
        },
      ],
      ctx.rootEvent.eventId,
    );

    const targetAfter = result.units.find((u) => u.battleUnitId === TARGET)!;
    expect(targetAfter.appliedEffects).toEqual([]);
    const expiredEvents = recorder.getEvents().filter((e) => e.eventType === "EffectExpired");
    expect(
      expiredEvents.map((e) => (e.payload as { effectInstanceId: string }).effectInstanceId),
    ).toEqual(["child", "parent"]);
    expect(
      (
        expiredEvents.find(
          (e) => (e.payload as { effectInstanceId: string }).effectInstanceId === "child",
        )?.payload as { reason: string }
      ).reason,
    ).toBe("LINKED_GROUP_CASCADE");
  });

  it("UT-EFF-EXPIRE-SVC-005: a child expiring independently does not cascade to (remove) the parent (子効果だけが消費条件で失効した場合、親効果は維持する)", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const ctx = makeContext(recorder);
    const units = [
      unitWith([
        effect({
          id: "parent",
          magnitude: 10,
          duplicate: true,
          active: true,
          linkedEffectGroupId: "GROUP_A",
        }),
        effect({
          id: "child",
          magnitude: 5,
          duplicate: true,
          active: true,
          linkedEffectGroupId: "GROUP_A",
        }),
      ]),
    ];

    const result = expireEffects(
      ctx,
      units,
      TARGET,
      [
        {
          kind: "EFFECT",
          effectInstanceId: createEffectInstanceId("child"),
          reason: "CONSUMPTION",
        },
      ],
      ctx.rootEvent.eventId,
    );

    const targetAfter = result.units.find((u) => u.battleUnitId === TARGET)!;
    expect(targetAfter.appliedEffects.map((e) => e.effectInstanceId)).toEqual(["parent"]);
  });

  it("PR #155 re-review [P1]: removes an expiring Marker and records MarkerRemoved", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const ctx = makeContext(recorder);
    const units = [unitWith([], [marker({ markerId: MARKER_A })])];

    const result = expireEffects(
      ctx,
      units,
      TARGET,
      [{ kind: "MARKER", markerId: MARKER_A, reason: "TIME_LIMIT" }],
      ctx.rootEvent.eventId,
    );

    const targetAfter = result.units.find((u) => u.battleUnitId === TARGET)!;
    expect(targetAfter.markers).toEqual([]);
    const removed = recorder.getEvents().find((e) => e.eventType === "MarkerRemoved");
    expect(removed?.payload).toMatchObject({ markerId: MARKER_A, reason: "TIME_LIMIT" });
  });

  it("PR #155 re-review [P1]: cascades an AppliedEffect parent's expiry to a Marker child in the same linkedEffectGroup, Marker removed before the effect expires (R-EFF-09)", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const ctx = makeContext(recorder);
    const units = [
      unitWith(
        [
          effect({
            id: "parent",
            magnitude: 10,
            duplicate: true,
            active: true,
            linkedEffectGroupId: "GROUP_A",
          }),
        ],
        [marker({ markerId: MARKER_A, linkedEffectGroupId: "GROUP_A" })],
      ),
    ];

    const result = expireEffects(
      ctx,
      units,
      TARGET,
      [
        {
          kind: "EFFECT",
          effectInstanceId: createEffectInstanceId("parent"),
          reason: "TIME_LIMIT",
        },
      ],
      ctx.rootEvent.eventId,
    );

    const targetAfter = result.units.find((u) => u.battleUnitId === TARGET)!;
    expect(targetAfter.appliedEffects).toEqual([]);
    expect(targetAfter.markers).toEqual([]);
    const events = recorder
      .getEvents()
      .filter((e) => e.eventType === "MarkerRemoved" || e.eventType === "EffectExpired");
    expect(events.map((e) => e.eventType)).toEqual(["MarkerRemoved", "EffectExpired"]);
    expect(events[0]?.payload).toMatchObject({
      markerId: MARKER_A,
      reason: "LINKED_GROUP_CASCADE",
    });
  });

  it("PR #155 re-review [P1]: within a mixed group, the AppliedEffect is always treated as parent (documented grant-order convention), so the Marker's own independent expiry does not cascade to it (子効果だけが失効した場合、親効果は維持する)", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const ctx = makeContext(recorder);
    const units = [
      unitWith(
        [
          effect({
            id: "parent",
            magnitude: 5,
            duplicate: true,
            active: true,
            linkedEffectGroupId: "GROUP_A",
          }),
        ],
        [marker({ markerId: MARKER_A, linkedEffectGroupId: "GROUP_A" })],
      ),
    ];

    const result = expireEffects(
      ctx,
      units,
      TARGET,
      [{ kind: "MARKER", markerId: MARKER_A, reason: "TIME_LIMIT" }],
      ctx.rootEvent.eventId,
    );

    const targetAfter = result.units.find((u) => u.battleUnitId === TARGET)!;
    expect(targetAfter.appliedEffects.map((e) => e.effectInstanceId)).toEqual(["parent"]);
    expect(targetAfter.markers).toEqual([]);
  });

  it("PR #155 re-review [P1]: does not confuse two different Markers when only one shares the group", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const ctx = makeContext(recorder);
    const units = [
      unitWith(
        [
          effect({
            id: "parent",
            magnitude: 10,
            duplicate: true,
            active: true,
            linkedEffectGroupId: "GROUP_A",
          }),
        ],
        [
          marker({ markerId: MARKER_A, linkedEffectGroupId: "GROUP_A" }),
          marker({ markerId: MARKER_B }),
        ],
      ),
    ];

    const result = expireEffects(
      ctx,
      units,
      TARGET,
      [
        {
          kind: "EFFECT",
          effectInstanceId: createEffectInstanceId("parent"),
          reason: "TIME_LIMIT",
        },
      ],
      ctx.rootEvent.eventId,
    );

    const targetAfter = result.units.find((u) => u.battleUnitId === TARGET)!;
    expect(targetAfter.markers.map((m) => m.markerId)).toEqual([MARKER_B]);
  });

  describe("PR #155 re-review round 2 [P2]: per-event PS interleaving (context.notify)", () => {
    it("calls notify once per recorded event, in order, with the units updated so far", () => {
      const recorder = new EventRecorder(BATTLE_ID);
      const ctx = makeContext(recorder);
      const units = [
        unitWith([
          effect({
            id: "parent",
            magnitude: 10,
            duplicate: true,
            active: true,
            linkedEffectGroupId: "GROUP_A",
          }),
          effect({
            id: "child",
            magnitude: 5,
            duplicate: true,
            active: true,
            linkedEffectGroupId: "GROUP_A",
          }),
        ]),
      ];
      const notified: string[] = [];

      expireEffects(
        {
          ...ctx,
          notify: (event, currentUnits) => {
            notified.push(
              `${event.eventType}:${(event.payload as { effectInstanceId: string }).effectInstanceId}`,
            );
            return currentUnits;
          },
        },
        units,
        TARGET,
        [
          {
            kind: "EFFECT",
            effectInstanceId: createEffectInstanceId("parent"),
            reason: "TIME_LIMIT",
          },
        ],
        ctx.rootEvent.eventId,
      );

      expect(notified).toEqual(["EffectExpired:child", "EffectExpired:parent"]);
    });

    it("uses the units returned by notify (not a stale pre-batch snapshot) to decide the next step: a reaction that removes the promotion candidate before promotion is decided prevents a stale EffectiveEffectChanged", () => {
      const recorder = new EventRecorder(BATTLE_ID);
      const ctx = makeContext(recorder);
      const units = [
        unitWith([
          effect({ id: "e1", magnitude: 30, duplicate: false, active: true }),
          effect({ id: "e2", magnitude: 15, duplicate: false, active: false }),
        ]),
      ];

      const result = expireEffects(
        {
          ...ctx,
          notify: (event, currentUnits) => {
            if (event.eventType !== "EffectExpired") {
              return currentUnits;
            }
            // Simulates a PS reacting to e1's expiry by independently removing e2
            // before this function's own promotion check runs.
            return currentUnits.map((u) =>
              u.battleUnitId === TARGET
                ? {
                    ...u,
                    appliedEffects: u.appliedEffects.filter((e) => e.effectInstanceId !== "e2"),
                  }
                : u,
            );
          },
        },
        units,
        TARGET,
        [{ kind: "EFFECT", effectInstanceId: createEffectInstanceId("e1"), reason: "TIME_LIMIT" }],
        ctx.rootEvent.eventId,
      );

      const targetAfter = result.units.find((u) => u.battleUnitId === TARGET)!;
      expect(targetAfter.appliedEffects).toEqual([]);
      // A stale (pre-notify) promotion computation would have wrongly promoted e2
      // (the only other instance in the pre-batch snapshot). The correct, current-state
      // computation reports the active effect going from e1 to none (e2 is already gone).
      const changed = recorder.getEvents().find((e) => e.eventType === "EffectiveEffectChanged");
      expect(changed?.payload).toMatchObject({ beforeEffectInstanceId: "e1" });
      expect(
        (changed?.payload as { afterEffectInstanceId?: string }).afterEffectInstanceId,
      ).toBeUndefined();
    });

    it("skips an already-notify-removed request instead of re-emitting a duplicate EffectExpired for it", () => {
      const recorder = new EventRecorder(BATTLE_ID);
      const ctx = makeContext(recorder);
      const units = [
        unitWith([
          effect({ id: "e1", magnitude: 10, duplicate: true, active: true }),
          effect({ id: "e2", magnitude: 5, duplicate: true, active: true }),
        ]),
      ];

      const result = expireEffects(
        {
          ...ctx,
          notify: (event, currentUnits) => {
            if ((event.payload as { effectInstanceId?: string }).effectInstanceId !== "e1") {
              return currentUnits;
            }
            // A PS reacting to e1's expiry independently removes e2 too.
            return currentUnits.map((u) =>
              u.battleUnitId === TARGET
                ? {
                    ...u,
                    appliedEffects: u.appliedEffects.filter((e) => e.effectInstanceId !== "e2"),
                  }
                : u,
            );
          },
        },
        units,
        TARGET,
        [
          { kind: "EFFECT", effectInstanceId: createEffectInstanceId("e1"), reason: "TIME_LIMIT" },
          { kind: "EFFECT", effectInstanceId: createEffectInstanceId("e2"), reason: "TIME_LIMIT" },
        ],
        ctx.rootEvent.eventId,
      );

      const targetAfter = result.units.find((u) => u.battleUnitId === TARGET)!;
      expect(targetAfter.appliedEffects).toEqual([]);
      const expiredIds = recorder
        .getEvents()
        .filter((e) => e.eventType === "EffectExpired")
        .map((e) => (e.payload as { effectInstanceId: string }).effectInstanceId);
      expect(expiredIds).toEqual(["e1"]);
    });
  });
});
