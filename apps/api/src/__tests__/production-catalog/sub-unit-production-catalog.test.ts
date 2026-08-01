import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runProductionUnitBattle } from "../../testing/scenario/run-production-battle.js";
import { reduceStateDeltas } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * DMG-005（Issue #190、R-SUB-01/R-SUB-02）: 実 `catalog/` の `APPLY_SUBUNIT` 定義を、
 * 実戦闘（`runProductionUnitBattle`）と独立Reducer復元へ通す。
 *
 * `CAP_SUBUNIT` の `verification.productionDefinitionIds` に載せた定義が、Catalog上の
 * 変換だけでなく実行時にも意図どおり効くことをここで固定する。それぞれ別の側面を担う。
 *
 * - `ACT_SHIRANA_SORA_EX_SUBUNIT`: `SUBUNIT_DURATION`（raw「3行動の間」）と、
 *   吸収・追加ダメージ・保存則（R-SHD-02 #4／`08_ドメインイベント.md`不変条件#6）
 * - `ACT_SHIRANA_SORA_AS1_SUBUNIT`: `SUBUNIT_ADDITIONAL_DAMAGE_DEBUFF`
 *   （raw「攻撃対象の行動速度を20低下させるデバフ（重複可）」）
 * - `ACT_OLGA_VETERAN_PS1_SUBUNIT`: 同じサブユニットを3つ付与する定義形と、
 *   期間を持たない`ACT_OLGA_VETERAN_PS2_SUBUNIT`（raw「カムラッドⅠ」）の対比
 * - `ACT_NADYA_SUCCESSOR_EX_SUBUNIT`: 型ごとに異なる存続期間（2行動/1行動）
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

function subUnitDefinition(unitDefinitionId: string, effectActionDefinitionId: string) {
  const snapshot = loadCatalogFromDirectory(CATALOG_DIR).loadSnapshot(
    [unitDefinitionId as never],
    [],
  );
  const definition = snapshot.effectActions.get(effectActionDefinitionId as never);
  if (definition?.kind !== "APPLY_SUBUNIT") {
    throw new Error(`production Catalog has no APPLY_SUBUNIT "${effectActionDefinitionId}"`);
  }
  return definition;
}

describe("production Catalog APPLY_SUBUNIT (CAP_SUBUNIT, DMG-005 Issue #190)", () => {
  it("IT-CAP-SUBUNIT-PROD-001: absorbs real-battle damage after the shields and conserves the calculated damage across every destination", () => {
    // raw原文「3行動の間、自身の最大HP×35%のHPを持ち……ENダメージを追加する
    // サブユニット『子機Ⅱ』を付与する」（`SUBUNIT_DURATION`の近似解除）。
    const definition = subUnitDefinition("UNIT_SHIRANA_SORA", "ACT_SHIRANA_SORA_EX_SUBUNIT");
    expect(definition.payload.duration.timeLimit).toEqual({ unit: "ACTION", count: 3 });
    expect(definition.payload.additionalDamage.damageType).toBe("EN");

    const result = runProductionUnitBattle(CATALOG_DIR, "UNIT_SHIRANA_SORA", {
      turnLimit: 5,
      randomValue: 0.5,
    });

    const damaged = result.events.filter((event) => event.type === "SUB_UNIT_DAMAGED");
    expect(damaged.length).toBeGreaterThan(0);
    for (const event of damaged) {
      const details = event.details as Record<string, unknown>;
      expect(details["reason"]).toBe("DAMAGE_ABSORPTION");
      expect(details["absorbed"]).toBe(
        (details["before"] as number) - (details["after"] as number),
      );
    }

    // R-SHD-03／`08_ドメインイベント.md`不変条件#6: シールド吸収・サブユニット吸収・
    // HPダメージ・超過破棄の合計が計算ダメージと一致する。
    const applied = result.events.filter((event) => event.type === "DAMAGE_APPLIED");
    expect(applied.length).toBeGreaterThan(0);
    const subUnitAbsorbedTotal = applied.reduce((sum, event) => {
      const details = event.details as Record<string, number | undefined>;
      expect(
        details["typedShieldAbsorbed"]! +
          details["untypedShieldAbsorbed"]! +
          details["subUnitAbsorbed"]! +
          details["hitPointDamage"]! +
          details["discardedDamage"]!,
      ).toBe(details["calculatedDamage"]);
      return sum + details["subUnitAbsorbed"]!;
    }, 0);
    expect(subUnitAbsorbedTotal).toBeGreaterThan(0);

    // 独立Reducer復元: `initialState`へ`stateTransitions`だけを適用すると
    // `finalState`と一致する — 残耐久力（`EffectSnapshot.subUnit`）も含めて。
    const restored = reduceStateDeltas(
      result.initialState,
      result.stateTransitions.map((transition) => transition.stateDelta),
    );
    expect(restored).toEqual(result.finalState);
  });

  it("IT-CAP-SUBUNIT-PROD-002: adds SKL_SHIRANA_SORA_AS1's accompanying action-speed debuff alongside the subunit's additional damage", () => {
    const definition = subUnitDefinition("UNIT_SHIRANA_SORA", "ACT_SHIRANA_SORA_AS1_SUBUNIT");
    // raw原文「……ENダメージと、攻撃対象の行動速度を20低下させるデバフ（重複可）を
    // 追加するサブユニット『子機Ⅰ』」（`SUBUNIT_ADDITIONAL_DAMAGE_DEBUFF`の近似解除）。
    expect(definition.payload.additionalDamage.debuff).toEqual({
      effectActionDefinitionId: "ACT_SHIRANA_SORA_AS1_SUBUNIT_SPEED_DOWN",
    });
    expect(definition.payload.duration.timeLimit).toEqual({ unit: "ACTION", count: 3 });

    const snapshot = loadCatalogFromDirectory(CATALOG_DIR).loadSnapshot(
      ["UNIT_SHIRANA_SORA" as never],
      [],
    );
    // 追加デバフはスキルのstepからは参照されないが、推移閉包へ含まれている。
    const debuff = snapshot.effectActions.get("ACT_SHIRANA_SORA_AS1_SUBUNIT_SPEED_DOWN" as never);
    expect(debuff?.kind).toBe("APPLY_STAT_MOD");
    if (debuff?.kind === "APPLY_STAT_MOD") {
      expect(debuff.payload.stat).toBe("ACTION_SPEED");
      expect(debuff.payload.formula).toEqual({ kind: "CONSTANT", value: -20 });
      // raw原文「（重複可）」。
      expect(debuff.payload.stacking.mode).toBe("STACKABLE");
    }

    const result = runProductionUnitBattle(CATALOG_DIR, "UNIT_SHIRANA_SORA", {
      turnLimit: 5,
      randomValue: 0.5,
    });
    const debuffApplied = result.events.filter(
      (event) =>
        event.type === "EFFECT_APPLIED" &&
        (event.details as Record<string, unknown>)["effectActionDefinitionId"] ===
          "ACT_SHIRANA_SORA_AS1_SUBUNIT_SPEED_DOWN",
    );
    expect(debuffApplied.length).toBeGreaterThan(0);

    const restored = reduceStateDeltas(
      result.initialState,
      result.stateTransitions.map((transition) => transition.stateDelta),
    );
    expect(restored).toEqual(result.finalState);
  });

  it("IT-CAP-SUBUNIT-PROD-003: carries SKL_OLGA_VETERAN's two subunit lifetimes without approximation (2 actions for カムラッドⅡ, no time limit for カムラッドⅠ)", () => {
    // raw原文「2行動の間、……サブユニット『カムラッドⅡ』を3つ付与する」。
    const camrad2 = subUnitDefinition("UNIT_OLGA_VETERAN", "ACT_OLGA_VETERAN_PS1_SUBUNIT");
    expect(camrad2.payload.duration.timeLimit).toEqual({ unit: "ACTION", count: 2 });
    expect(camrad2.payload.additionalDamage.damageType).toBe("EN");

    // raw原文「自身の最大HP×15%のHPを持ち、攻撃時に攻撃力×5.46%のENダメージを追加する
    // サブユニット『カムラッドⅠ』を3つ付与する」— 存続期間の記載がないため
    // 耐久力が尽きるまで存続する（`timeLimit`なし）。
    const camrad1 = subUnitDefinition("UNIT_OLGA_VETERAN", "ACT_OLGA_VETERAN_PS2_SUBUNIT");
    expect(camrad1.payload.duration.timeLimit).toBeUndefined();
    expect(camrad1.payload.duration.dispellable).toBe(true);

    // 「3つ付与する」は同じEffectActionを3回参照するstepとして表す。
    const snapshot = loadCatalogFromDirectory(CATALOG_DIR).loadSnapshot(
      ["UNIT_OLGA_VETERAN" as never],
      [],
    );
    const ps1 = snapshot.skills.get("SKL_OLGA_VETERAN_PS1" as never)!;
    const subUnitReferences =
      ps1.resolution.kind === "CHARGE"
        ? []
        : ps1.resolution.steps.flatMap((step) =>
            step.kind === "ACTION"
              ? step.actions.filter(
                  (action) => action.effectActionDefinitionId === "ACT_OLGA_VETERAN_PS1_SUBUNIT",
                )
              : [],
          );
    expect(subUnitReferences).toHaveLength(3);
  });

  it("IT-CAP-SUBUNIT-PROD-004: keeps each ドルズィヤ variant's own lifetime and drives them through a real battle", () => {
    // raw原文の存続期間: Ⅳ(EX)は2行動、Ⅰ(AS1)・Ⅱ(PS1)・Ⅲ(PS2)は1行動。
    const expected: Record<string, number> = {
      ACT_NADYA_SUCCESSOR_EX_SUBUNIT: 2,
      ACT_NADYA_SUCCESSOR_AS1_SUBUNIT: 1,
      ACT_NADYA_SUCCESSOR_PS1_SUBUNIT: 1,
      ACT_NADYA_SUCCESSOR_PS2_SUBUNIT: 1,
    };
    for (const [effectActionDefinitionId, count] of Object.entries(expected)) {
      const definition = subUnitDefinition("UNIT_NADYA_SUCCESSOR", effectActionDefinitionId);
      expect(definition.payload.duration.timeLimit).toEqual({ unit: "ACTION", count });
      // raw原文がダメージタイプを書いていないため、契機になった攻撃のタイプを引き継ぐ。
      expect(definition.payload.additionalDamage.damageType).toBeUndefined();
    }

    const result = runProductionUnitBattle(CATALOG_DIR, "UNIT_NADYA_SUCCESSOR", {
      turnLimit: 5,
      randomValue: 0.5,
    });
    const granted = result.events.filter(
      (event) =>
        event.type === "EFFECT_APPLIED" &&
        String((event.details as Record<string, unknown>)["effectActionDefinitionId"]).endsWith(
          "_SUBUNIT",
        ),
    );
    expect(granted.length).toBeGreaterThan(0);
    // R-SUB-01: サブユニットが実際にダメージを吸収し、耐久力が尽きたものは失効する。
    expect(
      result.events.filter((event) => event.type === "SUB_UNIT_DAMAGED").length,
    ).toBeGreaterThan(0);

    const restored = reduceStateDeltas(
      result.initialState,
      result.stateTransitions.map((transition) => transition.stateDelta),
    );
    expect(restored).toEqual(result.finalState);
  });
});
