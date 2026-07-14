import { describe, expect, it } from "vitest";
import { WorkerErrorCircuitBreaker } from "./worker-error-circuit-breaker.js";

describe("WorkerErrorCircuitBreaker", () => {
  it("CIRCUIT-001: stays closed with no errors recorded", () => {
    const breaker = new WorkerErrorCircuitBreaker(3);
    expect(breaker.isOpen()).toBe(false);
  });

  it("CIRCUIT-002: stays closed while errors remain below the threshold", () => {
    const breaker = new WorkerErrorCircuitBreaker(3);
    breaker.recordError();
    breaker.recordError();
    expect(breaker.isOpen()).toBe(false);
  });

  it("CIRCUIT-003 (11_インフラストラクチャ設計.md「連続ワーカー障害によるサーキット状態でない」): opens once consecutive errors reach the threshold", () => {
    const breaker = new WorkerErrorCircuitBreaker(3);
    breaker.recordError();
    breaker.recordError();
    breaker.recordError();
    expect(breaker.isOpen()).toBe(true);
  });

  it("CIRCUIT-004: a success resets the consecutive error count, closing the circuit again", () => {
    const breaker = new WorkerErrorCircuitBreaker(3);
    breaker.recordError();
    breaker.recordError();
    breaker.recordSuccess();
    breaker.recordError();
    breaker.recordError();
    expect(breaker.isOpen()).toBe(false);
  });

  it("CIRCUIT-005: once open, stays open until a success is recorded", () => {
    const breaker = new WorkerErrorCircuitBreaker(2);
    breaker.recordError();
    breaker.recordError();
    expect(breaker.isOpen()).toBe(true);
    breaker.recordError();
    expect(breaker.isOpen()).toBe(true);
    breaker.recordSuccess();
    expect(breaker.isOpen()).toBe(false);
  });

  it("CIRCUIT-006: defaults to a threshold of 3 consecutive errors when none is specified", () => {
    const breaker = new WorkerErrorCircuitBreaker();
    breaker.recordError();
    breaker.recordError();
    expect(breaker.isOpen()).toBe(false);
    breaker.recordError();
    expect(breaker.isOpen()).toBe(true);
  });
});
