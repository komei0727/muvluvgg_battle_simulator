import { describe, expect, it } from "vitest";
import {
  evaluateMemorySourceSelector,
  evaluateMemoryTargetSelector,
  evaluateSourceSelector,
  evaluateTargetSelector,
} from "./trigger-selector-evaluator.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { createBattleUnitId, type BattleUnitId } from "../../shared/ids.js";
import { createUnitDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import { DomainValidationError } from "../../shared/errors.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function unit(id: string, side: Side): BattleUnit {
  const position = { column: "LEFT", row: "FRONT" } as const;
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_001"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
  return createBattleUnit(member, side, LIMITS);
}

describe("evaluateSourceSelector", () => {
  const owner = unit("OWNER", "ALLY");
  const allyOther = unit("ALLY_OTHER", "ALLY");
  const enemyOther = unit("ENEMY_OTHER", "ENEMY");
  const unitsById = new Map([
    [owner.battleUnitId, owner],
    [allyOther.battleUnitId, allyOther],
    [enemyOther.battleUnitId, enemyOther],
  ]);

  /**
   * 本番の`event-recorder.ts`が実際に生成する形（`sourceUnitId`だけを設定し、
   * `sourceSide`は設定しない）を再現する。
   */
  function eventFromUnit(sourceUnitId: BattleUnitId | undefined): TriggerCandidateEvent {
    return {
      eventType: "DamageApplied",
      category: "FACT",
      payload: {},
      ...(sourceUnitId !== undefined ? { sourceUnitId } : {}),
    };
  }

  it("UT-R-PS-01-110: ANY matches regardless of source", () => {
    expect(evaluateSourceSelector("ANY", owner, eventFromUnit(undefined), unitsById)).toBe(true);
  });

  it("UT-R-PS-01-111: SELF matches only when the source is the owner itself", () => {
    expect(
      evaluateSourceSelector("SELF", owner, eventFromUnit(owner.battleUnitId), unitsById),
    ).toBe(true);
    expect(
      evaluateSourceSelector("SELF", owner, eventFromUnit(enemyOther.battleUnitId), unitsById),
    ).toBe(false);
  });

  it("UT-R-PS-01-034 (Issue #144 follow-up): SELF matches every owner for a globally-scoped event with neither sourceUnitId nor sourceSide (e.g. TurnStarted/TurnCompleting), and ALLY/ENEMY still never match it", () => {
    const globalEvent: TriggerCandidateEvent = {
      eventType: "TurnCompleting",
      category: "TIMING",
      payload: {},
    };
    expect(evaluateSourceSelector("SELF", owner, globalEvent, unitsById)).toBe(true);
    expect(evaluateSourceSelector("SELF", allyOther, globalEvent, unitsById)).toBe(true);
    expect(evaluateSourceSelector("ALLY", owner, globalEvent, unitsById)).toBe(false);
    expect(evaluateSourceSelector("ENEMY", owner, globalEvent, unitsById)).toBe(false);
  });

  it("UT-R-PS-01-112 (regression): ALLY matches by resolving sourceUnitId's side, even though the event carries no sourceSide (matches production event-recorder.ts shape)", () => {
    expect(
      evaluateSourceSelector("ALLY", owner, eventFromUnit(allyOther.battleUnitId), unitsById),
    ).toBe(true);
    expect(
      evaluateSourceSelector("ALLY", owner, eventFromUnit(enemyOther.battleUnitId), unitsById),
    ).toBe(false);
  });

  it("UT-R-PS-01-113 (regression): ENEMY matches by resolving sourceUnitId's side, even though the event carries no sourceSide", () => {
    expect(
      evaluateSourceSelector("ENEMY", owner, eventFromUnit(enemyOther.battleUnitId), unitsById),
    ).toBe(true);
    expect(
      evaluateSourceSelector("ENEMY", owner, eventFromUnit(allyOther.battleUnitId), unitsById),
    ).toBe(false);
    expect(evaluateSourceSelector("ENEMY", owner, eventFromUnit(undefined), unitsById)).toBe(false);
  });

  it("UT-R-PS-01-114: EFFECT_OWNER throws (M7 scope, requires AppliedEffect ownership)", () => {
    expect(() =>
      evaluateSourceSelector("EFFECT_OWNER", owner, eventFromUnit(undefined), unitsById),
    ).toThrow(DomainValidationError);
  });

  it("UT-R-PS-01-128: falls back to event.sourceSide when the event has no sourceUnitId (e.g. Memory-origin events)", () => {
    const memoryEvent: TriggerCandidateEvent = {
      eventType: "HealApplied",
      category: "FACT",
      sourceSide: "ALLY",
      payload: {},
    };
    expect(evaluateSourceSelector("ALLY", owner, memoryEvent, unitsById)).toBe(true);
    expect(evaluateSourceSelector("ENEMY", owner, memoryEvent, unitsById)).toBe(false);
  });

  it("UT-R-PS-01-134: OTHER_ALLY matches an ally that is not the owner, and never the owner itself", () => {
    expect(
      evaluateSourceSelector("OTHER_ALLY", owner, eventFromUnit(allyOther.battleUnitId), unitsById),
    ).toBe(true);
    // 「他の味方が」は自分の行動では成立しない。`ALLY`との唯一の差はここにある。
    expect(
      evaluateSourceSelector("OTHER_ALLY", owner, eventFromUnit(owner.battleUnitId), unitsById),
    ).toBe(false);
    expect(
      evaluateSourceSelector("ALLY", owner, eventFromUnit(owner.battleUnitId), unitsById),
    ).toBe(true);
    expect(
      evaluateSourceSelector(
        "OTHER_ALLY",
        owner,
        eventFromUnit(enemyOther.battleUnitId),
        unitsById,
      ),
    ).toBe(false);
  });

  it("UT-R-PS-01-135: OTHER_ALLY does not match a globally-scoped event with neither sourceUnitId nor sourceSide (no source to call an ally)", () => {
    expect(evaluateSourceSelector("OTHER_ALLY", owner, eventFromUnit(undefined), unitsById)).toBe(
      false,
    );
  });

  it("UT-R-PS-01-137: OTHER_ALLY requires a resolvable source BattleUnit — an event carrying only sourceSide (Memory-origin) never matches it, while ALLY still does", () => {
    // 発生源のBattleUnitが存在しないイベント。`ALLY`は陣営だけで成立するが、
    // 「他の味方が」は「所有者以外の味方BattleUnit」を指すため成立してはならない。
    const memoryEvent: TriggerCandidateEvent = {
      eventType: "HealApplied",
      category: "FACT",
      sourceSide: "ALLY",
      payload: {},
    };
    expect(evaluateSourceSelector("ALLY", owner, memoryEvent, unitsById)).toBe(true);
    expect(evaluateSourceSelector("OTHER_ALLY", owner, memoryEvent, unitsById)).toBe(false);

    // `sourceUnitId`はあるが盤面に居ない場合も同じ（`ALLY`は`sourceSide`へfallbackする）。
    const unknownSource: TriggerCandidateEvent = {
      eventType: "DamageApplied",
      category: "FACT",
      sourceUnitId: createBattleUnitId("UNKNOWN"),
      sourceSide: "ALLY",
      payload: {},
    };
    expect(evaluateSourceSelector("ALLY", owner, unknownSource, unitsById)).toBe(true);
    expect(evaluateSourceSelector("OTHER_ALLY", owner, unknownSource, unitsById)).toBe(false);
  });

  it("UT-R-PS-01-129: falls back to event.sourceSide when sourceUnitId does not resolve in unitsById", () => {
    const event: TriggerCandidateEvent = {
      eventType: "DamageApplied",
      category: "FACT",
      sourceUnitId: createBattleUnitId("UNKNOWN"),
      sourceSide: "ENEMY",
      payload: {},
    };
    expect(evaluateSourceSelector("ENEMY", owner, event, unitsById)).toBe(true);
  });
});

describe("evaluateTargetSelector", () => {
  const owner = unit("OWNER", "ALLY");
  const ally = unit("ALLY_1", "ALLY");
  const enemy = unit("ENEMY_1", "ENEMY");
  const unitsById = new Map([
    [owner.battleUnitId, owner],
    [ally.battleUnitId, ally],
    [enemy.battleUnitId, enemy],
  ]);

  function eventWithTargets(targetUnitIds: readonly BattleUnitId[] | undefined) {
    const event: TriggerCandidateEvent = {
      eventType: "DamageApplied",
      category: "FACT",
      payload: {},
      ...(targetUnitIds !== undefined ? { targetUnitIds } : {}),
    };
    return event;
  }

  it("UT-R-PS-01-115: ANY matches even without targets", () => {
    expect(evaluateTargetSelector("ANY", owner, eventWithTargets(undefined), unitsById)).toBe(true);
  });

  it("UT-R-PS-01-116: SELF matches when the owner itself is among the targets", () => {
    expect(
      evaluateTargetSelector(
        "SELF",
        owner,
        eventWithTargets([enemy.battleUnitId, owner.battleUnitId]),
        unitsById,
      ),
    ).toBe(true);
    expect(
      evaluateTargetSelector("SELF", owner, eventWithTargets([enemy.battleUnitId]), unitsById),
    ).toBe(false);
  });

  it("UT-R-PS-01-035 (Issue #144 follow-up): SELF matches every owner for an event with no targetUnitIds at all (e.g. TurnCompleting/PassiveResolved), and ALLY/ENEMY still never match it", () => {
    expect(evaluateTargetSelector("SELF", owner, eventWithTargets(undefined), unitsById)).toBe(
      true,
    );
    expect(evaluateTargetSelector("SELF", owner, eventWithTargets([]), unitsById)).toBe(true);
    expect(evaluateTargetSelector("SELF", ally, eventWithTargets(undefined), unitsById)).toBe(true);
    expect(evaluateTargetSelector("ALLY", owner, eventWithTargets(undefined), unitsById)).toBe(
      false,
    );
    expect(evaluateTargetSelector("ENEMY", owner, eventWithTargets(undefined), unitsById)).toBe(
      false,
    );
  });

  it("UT-R-PS-01-117: ALLY matches when at least one target shares the owner side", () => {
    expect(
      evaluateTargetSelector(
        "ALLY",
        owner,
        eventWithTargets([enemy.battleUnitId, ally.battleUnitId]),
        unitsById,
      ),
    ).toBe(true);
    expect(
      evaluateTargetSelector("ALLY", owner, eventWithTargets([enemy.battleUnitId]), unitsById),
    ).toBe(false);
  });

  it("UT-R-PS-01-118: ENEMY matches when at least one target is on the opposite side", () => {
    expect(
      evaluateTargetSelector("ENEMY", owner, eventWithTargets([enemy.battleUnitId]), unitsById),
    ).toBe(true);
    expect(
      evaluateTargetSelector("ENEMY", owner, eventWithTargets([ally.battleUnitId]), unitsById),
    ).toBe(false);
  });

  it("UT-R-PS-01-136: OTHER_ALLY matches an allied target other than the owner, and never the owner alone", () => {
    expect(
      evaluateTargetSelector(
        "OTHER_ALLY",
        owner,
        eventWithTargets([enemy.battleUnitId, ally.battleUnitId]),
        unitsById,
      ),
    ).toBe(true);
    expect(
      evaluateTargetSelector(
        "OTHER_ALLY",
        owner,
        eventWithTargets([owner.battleUnitId]),
        unitsById,
      ),
    ).toBe(false);
    expect(
      evaluateTargetSelector("ALLY", owner, eventWithTargets([owner.battleUnitId]), unitsById),
    ).toBe(true);
  });

  it("UT-R-PS-01-119: a non-ANY selector never matches when there are no targets", () => {
    expect(evaluateTargetSelector("ALLY", owner, eventWithTargets(undefined), unitsById)).toBe(
      false,
    );
    expect(evaluateTargetSelector("ALLY", owner, eventWithTargets([]), unitsById)).toBe(false);
  });
});

describe("evaluateMemorySourceSelector / evaluateMemoryTargetSelector", () => {
  const ally = unit("ALLY_1", "ALLY");
  const unitsById = new Map([[ally.battleUnitId, ally]]);
  const event: TriggerCandidateEvent = {
    eventType: "DamageApplied",
    category: "FACT",
    sourceUnitId: ally.battleUnitId,
    targetUnitIds: [ally.battleUnitId],
    payload: {},
  };

  it("UT-R-MEM-04-005: OTHER_ALLY throws for both Memory selectors (a Memory has no owner BattleUnit to exclude)", () => {
    expect(() => evaluateMemorySourceSelector("OTHER_ALLY", "ALLY", event, unitsById)).toThrow(
      DomainValidationError,
    );
    expect(() => evaluateMemoryTargetSelector("OTHER_ALLY", "ALLY", event, unitsById)).toThrow(
      DomainValidationError,
    );
    // 隔離しないと`ALLY`へ丸められ、原文が除いた自己発動が静かに復活する。
    expect(evaluateMemorySourceSelector("ALLY", "ALLY", event, unitsById)).toBe(true);
    expect(evaluateMemoryTargetSelector("ALLY", "ALLY", event, unitsById)).toBe(true);
  });
});
