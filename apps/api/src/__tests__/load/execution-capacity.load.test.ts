import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  allProductionUnitIds,
  createProductionBattleRunner,
  createProductionFormationBattleRunner,
} from "../../testing/scenario/run-production-battle.js";
import {
  DEFAULT_SIMULATION_EXECUTION_LIMITS,
  type SimulationExecutionLimits,
} from "../../application/simulation/battle-execution.js";
import { ExecutionGuardExceededError } from "../../domain/shared/errors.js";
import { ApplicationError } from "../../application/contracts/application-error.js";

/**
 * REL-005（Issue #198）の容量測定のうち、Battle実行そのものに閉じた部分
 * （`12_テスト戦略.md`「負荷・耐久テスト」シナリオの「5対5・99ターン・DETAILED」
 * 「深いPS連鎖」「多数の効果インスタンスと個別期間」「大きなイベント・状態差分」）。
 * HTTP・Worker Poolを含む容量測定は`http-capacity.load.test.ts`が持つ。
 *
 * 測定値は`console.log`へJSONで出力し、`docs/運用手順.md`「Cloud Run配備構成」の
 * M9確定値を決める根拠にする。固定閾値はSLO確定まで設けず、
 * 「production Catalogが実際に必要とする量」と「設定した上限」の間に余裕が
 * あることだけをassertする。
 */
const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const TURN_LIMIT = 99;

/**
 * production Unit全件を5体ずつに区切った5対5のミラー編成一覧。単一の組み合わせを
 * 「最大規模」と決め打つと、その組み合わせが早期決着した場合に容量を過小評価する
 * （実測: 先頭5体は99ターンに到達せず1,397イベントで終わる）。Catalog全体を
 * 走査して最悪値を採る。
 */
function maxScalePartyCandidates(
  unitIds: readonly string[],
): ReadonlyArray<{ readonly ally: readonly string[]; readonly enemy: readonly string[] }> {
  const candidates: Array<{ ally: readonly string[]; enemy: readonly string[] }> = [];
  for (let start = 0; start + 5 <= unitIds.length; start += 5) {
    const five = unitIds.slice(start, start + 5);
    candidates.push({ ally: five, enemy: five });
  }
  return candidates;
}

function limitsWith(overrides: Partial<SimulationExecutionLimits>): SimulationExecutionLimits {
  return { ...DEFAULT_SIMULATION_EXECUTION_LIMITS, ...overrides };
}

/** 実行ガード超過だけをfalseへ落とし、それ以外の失敗は測定の誤りとして送出する。 */
function completesWithin(run: () => unknown): boolean {
  try {
    run();
    return true;
  } catch (error) {
    if (error instanceof ExecutionGuardExceededError) return false;
    if (error instanceof ApplicationError && error.code === "EXECUTION_LIMIT_EXCEEDED")
      return false;
    throw error;
  }
}

/**
 * `completesWithin`が真になる最小の上限値を`[1, ceiling]`から二分探索する。
 * 上限を下げるほど失敗しやすい単調な性質を前提にする（ガードは「超過したら止める」
 * だけで、低い上限で通ったものが高い上限で落ちることはない）。
 */
function smallestPassingLimit(ceiling: number, passesAt: (limit: number) => boolean): number {
  let low = 1;
  let high = ceiling;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (passesAt(middle)) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

describe("battle execution capacity baseline", () => {
  it("LOAD-CAPACITY-001 (11_インフラストラクチャ設計.md「負荷試験で99ターン・DETAILEDの上限シナリオを測定する」): measures the maximum-scale 5v5 / 99-turn / DETAILED battle — response size, serialization, and compression — and reports the baseline that sizes the Cloud Run memory limit", () => {
    const unitIds = allProductionUnitIds(CATALOG_DIR);
    expect(
      unitIds.length,
      "at least five selectable production units are required",
    ).toBeGreaterThan(4);

    const candidates = maxScalePartyCandidates(unitIds);
    // ウォームアップ（JIT・初回割り当てを baseline から除外）。
    createProductionFormationBattleRunner(CATALOG_DIR, candidates[0]!, {
      turnLimit: TURN_LIMIT,
      logLevel: "DETAILED",
    })("B_MAXSCALE_WARMUP");

    let worst:
      | {
          allyUnitIds: readonly string[];
          completionReason: string;
          completedTurn: number | undefined;
          executionMs: number;
          eventCount: number;
          stateTransitionCount: number;
          responseBytes: number;
          serializeMs: number;
          gzipBytes: number;
          gzipMs: number;
          gzipRatio: number;
          battleHeapGrowthBytes: number;
        }
      | undefined;

    for (const [index, parties] of candidates.entries()) {
      const runBattle = createProductionFormationBattleRunner(CATALOG_DIR, parties, {
        turnLimit: TURN_LIMIT,
        logLevel: "DETAILED",
      });

      if (globalThis.gc) globalThis.gc();
      const heapBeforeBytes = process.memoryUsage().heapUsed;
      const executionStart = performance.now();
      const result = runBattle(`B_MAXSCALE_${index}`);
      const executionMs = performance.now() - executionStart;
      const heapAfterBytes = process.memoryUsage().heapUsed;

      const serializeStart = performance.now();
      const serialized = JSON.stringify(result);
      const serializeMs = performance.now() - serializeStart;
      const responseBytes = Buffer.byteLength(serialized, "utf8");

      const compressStart = performance.now();
      const compressed = gzipSync(Buffer.from(serialized, "utf8"));
      const compressMs = performance.now() - compressStart;

      expect(result.completionReason).toBeDefined();
      if (worst === undefined || responseBytes > worst.responseBytes) {
        worst = {
          allyUnitIds: parties.ally,
          completionReason: String(result.completionReason),
          completedTurn: result.finalState?.currentTurn,
          executionMs: Number(executionMs.toFixed(3)),
          eventCount: result.events.length,
          stateTransitionCount: result.stateTransitions.length,
          responseBytes,
          serializeMs: Number(serializeMs.toFixed(3)),
          gzipBytes: compressed.byteLength,
          gzipMs: Number(compressMs.toFixed(3)),
          gzipRatio: Number((compressed.byteLength / responseBytes).toFixed(4)),
          // 1戦分の実行で増えたheap（GCが使えない環境では上振れする参考値）。
          battleHeapGrowthBytes: heapAfterBytes - heapBeforeBytes,
        };
      }
    }

    const baseline = {
      testId: "LOAD-CAPACITY-001",
      partyCount: candidates.length,
      turnLimit: TURN_LIMIT,
      logLevel: "DETAILED",
      worst,
      gcAvailable: Boolean(globalThis.gc),
    };
    console.log(`[LOAD-CAPACITY-001] baseline ${JSON.stringify(baseline)}`);

    // 最大規模でも完走し、実行ガードの総イベント数上限に対して余裕があること。
    expect(worst!.eventCount).toBeGreaterThan(0);
    expect(worst!.eventCount).toBeLessThan(DEFAULT_SIMULATION_EXECUTION_LIMITS.maxTotalEvents);
  }, 300_000);

  it("LOAD-CAPACITY-002 (11_インフラストラクチャ設計.md「SimulationExecutionGuard」の上限決定): measures the smallest execution guard limits the maximum-scale battle actually needs, so the configured ceilings can be justified as headroom rather than guesses", () => {
    const unitIds = allProductionUnitIds(CATALOG_DIR);
    // 上限探索は1編成で足りる（他編成は`LOAD-CAPACITY-003`の全件走査が覆う）。
    const parties = maxScalePartyCandidates(unitIds)[0]!;
    const runWith = (executionLimits: SimulationExecutionLimits) => () =>
      createProductionFormationBattleRunner(CATALOG_DIR, parties, {
        turnLimit: TURN_LIMIT,
        logLevel: "DETAILED",
        executionLimits,
      })("B_GUARD_PROBE");

    const requiredPassiveDepth = smallestPassingLimit(
      DEFAULT_SIMULATION_EXECUTION_LIMITS.maxPassiveDepth,
      (maxPassiveDepth) => completesWithin(runWith(limitsWith({ maxPassiveDepth }))),
    );
    const requiredEffectsPerScope = smallestPassingLimit(
      DEFAULT_SIMULATION_EXECUTION_LIMITS.maxEffectsPerScope,
      (maxEffectsPerScope) => completesWithin(runWith(limitsWith({ maxEffectsPerScope }))),
    );

    const baseline = {
      testId: "LOAD-CAPACITY-002",
      turnLimit: TURN_LIMIT,
      logLevel: "DETAILED",
      requiredPassiveDepth,
      configuredPassiveDepth: DEFAULT_SIMULATION_EXECUTION_LIMITS.maxPassiveDepth,
      requiredEffectsPerScope,
      configuredEffectsPerScope: DEFAULT_SIMULATION_EXECUTION_LIMITS.maxEffectsPerScope,
    };
    console.log(`[LOAD-CAPACITY-002] baseline ${JSON.stringify(baseline)}`);

    // 上限は「正常系が必要とする量」より厳密に大きい——等しければ、production
    // Catalogが1段深い連鎖を持った瞬間に正常な戦闘が503で落ちる。
    expect(requiredPassiveDepth).toBeLessThan(DEFAULT_SIMULATION_EXECUTION_LIMITS.maxPassiveDepth);
    expect(requiredEffectsPerScope).toBeLessThan(
      DEFAULT_SIMULATION_EXECUTION_LIMITS.maxEffectsPerScope,
    );
  });

  it("LOAD-CAPACITY-003 (12_テスト戦略.md「深いPS連鎖」「多数の効果インスタンスと個別期間」): sweeps every selectable production unit at the configured guard limits and reports the worst-case event and state-delta volume across the whole Catalog", () => {
    const unitIds = allProductionUnitIds(CATALOG_DIR);

    let worst = {
      unitId: "",
      eventCount: 0,
      stateTransitionCount: 0,
      responseBytes: 0,
      executionMs: 0,
      serializeMs: 0,
      gzipBytes: 0,
      gzipMs: 0,
      gzipRatio: 0,
    };
    let totalEvents = 0;
    let peakRssBytes = 0;
    const durationsMs: number[] = [];

    for (const unitId of unitIds) {
      const runBattle = createProductionBattleRunner(CATALOG_DIR, unitId, {
        turnLimit: TURN_LIMIT,
        logLevel: "DETAILED",
      });
      const start = performance.now();
      const result = runBattle(`B_SWEEP_${unitId}`);
      const executionMs = performance.now() - start;
      durationsMs.push(executionMs);
      totalEvents += result.events.length;
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);

      const serializeStart = performance.now();
      const serialized = JSON.stringify(result);
      const serializeMs = performance.now() - serializeStart;
      const responseBytes = Buffer.byteLength(serialized, "utf8");

      if (responseBytes > worst.responseBytes) {
        // 最大応答になったときだけ圧縮を測る（全件の圧縮は測定自体の支配的コストになる）。
        const compressStart = performance.now();
        const compressed = gzipSync(Buffer.from(serialized, "utf8"));
        const gzipMs = performance.now() - compressStart;
        worst = {
          unitId,
          eventCount: result.events.length,
          stateTransitionCount: result.stateTransitions.length,
          responseBytes,
          executionMs: Number(executionMs.toFixed(3)),
          serializeMs: Number(serializeMs.toFixed(3)),
          gzipBytes: compressed.byteLength,
          gzipMs: Number(gzipMs.toFixed(3)),
          gzipRatio: Number((compressed.byteLength / responseBytes).toFixed(4)),
        };
        peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      }
    }

    const baseline = {
      testId: "LOAD-CAPACITY-003",
      unitCount: unitIds.length,
      turnLimit: TURN_LIMIT,
      logLevel: "DETAILED",
      totalEvents,
      worst,
      slowestMs: Number(Math.max(...durationsMs).toFixed(3)),
      peakRssBytes,
    };
    console.log(`[LOAD-CAPACITY-003] baseline ${JSON.stringify(baseline)}`);

    // 全ユニットが既定の上限で完走する（ここまで到達している時点で
    // `EXECUTION_LIMIT_EXCEEDED`は起きていない）。
    expect(worst.eventCount).toBeGreaterThan(0);
    expect(worst.eventCount).toBeLessThan(DEFAULT_SIMULATION_EXECUTION_LIMITS.maxTotalEvents);
  }, 300_000);
});
