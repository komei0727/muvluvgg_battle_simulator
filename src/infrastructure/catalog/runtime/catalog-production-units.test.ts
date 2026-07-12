import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCatalogFromDirectory } from "./catalog-file-loader.js";

/**
 * Issue #46: promotes the Issue #41/#44 pilot fixture (retired in the
 * docs/ddd/19 cleanup) to the production Catalog candidate at `catalog/`
 * (repo root, per `docs/ddd/14_Catalog定義スキーマ.md`). These tests lock in
 * the conversion-mistake fixes found while re-checking raw/units/ against
 * the pilot fixture, so a future edit to `catalog/` cannot silently
 * reintroduce them.
 */

function catalogPath(): string {
  return fileURLToPath(new URL("../../../../catalog", import.meta.url));
}

describe("Catalog v2 production candidate: 10-unit promotion (Issue #46)", () => {
  it("IT-CAT-PROD-001: loads all 10 units from catalog/ without an integrity violation", () => {
    const catalog = loadCatalogFromDirectory(catalogPath());
    expect(catalog.catalogRevision).toBe("2026-07-12.7");
  });

  it("IT-CAT-PROD-002: Evie's デコイプロトコル (PS1) triggers on an ally being attacked by an enemy, not on self being attacked by an ally", () => {
    const catalog = loadCatalogFromDirectory(catalogPath());
    const snapshot = catalog.loadSnapshot(["UNIT_EVIE_ECO"] as never[], []);
    const ps1 = snapshot.skills.get("SKL_EVIE_ECO_PS1" as never);
    expect(ps1?.triggers[0]?.sourceSelector).toBe("ENEMY");
    expect(ps1?.triggers[0]?.targetSelector).toBe("ALLY");
  });

  it("IT-CAT-PROD-003: Karina's とりしまり～ (AS1) reduces EX gauge on all enemies, not a single target", () => {
    const catalog = loadCatalogFromDirectory(catalogPath());
    const snapshot = catalog.loadSnapshot(["UNIT_KARINA_DOWNER"] as never[], []);
    const as1 = snapshot.skills.get("SKL_KARINA_DOWNER_AS1" as never);
    const binding = as1?.resolution.targetBindings.find(
      (b) => b.targetBindingId === "TGT_ALL_ENEMIES",
    );
    expect(binding?.selector.side).toBe("ENEMY");
    expect(binding?.selector.count).toBe("ALL");
    const step = as1?.resolution.steps[0];
    expect(step?.kind).toBe("ACTION");
    if (step?.kind === "ACTION") {
      const actionIds = step.actions.map((a) => a.effectActionDefinitionId);
      expect(actionIds).toContain("ACT_KARINA_DOWNER_AS1_EX_DOWN");
      expect(step.target).toEqual({ kind: "BINDING", targetBindingId: "TGT_ALL_ENEMIES" });
    }
  });

  it("IT-CAT-PROD-004: Flute's ＃ぽよ・オア・トリート (EX) self-heal references the summed damage dealt, not only the last hit", () => {
    const catalog = loadCatalogFromDirectory(catalogPath());
    const snapshot = catalog.loadSnapshot(["UNIT_FLUTE_VAMPIRE"] as never[], []);
    const heal = snapshot.effectActions.get("ACT_FLUTE_VAMPIRE_EX_SELF_HEAL" as never);
    expect(heal?.kind).toBe("HEAL");
    if (heal?.kind === "HEAL") {
      expect(heal.payload.formula.kind).toBe("DAMAGE_DEALT_RATIO");
      if (heal.payload.formula.kind === "DAMAGE_DEALT_RATIO") {
        expect(heal.payload.formula.sourceResult).toBe("SUM_DAMAGE_DEALT");
      }
    }
  });

  it("IT-CAT-PROD-005: Flute's HP cost (AS1 かぷっとファンサ) bypasses defense/shield/evasion/crit so it behaves as an unconditional resource cost", () => {
    const catalog = loadCatalogFromDirectory(catalogPath());
    const snapshot = catalog.loadSnapshot(["UNIT_FLUTE_VAMPIRE"] as never[], []);
    const hpCost = snapshot.effectActions.get("ACT_FLUTE_VAMPIRE_AS1_HP_COST" as never);
    expect(hpCost?.kind).toBe("DAMAGE");
    if (hpCost?.kind === "DAMAGE") {
      expect(hpCost.payload.critical?.mode).toBe("PREVENTED");
      expect(hpCost.payload.accuracy?.mode).toBe("GUARANTEED");
      expect(hpCost.payload.piercing).toEqual({
        defenseIgnoreRate: 1,
        shieldIgnoreRate: 1,
        damageReductionIgnoreRate: 1,
      });
    }
  });

  it("IT-CAT-PROD-006: every declared targetBindingId is referenced by a resolution step or another binding's base (no orphaned bindings, e.g. Lydia's EX fallback)", () => {
    const catalog = loadCatalogFromDirectory(catalogPath());
    const unitIds = [
      "UNIT_EVIE_ECO",
      "UNIT_LYDIA_GENIUS",
      "UNIT_LAURA_MOUNTAIN",
      "UNIT_STELLA_STATUE",
      "UNIT_KARINA_DOWNER",
      "UNIT_HARRIET_SAGE",
      "UNIT_KOTOHA_REBEL",
      "UNIT_MIKOTO_SURVIVOR",
      "UNIT_KATE_PALADIN",
      "UNIT_FLUTE_VAMPIRE",
    ];
    const snapshot = catalog.loadSnapshot(unitIds as never[], []);

    // Any `{ kind: "BINDING", targetBindingId: "..." }` occurring anywhere inside
    // resolution.steps (step targets, BRANCH/RANDOM_BRANCH conditions and nested
    // branches) or inside another binding's selector (e.g. BINDING_DERIVED.base)
    // counts as a usage. Declaration sites (`{ targetBindingId, selector }`) never
    // match this shape, since `kind` lives one level deeper inside `selector`.
    function collectBindingReferences(node: unknown, into: Set<string>): void {
      if (Array.isArray(node)) {
        for (const item of node) collectBindingReferences(item, into);
        return;
      }
      if (node !== null && typeof node === "object") {
        const record = node as Record<string, unknown>;
        if (record.kind === "BINDING" && typeof record.targetBindingId === "string") {
          into.add(record.targetBindingId);
        }
        for (const value of Object.values(record)) collectBindingReferences(value, into);
      }
    }

    for (const skill of snapshot.skills.values()) {
      const referenced = new Set<string>();
      collectBindingReferences(skill.resolution.steps, referenced);
      for (const binding of skill.resolution.targetBindings) {
        collectBindingReferences(binding.selector, referenced);
      }
      const declared = skill.resolution.targetBindings.map((b) => b.targetBindingId);
      for (const bindingId of declared) {
        expect(referenced.has(bindingId), `${skill.skillDefinitionId}: ${bindingId} unused`).toBe(
          true,
        );
      }
    }
  });
});
