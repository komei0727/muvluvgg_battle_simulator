import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { grantEffect } from "../../domain/battle/effects/effect-grant-service.js";
import { composeDamageModifiers } from "../../domain/battle/combat/damage-modifier-policy.js";
import { evaluateFormula } from "../../domain/battle/skill/formula-evaluator.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import { createHitPoint } from "../../domain/battle/model/resource-gauge.js";
import { runProductionUnitBattle } from "../../testing/scenario/run-production-battle.js";
import { reduceStateDeltas } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import type { Side } from "../../domain/shared/side.js";
import {
  effectActionFrom,
  loadProductionSnapshot,
  seedRecorder,
  testBattleUnit,
  testMarker,
} from "../../testing/fixtures/index.js";

/**
 * DMG-002（Issue #192、R-DMG-03／R-DMG-04）: 実 `catalog/` の
 * `APPLY_DAMAGE_MOD` 定義を、実 domain executor（`grantEffect` →
 * `composeDamageModifiers`）と実戦闘（`runProductionUnitBattle`）に通す。
 *
 * `CAP_DAMAGE_MOD` の `verification.productionDefinitionIds` に載せた定義が、
 * Catalog上の変換だけでなく実行時にも意図どおり効くことをここで固定する。
 * 特に `DYNAMIC_DAMAGE_MOD_CONDITION`（保持者・相手の状態でヒットごとに成立を
 * 判定する `payload.condition`）は、付与時点ではなく集計時点で評価されるため、
 * 同じ `AppliedEffect` が状況によって効いたり効かなかったりすることを確かめる。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

const COMBAT_STATS = {
  maximumHp: 1000,
  attack: 100,
  defense: 50,
  criticalRate: 0.1,
  actionSpeed: 100,
  criticalDamageBonus: 0.5,
  affinityBonus: 0.25,
};

function unitFor(id: string, unitDefinitionId: string, side: Side): BattleUnit {
  return testBattleUnit({ battleUnitId: id, unitDefinitionId, side, combatStats: COMBAT_STATS });
}

function withCurrentHp(unit: BattleUnit, currentHp: number): BattleUnit {
  return { ...unit, currentHp: createHitPoint(currentHp, unit.combatStats.maximumHp) };
}

function withMarker(unit: BattleUnit, markerIdValue: string): BattleUnit {
  return { ...unit, markerStates: [testMarker(unit, markerIdValue)] };
}

/**
 * 実Catalogの`APPLY_DAMAGE_MOD`定義を、実`grantEffect`で`holder`へ付与する。
 * `magnitude`は`APPLY_STAT_MOD`等と同じ「付与時点で一度だけ`formula`を評価する」
 * 規約どおり、実`evaluateFormula`の結果を渡す。
 */
function grantDamageModFromCatalog(
  effectActionDefinitionId: string,
  unitDefinitionId: string,
  holder: BattleUnit,
  others: readonly BattleUnit[],
) {
  const snapshot = loadProductionSnapshot(CATALOG_DIR, [unitDefinitionId]);
  const definition = effectActionFrom(snapshot, effectActionDefinitionId);
  if (definition.kind !== "APPLY_DAMAGE_MOD") {
    throw new Error(`production Catalog has no APPLY_DAMAGE_MOD "${effectActionDefinitionId}"`);
  }
  const { recorder, seed } = seedRecorder("B_1");
  const units = [holder, ...others];
  const magnitude = evaluateFormula(definition.payload.formula, {
    skillSource: holder,
    target: holder,
    allUnits: units,
  });
  const result = grantEffect(
    {
      recorder,
      turnNumber: 1,
      cycleNumber: 1,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      rootEventId: seed.eventId,
    },
    units,
    {
      definition,
      sourceId: holder.battleUnitId,
      targetId: holder.battleUnitId,
      duplicate: true,
      magnitude,
      damageModifier: {
        direction: definition.payload.direction,
        damageType: definition.payload.damageType,
        ...(definition.payload.condition !== undefined
          ? { condition: definition.payload.condition }
          : {}),
      },
      durationDefinition: definition.payload.duration,
    },
    seed.eventId,
  );
  const holderAfter = result.units.find((u) => u.battleUnitId === holder.battleUnitId)!;
  return { definition, magnitude, recorder, result, holderAfter };
}

describe("production Catalog APPLY_DAMAGE_MOD (DMG-002, R-DMG-03/R-DMG-04)", () => {
  it("IT-CAP-DAMAGE-MOD-PROD-001: ACT_MAO_COMMITTEE_PS2_DMG_DOWN's HP_RATIO_SCALE formula is snapshotted at grant time and composes into the incoming multiplier", () => {
    const attacker = unitFor("B_1:unit:2", "UNIT_MAO_COMMITTEE", "ENEMY");

    // 付与時の自身のHPが多いほど高い効果（最大 被ダメージ-50%）。
    const full = grantDamageModFromCatalog(
      "ACT_MAO_COMMITTEE_PS2_DMG_DOWN",
      "UNIT_MAO_COMMITTEE",
      unitFor("B_1:unit:1", "UNIT_MAO_COMMITTEE", "ALLY"),
      [attacker],
    );
    expect(full.definition.payload.formula.kind).toBe("HP_RATIO_SCALE");
    expect(full.magnitude).toBeCloseTo(-0.5);
    expect(full.holderAfter.appliedEffects).toHaveLength(1);
    expect(full.holderAfter.appliedEffects[0]).toMatchObject({
      magnitude: -0.5,
      damageModifier: { direction: "INCOMING", damageType: null },
    });
    expect(
      composeDamageModifiers({
        attacker,
        defender: full.holderAfter,
        damageType: "PHYSICAL",
        damageReductionIgnoreRate: 0,
      }).incomingMultiplier,
    ).toBeCloseTo(0.5);

    // HP半分で付与すれば逓減し、-25%（倍率0.75）になる。
    const half = grantDamageModFromCatalog(
      "ACT_MAO_COMMITTEE_PS2_DMG_DOWN",
      "UNIT_MAO_COMMITTEE",
      withCurrentHp(unitFor("B_1:unit:1", "UNIT_MAO_COMMITTEE", "ALLY"), 500),
      [attacker],
    );
    expect(half.magnitude).toBeCloseTo(-0.25);
    expect(
      composeDamageModifiers({
        attacker,
        defender: half.holderAfter,
        damageType: "PHYSICAL",
        damageReductionIgnoreRate: 0,
      }).incomingMultiplier,
    ).toBeCloseTo(0.75);

    // R-DMG-03: 攻撃側の`damageReductionIgnoreRate`は、この負の被ダメージ補正だけを
    // 割合で無視する（1なら軽減が完全に消える）。
    expect(
      composeDamageModifiers({
        attacker,
        defender: full.holderAfter,
        damageType: "PHYSICAL",
        damageReductionIgnoreRate: 1,
      }).incomingMultiplier,
    ).toBeCloseTo(1);

    // 実`grantEffect`が`EffectApplied`とそのStateDeltaを発行している。
    const applied = full.recorder.getEvents().find((e) => e.eventType === "EffectApplied")!;
    expect(applied.payload).toMatchObject({
      effectActionDefinitionId: "ACT_MAO_COMMITTEE_PS2_DMG_DOWN",
      targetUnitId: full.holderAfter.battleUnitId,
    });
    expect(applied.stateDelta).toBeDefined();
  });

  it("IT-CAP-DAMAGE-MOD-PROD-002: ACT_KOTOHA_REBEL_PS2_DMG_UP's HP_RATIO_COMPARISON condition is evaluated per hit, not at grant time", () => {
    const holder = unitFor("B_1:unit:1", "UNIT_KOTOHA_REBEL", "ALLY");
    const target = unitFor("B_1:unit:2", "UNIT_KOTOHA_REBEL", "ENEMY");
    const granted = grantDamageModFromCatalog(
      "ACT_KOTOHA_REBEL_PS2_DMG_UP",
      "UNIT_KOTOHA_REBEL",
      holder,
      [target],
    );

    expect(granted.definition.payload.direction).toBe("OUTGOING");
    expect(granted.definition.payload.condition).toEqual({
      kind: "HP_RATIO_COMPARISON",
      left: "OPPONENT",
      op: "LT",
      right: "EFFECT_OWNER",
    });

    // 「対象のHP割合が自身より低い敵に対してのみ」+10%。互角のHP割合では成立しない。
    expect(
      composeDamageModifiers({
        attacker: granted.holderAfter,
        defender: target,
        damageType: "PHYSICAL",
        damageReductionIgnoreRate: 0,
      }).outgoingMultiplier,
    ).toBe(1);

    expect(
      composeDamageModifiers({
        attacker: granted.holderAfter,
        defender: withCurrentHp(target, 400),
        damageType: "PHYSICAL",
        damageReductionIgnoreRate: 0,
      }).outgoingMultiplier,
    ).toBeCloseTo(1.1);
  });

  it("IT-CAP-DAMAGE-MOD-PROD-003: ACT_AOI_ELEGANT_PS2_SELF_DAMAGE_MOD only reduces damage from an attacker that holds 「浮足」", () => {
    const holder = unitFor("B_1:unit:1", "UNIT_AOI_ELEGANT", "ALLY");
    const attacker = unitFor("B_1:unit:2", "UNIT_AOI_ELEGANT", "ENEMY");
    const granted = grantDamageModFromCatalog(
      "ACT_AOI_ELEGANT_PS2_SELF_DAMAGE_MOD",
      "UNIT_AOI_ELEGANT",
      holder,
      [attacker],
    );

    expect(granted.definition.payload.condition).toEqual({
      kind: "UNIT_HAS_MARKER",
      unit: "OPPONENT",
      markerId: "MARKER_AOI_ELEGANT_UKIASHI",
    });

    expect(
      composeDamageModifiers({
        attacker,
        defender: granted.holderAfter,
        damageType: "PHYSICAL",
        damageReductionIgnoreRate: 0,
      }).incomingMultiplier,
    ).toBe(1);

    expect(
      composeDamageModifiers({
        attacker: withMarker(attacker, "MARKER_AOI_ELEGANT_UKIASHI"),
        defender: granted.holderAfter,
        damageType: "PHYSICAL",
        damageReductionIgnoreRate: 0,
      }).incomingMultiplier,
    ).toBeCloseTo(0.6);
  });

  it("IT-CAP-DAMAGE-MOD-PROD-005: a dynamically conditioned APPLY_DAMAGE_MOD survives independent Reducer restoration with its direction, damageType and condition intact", () => {
    // `SKL_KEI_JACKKNIFE_PS1`はターン開始時に`ACT_KEI_JACKKNIFE_PS1_DMG_DOWN`
    // （`UNIT_STATE`条件付きの被ダメージ-30%）を自身へ付与する。
    const result = runProductionUnitBattle(CATALOG_DIR, "UNIT_KEI_JACKKNIFE", {
      turnLimit: 5,
      randomValue: 0.5,
    });

    // 独立Reducer復元: `initialState`へ`stateTransitions`だけを適用すると
    // `finalState`と一致する（`assembleSimulationResult`も同じ不変条件を課すが、
    // ここでは補正メタデータが復元されていることまで明示的に確かめる）。
    const restored = reduceStateDeltas(
      result.initialState,
      result.stateTransitions.map((transition) => transition.stateDelta),
    );
    expect(restored).toEqual(result.finalState);

    const restoredModifiers = Object.values(restored.units).flatMap((unit) =>
      (unit?.effects ?? []).filter(
        (effect) => effect.effectDefinitionId === "ACT_KEI_JACKKNIFE_PS1_DMG_DOWN",
      ),
    );
    expect(restoredModifiers.length).toBeGreaterThan(0);
    for (const effect of restoredModifiers) {
      expect(effect.magnitude).toBeCloseTo(-0.3);
      expect(effect.damageModifier).toEqual({
        direction: "INCOMING",
        damageType: null,
        condition: {
          kind: "UNIT_STATE",
          unit: "EFFECT_OWNER",
          field: "HP_RATIO",
          op: "GTE",
          value: 0.65,
        },
      });
    }
  });

  it("IT-CAP-DAMAGE-MOD-PROD-004: a full production battle emits DamageCalculated payloads that carry both R-DMG-04 multipliers", () => {
    const result = runProductionUnitBattle(CATALOG_DIR, "UNIT_ELENA_MOODMAKER", {
      turnLimit: 5,
      randomValue: 0.5,
    });
    const calculated = result.events.filter((event) => event.type === "DAMAGE_CALCULATED");
    expect(calculated.length).toBeGreaterThan(0);
    for (const event of calculated) {
      const details = event.details as Record<string, unknown>;
      expect(typeof details["outgoingDamageMultiplier"]).toBe("number");
      expect(typeof details["incomingDamageMultiplier"]).toBe("number");
      expect(typeof details["shieldIgnoreRate"]).toBe("number");
      expect(typeof details["damageReductionIgnoreRate"]).toBe("number");
    }
  });
});
