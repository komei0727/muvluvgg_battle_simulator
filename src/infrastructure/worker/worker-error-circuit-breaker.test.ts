import { describe, expect, it } from "vitest";
import { WorkerErrorCircuitBreaker } from "./worker-error-circuit-breaker.js";
import { ManualClock } from "../../testing/clock/manual-clock.js";

describe("WorkerErrorCircuitBreaker", () => {
  it("CIRCUIT-001: stays closed with no errors recorded", () => {
    const breaker = new WorkerErrorCircuitBreaker(new ManualClock(), 3);
    expect(breaker.isOpen()).toBe(false);
  });

  it("CIRCUIT-002: stays closed while errors remain below the threshold", () => {
    const breaker = new WorkerErrorCircuitBreaker(new ManualClock(), 3);
    breaker.recordError();
    breaker.recordError();
    expect(breaker.isOpen()).toBe(false);
  });

  it("CIRCUIT-003 (11_インフラストラクチャ設計.md「一定時間内に障害が連続した場合はreadinessを失敗させる」): opens once consecutive errors within the window reach the threshold", () => {
    const clock = new ManualClock();
    const breaker = new WorkerErrorCircuitBreaker(clock, 3, 60_000);
    breaker.recordError();
    clock.advance(1_000);
    breaker.recordError();
    clock.advance(1_000);
    breaker.recordError();
    expect(breaker.isOpen()).toBe(true);
  });

  it("CIRCUIT-004: a success resets recorded errors, closing the circuit again", () => {
    const breaker = new WorkerErrorCircuitBreaker(new ManualClock(), 3);
    breaker.recordError();
    breaker.recordError();
    breaker.recordSuccess();
    breaker.recordError();
    breaker.recordError();
    expect(breaker.isOpen()).toBe(false);
  });

  it("CIRCUIT-005: once open, stays open until a success is recorded", () => {
    const breaker = new WorkerErrorCircuitBreaker(new ManualClock(), 2);
    breaker.recordError();
    breaker.recordError();
    expect(breaker.isOpen()).toBe(true);
    breaker.recordError();
    expect(breaker.isOpen()).toBe(true);
    breaker.recordSuccess();
    expect(breaker.isOpen()).toBe(false);
  });

  it("CIRCUIT-006: defaults to a threshold of 3 consecutive errors when none is specified", () => {
    const breaker = new WorkerErrorCircuitBreaker(new ManualClock());
    breaker.recordError();
    breaker.recordError();
    expect(breaker.isOpen()).toBe(false);
    breaker.recordError();
    expect(breaker.isOpen()).toBe(true);
  });

  it("CIRCUIT-007 (PRレビュー指摘: 時刻を持たないと散発的な障害が無期限に蓄積し、長期間隔の異常でも『連続』と誤認する): errors that fall outside the time window do not count toward the threshold, even without an intervening success", () => {
    const clock = new ManualClock();
    const breaker = new WorkerErrorCircuitBreaker(clock, 3, 60_000);

    breaker.recordError();
    clock.advance(30_000);
    breaker.recordError();
    // 1件目の記録から70秒経過——60秒の時間窓の外に押し出される。
    clock.advance(40_000);
    breaker.recordError();

    // 時間窓内に残っているのは直近2件（2件目・3件目）だけなので、
    // 閾値3には届かない。
    expect(breaker.isOpen()).toBe(false);
  });

  it("CIRCUIT-008: isOpen() re-evaluates the window even without a new recordError() call, so a stale open circuit closes once every recorded error has aged out", () => {
    const clock = new ManualClock();
    const breaker = new WorkerErrorCircuitBreaker(clock, 2, 60_000);

    breaker.recordError();
    breaker.recordError();
    expect(breaker.isOpen()).toBe(true);

    clock.advance(60_001);
    expect(breaker.isOpen()).toBe(false);
  });
});
