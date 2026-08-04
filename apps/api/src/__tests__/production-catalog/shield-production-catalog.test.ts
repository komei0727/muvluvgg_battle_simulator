import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runProductionUnitBattle } from "../../testing/scenario/run-production-battle.js";
import { reduceStateDeltas } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import { grantEffect } from "../../domain/battle/effects/effect-grant-service.js";
import { decayActionShields, shieldPoolsOf } from "../../domain/battle/combat/shield-policy.js";
import { evaluateFormula } from "../../domain/battle/skill/formula-evaluator.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import { truncateFraction } from "../../domain/battle/model/resource-gauge.js";
import type { EffectInstanceId } from "../../domain/shared/event-ids.js";
import {
  effectActionFrom,
  loadProductionSnapshot,
  seedRecorder,
  testBattleUnit,
} from "../../testing/fixtures/index.js";

/**
 * DMG-004（Issue #194、R-SHD-01〜03）: 実 `catalog/` の `APPLY_SHIELD` 定義を、
 * 実戦闘（`runProductionUnitBattle`）と独立Reducer復元へ通す。
 *
 * `CAP_SHIELD` の `verification.productionDefinitionIds` に載せた3定義が、
 * Catalog上の変換だけでなく実行時にも意図どおり効くことをここで固定する。
 * それぞれ別の側面を担う。
 *
 * - `ACT_AOI_GUARDIAN_AS1_SHIELD`: タイプなしシールドの吸収と保存則
 *   （R-SHD-02/R-SHD-03、`DamageApplied`の内訳）
 * - `ACT_LILY_SINGER_PS2_SHIELD`: `shieldType: EN` と `LILY_SINGER_PS2_LINK`
 *   （`LINKED_EFFECT_GROUP_SHIELD`の近似解除）
 * - `ACT_SHIRANA_LUCKY_EX_SHIELD`: `decay`（`SHIELD_DECAY_OVER_TIME`の近似解除）
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

function shieldHolder(): BattleUnit {
  return testBattleUnit({
    battleUnitId: "ally:1",
    unitDefinitionId: "UNIT_SHIRANA_LUCKY",
    combatStats: {
      maximumHp: 1000,
      attack: 100,
      defense: 50,
      criticalRate: 0.1,
      actionSpeed: 100,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  });
}

function shieldDefinition(unitDefinitionId: string, effectActionDefinitionId: string) {
  const snapshot = loadProductionSnapshot(CATALOG_DIR, [unitDefinitionId]);
  const definition = effectActionFrom(snapshot, effectActionDefinitionId);
  if (definition.kind !== "APPLY_SHIELD") {
    throw new Error(`production Catalog has no APPLY_SHIELD "${effectActionDefinitionId}"`);
  }
  return definition;
}

describe("production Catalog APPLY_SHIELD (CAP_SHIELD, DMG-004 Issue #194)", () => {
  it("IT-CAP-SHIELD-PROD-001: absorbs real-battle damage with an untyped pool and conserves the calculated damage across every destination", () => {
    // `ACT_AOI_GUARDIAN_AS1_SHIELD`は`shieldType`を宣言しない＝タイプなしシールド。
    expect(
      shieldDefinition("UNIT_AOI_GUARDIAN", "ACT_AOI_GUARDIAN_AS1_SHIELD").payload.shieldType,
    ).toBeUndefined();

    const result = runProductionUnitBattle(CATALOG_DIR, "UNIT_AOI_GUARDIAN", {
      turnLimit: 5,
      randomValue: 0.5,
    });

    const consumed = result.events.filter((event) => event.type === "SHIELD_CONSUMED");
    expect(consumed.length).toBeGreaterThan(0);
    for (const event of consumed) {
      const details = event.details as Record<string, unknown>;
      expect(details["reason"]).toBe("DAMAGE_ABSORPTION");
      expect(details["shieldType"]).toBeNull();
      expect(details["absorbed"]).toBe(
        (details["before"] as number) - (details["after"] as number),
      );
    }

    // R-SHD-03／`08_ドメインイベント.md`不変条件#6: シールド吸収・HPダメージ・
    // 超過破棄の合計が計算ダメージと一致する。
    const applied = result.events.filter((event) => event.type === "DAMAGE_APPLIED");
    expect(applied.length).toBeGreaterThan(0);
    const absorbedTotal = applied.reduce((sum, event) => {
      const details = event.details as Record<string, number | undefined>;
      expect(
        details["typedShieldAbsorbed"]! +
          details["untypedShieldAbsorbed"]! +
          details["hitPointDamage"]! +
          details["discardedDamage"]!,
      ).toBe(details["calculatedDamage"]);
      return sum + details["untypedShieldAbsorbed"]!;
    }, 0);
    expect(absorbedTotal).toBeGreaterThan(0);

    // 独立Reducer復元: `initialState`へ`stateTransitions`だけを適用すると
    // `finalState`と一致する — シールド残量（`EffectSnapshot.shield`）も含めて。
    const restored = reduceStateDeltas(
      result.initialState,
      result.stateTransitions.map((transition) => transition.stateDelta),
    );
    expect(restored).toEqual(result.finalState);
  });

  it("IT-CAP-SHIELD-PROD-002: carries the EN shield type and the linked attack buff group of SKL_LILY_SINGER_PS2 without approximation", () => {
    const definition = shieldDefinition("UNIT_LILY_SINGER", "ACT_LILY_SINGER_PS2_SHIELD");
    // raw原文「前列の味方に自身の最大HP×25%のENシールドを付与する」。
    expect(definition.payload.shieldType).toBe("EN");
    // raw原文「シールドの消滅と共に攻撃力バフも消滅する」＝ R-EFF-09のカスケード。
    expect(definition.payload.duration.linkedEffectGroupId).toBe("LILY_SINGER_PS2_LINK");
    expect(definition.payload.duration.linkedEffectGroupRole).toBe("PARENT");

    const snapshot = loadProductionSnapshot(CATALOG_DIR, ["UNIT_LILY_SINGER"]);
    const atkUp = effectActionFrom(snapshot, "ACT_LILY_SINGER_PS2_ATK_UP");
    expect(atkUp.kind).toBe("APPLY_STAT_MOD");
    if (atkUp.kind === "APPLY_STAT_MOD") {
      expect(atkUp.payload.duration.linkedEffectGroupId).toBe("LILY_SINGER_PS2_LINK");
      expect(atkUp.payload.duration.linkedEffectGroupRole).toBe("CHILD");
    }

    const result = runProductionUnitBattle(CATALOG_DIR, "UNIT_LILY_SINGER", {
      turnLimit: 5,
      randomValue: 0.5,
    });
    const applied = result.events.filter(
      (event) =>
        event.type === "EFFECT_APPLIED" &&
        (event.details as Record<string, unknown>)["effectActionDefinitionId"] ===
          "ACT_LILY_SINGER_PS2_SHIELD",
    );
    expect(applied.length).toBeGreaterThan(0);

    const restored = reduceStateDeltas(
      result.initialState,
      result.stateTransitions.map((transition) => transition.stateDelta),
    );
    expect(restored).toEqual(result.finalState);
    // 付与されたインスタンスがENプールを持つ（R-SHD-01のタイプ別プール）。
    const shields = Object.values(restored.units).flatMap((unit) =>
      (unit?.effects ?? []).filter(
        (effect) => effect.effectDefinitionId === "ACT_LILY_SINGER_PS2_SHIELD",
      ),
    );
    for (const shield of shields) {
      expect(shield.shield?.shieldType).toBe("EN");
    }
  });

  it("IT-CAP-SHIELD-PROD-003: decays SKL_SHIRANA_LUCKY_EX's shield by 25% of its granted maximum per action instead of the former fixed 4-action approximation", () => {
    const definition = shieldDefinition("UNIT_SHIRANA_LUCKY", "ACT_SHIRANA_LUCKY_EX_SHIELD");
    // raw原文「シールドは1行動に付き最大値の25%減少する」。近似だった
    // `timeLimit: { unit: ACTION, count: 4 }` は`decay`へ置き換えた — 漸減自体が
    // 消滅契機になるため、固定期間を併記する必要がなくなっている。
    expect(definition.payload.decay).toEqual({ unit: "ACTION", ratio: 0.25 });
    expect(definition.payload.duration.timeLimit).toBeUndefined();

    // 漸減の各行動時点でのシールド量と`depletedEffectInstanceIds`という
    // resolver内部の中間産物を検証するため、実戦闘（`runProductionUnitBattle`）
    // ではなく実定義を実domain executor（`grantEffect` → `decayActionShields`）へ
    // 直接通し、4行動でちょうど枯渇することを固定する。
    const holder = shieldHolder();
    const { recorder, seed } = seedRecorder("B_1");
    const granted = grantEffect(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 1,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId: seed.eventId,
      },
      [holder],
      {
        definition,
        sourceUnitId: holder.battleUnitId,
        targetUnitId: holder.battleUnitId,
        duplicate: true,
        magnitude: truncateFraction(
          evaluateFormula(definition.payload.formula, {
            skillSource: holder,
            target: holder,
            allUnits: [holder],
          }),
        ),
        shield: {
          shieldType: definition.payload.shieldType ?? null,
          remaining: truncateFraction(
            evaluateFormula(definition.payload.formula, {
              skillSource: holder,
              target: holder,
              allUnits: [holder],
            }),
          ),
          decay: definition.payload.decay!,
        },
        durationDefinition: definition.payload.duration,
      },
      seed.eventId,
    );

    // `MAX_HP_RATIO` ratio 1.0 なので最大HPと同量から始まる。
    expect(shieldPoolsOf(granted.units[0]!.appliedEffects).untyped).toBe(
      holder.combatStats.maximumHp,
    );

    let units = granted.units;
    const steps: number[] = [];
    let lastDepleted: readonly EffectInstanceId[] = [];
    for (let i = 0; i < 4; i++) {
      const decayed = decayActionShields(units, holder.battleUnitId, holder.battleUnitId, null);
      units = decayed.units;
      lastDepleted = decayed.change!.depletedEffectInstanceIds;
      steps.push(shieldPoolsOf(units[0]!.appliedEffects).untyped);
      // 3行動目まではまだ残っており、個別消滅の対象にならない。
      if (i < 3) {
        expect(lastDepleted).toEqual([]);
      }
    }
    const maximum = holder.combatStats.maximumHp;
    expect(steps).toEqual([maximum * 0.75, maximum * 0.5, maximum * 0.25, 0]);
    // 4行動目で枯渇し、R-SHD-01第3項の個別消滅（`EffectExpired`/`SHIELD_DEPLETED`）の
    // 対象になる。
    expect(lastDepleted).toEqual([granted.appliedEffect.effectInstanceId]);
  });
});
