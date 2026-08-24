import { describe, expect, it } from "vitest";
import { summarizeEventSequence } from "./event-sequence-fingerprint.js";

/**
 * `summarizeEventSequence`の自己検証（Issue #607）。3つの golden battle snapshot
 * （unit/party/exercise）が共有するイベント要約の検出力を、`eventTypeCounts`だけでは
 * 拾えない**順序**の回帰（swap）と、`eventTypeCounts`が拾う**種別**の回帰（add/remove）
 * の両方について意図的な改変で確認する。
 */
function event(type: string): { readonly type: string } {
  return { type };
}

describe("summarizeEventSequence", () => {
  it("UT-TESTING-EVENTSEQ-001: counts events per type, sorted by type name", () => {
    const summary = summarizeEventSequence([
      event("RESOURCE_CHANGED"),
      event("DAMAGE_APPLIED"),
      event("RESOURCE_CHANGED"),
    ]);

    expect(summary.eventCount).toBe(3);
    expect(summary.eventTypeCounts).toEqual({
      DAMAGE_APPLIED: 1,
      RESOURCE_CHANGED: 2,
    });
    expect(Object.keys(summary.eventTypeCounts)).toEqual(["DAMAGE_APPLIED", "RESOURCE_CHANGED"]);
  });

  it("UT-TESTING-EVENTSEQ-002: eventSequenceHash is stable across repeated calls with the same sequence", () => {
    const events = [event("A"), event("B"), event("A")];

    expect(summarizeEventSequence(events).eventSequenceHash).toBe(
      summarizeEventSequence(events).eventSequenceHash,
    );
  });

  it("UT-TESTING-EVENTSEQ-003: swapping two events changes eventSequenceHash but not eventTypeCounts (order regression, same multiset)", () => {
    const baseline = summarizeEventSequence([event("A"), event("B"), event("C")]);
    const swapped = summarizeEventSequence([event("B"), event("A"), event("C")]);

    expect(swapped.eventTypeCounts).toEqual(baseline.eventTypeCounts);
    expect(swapped.eventCount).toBe(baseline.eventCount);
    expect(swapped.eventSequenceHash).not.toBe(baseline.eventSequenceHash);
  });

  it("UT-TESTING-EVENTSEQ-004: adding one event changes eventCount, eventTypeCounts, and eventSequenceHash", () => {
    const baseline = summarizeEventSequence([event("A"), event("B")]);
    const withExtra = summarizeEventSequence([event("A"), event("B"), event("A")]);

    expect(withExtra.eventCount).toBe(baseline.eventCount + 1);
    expect(withExtra.eventTypeCounts).not.toEqual(baseline.eventTypeCounts);
    expect(withExtra.eventSequenceHash).not.toBe(baseline.eventSequenceHash);
  });

  it("UT-TESTING-EVENTSEQ-005: removing one event changes eventCount, eventTypeCounts, and eventSequenceHash", () => {
    const baseline = summarizeEventSequence([event("A"), event("B"), event("A")]);
    const withoutOne = summarizeEventSequence([event("A"), event("B")]);

    expect(withoutOne.eventCount).toBe(baseline.eventCount - 1);
    expect(withoutOne.eventTypeCounts).not.toEqual(baseline.eventTypeCounts);
    expect(withoutOne.eventSequenceHash).not.toBe(baseline.eventSequenceHash);
  });

  it("UT-TESTING-EVENTSEQ-006: an empty sequence yields eventCount 0, an empty eventTypeCounts, and a stable hash", () => {
    const summary = summarizeEventSequence([]);

    expect(summary.eventCount).toBe(0);
    expect(summary.eventTypeCounts).toEqual({});
    expect(summary.eventSequenceHash).toBe(summarizeEventSequence([]).eventSequenceHash);
  });
});
