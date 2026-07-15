import { SequenceRandomSource } from "./sequence-random-source.js";
import type { RandomSource } from "../../domain/ports/random-source.js";
import type { RandomSourceFactory } from "../../domain/ports/random-source-factory.js";

/**
 * Deterministic `RandomSourceFactory` (`12_テスト戦略.md`): returns a fresh
 * `SequenceRandomSource` seeded with the same preset values on every `create()`
 * call, so each simulated Battle gets its own independent, exhaustible sequence.
 */
export class SequenceRandomSourceFactory implements RandomSourceFactory {
  private readonly values: readonly number[];

  constructor(values: readonly number[]) {
    this.values = values;
  }

  create(): RandomSource {
    return new SequenceRandomSource(this.values);
  }
}
