import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCatalogFromDirectory } from "./catalog-file-loader.js";

/**
 * Issue #46: promotes the Issue #41/#44 pilot fixture (retired in the
 * docs/ddd/19 cleanup) to the production Catalog candidate at `catalog/`
 * (apps/api package root, per `docs/ddd/14_Catalog定義スキーマ.md`). These tests lock in
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
    // Issue #159 (EFF-003): `CAP_STAT_MOD`/`CAP_COMPLEX_EXPIRATION` flipped to
    // IMPLEMENTED once ACTION/TURN duration decrement, consumption, special
    // expiration, and linkedEffectGroup cascade (R-EFF-04/06/07/08/09) wired
    // the real lifecycle (`capabilities.json`, production integration tests
    // `IT-CAP-COMPLEX-EXPIRATION-PROD-001〜003`). Issue #160 (EFF-004):
    // `CAP_MARKER` flipped to IMPLEMENTED once MarkerState stack policies and
    // ACTION/TURN duration expiration (R-EFF-10) wired the real lifecycle
    // (`IT-MARKER-PROD-001〜002`). RES-001 (Issue #175, PR #214 re-review):
    // `CAP_FORMULA` flipped to IMPLEMENTED once the general FormulaEvaluator
    // wired the real lifecycle (`IT-CAP-FORMULA-PROD-001〜004`). Issue #217:
    // `SKL_JULIE_SNOW_PS2`/`SKL_MAO_COMMITTEE_PS1` corrected from a misused
    // `LAST_ACTION_TARGETS` (no preceding EffectAction result in their own
    // EffectSequence, R-SKL-08) to `TRIGGER_TARGET` (the actually-intended
    // "the AS/EX that triggered me" target, per raw/units/ design source).
    // RES-005 (Issue #172): `CAP_TRIGGER_CONTEXT` flipped to IMPLEMENTED once
    // `TRIGGER_SOURCE`/`TRIGGER_TARGET` effect-target resolution
    // (`skill-resolution-service.ts`/`target-selection-policy.ts`) and the
    // `HitPointReduced` basic pipeline event wired the real lifecycle
    // (`IT-CAP-TRIGGER-CONTEXT-PROD-001`, `SKL_SUIRAN_CHAOS_PS3`). Both of
    // `SKL_JULIE_SNOW_PS2`/`SKL_MAO_COMMITTEE_PS1` still require other
    // not-yet-implemented capabilities of their own before they fully
    // activate. Issue #170 (TGT-001):
    // `CAP_TARGET_DERIVED_AREA` flipped to IMPLEMENTED once `TargetSelectorDefinition`
    // `kind: BINDING_DERIVED` (`base`: SELF/BINDING) and `area` (ADJACENT_ORTHOGONAL,
    // DIRECTLY_AHEAD_OF_BASE, BEHIND_BASE, SAME_ROW_AS_BASE, SAME_COLUMN_AS_BASE,
    // R-TGT-04/05) plus `order` FARTHEST (R-TGT-03) and FRONT_ROW/BACK_ROW (R-TGT-06)
    // wired the real lifecycle (`IT-CAP-TARGET-DERIVED-AREA-PROD-001`).
    // RES-004 (Issue #171後半): `CAP_EFFECT_STEP_CONDITION` flipped to IMPLEMENTED
    // once ACTION step conditions referencing their own `target` (TARGET_STATE/
    // TARGET_HAS_MARKER) are evaluated per-target, always deferred to JIT
    // resolution time (`isEagerActionStep`) so a self-referencing condition sees
    // the state left by earlier steps and by this step's own `EffectStepStarting`
    // chain, not a stale pre-sequence/pre-timing-event snapshot (PR #223 review
    // finding [P1]; `effect-step-condition-evaluator.ts`'s `EffectStepTargetContext`,
    // `skill-resolution-service.ts`'s `buildEffectStepPerTargetFilter`), wiring
    // the real lifecycle for `SKL_AOI_ELEGANT_EX`/`SKL_LUCIE_MAID_AS1`/
    // `SKL_LUCIE_MAID_PS2`/`SKL_ROSIE_ARTIST_PS2` (`IT-CAP-EFFSTEP-001〜004`).
    // PR #223 review finding [P2]: this capability's completion boundary is
    // narrowed to exclude "集合条件" (set-threshold) — no ConditionKind exists
    // for it yet, so it isn't part of what `IMPLEMENTED` claims here. It becomes
    // its own Capability entry once a concrete schema-supported design exists.
    expect(catalog.catalogRevision).toBe("2026-07-24.9");
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

  it.each([
    { unitId: "UNIT_DOROTHEA_GRACE", skillId: "SKL_DOROTHEA_GRACE_PS3", sourceSelector: "ANY" },
    { unitId: "UNIT_KOTOHA_REBEL", skillId: "SKL_KOTOHA_REBEL_PS1", sourceSelector: "ANY" },
    { unitId: "UNIT_ELENA_MOODMAKER", skillId: "SKL_ELENA_MOODMAKER_PS2", sourceSelector: "ENEMY" },
    { unitId: "UNIT_RAVEL_MODEL", skillId: "SKL_RAVEL_MODEL_PS1", sourceSelector: "ENEMY" },
  ])(
    "IT-CAT-PROD-007: $skillId's UnitDefeated trigger targets the defeated ally, not the skill owner ($unitId)",
    ({ unitId, skillId, sourceSelector }) => {
      const catalog = loadCatalogFromDirectory(catalogPath());
      const snapshot = catalog.loadSnapshot([unitId] as never[], []);
      const skill = snapshot.skills.get(skillId as never);
      const trigger = skill?.triggers[0];
      expect(trigger?.eventType).toBe("UnitDefeated");
      expect(trigger?.targetSelector).toBe("ALLY");
      expect(trigger?.sourceSelector).toBe(sourceSelector);
    },
  );

  /**
   * Issue #143: `RUNTIME_COUNTER`のCondition木からRUNTIME_COUNTER kindだけを
   * 再帰的に探す（`AND`でラップされている場合があるため）。
   */
  function findRuntimeCounterCondition(
    condition: unknown,
  ): { readonly counter?: string; readonly modulo?: number | undefined } | undefined {
    if (condition === null || typeof condition !== "object") {
      return undefined;
    }
    const c = condition as Record<string, unknown>;
    if (c.kind === "RUNTIME_COUNTER") {
      return { counter: c.counter as string, modulo: c.modulo as number | undefined };
    }
    if ((c.kind === "AND" || c.kind === "OR") && Array.isArray(c.conditions)) {
      for (const sub of c.conditions) {
        const found = findRuntimeCounterCondition(sub);
        if (found !== undefined) {
          return found;
        }
      }
    }
    if (c.kind === "NOT") {
      return findRuntimeCounterCondition(c.condition);
    }
    return undefined;
  }

  it.each([
    { unitId: "UNIT_LAYLA_ENTREPRENEUR", skillId: "SKL_LAYLA_ENTREPRENEUR_PS2", modulo: 4 },
    { unitId: "UNIT_JUNKA_CHILDHOOD", skillId: "SKL_JUNKA_CHILDHOOD_PS2", modulo: 3 },
    { unitId: "UNIT_SHIRANA_SORA", skillId: "SKL_SHIRANA_SORA_PS1", modulo: 2 },
    { unitId: "UNIT_CLARA_SANTA", skillId: "SKL_CLARA_SANTA_PS1", modulo: 3 },
    { unitId: "UNIT_OLGA_VETERAN", skillId: "SKL_OLGA_VETERAN_PS1", modulo: 4 },
    { unitId: "UNIT_MAO_COMMITTEE", skillId: "SKL_MAO_COMMITTEE_PS1", modulo: 3 },
    { unitId: "UNIT_MIRIAM_MAGE", skillId: "SKL_MIRIAM_MAGE_PS1", modulo: 3 },
    { unitId: "UNIT_ELENA_MOODMAKER", skillId: "SKL_ELENA_MOODMAKER_PS1", modulo: 4 },
    { unitId: "UNIT_NADYA_SUCCESSOR", skillId: "SKL_NADYA_SUCCESSOR_PS3", modulo: 3 },
  ])(
    "IT-CAT-PROD-008 (Issue #143, RUNTIME_COUNTER_MODULO): $skillId declares a matching counterUpdates INCREMENT entry and a RUNTIME_COUNTER trigger condition with modulo=$modulo ($unitId)",
    ({ unitId, skillId, modulo }) => {
      const catalog = loadCatalogFromDirectory(catalogPath());
      const snapshot = catalog.loadSnapshot([unitId] as never[], []);
      const skill = snapshot.skills.get(skillId as never);
      expect(skill?.counterUpdates).toHaveLength(1);
      const update = skill?.counterUpdates[0];
      expect(update?.kind).toBe("INCREMENT");
      expect(update?.scope).toBe("SKILL_RUNTIME");
      if (update?.kind === "INCREMENT") {
        expect(update.amount).toBe(1);
      }

      const found = findRuntimeCounterCondition(skill?.triggers[0]?.condition);
      expect(found).toBeDefined();
      expect(found?.counter).toBe(update?.counter);
      expect(found?.modulo).toBe(modulo);
    },
  );

  it.each([
    { unitId: "UNIT_CHIYURU_NEWYEAR", skillId: "SKL_CHIYURU_NEWYEAR_PS2", maxHpRatio: 0.4 },
    { unitId: "UNIT_CHIZURU_DOMESTIC", skillId: "SKL_CHIZURU_DOMESTIC_PS3", maxHpRatio: 0.85 },
    { unitId: "UNIT_TATIANA_SAGE", skillId: "SKL_TATIANA_SAGE_PS1", maxHpRatio: 0.2 },
  ])(
    "IT-CAT-PROD-009 (Issue #143, CUMULATIVE_DAMAGE_THRESHOLD_TRIGGER): $skillId declares a matching counterUpdates CUMULATIVE_DAMAGE_THRESHOLD entry (maxHpRatio=$maxHpRatio) and triggers on its own RuntimeCounterChanged only when valueChanged is true ($unitId)",
    ({ unitId, skillId, maxHpRatio }) => {
      const catalog = loadCatalogFromDirectory(catalogPath());
      const snapshot = catalog.loadSnapshot([unitId] as never[], []);
      const skill = snapshot.skills.get(skillId as never);
      expect(skill?.counterUpdates).toHaveLength(1);
      const update = skill?.counterUpdates[0];
      expect(update?.kind).toBe("CUMULATIVE_DAMAGE_THRESHOLD");
      expect(update?.scope).toBe("SKILL_RUNTIME");
      if (update?.kind === "CUMULATIVE_DAMAGE_THRESHOLD") {
        expect(update.maxHpRatio).toBe(maxHpRatio);
      }
      expect(update?.trigger.eventType).toBe("DamageApplied");

      const trigger = skill?.triggers[0];
      expect(trigger?.eventType).toBe("RuntimeCounterChanged");
      expect(trigger?.sourceSelector).toBe("SELF");
      // レビュー再々レビュー[P1]: carryのみの変化でも`RuntimeCounterChanged`が
      // 発行されるようになったため、閾値到達時（`valueChanged: true`）だけに
      // 絞り込む条件をANDで持つ（さもないと閾値未到達の被弾ごとに誤発動する）。
      expect(trigger?.condition).toEqual({
        kind: "AND",
        conditions: [
          { kind: "EVENT_PAYLOAD", field: "counter", op: "EQ", value: update?.counter },
          { kind: "EVENT_PAYLOAD", field: "valueChanged", op: "EQ", value: true },
        ],
      });
    },
  );

  /**
   * Issue #144: `POSITION_RELATION`/`RESOLUTION_PHASE` ConditionのCondition木
   * からそのkindだけを再帰的に探す（`AND`でラップされている場合があるため、
   * `findRuntimeCounterCondition`と同じ形）。
   */
  function findConditionsOfKind<K extends string>(
    condition: unknown,
    kind: K,
  ): readonly Record<string, unknown>[] {
    if (condition === null || typeof condition !== "object") {
      return [];
    }
    const c = condition as Record<string, unknown>;
    if (c.kind === kind) {
      return [c];
    }
    if ((c.kind === "AND" || c.kind === "OR") && Array.isArray(c.conditions)) {
      return c.conditions.flatMap((sub) => findConditionsOfKind(sub, kind));
    }
    if (c.kind === "NOT") {
      return findConditionsOfKind(c.condition, kind);
    }
    return [];
  }

  it.each([
    {
      unitId: "UNIT_SUIRAN_CHAOS",
      skillId: "SKL_SUIRAN_CHAOS_PS1",
      target: { kind: "TRIGGER_TARGET" },
    },
    {
      unitId: "UNIT_SUIRAN_CHAOS",
      skillId: "SKL_SUIRAN_CHAOS_PS2",
      target: { kind: "TRIGGER_TARGET" },
    },
    {
      unitId: "UNIT_SUIRAN_CHAOS",
      skillId: "SKL_SUIRAN_CHAOS_PS3",
      target: { kind: "TRIGGER_SOURCE" },
    },
  ])(
    "IT-CAT-PROD-010 (Issue #144, TRIGGER_POSITION_RELATION): $skillId's trigger condition requires the target to be IN_FRONT_OF the PS owner, not an approximated 任意の味方 ($unitId)",
    ({ unitId, skillId, target }) => {
      const catalog = loadCatalogFromDirectory(catalogPath());
      const snapshot = catalog.loadSnapshot([unitId] as never[], []);
      const skill = snapshot.skills.get(skillId as never);
      const trigger = skill?.triggers[0];
      const positionConditions = findConditionsOfKind(trigger?.condition, "POSITION_RELATION");
      expect(positionConditions).toHaveLength(1);
      expect(positionConditions[0]).toEqual({
        kind: "POSITION_RELATION",
        target,
        relation: "IN_FRONT_OF",
      });
    },
  );

  it.each([
    { unitId: "UNIT_KEI_JACKKNIFE", skillId: "SKL_KEI_JACKKNIFE_PS2" },
    { unitId: "UNIT_LILY_SINGER", skillId: "SKL_LILY_SINGER_PS1" },
    { unitId: "UNIT_SIENA_DIVA", skillId: "SKL_SIENA_DIVA_PS1" },
  ])(
    "IT-CAT-PROD-011 (Issue #144, TRIGGER_EXCLUSION_TIMING): $skillId's trigger condition excludes BATTLE_START/TURN_START/TURN_END resolution phases ($unitId)",
    ({ unitId, skillId }) => {
      const catalog = loadCatalogFromDirectory(catalogPath());
      const snapshot = catalog.loadSnapshot([unitId] as never[], []);
      const skill = snapshot.skills.get(skillId as never);
      const trigger = skill?.triggers[0];
      const phaseConditions = findConditionsOfKind(trigger?.condition, "RESOLUTION_PHASE");
      const phases = phaseConditions.map((c) => c.phase).sort();
      expect(phases).toEqual(["BATTLE_START", "TURN_END", "TURN_START"]);
      for (const c of phaseConditions) {
        expect(c.negate).toBe(true);
      }
    },
  );
});
