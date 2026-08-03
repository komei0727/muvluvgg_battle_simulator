import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runProductionUnitBattle } from "../../testing/scenario/run-production-battle.js";
import { reduceStateDeltas } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import { effectActionFrom, loadProductionSnapshot } from "../../testing/fixtures/index.js";

/**
 * DMG-008（Issue #189、R-DOT-01〜04）: 実 `catalog/` の `APPLY_CONTINUOUS_DAMAGE`
 * 定義を、実戦闘（`runProductionUnitBattle`）と独立Reducer復元へ通す。
 *
 * `CAP_CONTINUOUS_DAMAGE` の `verification.productionDefinitionIds` に載せた3定義が、
 * Catalog上の変換だけでなく実行時にも意図どおり効くことをここで固定する。
 * それぞれ別の種別（`continuousDamageKind`）を担う。
 *
 * - `ACT_SENKA_SCHEMER_AS1_BURN`: 炎上（R-DOT-03）。raw原文「3行動分の炎上を
 *   付与する。炎上は攻撃力×30%の持続ダメージを与える」
 * - `ACT_LUCIE_COMPANION_EX_POISON`: 毒（R-DOT-04）。raw原文「1行動の毒を付与する。
 *   毒状態は行動タイミングごとに現在HPの20%のダメージを受ける」
 * - `ACT_MAO_COMMITTEE_AS2_DMG_DEBUFF`: 固定継続ダメージ（R-DOT-02）。raw原文
 *   「敵前後列に3行動の間、行動時に攻撃力×20%のENダメージを受けるデバフ」
 *
 * 3件とも`CAP_CONTINUOUS_DAMAGE`が`IMPLEMENTED`になったことで`selectable`へ
 * 変わったUnitの定義であり、preflightを通って実戦闘へ到達できる。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

function continuousDamageDefinition(unitDefinitionId: string, effectActionDefinitionId: string) {
  const snapshot = loadProductionSnapshot(CATALOG_DIR, [unitDefinitionId]);
  const definition = effectActionFrom(snapshot, effectActionDefinitionId);
  if (definition.kind !== "APPLY_CONTINUOUS_DAMAGE") {
    throw new Error(
      `production Catalog has no APPLY_CONTINUOUS_DAMAGE "${effectActionDefinitionId}"`,
    );
  }
  return definition;
}

describe("production Catalog APPLY_CONTINUOUS_DAMAGE (CAP_CONTINUOUS_DAMAGE, DMG-008 Issue #189)", () => {
  it("IT-CAP-CONTINUOUS-DAMAGE-PROD-001: fires ACT_SENKA_SCHEMER_AS1_BURN as a BURN at the holder's own action start and restores the same HP through the independent Reducer", () => {
    const definition = continuousDamageDefinition(
      "UNIT_SENKA_SCHEMER",
      "ACT_SENKA_SCHEMER_AS1_BURN",
    );
    // raw原文「炎上は攻撃力×30%の持続ダメージを与える」を近似なしで表す。
    expect(definition.payload.continuousDamageKind).toBe("BURN");
    expect(definition.payload.formula).toMatchObject({ kind: "STAT_RATIO", ratio: 0.3 });
    // R-DOT-01「付与対象の行動開始時に発生する」。
    expect(definition.payload.timing).toEqual({
      eventType: "ActionStarted",
      targetSelector: "EFFECT_OWNER",
    });

    const result = runProductionUnitBattle(CATALOG_DIR, "UNIT_SENKA_SCHEMER", {
      turnLimit: 5,
      randomValue: 0.5,
    });

    const ticks = result.events.filter(
      (event) =>
        event.type === "CONTINUOUS_DAMAGE_APPLIED" &&
        (event.details as Record<string, unknown>)["effectActionDefinitionId"] ===
          "ACT_SENKA_SCHEMER_AS1_BURN",
    );
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      const details = tick.details as Record<string, number | string | boolean>;
      expect(details["continuousDamageKind"]).toBe("BURN");
      // R-DOT-01「ダメージが1未満なら最低1とする」。
      expect(details["calculatedDamage"] as number).toBeGreaterThanOrEqual(1);
      // R-SUB-01/R-LNK-02: 炎上はシールドで受けない。
      expect(details["typedShieldAbsorbed"]).toBe(0);
      expect(details["untypedShieldAbsorbed"]).toBe(0);
      // 保存則: 吸収 + HPダメージ + 超過破棄 = 計算ダメージ。
      expect(
        (details["typedShieldAbsorbed"] as number) +
          (details["untypedShieldAbsorbed"] as number) +
          (details["hitPointDamage"] as number) +
          (details["discardedDamage"] as number),
      ).toBe(details["calculatedDamage"]);
      // R-DOT-01: 付与時攻撃力のスナップショットを常に運ぶ。
      expect(details["snapshotAttack"] as number).toBeGreaterThan(0);
    }

    const restored = reduceStateDeltas(
      result.initialState,
      result.stateTransitions.map((transition) => transition.stateDelta),
    );
    expect(restored).toEqual(result.finalState);
  });

  it("IT-CAP-CONTINUOUS-DAMAGE-PROD-002: fires ACT_LUCIE_COMPANION_EX_POISON as a POISON capped by the granter's snapshot attack and never absorbed by shields", () => {
    const definition = continuousDamageDefinition(
      "UNIT_LUCIE_COMPANION",
      "ACT_LUCIE_COMPANION_EX_POISON",
    );
    // raw原文「毒状態は行動タイミングごとに現在HPの20%のダメージを受ける」。
    expect(definition.payload.continuousDamageKind).toBe("POISON");
    expect(definition.payload.formula).toMatchObject({
      kind: "CURRENT_HP_RATIO",
      source: { kind: "TARGET" },
      ratio: 0.2,
    });

    // R-DOT-01: `ActionPointConsumed`/`EFFECT_SOURCE`という到達不能な`timing`は
    // 残っていない（PS由来の毒2件も保持者自身の行動開始で発生する）。
    for (const id of ["ACT_CHIYURU_MAZE_PS1_POISON", "ACT_CHIYURU_MAZE_PS2_POISON"]) {
      expect(continuousDamageDefinition("UNIT_CHIYURU_MAZE", id).payload.timing).toEqual({
        eventType: "ActionStarted",
        targetSelector: "EFFECT_OWNER",
      });
    }

    const result = runProductionUnitBattle(CATALOG_DIR, "UNIT_LUCIE_COMPANION", {
      turnLimit: 5,
      randomValue: 0.5,
    });

    const ticks = result.events.filter(
      (event) =>
        event.type === "CONTINUOUS_DAMAGE_APPLIED" &&
        (event.details as Record<string, unknown>)["continuousDamageKind"] === "POISON",
    );
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      const details = tick.details as Record<string, number | string | boolean>;
      // R-DOT-04「毒ダメージはシールドとサブユニットで受けない」。
      expect(details["typedShieldAbsorbed"]).toBe(0);
      expect(details["untypedShieldAbsorbed"]).toBe(0);
      // R-DOT-04「上限ダメージ = 付与時攻撃力 × 100%」。
      expect(details["calculatedDamage"] as number).toBeLessThanOrEqual(
        details["snapshotAttack"] as number,
      );
      if (details["cappedBySnapshotAttack"] === true) {
        expect(details["formulaResult"] as number).toBeGreaterThan(
          details["snapshotAttack"] as number,
        );
      }
    }

    const restored = reduceStateDeltas(
      result.initialState,
      result.stateTransitions.map((transition) => transition.stateDelta),
    );
    expect(restored).toEqual(result.finalState);
  });

  it("IT-CAP-CONTINUOUS-DAMAGE-PROD-003: fires ACT_MAO_COMMITTEE_AS2_DMG_DEBUFF as a shield-eligible FIXED continuous EN damage that uses its grant-time attack snapshot", () => {
    const definition = continuousDamageDefinition(
      "UNIT_MAO_COMMITTEE",
      "ACT_MAO_COMMITTEE_AS2_DMG_DEBUFF",
    );
    // raw原文「敵前後列に3行動の間、行動時に攻撃力×20%のENダメージを受けるデバフ」—
    // 炎上でも毒でもない固定継続ダメージ。
    expect(definition.payload.continuousDamageKind).toBe("FIXED");
    expect(definition.payload.damageType).toBe("EN");
    expect(definition.payload.formula).toMatchObject({ kind: "STAT_RATIO", ratio: 0.2 });

    const result = runProductionUnitBattle(CATALOG_DIR, "UNIT_MAO_COMMITTEE", {
      turnLimit: 5,
      randomValue: 0.5,
    });

    const ticks = result.events.filter(
      (event) =>
        event.type === "CONTINUOUS_DAMAGE_APPLIED" &&
        (event.details as Record<string, unknown>)["effectActionDefinitionId"] ===
          "ACT_MAO_COMMITTEE_AS2_DMG_DEBUFF",
    );
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      const details = tick.details as Record<string, number | string | boolean>;
      expect(details["continuousDamageKind"]).toBe("FIXED");
      expect(details["damageType"]).toBe("EN");
      // R-DOT-03の2倍は炎上だけの規則であり、固定継続ダメージには掛からない。
      expect(details["burnStackMultiplier"]).toBe(1);
      // R-DOT-04の上限は毒だけの規則。
      expect(details["cappedBySnapshotAttack"]).toBe(false);
      // R-DOT-01/R-DOT-02: 付与時攻撃力 × 20% を切り捨てた固定量。シールドが
      // 一切無い盤面のため、全量がHPへ向かう（R-DOT-02の適用順の最終段）。
      expect(details["calculatedDamage"]).toBe(
        Math.max(1, Math.floor((details["snapshotAttack"] as number) * 0.2)),
      );
    }

    const restored = reduceStateDeltas(
      result.initialState,
      result.stateTransitions.map((transition) => transition.stateDelta),
    );
    expect(restored).toEqual(result.finalState);
  });
});
