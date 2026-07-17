import { describe, expect, it } from "vitest";
import {
  createEmptyPassiveResolutionStack,
  depthOf,
  peekTop,
  popTop,
  pushCandidateGroups,
  withTopCandidates,
  type PassiveResolutionStackEntry,
} from "./passive-resolution-stack.js";
import type { PassiveCandidate } from "./passive-candidate.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";

const EVENT_A: TriggerCandidateEvent = { eventType: "EVENT_A", category: "FACT", payload: {} };
const EVENT_B: TriggerCandidateEvent = { eventType: "EVENT_B", category: "FACT", payload: {} };

const CANDIDATE_1 = { id: 1 } as unknown as PassiveCandidate;
const CANDIDATE_2 = { id: 2 } as unknown as PassiveCandidate;
const CANDIDATE_3 = { id: 3 } as unknown as PassiveCandidate;

function entry(
  event: TriggerCandidateEvent,
  candidates: readonly PassiveCandidate[],
): PassiveResolutionStackEntry {
  return { event, candidates };
}

describe("PassiveResolutionStack", () => {
  it("UT-R-PS-06-001: an empty stack has depth 0 and no top entry", () => {
    const stack = createEmptyPassiveResolutionStack();
    expect(depthOf(stack)).toBe(0);
    expect(peekTop(stack)).toBeUndefined();
  });

  it("UT-R-PS-06-002: pushing a candidate group makes it the top entry", () => {
    const stack = pushCandidateGroups(createEmptyPassiveResolutionStack(), [
      entry(EVENT_A, [CANDIDATE_1]),
    ]);
    expect(depthOf(stack)).toBe(1);
    expect(peekTop(stack)).toEqual(entry(EVENT_A, [CANDIDATE_1]));
  });

  it("UT-R-PS-06-003: pushing new candidate groups onto a non-empty stack puts them ahead of the existing top (R-PS-06 stack-front insertion)", () => {
    const base = pushCandidateGroups(createEmptyPassiveResolutionStack(), [
      entry(EVENT_A, [CANDIDATE_1]),
    ]);
    const withNew = pushCandidateGroups(base, [entry(EVENT_B, [CANDIDATE_2])]);
    expect(depthOf(withNew)).toBe(2);
    expect(peekTop(withNew)).toEqual(entry(EVENT_B, [CANDIDATE_2]));
  });

  it("UT-R-PS-06-004: pushing multiple groups at once preserves their relative order, first-to-process on top", () => {
    const stack = pushCandidateGroups(createEmptyPassiveResolutionStack(), [
      entry(EVENT_A, [CANDIDATE_1]),
      entry(EVENT_B, [CANDIDATE_2]),
    ]);
    expect(peekTop(stack)).toEqual(entry(EVENT_A, [CANDIDATE_1]));
    const afterPop = popTop(stack);
    expect(peekTop(afterPop)).toEqual(entry(EVENT_B, [CANDIDATE_2]));
  });

  it("UT-R-PS-06-005: withTopCandidates replaces only the top entry's remaining candidates", () => {
    const stack = pushCandidateGroups(createEmptyPassiveResolutionStack(), [
      entry(EVENT_A, [CANDIDATE_1, CANDIDATE_2]),
      entry(EVENT_B, [CANDIDATE_3]),
    ]);
    const updated = withTopCandidates(stack, [CANDIDATE_2]);
    expect(peekTop(updated)).toEqual(entry(EVENT_A, [CANDIDATE_2]));
    expect(depthOf(updated)).toBe(2);
  });

  it("UT-R-PS-06-006 / R-PS-06「元のグループの続きへ戻る」: popTop removes an exhausted top entry, returning control to the parent group", () => {
    const stack = pushCandidateGroups(createEmptyPassiveResolutionStack(), [
      entry(EVENT_A, []),
      entry(EVENT_B, [CANDIDATE_2]),
    ]);
    const parentRestored = popTop(stack);
    expect(depthOf(parentRestored)).toBe(1);
    expect(peekTop(parentRestored)).toEqual(entry(EVENT_B, [CANDIDATE_2]));
  });
});
