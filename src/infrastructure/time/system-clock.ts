import type { Clock } from "../../domain/ports/clock.js";

/** Wall-clock `Clock` adapter backing production `deadlineEpochMs` checks. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}
