import { describe, expect, it } from "vitest";
import {
  buildRosterIndex,
  mergeDisjointFormatters,
  resolveDisplayName,
} from "./event-presentation.js";
import type { EventFormatter, EventPresentation } from "./event-presentation.js";
import type { RosterEntry } from "../../entities/roster.js";

function formatterStub(summary: string): EventFormatter {
  return (event): EventPresentation => ({
    title: event.type,
    summary,
    details: event["details"],
    severity: "neutral",
  });
}

function rosterEntry(battleUnitId: string, displayName: string): RosterEntry {
  return {
    battleUnitId,
    displayName,
    side: "ALLY",
    unitDefinitionId: "UNIT_X",
    position: { row: "FRONT", column: 0 },
  } as RosterEntry;
}

describe("buildRosterIndex / resolveDisplayName", () => {
  it("resolves a display name by battleUnitId and falls back to the id itself", () => {
    const roster = buildRosterIndex([rosterEntry("ally-1", "アルファ")]);

    expect(resolveDisplayName(roster, "ally-1")).toBe("アルファ");
    expect(resolveDisplayName(roster, "unknown-1")).toBe("unknown-1");
  });
});

describe("mergeDisjointFormatters", () => {
  it("merges registries that do not share an event type", () => {
    const merged = mergeDisjointFormatters({
      flow: { BATTLE_STARTED: formatterStub("flow") },
      damage: { DAMAGE_APPLIED: formatterStub("damage") },
    });

    expect(Object.keys(merged).sort()).toEqual(["BATTLE_STARTED", "DAMAGE_APPLIED"]);
  });

  // 後勝ちで黙って上書きされると、片方のカテゴリのformatterが無言で死ぬ。
  // 名前を挙げて失敗させ、どのtypeがどのカテゴリ間で衝突したかを分かるようにする。
  it("throws naming the duplicated type and both categories when two registries collide", () => {
    expect(() =>
      mergeDisjointFormatters({
        flow: { BATTLE_STARTED: formatterStub("flow") },
        damage: { BATTLE_STARTED: formatterStub("damage") },
      }),
    ).toThrow(/BATTLE_STARTED/);

    expect(() =>
      mergeDisjointFormatters({
        flow: { BATTLE_STARTED: formatterStub("flow") },
        damage: { BATTLE_STARTED: formatterStub("damage") },
      }),
    ).toThrow(/flow.*damage|damage.*flow/);
  });

  it("reports every duplicated type rather than only the first", () => {
    expect(() =>
      mergeDisjointFormatters({
        flow: { BATTLE_STARTED: formatterStub("a"), TURN_STARTED: formatterStub("a") },
        skill: { BATTLE_STARTED: formatterStub("b"), TURN_STARTED: formatterStub("b") },
      }),
    ).toThrow(/BATTLE_STARTED[\s\S]*TURN_STARTED|TURN_STARTED[\s\S]*BATTLE_STARTED/);
  });
});
