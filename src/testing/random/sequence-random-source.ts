import type { RandomSource } from "../../domain/ports/random-source.js";

/**
 * Deterministic RandomSource that returns preset values in order.
 * Throws immediately if values run out (underflow).
 * Call assertFullyConsumed() in afterEach to detect leftover values (overflow).
 */
export class SequenceRandomSource implements RandomSource {
  private readonly values: readonly number[];
  private index = 0;
  readonly consumedValues: number[] = [];

  constructor(values: readonly number[]) {
    this.values = values;
  }

  next(): number {
    if (this.index >= this.values.length) {
      throw new Error(
        `SequenceRandomSource exhausted: all ${this.values.length} preset values have been consumed`,
      );
    }
    const value = this.values[this.index];
    if (value === undefined) {
      throw new Error(`SequenceRandomSource: unexpected undefined at index ${this.index}`);
    }
    this.index++;
    this.consumedValues.push(value);
    return value;
  }

  get callCount(): number {
    return this.index;
  }

  assertFullyConsumed(): void {
    const remaining = this.values.length - this.index;
    if (remaining > 0) {
      const unused = [...this.values.slice(this.index)].join(", ");
      throw new Error(`SequenceRandomSource has ${remaining} unconsumed value(s): [${unused}]`);
    }
  }
}
