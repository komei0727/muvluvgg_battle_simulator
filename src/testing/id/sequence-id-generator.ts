/**
 * Generates predictable string IDs for tests: `<prefix>-1`, `<prefix>-2`, ...
 * Each instance maintains its own counter to keep tests isolated.
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

  reset(): void {
    this.counter = 0;
  }
}
