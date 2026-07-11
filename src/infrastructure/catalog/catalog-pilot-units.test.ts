import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCatalogFromDirectory } from "./catalog-file-loader.js";

/**
 * Issue #41: v2 Catalog conversion pilot for 10 representative units
 * (`docs/ddd/18_ユニットv2Catalog変換検討.md`). This fixture set is an
 * authoring draft, not production data — it exercises the full
 * Read→Hash→Shape→Resolve→Semantic load pipeline (`catalog-file-loader.ts`)
 * against real raw/units/ conversions to surface schema/Mapper gaps early.
 */

function fixturePath(...segments: string[]): string {
  return fileURLToPath(new URL(`./__fixtures__/${segments.join("/")}`, import.meta.url));
}

describe("Catalog v2 pilot: 10-unit conversion (Issue #41)", () => {
  it("IT-CAT-PILOT-001: loads all 10 pilot units without an integrity violation", () => {
    const catalog = loadCatalogFromDirectory(fixturePath("pilot-units"));
    expect(catalog.catalogRevision).toBe("pilot-units.1");
  });

  it("IT-CAT-PILOT-002: every unit's EX skill cost.amount matches extraGaugeMaximum (checked by the loader, asserted here per-unit for traceability)", () => {
    const catalog = loadCatalogFromDirectory(fixturePath("pilot-units"));
    const unitIds = [
      "UNIT_EVIE",
      "UNIT_LYDIA",
      "UNIT_LAURA",
      "UNIT_STELLA",
      "UNIT_KARINA",
      "UNIT_HARRIET",
      "UNIT_KOTOHA",
      "UNIT_MIKOTO",
      "UNIT_KATE",
      "UNIT_FLUTE",
    ];
    const snapshot = catalog.loadSnapshot(unitIds as never[], []);
    expect(snapshot.units.size).toBe(10);
    for (const unitId of unitIds) {
      const unit = snapshot.units.get(unitId as never);
      expect(unit).toBeDefined();
      const exSkill = snapshot.skills.get(unit!.extraSkillDefinitionId);
      expect(exSkill?.cost.amount).toBe(unit!.extraGaugeMaximum);
    }
  });

  it("IT-CAT-PILOT-003: Evie's full skill set (EX/AS1/AS2/PS1/PS2) resolves as v2 structures", () => {
    const catalog = loadCatalogFromDirectory(fixturePath("pilot-units"));
    const snapshot = catalog.loadSnapshot(["UNIT_EVIE"] as never[], []);
    const evie = snapshot.units.get("UNIT_EVIE" as never);
    expect(evie?.activeSkillDefinitionIds).toHaveLength(2);
    expect(evie?.passiveSkillDefinitionIds).toHaveLength(2);
    expect(snapshot.skills.get("SKL_EVIE_EX" as never)?.skillType).toBe("EX");
    expect(snapshot.skills.get("SKL_EVIE_PS1" as never)?.triggers[0]?.eventType).toBe(
      "UnitBeingAttacked",
    );
    const ps1 = snapshot.skills.get("SKL_EVIE_PS1" as never);
    expect(ps1?.traits.simultaneousActivationLimited).toBe(true);
  });

  it("IT-CAT-PILOT-004: Kate's EX resolves a RANDOM_BRANCH (WEIGHTED_ONE) over 3 equal-weight branches", () => {
    const catalog = loadCatalogFromDirectory(fixturePath("pilot-units"));
    const snapshot = catalog.loadSnapshot(["UNIT_KATE"] as never[], []);
    const ex = snapshot.skills.get("SKL_KATE_EX" as never);
    const step = ex?.resolution.steps[0];
    expect(step?.kind).toBe("RANDOM_BRANCH");
    if (step?.kind === "RANDOM_BRANCH") {
      expect(step.mode).toBe("WEIGHTED_ONE");
      expect(step.branches).toHaveLength(3);
    }
  });

  it("IT-CAT-PILOT-005: Kotoha's AS2 nests BRANCH steps keyed on a Marker-count condition (Target/Condition/EffectAction wiring)", () => {
    const catalog = loadCatalogFromDirectory(fixturePath("pilot-units"));
    const snapshot = catalog.loadSnapshot(["UNIT_KOTOHA"] as never[], []);
    const as2 = snapshot.skills.get("SKL_KOTOHA_AS2" as never);
    const branch = as2?.resolution.steps[1];
    expect(branch?.kind).toBe("BRANCH");
    if (branch?.kind === "BRANCH") {
      expect(branch.condition.kind).toBe("TARGET_HAS_MARKER");
    }
  });

  it("IT-CAT-PILOT-006: Stella's 氷結のシンフォニー DAMAGE formula composes MIN(CURRENT_HP_RATIO, STAT_RATIO), matching the raw HP%/ATK% cap", () => {
    const catalog = loadCatalogFromDirectory(fixturePath("pilot-units"));
    const snapshot = catalog.loadSnapshot(["UNIT_STELLA"] as never[], []);
    const effectAction = snapshot.effectActions.get("ACT_STELLA_PS1_DAMAGE" as never);
    expect(effectAction?.kind).toBe("DAMAGE");
    if (effectAction?.kind === "DAMAGE") {
      expect(effectAction.payload.formula.kind).toBe("MIN");
    }
  });
});
