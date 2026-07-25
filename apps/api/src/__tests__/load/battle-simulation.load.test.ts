import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createProductionBattleRunner,
  selectableProductionUnitIds,
} from "../../testing/scenario/run-production-battle.js";

/**
 * 負荷・耐久（soak）テストの最小1本（`12_テスト戦略.md`「負荷・耐久テスト」）。
 * 現時点では固定の合格閾値を設けず（配備CPU・メモリとSLO確定まで baseline を保存する方針）、
 * 「完走する・メモリが単調発散しない・実行時間が極端でない」というサニティ上限のみを assert し、
 * 測定値を baseline として出力する。回帰レビューの起点とする。
 *
 * catalog は一度だけロードして戦闘を反復する（Workerが catalog を一度だけ読み込む設計に整合し、
 * 1戦あたりコストから catalog ロードを除外する）。nightly / リリース前に `mise run test:load` で実行。
 */
const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const ITERATIONS = 200;
const TURN_LIMIT = 99;

function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const index = Math.min(
    sortedAscending.length - 1,
    Math.floor((p / 100) * sortedAscending.length),
  );
  return sortedAscending[index]!;
}

describe("battle simulation load/soak baseline", () => {
  it("LOAD-SOAK-001: repeatedly simulates a DIAGNOSTIC production battle without runaway time or heap growth, and reports a baseline", () => {
    const [unitId] = selectableProductionUnitIds(CATALOG_DIR);
    expect(unitId, "at least one selectable production unit is required").toBeDefined();

    const runBattle = createProductionBattleRunner(CATALOG_DIR, unitId!, {
      turnLimit: TURN_LIMIT,
      logLevel: "DIAGNOSTIC",
    });

    // ウォームアップ（JIT・初回割り当てを baseline から除外）。
    runBattle("B_WARMUP");
    if (globalThis.gc) globalThis.gc();
    const heapBeforeBytes = process.memoryUsage().heapUsed;

    const durationsMs: number[] = [];
    let maxEventCount = 0;
    let maxStateTransitionCount = 0;
    let maxResponseBytes = 0;

    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now();
      const result = runBattle(`B_SOAK_${i}`);
      durationsMs.push(performance.now() - start);

      // 各戦闘は決定的に完走する（例外なく outcome/completionReason を返す）。
      expect(typeof result.outcome).toBe("string");
      expect(typeof result.completionReason).toBe("string");

      maxEventCount = Math.max(maxEventCount, result.events.length);
      maxStateTransitionCount = Math.max(maxStateTransitionCount, result.stateTransitions.length);
      maxResponseBytes = Math.max(maxResponseBytes, JSON.stringify(result).length);
    }

    if (globalThis.gc) globalThis.gc();
    const heapAfterBytes = process.memoryUsage().heapUsed;
    const heapGrowthBytes = heapAfterBytes - heapBeforeBytes;

    const sorted = [...durationsMs].sort((a, b) => a - b);
    const baseline = {
      testId: "LOAD-SOAK-001",
      unitId,
      iterations: ITERATIONS,
      turnLimit: TURN_LIMIT,
      logLevel: "DIAGNOSTIC",
      durationMs: {
        p50: Number(percentile(sorted, 50).toFixed(3)),
        p95: Number(percentile(sorted, 95).toFixed(3)),
        p99: Number(percentile(sorted, 99).toFixed(3)),
        max: Number(Math.max(...durationsMs).toFixed(3)),
      },
      maxEventCount,
      maxStateTransitionCount,
      maxResponseBytes,
      heapGrowthBytes,
      gcAvailable: Boolean(globalThis.gc),
    };
    // baseline を CI ログへ残す（固定閾値の代わりに回帰レビューの基準にする）。
    console.log(`[LOAD-SOAK-001] baseline ${JSON.stringify(baseline)}`);

    // サニティ上限（配備SLO未確定のため緩め。明らかな暴走のみ検出）。
    expect(baseline.durationMs.p95).toBeLessThan(5_000);
    expect(maxEventCount).toBeGreaterThan(0);
    // メモリの単調発散を検出（GCが使える場合のみ厳密に、無い場合は緩く）。
    if (globalThis.gc) {
      expect(heapGrowthBytes).toBeLessThan(100 * 1024 * 1024);
    }
  }, 120_000);
});
