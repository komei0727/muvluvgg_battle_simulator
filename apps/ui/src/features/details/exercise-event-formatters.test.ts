import { describe, expect, it } from "vitest";
import { buildRosterIndex, formatEvent } from "./event-formatters.js";
import type { RosterIndex } from "./event-presentation.js";

const roster: RosterIndex = buildRosterIndex([
  {
    battleUnitId: "enemy-1",
    unitDefinitionId: "UNIT_ENEMY",
    displayName: "エネミー",
    side: "ENEMY",
  },
  {
    battleUnitId: "ally-1",
    unitDefinitionId: "UNIT_ALLY",
    displayName: "アライ",
    side: "ALLY",
  },
]);

// UI-AC-022 / UI-API-016: 演習イベント（スコア加算・ブレイク・復活）を詳細表示へ
// 残し、detailsが想定外でも汎用表示へ落ちてクラッシュしない。
describe("exercise event formatters", () => {
  it("summarizes EXERCISE_SCORE_ACCUMULATED with the added amount and the running total", () => {
    const presentation = formatEvent(
      {
        type: "EXERCISE_SCORE_ACCUMULATED",
        details: {
          targetUnitId: "enemy-1",
          amount: 1200,
          totalScore: 3600,
          causeEventId: "evt-1",
        },
      },
      roster,
    );

    expect(presentation.title).toBe("EXERCISE_SCORE_ACCUMULATED");
    expect(presentation.summary).toContain("エネミー");
    expect(presentation.summary).toContain("1,200");
    expect(presentation.summary).toContain("3,600");
    expect(presentation.severity).toBe("positive");
  });

  it("summarizes EXERCISE_SCORE_DEDUCTED with the deducted amount and the remaining total", () => {
    const presentation = formatEvent(
      {
        type: "EXERCISE_SCORE_DEDUCTED",
        details: {
          targetUnitId: "enemy-1",
          amount: 800,
          totalScore: 2800,
          causeEventId: "evt-3",
        },
      },
      roster,
    );

    expect(presentation.title).toBe("EXERCISE_SCORE_DEDUCTED");
    expect(presentation.summary).toContain("エネミー");
    expect(presentation.summary).toContain("800");
    expect(presentation.summary).toContain("2,800");
    // 敵に有利な事象であり、`UNIT_REVIVED`と同じ扱いにする。
    expect(presentation.severity).toBe("negative");
  });

  it("summarizes UNIT_BROKEN with the break number and the turn it happened on", () => {
    const presentation = formatEvent(
      {
        type: "UNIT_BROKEN",
        details: {
          unitId: "enemy-1",
          breakNumber: 2,
          turnNumber: 4,
          totalScore: 3600,
          causeEventId: "evt-2",
        },
      },
      roster,
    );

    expect(presentation.summary).toContain("エネミー");
    expect(presentation.summary).toContain("2");
    expect(presentation.summary).toContain("4");
    expect(presentation.severity).toBe("positive");
  });

  it("summarizes UNIT_REVIVED with the restored hit points", () => {
    const presentation = formatEvent(
      {
        type: "UNIT_REVIVED",
        details: {
          unitId: "enemy-1",
          breakNumber: 2,
          hpAfter: 25000,
          baseCombatStats: { maximumHp: 25000, attack: 100, defense: 50 },
        },
      },
      roster,
    );

    expect(presentation.summary).toContain("エネミー");
    expect(presentation.summary).toContain("25,000");
    expect(presentation.severity).toBe("negative");
  });

  it("falls back to the generic presentation when an exercise event's details are unexpected", () => {
    const presentation = formatEvent(
      { type: "UNIT_BROKEN", details: { unitId: 7 }, sourceUnitId: "ally-1" },
      roster,
    );

    expect(presentation.title).toBe("UNIT_BROKEN");
    expect(presentation.severity).toBe("neutral");
    expect(presentation.summary).toContain("アライ");
  });

  it("keeps a completely unknown exercise event on the generic path", () => {
    const presentation = formatEvent({ type: "EXERCISE_FUTURE_EVENT" }, roster);

    expect(presentation.title).toBe("EXERCISE_FUTURE_EVENT");
    expect(presentation.severity).toBe("neutral");
  });
});
