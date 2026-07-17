import { describe, expect, it } from "vitest";
import { beginNextTurn, createTurnState, isFinalTurn } from "./turn-state.js";
import { createTurnLimit } from "../model/turn-limit.js";

describe("createTurnState", () => {
  it("UT-TURN-STATE-001: starts before turn 1 (06_戦闘状態遷移.md TURN_STARTING #1: 初回は1とする)", () => {
    const state = createTurnState(createTurnLimit(5));
    expect(state.currentTurn).toBe(0);
    expect(state.turnLimit).toBe(5);
  });
});

describe("beginNextTurn", () => {
  it("UT-TURN-STATE-002: the first call advances to turn 1", () => {
    const state = beginNextTurn(createTurnState(createTurnLimit(5)));
    expect(state.currentTurn).toBe(1);
  });

  it("UT-TURN-STATE-003: each subsequent call increments the turn number by one", () => {
    let state = createTurnState(createTurnLimit(5));
    state = beginNextTurn(state);
    state = beginNextTurn(state);
    state = beginNextTurn(state);
    expect(state.currentTurn).toBe(3);
  });
});

describe("isFinalTurn", () => {
  it("UT-TURN-STATE-004: is false before the turn limit is reached", () => {
    const state = beginNextTurn(createTurnState(createTurnLimit(3)));
    expect(isFinalTurn(state)).toBe(false);
  });

  it("UT-TURN-STATE-005: is true once the current turn equals the turn limit", () => {
    let state = createTurnState(createTurnLimit(2));
    state = beginNextTurn(state);
    state = beginNextTurn(state);
    expect(isFinalTurn(state)).toBe(true);
  });
});
