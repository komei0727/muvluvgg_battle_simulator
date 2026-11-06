import { describe, expect, it } from "vitest";
import {
  TOTAL_WAR_DRAFT_STORAGE_KEY,
  parseStoredTotalWarDraft,
  toStoredTotalWarDraft,
} from "./total-war-persistence.js";
import { createInitialTotalWarDraft } from "./total-war-draft.js";
import type { TotalWarDraft } from "./total-war-draft.js";
import { createInitialTotalWarState, totalWarReducer } from "./total-war-reducer.js";
import type { TotalWarAction } from "./total-war-reducer.js";
import {
  EXERCISE_DRAFT_STORAGE_KEY,
  LAST_DRAFT_STORAGE_KEY,
  PERSISTENCE_SCHEMA_VERSION,
} from "../formation/persistence.js";
import { DEFAULT_UNIT_RANK, slotKeyOf } from "../formation/types.js";

/** localStorageはJSONを経由するため、`undefined`の枠は`null`になって戻る。 */
function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function editedDraft(): TotalWarDraft {
  const actions: readonly TotalWarAction[] = [
    { type: "unitSelected", slotKey: slotKeyOf("ally", "FRONT", 0), unitDefinitionId: "UNIT_A" },
    { type: "formationAdded", side: "ally" },
    { type: "unitSelected", slotKey: slotKeyOf("ally", "REAR", 2), unitDefinitionId: "UNIT_B" },
    { type: "memorySelected", side: "ally", index: 3, memoryDefinitionId: "MEM_B" },
    { type: "formationAdded", side: "enemy" },
    { type: "formationAdded", side: "enemy" },
    { type: "enhancementToggled", side: "enemy", enabled: true },
    { type: "unitSelected", slotKey: slotKeyOf("enemy", "FRONT", 1), unitDefinitionId: "UNIT_E" },
    { type: "unitEnhancementLevelChanged", slotKey: slotKeyOf("enemy", "FRONT", 1), value: 120 },
    { type: "logLevelChanged", value: "DETAILED" },
  ];
  return actions.reduce(totalWarReducer, createInitialTotalWarState()).draft;
}

describe("total war persistence (UI-UT-TWR-012)", () => {
  it("uses its own storage key distinct from the other modes", () => {
    expect(TOTAL_WAR_DRAFT_STORAGE_KEY).toBe("mlgg:last-draft:total-war");
    expect(TOTAL_WAR_DRAFT_STORAGE_KEY).not.toBe(LAST_DRAFT_STORAGE_KEY);
    expect(TOTAL_WAR_DRAFT_STORAGE_KEY).not.toBe(EXERCISE_DRAFT_STORAGE_KEY);
  });

  it("round-trips the three formations, formation counts and log level", () => {
    const draft = editedDraft();
    const stored = roundTrip(toStoredTotalWarDraft(draft, "rev-1"));
    expect(parseStoredTotalWarDraft(stored)).toEqual(draft);
  });

  it("does not store the active formation", () => {
    const stored = roundTrip(toStoredTotalWarDraft(editedDraft())) as Record<string, unknown>;
    expect(Object.keys(stored).toSorted()).toEqual(
      ["formationCounts", "formations", "logLevel", "schemaVersion"].toSorted(),
    );
  });

  it("discards stored data whose formations are not exactly three", () => {
    const stored = roundTrip(toStoredTotalWarDraft(createInitialTotalWarDraft())) as {
      formations: unknown[];
    };
    expect(
      parseStoredTotalWarDraft({ ...stored, formations: stored.formations.slice(0, 2) }),
    ).toBeUndefined();
    expect(parseStoredTotalWarDraft({ ...stored, formations: "x" })).toBeUndefined();
  });

  it.each([0, 4, 1.5, "2", undefined])("discards formation count %s", (count) => {
    const stored = roundTrip(toStoredTotalWarDraft(createInitialTotalWarDraft())) as Record<
      string,
      unknown
    >;
    expect(
      parseStoredTotalWarDraft({ ...stored, formationCounts: { ally: count, enemy: 1 } }),
    ).toBeUndefined();
    expect(parseStoredTotalWarDraft({ ...stored, formationCounts: undefined })).toBeUndefined();
  });

  it("discards the whole draft when one formation is broken", () => {
    const stored = roundTrip(toStoredTotalWarDraft(createInitialTotalWarDraft())) as {
      formations: Record<string, unknown>[];
    };
    const broken = [
      stored.formations[0],
      { ...stored.formations[1], allySlots: [] },
      stored.formations[2],
    ];
    expect(parseStoredTotalWarDraft({ ...stored, formations: broken })).toBeUndefined();
  });

  it("discards other schema versions, unknown log levels and non-records", () => {
    const stored = roundTrip(toStoredTotalWarDraft(createInitialTotalWarDraft())) as Record<
      string,
      unknown
    >;
    expect(
      parseStoredTotalWarDraft({ ...stored, schemaVersion: PERSISTENCE_SCHEMA_VERSION + 1 }),
    ).toBeUndefined();
    expect(parseStoredTotalWarDraft({ ...stored, logLevel: "VERBOSE" })).toBeUndefined();
    expect(parseStoredTotalWarDraft(null)).toBeUndefined();
  });

  it("reads formations lacking levelLink, linkExcluded and rank with defaults", () => {
    const draft = editedDraft();
    const stored = roundTrip(toStoredTotalWarDraft(draft)) as {
      formations: {
        enemyEnhancement: Record<string, unknown>;
        enemySlots: { enhancement?: Record<string, unknown> }[];
      }[];
    };
    for (const formation of stored.formations) {
      delete formation.enemyEnhancement["levelLink"];
      for (const slot of formation.enemySlots) {
        if (slot.enhancement !== undefined) {
          delete slot.enhancement["linkExcluded"];
          delete slot.enhancement["rank"];
        }
      }
    }

    const parsed = parseStoredTotalWarDraft(stored);
    const slot = parsed?.formations[2].enemySlots.find(
      (candidate) => candidate.slotKey === slotKeyOf("enemy", "FRONT", 1),
    );
    expect(parsed?.formations[0].enemyEnhancement.levelLink).toEqual({
      enabled: false,
      level: 200,
    });
    expect(slot?.enhancement?.linkExcluded).toBe(false);
    expect(slot?.enhancement?.rank).toBe(DEFAULT_UNIT_RANK);
    expect(slot?.enhancement?.level).toBe(120);
  });
});
