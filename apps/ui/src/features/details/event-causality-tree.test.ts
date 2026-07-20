import { describe, expect, it } from "vitest";
import { buildCausalityTree } from "./event-causality-tree.js";
import type { BattleLogEventResponse } from "../simulation/api-contract.js";

function event(
  overrides: Partial<BattleLogEventResponse> & { sequence: number; type: string },
): BattleLogEventResponse {
  return {
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    rootSequence: overrides.parentSequence !== undefined ? 1 : overrides.sequence,
    targetUnitIds: [],
    details: {},
    stateVersionBefore: 0,
    stateVersionAfter: 0,
    ...overrides,
  } satisfies BattleLogEventResponse;
}

describe("buildCausalityTree", () => {
  it("places events without a parentSequence as independent roots (08_ドメインイベント.md rootSequence)", () => {
    const events = [
      event({ sequence: 1, type: "TURN_STARTED" }),
      event({ sequence: 2, type: "BATTLE_COMPLETED" }),
    ];

    const roots = buildCausalityTree(events);

    expect(roots).toHaveLength(2);
    expect(roots[0]?.sequence).toBe(1);
    expect(roots[1]?.sequence).toBe(2);
    expect(roots[0]?.children).toEqual([]);
  });

  it("nests a child event under its parent via parentSequence", () => {
    const events = [
      event({ sequence: 1, type: "ACTION_STARTED" }),
      event({ sequence: 2, type: "PASSIVE_ACTIVATED", parentSequence: 1 }),
    ];

    const roots = buildCausalityTree(events);

    expect(roots).toHaveLength(1);
    expect(roots[0]?.sequence).toBe(1);
    expect(roots[0]?.children).toHaveLength(1);
    expect(roots[0]?.children[0]?.sequence).toBe(2);
  });

  it("nests multi-level PS chains (PP consumed -> EX increased -> PassiveActivated)", () => {
    const events = [
      event({ sequence: 1, type: "ACTION_STARTED" }),
      event({ sequence: 2, type: "PASSIVE_POINT_CONSUMED", parentSequence: 1 }),
      event({ sequence: 3, type: "EXTRA_GAUGE_INCREASED", parentSequence: 2 }),
      event({ sequence: 4, type: "PASSIVE_ACTIVATED", parentSequence: 3 }),
    ];

    const roots = buildCausalityTree(events);

    expect(roots).toHaveLength(1);
    const level1 = roots[0]!.children;
    expect(level1[0]?.sequence).toBe(2);
    const level2 = level1[0]!.children;
    expect(level2[0]?.sequence).toBe(3);
    const level3 = level2[0]!.children;
    expect(level3[0]?.sequence).toBe(4);
  });

  it("treats an event whose parentSequence points to a missing/filtered-out event as a root instead of dropping it (詳細ログを黙って削除しない)", () => {
    const events = [event({ sequence: 5, type: "PASSIVE_RESOLVED", parentSequence: 99 })];

    const roots = buildCausalityTree(events);

    expect(roots).toHaveLength(1);
    expect(roots[0]?.sequence).toBe(5);
  });

  it("orders roots and siblings by sequence ascending regardless of input order", () => {
    const events = [
      event({ sequence: 2, type: "PASSIVE_ACTIVATED", parentSequence: 1 }),
      event({ sequence: 3, type: "PASSIVE_RESOLVED", parentSequence: 1 }),
      event({ sequence: 1, type: "ACTION_STARTED" }),
    ];

    const roots = buildCausalityTree(events);

    expect(roots.map((node) => node.sequence)).toEqual([1]);
    expect(roots[0]?.children.map((node) => node.sequence)).toEqual([2, 3]);
  });

  it("tolerates sequence gaps between a parent and its child without breaking the link (欠番を許容する)", () => {
    const events = [
      event({ sequence: 1, type: "ACTION_STARTED" }),
      event({ sequence: 12, type: "PASSIVE_ACTIVATED", parentSequence: 1 }),
    ];

    const roots = buildCausalityTree(events);

    expect(roots[0]?.children[0]?.sequence).toBe(12);
  });
});
