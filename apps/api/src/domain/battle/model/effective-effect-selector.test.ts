import { describe, expect, it } from "vitest";
import {
  selectEffectiveInstances,
  selectNonStackableWinners,
  type EffectiveEffectCandidate,
} from "./effective-effect-selector.js";
import type { EffectInstanceId } from "../../shared/event-ids.js";
import type { EffectKindKey } from "./applied-effect.js";

function instanceId(id: string): EffectInstanceId {
  return id as EffectInstanceId;
}

function kindKey(key: string): EffectKindKey {
  return key as EffectKindKey;
}

function candidate(
  id: string,
  kind: string,
  duplicate: boolean,
  magnitude: number,
): EffectiveEffectCandidate {
  return {
    effectInstanceId: instanceId(id),
    kindKey: kindKey(kind),
    duplicate,
    magnitude,
  };
}

describe("selectEffectiveInstances — R-EFF-05 重複効果の期間・R-STA-03 重複なし効果", () => {
  it("UT-R-EFF-05-001: every duplicate-allowed instance is always effective", () => {
    const result = selectEffectiveInstances([
      candidate("E1", "K1", true, 0.1),
      candidate("E2", "K1", true, 0.05),
      candidate("E3", "K1", true, -0.2),
    ]);
    expect(result).toEqual(new Set([instanceId("E1"), instanceId("E2"), instanceId("E3")]));
  });

  it("UT-R-EFF-05-002: only the strongest (largest absolute magnitude) instance in a non-stackable group is effective", () => {
    const result = selectEffectiveInstances([
      candidate("E1", "K1", false, 0.1),
      candidate("E2", "K1", false, 0.3),
      candidate("E3", "K1", false, -0.2),
    ]);
    expect(result).toEqual(new Set([instanceId("E2")]));
  });

  it("UT-R-EFF-05-003: on a magnitude tie, the earliest-granted (first in array order) instance is effective", () => {
    const result = selectEffectiveInstances([
      candidate("E1", "K1", false, 0.3),
      candidate("E2", "K1", false, -0.3),
      candidate("E3", "K1", false, 0.3),
    ]);
    expect(result).toEqual(new Set([instanceId("E1")]));
  });

  it("UT-R-EFF-05-004: distinct EffectKindKey groups are resolved independently", () => {
    const result = selectEffectiveInstances([
      candidate("E1", "HASTE", false, 0.1),
      candidate("E2", "HASTE", false, 0.3),
      candidate("E3", "SLOW", false, -0.2),
      candidate("E4", "SLOW", false, -0.05),
    ]);
    expect(result).toEqual(new Set([instanceId("E2"), instanceId("E3")]));
  });

  it("UT-R-EFF-05-005: an empty candidate list yields an empty effective set", () => {
    expect(selectEffectiveInstances([])).toEqual(new Set());
  });

  it("UT-R-EFF-05-006: removing the current strongest instance from the candidate list promotes the next-strongest surviving instance (次点繰上げ)", () => {
    const withStrongest = selectEffectiveInstances([
      candidate("E1", "K1", false, 0.1),
      candidate("E2", "K1", false, 0.3),
    ]);
    expect(withStrongest).toEqual(new Set([instanceId("E2")]));

    // E2 (the previous strongest) expires/is removed and is no longer part of
    // the candidate list; recomputing from the remaining instances promotes E1.
    const afterExpiry = selectEffectiveInstances([candidate("E1", "K1", false, 0.1)]);
    expect(afterExpiry).toEqual(new Set([instanceId("E1")]));
  });

  it("UT-R-EFF-05-007: duplicate-allowed and non-stackable groups are independent — a stackable instance never displaces a non-stackable winner", () => {
    const result = selectEffectiveInstances([
      candidate("E1", "K1", false, 0.1),
      candidate("E2", "K1", false, 0.3),
      candidate("E3", "K2", true, 0.05),
    ]);
    expect(result).toEqual(new Set([instanceId("E2"), instanceId("E3")]));
  });
});

describe("selectNonStackableWinners — kindKeyごとの採用中インスタンスID", () => {
  it("UT-R-EFF-05-008: maps each non-stackable EffectKindKey group to its winning instance id", () => {
    const result = selectNonStackableWinners([
      candidate("E1", "HASTE", false, 0.1),
      candidate("E2", "HASTE", false, 0.3),
      candidate("E3", "SLOW", false, -0.2),
    ]);
    expect(result).toEqual(
      new Map([
        [kindKey("HASTE"), instanceId("E2")],
        [kindKey("SLOW"), instanceId("E3")],
      ]),
    );
  });

  it("UT-R-EFF-05-009: excludes duplicate-allowed instances entirely (they have no single winner)", () => {
    const result = selectNonStackableWinners([candidate("E1", "K1", true, 0.1)]);
    expect(result).toEqual(new Map());
  });
});
