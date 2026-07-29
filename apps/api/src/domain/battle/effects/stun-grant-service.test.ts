import { describe, expect, it } from "vitest";
import { grantStunStatus } from "./stun-grant-service.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createActionId, type createDomainEventId } from "../../shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 10 };

function unit(id: string): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
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

function seedRecorder(): {
  recorder: EventRecorder;
  rootEventId: ReturnType<typeof createDomainEventId>;
} {
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

const STUN_ACTION_ID = createEffectActionDefinitionId("ACT_STUN");

function stunDuration(count: number): DurationDefinition {
  return { timeLimit: { unit: "ACTION", count }, dispellable: true, linkedEffectGroupId: null };
}

/**
 * M7-011（Issue #265）: `grantEffect`系は`EffectActionDefinition`そのものを受け取り、
 * `EffectApplied`の分類payload（`effectKind`/`categories`）を定義から導く。
 */
function stunDefinition(): EffectActionDefinition {
  return {
    kind: "APPLY_STATUS",
    effectActionDefinitionId: STUN_ACTION_ID,
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: { status: "STUN", duration: stunDuration(1) },
  };
}

describe("grantStunStatus (R-STS-02)", () => {
  it("UT-R-STS-02-001: grants a new STUN AppliedEffect when the target has none yet", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();

    const result = grantStunStatus(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        actionId: createActionId("B_1:action:1"),
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        definition: stunDefinition(),
        sourceId: source.battleUnitId,
        targetId: target.battleUnitId,
        duplicate: true,
        magnitude: 0,
        statusKind: "STUN",
        durationDefinition: stunDuration(1),
      },
      rootEventId,
    );

    const grantedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(grantedTarget.appliedEffects).toHaveLength(1);
    expect(grantedTarget.appliedEffects[0]).toMatchObject({
      statusKind: "STUN",
      duration: { timeLimitRemaining: 1 },
    });
    expect(recorder.getEvents().some((e) => e.eventType === "EffectApplied")).toBe(true);
    expect(recorder.getEvents().some((e) => e.eventType === "StunDurationChanged")).toBe(false);
  });

  it("UT-R-STS-02-002: re-grant with a longer remaining count replaces the same instance's duration and records StunDurationChanged", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = {
      recorder,
      turnNumber: 1,
      cycleNumber: 0,
      actionId: createActionId("B_1:action:1"),
      resolutionScopeId: recorder.nextResolutionScopeId(),
      rootEventId,
    };
    const request = (durationCount: number) => ({
      definition: stunDefinition(),
      sourceId: source.battleUnitId,
      targetId: target.battleUnitId,
      duplicate: true,
      magnitude: 0,
      statusKind: "STUN" as const,
      durationDefinition: stunDuration(durationCount),
    });

    const first = grantStunStatus(context, [source, target], request(1), rootEventId);
    const firstTarget = first.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    const firstInstanceId = firstTarget.appliedEffects[0]!.effectInstanceId;

    const second = grantStunStatus(context, first.units, request(3), first.lastEventId);
    const secondTarget = second.units.find((u) => u.battleUnitId === target.battleUnitId)!;

    expect(secondTarget.appliedEffects).toHaveLength(1);
    expect(secondTarget.appliedEffects[0]!.effectInstanceId).toBe(firstInstanceId);
    expect(secondTarget.appliedEffects[0]!.duration.timeLimitRemaining).toBe(3);

    const changed = recorder
      .getEvents()
      .find((e) => e.eventType === "StunDurationChanged") as Extract<
      BattleDomainEvent,
      { eventType: "StunDurationChanged" }
    >;
    expect(changed).toBeDefined();
    expect(changed.payload).toMatchObject({
      effectInstanceId: firstInstanceId,
      battleUnitId: target.battleUnitId,
      remainingBefore: 1,
      remainingAfter: 3,
      reason: "REGRANT_EXTENDED",
    });
  });

  it("UT-R-STS-02-003: re-grant with a shorter or equal remaining count keeps the existing instance unchanged and records no event", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = {
      recorder,
      turnNumber: 1,
      cycleNumber: 0,
      actionId: createActionId("B_1:action:1"),
      resolutionScopeId: recorder.nextResolutionScopeId(),
      rootEventId,
    };
    const request = (durationCount: number) => ({
      definition: stunDefinition(),
      sourceId: source.battleUnitId,
      targetId: target.battleUnitId,
      duplicate: true,
      magnitude: 0,
      statusKind: "STUN" as const,
      durationDefinition: stunDuration(durationCount),
    });

    const first = grantStunStatus(context, [source, target], request(3), rootEventId);
    const eventCountAfterFirst = recorder.getEvents().length;

    const second = grantStunStatus(context, first.units, request(3), first.lastEventId);
    const secondTarget = second.units.find((u) => u.battleUnitId === target.battleUnitId)!;

    expect(secondTarget.appliedEffects).toHaveLength(1);
    expect(secondTarget.appliedEffects[0]!.duration.timeLimitRemaining).toBe(3);
    expect(recorder.getEvents()).toHaveLength(eventCountAfterFirst);
    expect(second.lastEventId).toBe(first.lastEventId);
  });
});

/**
 * R-EFF-12（`DYNAMIC_DURATION_ON_REAPPLY`、M7-014、Issue #268）:
 * `SKL_SIENA_DIVA_PS1`「コン・フオーコ」の原文
 * 「1行動の気絶を付与する。対象に1行動の気絶が付与されていた場合は、2行動の
 * 気絶に上書きする」を、STUNの再付与規則（R-STS-02）と組み合わせて検証する。
 * 一致判定は`statusKind`で行う（原文が付与元スキルを限定していないため、
 * 同じ定義から来た気絶だけでなく他スキル由来の気絶も「付与されていた」に
 * 当たる）。
 */
describe("grantStunStatus with a dynamic duration on re-apply (R-EFF-12)", () => {
  const context = (
    recorder: EventRecorder,
    rootEventId: ReturnType<typeof createDomainEventId>,
  ) => ({
    recorder,
    turnNumber: 1,
    cycleNumber: 0,
    actionId: createActionId("B_1:action:1"),
    resolutionScopeId: recorder.nextResolutionScopeId(),
    rootEventId,
  });

  /** `ACT_SIENA_DIVA_PS1_STUN`と同じ形: 基本1行動、既存が残り1なら2行動へ。 */
  function reapplyingStunDuration(): DurationDefinition {
    return {
      timeLimit: { unit: "ACTION", count: 1 },
      dispellable: true,
      linkedEffectGroupId: null,
      reapply: { existingRemaining: { op: "EQ", value: 1 }, count: 2 },
    };
  }

  function reapplyingStunDefinition(): EffectActionDefinition {
    return {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: STUN_ACTION_ID,
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: { status: "STUN", duration: reapplyingStunDuration() },
    };
  }

  function reapplyingRequest(source: BattleUnit, target: BattleUnit) {
    return {
      definition: reapplyingStunDefinition(),
      sourceId: source.battleUnitId,
      targetId: target.battleUnitId,
      duplicate: true,
      magnitude: 0,
      statusKind: "STUN" as const,
      durationDefinition: reapplyingStunDuration(),
    };
  }

  it("UT-R-EFF-12-001: the first grant uses the base count and the re-grant onto a 1-action STUN overwrites it with the reapply count", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const ctx = context(recorder, rootEventId);
    const request = reapplyingRequest(source, target);

    const first = grantStunStatus(ctx, [source, target], request, rootEventId);
    const firstTarget = first.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(firstTarget.appliedEffects[0]!.duration.timeLimitRemaining).toBe(1);

    const second = grantStunStatus(ctx, first.units, request, first.lastEventId);
    const secondTarget = second.units.find((u) => u.battleUnitId === target.battleUnitId)!;

    expect(secondTarget.appliedEffects).toHaveLength(1);
    expect(secondTarget.appliedEffects[0]!.effectInstanceId).toBe(
      firstTarget.appliedEffects[0]!.effectInstanceId,
    );
    expect(secondTarget.appliedEffects[0]!.duration.timeLimitRemaining).toBe(2);

    const changed = recorder
      .getEvents()
      .find((e) => e.eventType === "StunDurationChanged") as Extract<
      BattleDomainEvent,
      { eventType: "StunDurationChanged" }
    >;
    expect(changed.payload).toMatchObject({
      remainingBefore: 1,
      remainingAfter: 2,
      reason: "REGRANT_EXTENDED",
    });
  });

  it("UT-R-EFF-12-002: a STUN applied by another definition also satisfies the reapply match", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const ctx = context(recorder, rootEventId);

    // 他スキル由来（`ACT_SIENA_DIVA_EX_STUN`相当、reapplyを持たない1行動の気絶）。
    const first = grantStunStatus(
      ctx,
      [source, target],
      {
        definition: stunDefinition(),
        sourceId: source.battleUnitId,
        targetId: target.battleUnitId,
        duplicate: true,
        magnitude: 0,
        statusKind: "STUN" as const,
        durationDefinition: stunDuration(1),
      },
      rootEventId,
    );

    const second = grantStunStatus(
      ctx,
      first.units,
      reapplyingRequest(source, target),
      first.lastEventId,
    );
    const secondTarget = second.units.find((u) => u.battleUnitId === target.battleUnitId)!;

    expect(secondTarget.appliedEffects).toHaveLength(1);
    expect(secondTarget.appliedEffects[0]!.duration.timeLimitRemaining).toBe(2);
  });

  it("UT-R-EFF-12-003: an existing STUN outside the existingRemaining comparison keeps the base count, so R-STS-02 leaves it unchanged", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const ctx = context(recorder, rootEventId);

    // 残り2の気絶（`reapply`の`EQ 1`を満たさない境界）。基本1行動のまま付与を
    // 試み、R-STS-02「残り回数が長い方を一つだけ残す」でno-opになる。
    const first = grantStunStatus(
      ctx,
      [source, target],
      {
        definition: stunDefinition(),
        sourceId: source.battleUnitId,
        targetId: target.battleUnitId,
        duplicate: true,
        magnitude: 0,
        statusKind: "STUN" as const,
        durationDefinition: stunDuration(2),
      },
      rootEventId,
    );
    const eventCountAfterFirst = recorder.getEvents().length;

    const second = grantStunStatus(
      ctx,
      first.units,
      reapplyingRequest(source, target),
      first.lastEventId,
    );
    const secondTarget = second.units.find((u) => u.battleUnitId === target.battleUnitId)!;

    expect(secondTarget.appliedEffects).toHaveLength(1);
    expect(secondTarget.appliedEffects[0]!.duration.timeLimitRemaining).toBe(2);
    expect(recorder.getEvents()).toHaveLength(eventCountAfterFirst);
  });
});
