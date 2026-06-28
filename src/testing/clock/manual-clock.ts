import type { Clock } from "../../domain/ports/clock.js";

/**
 * Manually-advanceable clock for deterministic deadline tests.
 * Use advance() to move time without real sleep.
 */
export class ManualClock implements Clock {
  private currentTime: number;

  constructor(initialTime = 0) {
    this.currentTime = initialTime;
  }

  now(): number {
    return this.currentTime;
  }

  advance(ms: number): void {
    this.currentTime += ms;
  }

  set(ms: number): void {
    this.currentTime = ms;
  }
}
