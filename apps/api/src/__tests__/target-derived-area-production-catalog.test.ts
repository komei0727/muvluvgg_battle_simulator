import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBattleUnit, type BattleUnit } from "../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../domain/battle/model/battle-party.js";
import { toGlobalCoordinate } from "../domain/battle/model/global-coordinate.js";
import type { FormationPosition } from "../domain/battle/model/formation-input.js";
import { createBattleUnitId } from "../domain/shared/ids.js";
import type { Side } from "../domain/shared/side.js";
import { resolveBindingSelections } from "../domain/battle/lifecycle/action-skill-use-resolver.js";
import { loadCatalogFromDirectory } from "../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * Issue #170 (TGT-001): `CAP_TARGET_DERIVED_AREA` covers area/距離/隣接/列に
 * よる派生対象（R-TGT-03〜06, R-TGT-09）. This exercises the REAL, unmodified
 * `SKL_LUCIE_MAID_AS2` (`TGT_MAIN`: SELECT ENEMY count 1 DEFAULT, `TGT_ADJ`:
 * BINDING_DERIVED base=BINDING(TGT_MAIN) area=ADJACENT_ORTHOGONAL) through
 * `resolveBindingSelections`, the same function `resolveSkillUse` calls to
 * build the `TargetsSelected` event payload, proving the resolvedBindings
 * threading (R-TGT-09/10: `base: BINDING` referencing an earlier binding in
 * the same EffectSequence) works against production Catalog data end to end.
 */

function catalogPath(): string {
  return fileURLToPath(new URL("../../catalog", import.meta.url));
}

function unitAt(battleUnitId: string, side: Side, position: FormationPosition): BattleUnit {
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(battleUnitId),
    unitDefinitionId: "UNIT_LUCIE_MAID" as never,
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
  return createBattleUnit(member, side, { maximumAp: 4, maximumPp: 4, maximumExtraGauge: 10 });
}

describe("production Catalog CAP_TARGET_DERIVED_AREA (Issue #170/TGT-001)", () => {
  it("IT-CAP-TARGET-DERIVED-AREA-PROD-001: SKL_LUCIE_MAID_AS2's real BINDING_DERIVED+ADJACENT_ORTHOGONAL binding resolves the enemy adjacent to TGT_MAIN", () => {
    const catalog = loadCatalogFromDirectory(catalogPath());
    const snapshot = catalog.loadSnapshot(["UNIT_LUCIE_MAID"] as never[], []);
    const skill = snapshot.skills.get("SKL_LUCIE_MAID_AS2" as never);
    expect(skill).toBeDefined();
    expect(skill!.requiredCapabilities).toContain("CAP_TARGET_DERIVED_AREA");
    expect(skill!.resolution.kind).toBe("IMMEDIATE");
    const targetBindings =
      skill!.resolution.kind === "IMMEDIATE" ? skill!.resolution.targetBindings : [];
    expect(targetBindings.map((b) => b.targetBindingId)).toEqual(["TGT_MAIN", "TGT_ADJ"]);

    const actor = unitAt("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
    const mainTarget = unitAt("MAIN", "ENEMY", { column: "CENTER", row: "FRONT" });
    const adjacentTarget = unitAt("ADJ", "ENEMY", { column: "LEFT", row: "FRONT" });
    const farAway = unitAt("FAR", "ENEMY", { column: "RIGHT", row: "BACK" });

    const selections = resolveBindingSelections(targetBindings, actor, [
      actor,
      mainTarget,
      adjacentTarget,
      farAway,
    ]);

    const mainSelection = selections.find((s) => s.targetBindingId === "TGT_MAIN");
    const adjSelection = selections.find((s) => s.targetBindingId === "TGT_ADJ");
    expect(mainSelection?.selectedTargetUnitIds).toEqual([createBattleUnitId("MAIN")]);
    expect(adjSelection?.selectedTargetUnitIds).toEqual([createBattleUnitId("ADJ")]);
  });
});
