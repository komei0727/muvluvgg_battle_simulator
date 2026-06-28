/**
 * Generates predictable string IDs for tests: `<prefix>-1`, `<prefix>-2`, ...
 * Each instance maintains its own counter. Use a new instance per test to keep sequences isolated.
 */
export class SequenceIdGenerator {
  private readonly prefix: string;
  private counter = 0;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  next(): string {
    return `${this.prefix}-${++this.counter}`;
  }

  get callCount(): number {
    return this.counter;
  }
}
