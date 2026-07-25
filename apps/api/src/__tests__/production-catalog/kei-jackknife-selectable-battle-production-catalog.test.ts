import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadBattleCatalogDirectory,
  loadCatalogFromDirectory,
} from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { GetBattleSimulationCatalogUseCase } from "../../application/catalog/get-battle-simulation-catalog-use-case.js";
import { SimulateBattleUseCase } from "../../application/simulation/simulate-battle-use-case.js";
import type { SimulateBattleCommand } from "../../application/simulation/simulate-battle-command.js";
import type { SimulationExecutionContext } from "../../application/simulation/simulation-execution-context.js";
import { FixedBattleIdGenerator } from "../../testing/id/fixed-battle-id-generator.js";
import { ManualClock } from "../../testing/clock/manual-clock.js";
import type { RandomSource } from "../../domain/ports/random-source.js";
import type { RandomSourceFactory } from "../../domain/ports/random-source-factory.js";
import { createUnitDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";

/**
 * RES-003（Issue #173）レビュー[P1]の回帰テスト: `CAP_RESOLUTION_BRANCH_REPEAT`を
 * `IMPLEMENTED`へ昇格すると`UNIT_KEI_JACKKNIFE`が初の`selectable`な実production
 * Unitになる。`selectable`は「現在の実装Capabilityで戦闘事前検証を通過できる」という
 * API契約なので、選択可能と公開したUnitは実際に戦闘を開始・完走できなければならない。
 *
 * `UNIT_KEI_JACKKNIFE`は`maximumHp`が非整数になる（PS1 `ACT_KEI_JACKKNIFE_PS1_MAXHP_UP`の
 * +20% `MAXIMUM_HP`比率補正で33623→40347.6。編成補正で端数が生じる場合も同様）。
 * `combatStats.maximumHp`はR-NUM-01/R-STA-01に従い全精度で保持する契約（後続の
 * R-STA-04再計算の基準）だが、HPゲージ最大値は整数でなければならない
 * （`createHitPoint`→`assertInteger`）。`createBattleUnit`/`applyDamageAction`の
 * ゲージ境界で最大値をR-NUM-02整数化しないと、`selectable: true`なのに最小の実戦闘
 * POSTが422で失敗する。既存のE2E smoke testはID順で先頭の`UNIT_CI_SMOKE_TEST`を
 * 選ぶためこの回帰を検出しない。
 *
 * ここでは実`catalog/`から、GET一覧APIが`UNIT_KEI_JACKKNIFE`を`selectable`と
 * 報告することを確認したうえで、そのUnitを味方・敵に据えた実戦闘を`SimulateBattleUseCase`
 * （実preflight → 実formation-factory → 実battle engine）で完走できることを検証する。
 * 乱数はconstant sourceで決定化し、outcomeが確定する（turnLimitで必ず停止）ことだけを
 * 主張する（E2E-CATALOG-PROD-SMOKE-001と同じ主張水準）。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const KEI = "UNIT_KEI_JACKKNIFE";

/** 枯渇しない決定的RandomSource（常に同じ値を返す）。完走のみを検証するため値は任意。 */
class ConstantRandomSourceFactory implements RandomSourceFactory {
  private readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
  create(): RandomSource {
    const value = this.value;
    return { next: () => value };
  }
}

function keiVsKeiCommand(): SimulateBattleCommand {
  const slot = {
    unitDefinitionId: createUnitDefinitionId(KEI),
    position: { column: 0 as const, row: "FRONT" as const },
  };
  return {
    allyFormation: { slots: [slot], memoryDefinitionIds: [] },
    enemyFormation: { slots: [slot], memoryDefinitionIds: [] },
    turnLimit: 3,
    logLevel: "DETAILED",
  };
}

function testContext(): SimulationExecutionContext {
  return { requestId: "test-kei-battle", deadlineEpochMs: Number.MAX_SAFE_INTEGER };
}

describe("production Catalog: UNIT_KEI_JACKKNIFE selectable-unit battle completion (RES-003 review [P1])", () => {
  it("IT-CAP-BRANCH-REPEAT-PROD-005: GET catalog marks UNIT_KEI_JACKKNIFE selectable once CAP_RESOLUTION_BRANCH_REPEAT is IMPLEMENTED", () => {
    const directory = loadBattleCatalogDirectory(CATALOG_DIR);
    const result = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: directory,
    }).execute();
    const kei = result.units.find((unit) => unit.unitDefinitionId === KEI);
    expect(kei).toBeDefined();
    expect(kei!.selectable).toBe(true);
  });

  it("IT-CAP-BRANCH-REPEAT-PROD-006: a real battle with the selectable UNIT_KEI_JACKKNIFE integerizes the HP gauge from its full-precision maximumHp and runs to a decided outcome (no 422 hitPoint.max regression)", () => {
    const battleCatalog = loadCatalogFromDirectory(CATALOG_DIR);
    const catalogRevision = battleCatalog.catalogRevision;
    const useCase = new SimulateBattleUseCase({
      battleCatalog,
      battleIdGenerator: new FixedBattleIdGenerator(["B_KEI"]),
      randomSourceFactory: new ConstantRandomSourceFactory(0.5),
      clock: new ManualClock(0),
    });

    const result = useCase.execute(keiVsKeiCommand(), testContext());

    expect(result.catalogRevision).toBe(catalogRevision);
    expect(result.outcome).toEqual(expect.any(String));
  });
});
