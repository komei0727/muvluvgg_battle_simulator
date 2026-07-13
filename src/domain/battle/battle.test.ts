import { describe, expect, it } from "vitest";
import { advanceBattle, createBattle, startBattle } from "./battle.js";
import { createBattleUnit, type BattleUnit } from "./battle-unit.js";
import type { BattlePartyMember } from "./battle-party.js";
import { createTurnLimit } from "./turn-limit.js";
import { DomainValidationError } from "../shared/errors.js";
import { createBattleId, createBattleUnitId } from "../shared/ids.js";
import { createUnitDefinitionId } from "../catalog/catalog-ids.js";
import type { Side } from "./side.js";

function member(id: string, overrides: Partial<BattlePartyMember> = {}): BattlePartyMember {
  return {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_001"),
    attribute: "AGGRESSIVE",
    position: { column: "LEFT", row: "FRONT" },
    globalCoordinate: { x: 0, y: 2 },
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
    ...overrides,
  };
}

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function unit(id: string, side: Side, overrides: Partial<BattleUnit> = {}): BattleUnit {
  return { ...createBattleUnit(member(id), side, LIMITS), ...overrides };
}

function readyBattle(turnLimit = 5) {
  return createBattle(
    createBattleId("B_1"),
    [unit("ally:1", "ALLY")],
    [unit("enemy:1", "ENEMY")],
    createTurnLimit(turnLimit),
  );
}

describe("createBattle", () => {
  it("UT-BATTLE-001: creates a READY battle with turn 0 and the given units", () => {
    const battle = readyBattle(5);

    expect(battle.status).toBe("READY");
    expect(battle.turnState.currentTurn).toBe(0);
    expect(battle.turnState.turnLimit).toBe(5);
    expect(battle.allyUnits).toHaveLength(1);
    expect(battle.enemyUnits).toHaveLength(1);
    expect(battle.result).toBeUndefined();
  });

  it("UT-BATTLE-002: rejects creation with no ally units (06_戦闘状態遷移.md: 両陣営に1体以上のユニットが存在)", () => {
    expect(() =>
      createBattle(createBattleId("B_1"), [], [unit("enemy:1", "ENEMY")], createTurnLimit(5)),
    ).toThrow(DomainValidationError);
  });

  it("UT-BATTLE-003: rejects creation with no enemy units", () => {
    expect(() =>
      createBattle(createBattleId("B_1"), [unit("ally:1", "ALLY")], [], createTurnLimit(5)),
    ).toThrow(DomainValidationError);
  });
});

describe("startBattle", () => {
  it("UT-BATTLE-004: transitions READY to RUNNING (06_戦闘状態遷移.md)", () => {
    const battle = startBattle(readyBattle());
    expect(battle.status).toBe("RUNNING");
  });

  it("UT-BATTLE-005: rejects starting a battle that is not READY", () => {
    const running = startBattle(readyBattle());
    expect(() => startBattle(running)).toThrow(DomainValidationError);
  });
});

describe("advanceBattle", () => {
  it("UT-BATTLE-006: rejects advancing a battle that is not RUNNING", () => {
    expect(() => advanceBattle(readyBattle())).toThrow(DomainValidationError);
  });

  it("UT-BATTLE-007: TURN_STARTING increments the turn and recovers AP/PP for surviving units", () => {
    const battle = advanceBattle(startBattle(readyBattle(5)));

    expect(battle.turnState.currentTurn).toBe(1);
    expect(battle.allyUnits[0]!.currentAp).toBe(3);
    expect(battle.allyUnits[0]!.currentPp).toBe(3);
    expect(battle.status).toBe("RUNNING");
  });

  it("UT-BATTLE-008: does not recover resources for a unit that started defeated", () => {
    const battle = createBattle(
      createBattleId("B_1"),
      [unit("ally:1", "ALLY", { currentHp: 0, currentAp: 0 })],
      [unit("enemy:1", "ENEMY")],
      createTurnLimit(5),
    );

    const advanced = advanceBattle(startBattle(battle));

    expect(advanced.allyUnits[0]!.currentAp).toBe(0);
  });

  it("UT-R-END-01-001 / SCN-BTL-019 lifecycle: mutual defeat at battle start resolves ALLY_WIN/SIMULTANEOUS_DEFEAT on the first TURN_STARTING result check", () => {
    const battle = createBattle(
      createBattleId("B_1"),
      [unit("ally:1", "ALLY", { currentHp: 0 })],
      [unit("enemy:1", "ENEMY", { currentHp: 0 })],
      createTurnLimit(5),
    );

    const completed = advanceBattle(startBattle(battle));

    expect(completed.status).toBe("COMPLETED");
    expect(completed.result).toEqual({
      outcome: "ALLY_WIN",
      completionReason: "SIMULTANEOUS_DEFEAT",
      completedTurn: 1,
    });
  });

  it("UT-R-END-01-002: an enemy defeated before allies resolves ALLY_WIN/ENEMY_DEFEATED even mid-way through the turn limit", () => {
    const battle = createBattle(
      createBattleId("B_1"),
      [unit("ally:1", "ALLY")],
      [unit("enemy:1", "ENEMY", { currentHp: 0 })],
      createTurnLimit(99),
    );

    const completed = advanceBattle(startBattle(battle));

    expect(completed.status).toBe("COMPLETED");
    expect(completed.result).toEqual({
      outcome: "ALLY_WIN",
      completionReason: "ENEMY_DEFEATED",
      completedTurn: 1,
    });
  });

  it("UT-R-END-01-003: allies defeated with the enemy surviving resolves ALLY_LOSE/ALLY_DEFEATED", () => {
    const battle = createBattle(
      createBattleId("B_1"),
      [unit("ally:1", "ALLY", { currentHp: 0 })],
      [unit("enemy:1", "ENEMY")],
      createTurnLimit(5),
    );

    const completed = advanceBattle(startBattle(battle));

    expect(completed.status).toBe("COMPLETED");
    expect(completed.result).toEqual({
      outcome: "ALLY_LOSE",
      completionReason: "ALLY_DEFEATED",
      completedTurn: 1,
    });
  });

  it("UT-R-END-01-004 / SCN-BTL-020 lifecycle: neither side defeated stays RUNNING until the regulation turn count is reached, then resolves ALLY_LOSE/TURN_LIMIT_REACHED", () => {
    let battle = startBattle(readyBattle(2));

    battle = advanceBattle(battle);
    expect(battle.status).toBe("RUNNING");
    expect(battle.turnState.currentTurn).toBe(1);

    battle = advanceBattle(battle);
    expect(battle.status).toBe("COMPLETED");
    expect(battle.result).toEqual({
      outcome: "ALLY_LOSE",
      completionReason: "TURN_LIMIT_REACHED",
      completedTurn: 2,
    });
  });

  it("UT-BATTLE-009: rejects advancing a COMPLETED battle (06_戦闘状態遷移.md 異常系: COMPLETED後の進行要求)", () => {
    const battle = createBattle(
      createBattleId("B_1"),
      [unit("ally:1", "ALLY", { currentHp: 0 })],
      [unit("enemy:1", "ENEMY", { currentHp: 0 })],
      createTurnLimit(5),
    );
    const completed = advanceBattle(startBattle(battle));

    expect(() => advanceBattle(completed)).toThrow(DomainValidationError);
  });
});
