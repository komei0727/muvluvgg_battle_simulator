import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBattleUnit, type BattleUnit } from "../domain/battle/model/battle-unit.js";
import { buildInitialMarkerState } from "../domain/battle/model/marker-state.js";
import type { BattlePartyMember } from "../domain/battle/model/battle-party.js";
import { toGlobalCoordinate } from "../domain/battle/model/global-coordinate.js";
import type { FormationPosition } from "../domain/battle/model/formation-input.js";
import { createBattleUnitId } from "../domain/shared/ids.js";
import { createMarkerInstanceId } from "../domain/shared/event-ids.js";
import type { Side } from "../domain/shared/side.js";
import { resolveBindingSelections } from "../domain/battle/lifecycle/action-skill-use-resolver.js";
import { loadCatalogFromDirectory } from "../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * Issue #169 (TGT-002): `CAP_TARGET_FILTER_ORDER` — `TargetSelectorDefinition`
 * `filters`（AND/OR/NOT・POSITION_*・HAS_MARKER・EXCLUDE_RESOLVED_UNIT・
 * MARKER_IN_AREA）と、DEFAULTを超える`order`（NEAREST/LEFT_TO_RIGHT/
 * 統計値の極値・MARKER_COUNT・UNIT_TYPE_PRIORITY・SELF_LOWEST_PRIORITY）を
 * 実装する。REAL, unmodified production Catalog skillsを
 * `resolveBindingSelections`（`resolveSkillUse`と同じ関数）へ通し、
 * `assertNoFilters`/未対応orderキー拒否が撤廃された後の挙動を検証する。
 * `SKL_LYDIA_GENIUS_EX`/`SKL_CLARA_SANTA_AS2`は非空`filters`を伴う`fallback`
 * も同時に持つため、`CAP_TARGET_BINDING_FALLBACK`（TGT-003）を無改変Catalogで
 * 経由する初めてのproduction統合テストも兼ねる。
 */

function catalogPath(): string {
  return fileURLToPath(new URL("../../catalog", import.meta.url));
}

function unitAt(
  battleUnitId: string,
  unitDefinitionId: string,
  side: Side,
  position: FormationPosition,
  overrides: Partial<BattleUnit> = {},
): BattleUnit {
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(battleUnitId),
    unitDefinitionId: unitDefinitionId as never,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 100,
      defense: 50,
      criticalRate: 0.1,
      actionSpeed: 100,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
  return {
    ...createBattleUnit(member, side, { maximumAp: 4, maximumPp: 4, maximumExtraGauge: 10 }),
    ...overrides,
  };
}

describe("production Catalog CAP_TARGET_FILTER_ORDER (Issue #169/TGT-002)", () => {
  it("IT-CAP-TARGET-FILTER-ORDER-PROD-001: SKL_LYDIA_GENIUS_EX's real OR/POSITION_COLUMN filter with NEAREST/FRONT_ROW/LEFT_TO_RIGHT fallback order and POSITION_ROW filter", () => {
    const catalog = loadCatalogFromDirectory(catalogPath());
    const snapshot = catalog.loadSnapshot(["UNIT_LYDIA_GENIUS"] as never[], []);
    const skill = snapshot.skills.get("SKL_LYDIA_GENIUS_EX" as never);
    expect(skill).toBeDefined();
    expect(skill!.requiredCapabilities).toContain("CAP_TARGET_FILTER_ORDER");
    expect(skill!.requiredCapabilities).toContain("CAP_TARGET_BINDING_FALLBACK");
    const targetBindings =
      skill!.resolution.kind === "IMMEDIATE" ? skill!.resolution.targetBindings : [];
    expect(targetBindings.map((b) => b.targetBindingId)).toEqual(["TGT_COLUMNS", "TGT_BACK_ROW"]);

    const actor = unitAt("ACTOR", "UNIT_LYDIA_GENIUS", "ALLY", { column: "CENTER", row: "FRONT" });
    const left = unitAt("LEFT", "UNIT_LYDIA_GENIUS", "ENEMY", { column: "LEFT", row: "FRONT" });
    const right = unitAt("RIGHT", "UNIT_LYDIA_GENIUS", "ENEMY", { column: "RIGHT", row: "BACK" });
    const center = unitAt("CENTER", "UNIT_LYDIA_GENIUS", "ENEMY", {
      column: "CENTER",
      row: "FRONT",
    });

    const selections = resolveBindingSelections(targetBindings, actor, [
      actor,
      left,
      right,
      center,
    ]);

    // TGT_COLUMNS: OR(POSITION_COLUMN LEFT, POSITION_COLUMN RIGHT) matches LEFT/RIGHT, not CENTER.
    const columns = selections.find((s) => s.targetBindingId === "TGT_COLUMNS");
    expect(columns?.selectedTargetUnitIds.map(String).sort()).toEqual(
      [createBattleUnitId("LEFT"), createBattleUnitId("RIGHT")].map(String).sort(),
    );

    // TGT_BACK_ROW: POSITION_ROW BACK matches only RIGHT.
    const backRow = selections.find((s) => s.targetBindingId === "TGT_BACK_ROW");
    expect(backRow?.selectedTargetUnitIds).toEqual([createBattleUnitId("RIGHT")]);
  });

  it("IT-CAP-TARGET-FILTER-ORDER-PROD-002: SKL_LYDIA_GENIUS_EX's TGT_COLUMNS falls back to NEAREST/FRONT_ROW/LEFT_TO_RIGHT when no column candidate exists", () => {
    const catalog = loadCatalogFromDirectory(catalogPath());
    const snapshot = catalog.loadSnapshot(["UNIT_LYDIA_GENIUS"] as never[], []);
    const skill = snapshot.skills.get("SKL_LYDIA_GENIUS_EX" as never);
    const targetBindings =
      skill!.resolution.kind === "IMMEDIATE" ? skill!.resolution.targetBindings : [];

    const actor = unitAt("ACTOR", "UNIT_LYDIA_GENIUS", "ALLY", { column: "CENTER", row: "FRONT" });
    const onlyCenter = unitAt("ONLY_CENTER", "UNIT_LYDIA_GENIUS", "ENEMY", {
      column: "CENTER",
      row: "FRONT",
    });

    const selections = resolveBindingSelections(targetBindings, actor, [actor, onlyCenter]);

    const columns = selections.find((s) => s.targetBindingId === "TGT_COLUMNS");
    expect(columns?.selectedTargetUnitIds).toEqual([createBattleUnitId("ONLY_CENTER")]);
  });

  it("IT-CAP-TARGET-FILTER-ORDER-PROD-003: SKL_CLARA_SANTA_AS2's real MARKER_IN_AREA filter targets a column containing the tagged unit, not necessarily the tagged unit itself", () => {
    const catalog = loadCatalogFromDirectory(catalogPath());
    const snapshot = catalog.loadSnapshot(["UNIT_CLARA_SANTA"] as never[], []);
    const skill = snapshot.skills.get("SKL_CLARA_SANTA_AS2" as never);
    expect(skill).toBeDefined();
    expect(skill!.requiredCapabilities).toContain("CAP_TARGET_FILTER_ORDER");
    const targetBindings =
      skill!.resolution.kind === "IMMEDIATE" ? skill!.resolution.targetBindings : [];
    expect(targetBindings.map((b) => b.targetBindingId)).toEqual(["TGT_BASE", "TGT_COLUMN"]);

    const actor = unitAt("ACTOR", "UNIT_CLARA_SANTA", "ALLY", { column: "CENTER", row: "FRONT" });
    const markerId = "MARKER_CLARA_SANTA_TAG" as never;
    const taggedBack = unitAt(
      "TAGGED_BACK",
      "UNIT_CLARA_SANTA",
      "ENEMY",
      { column: "LEFT", row: "BACK" },
      {
        markerStates: [
          buildInitialMarkerState(
            createMarkerInstanceId("mi-tag"),
            markerId,
            createBattleUnitId("ACTOR"),
            createBattleUnitId("TAGGED_BACK"),
            null,
            {
              dispellable: true,
              linkedEffectGroupId: null,
              timeLimit: { unit: "BATTLE", count: 1 },
            },
            { turnNumber: 1 },
          ),
        ],
      },
    );
    const untaggedFront = unitAt("UNTAGGED_FRONT", "UNIT_CLARA_SANTA", "ENEMY", {
      column: "LEFT",
      row: "FRONT",
    });
    const otherColumn = unitAt("OTHER_COLUMN", "UNIT_CLARA_SANTA", "ENEMY", {
      column: "RIGHT",
      row: "FRONT",
    });

    const selections = resolveBindingSelections(targetBindings, actor, [
      actor,
      taggedBack,
      untaggedFront,
      otherColumn,
    ]);

    // TGT_BASE resolves to the untagged front-row enemy in the same column as the
    // tagged back-row enemy (MARKER_IN_AREA: candidate's own column contains the marker).
    const base = selections.find((s) => s.targetBindingId === "TGT_BASE");
    expect(base?.selectedTargetUnitIds).toEqual([createBattleUnitId("UNTAGGED_FRONT")]);

    // TGT_COLUMN (SAME_COLUMN_AS_BASE, includeBase) then AOEs the whole LEFT column.
    const column = selections.find((s) => s.targetBindingId === "TGT_COLUMN");
    expect(column?.selectedTargetUnitIds.map(String).sort()).toEqual(
      [createBattleUnitId("UNTAGGED_FRONT"), createBattleUnitId("TAGGED_BACK")].map(String).sort(),
    );
  });

  it("IT-CAP-TARGET-FILTER-ORDER-PROD-004: SKL_DOROTHEA_PIONEER_AS1's real MARKER_COUNT ASC order prioritizes the enemy with the fewest markers", () => {
    const catalog = loadCatalogFromDirectory(catalogPath());
    const snapshot = catalog.loadSnapshot(["UNIT_DOROTHEA_PIONEER"] as never[], []);
    const skill = snapshot.skills.get("SKL_DOROTHEA_PIONEER_AS1" as never);
    expect(skill).toBeDefined();
    expect(skill!.requiredCapabilities).toContain("CAP_TARGET_FILTER_ORDER");
    const targetBindings =
      skill!.resolution.kind === "IMMEDIATE" ? skill!.resolution.targetBindings : [];

    const actor = unitAt("ACTOR", "UNIT_DOROTHEA_PIONEER", "ALLY", {
      column: "CENTER",
      row: "FRONT",
    });
    const markerId = "MARKER_DOROTHEA_PIONEER_GRACE" as never;
    const graced = unitAt(
      "GRACED",
      "UNIT_DOROTHEA_PIONEER",
      "ENEMY",
      { column: "LEFT", row: "FRONT" },
      {
        markerStates: [
          {
            ...buildInitialMarkerState(
              createMarkerInstanceId("mi-grace"),
              markerId,
              createBattleUnitId("ACTOR"),
              createBattleUnitId("GRACED"),
              null,
              {
                dispellable: true,
                linkedEffectGroupId: null,
                timeLimit: { unit: "BATTLE", count: 1 },
              },
              { turnNumber: 1 },
            ),
            stackCount: 3,
          },
        ],
      },
    );
    const bare = unitAt("BARE", "UNIT_DOROTHEA_PIONEER", "ENEMY", {
      column: "RIGHT",
      row: "FRONT",
    });

    const selections = resolveBindingSelections(targetBindings, actor, [actor, graced, bare]);

    const base = selections.find((s) => s.targetBindingId === "TGT_BASE");
    expect(base?.selectedTargetUnitIds).toEqual([createBattleUnitId("BARE")]);
  });

  it("IT-CAP-TARGET-FILTER-ORDER-PROD-005: SKL_MIHIME_SNIPER_AS1's real EXCLUDE_RESOLVED_UNIT filter picks a second, different enemy for TGT_OTHER", () => {
    const catalog = loadCatalogFromDirectory(catalogPath());
    const snapshot = catalog.loadSnapshot(["UNIT_MIHIME_SNIPER"] as never[], []);
    const skill = snapshot.skills.get("SKL_MIHIME_SNIPER_AS1" as never);
    expect(skill).toBeDefined();
    expect(skill!.requiredCapabilities).toContain("CAP_TARGET_FILTER_ORDER");
    const targetBindings =
      skill!.resolution.kind === "IMMEDIATE" ? skill!.resolution.targetBindings : [];
    expect(targetBindings.map((b) => b.targetBindingId)).toEqual(["TGT_LOWEST", "TGT_OTHER"]);

    const actor = unitAt("ACTOR", "UNIT_MIHIME_SNIPER", "ALLY", { column: "CENTER", row: "FRONT" });
    const lowest = unitAt(
      "LOWEST",
      "UNIT_MIHIME_SNIPER",
      "ENEMY",
      { column: "LEFT", row: "FRONT" },
      { currentHp: 10 },
    );
    const second = unitAt(
      "SECOND",
      "UNIT_MIHIME_SNIPER",
      "ENEMY",
      { column: "RIGHT", row: "FRONT" },
      { currentHp: 50 },
    );

    const selections = resolveBindingSelections(targetBindings, actor, [actor, lowest, second]);

    const first = selections.find((s) => s.targetBindingId === "TGT_LOWEST");
    const other = selections.find((s) => s.targetBindingId === "TGT_OTHER");
    expect(first?.selectedTargetUnitIds).toEqual([createBattleUnitId("LOWEST")]);
    // TGT_OTHER excludes TGT_LOWEST's resolved unit, so it picks SECOND rather than
    // re-resolving to LOWEST again despite LOWEST_HP_RATIO still ranking it first.
    expect(other?.selectedTargetUnitIds).toEqual([createBattleUnitId("SECOND")]);
  });

  it("IT-CAP-TARGET-FILTER-ORDER-PROD-006: SKL_SHIRANA_SORA_AS1's real UNIT_TYPE_PRIORITY+SELF_LOWEST_PRIORITY order prefers the ENERGY-type ally over self", () => {
    const catalog = loadCatalogFromDirectory(catalogPath());
    const snapshot = catalog.loadSnapshot(
      ["UNIT_SHIRANA_SORA", "UNIT_DOROTHEA_PIONEER"] as never[],
      [],
    );
    const skill = snapshot.skills.get("SKL_SHIRANA_SORA_AS1" as never);
    expect(skill).toBeDefined();
    expect(skill!.requiredCapabilities).toContain("CAP_TARGET_FILTER_ORDER");
    const targetBindings =
      skill!.resolution.kind === "IMMEDIATE" ? skill!.resolution.targetBindings : [];

    const actor = unitAt("ACTOR", "UNIT_SHIRANA_SORA", "ALLY", { column: "CENTER", row: "FRONT" });
    const enAlly = unitAt("EN_ALLY", "UNIT_DOROTHEA_PIONEER", "ALLY", {
      column: "LEFT",
      row: "FRONT",
    });
    expect(snapshot.units.get("UNIT_DOROTHEA_PIONEER" as never)?.unitType).toBe("ENERGY");

    const selections = resolveBindingSelections(
      targetBindings,
      actor,
      [actor, enAlly],
      snapshot.units,
    );

    const ally = selections.find((s) => s.targetBindingId === "TGT_ALLY");
    expect(ally?.selectedTargetUnitIds).toEqual([createBattleUnitId("EN_ALLY")]);
  });
});
