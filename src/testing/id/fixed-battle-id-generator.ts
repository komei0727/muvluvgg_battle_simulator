import { createBattleId } from "../../domain/shared/ids.js";
import type { BattleId } from "../../domain/shared/ids.js";
import type { BattleIdGenerator } from "../../domain/ports/battle-id-generator.js";

/** Deterministic `BattleIdGenerator` (`12_テスト戦略.md`): returns preset IDs in order. */
export class FixedBattleIdGenerator implements BattleIdGenerator {
  private readonly values: readonly BattleId[];
  private index = 0;

  constructor(values: readonly string[]) {
    this.values = values.map((value) => createBattleId(value));
  }

  next(): BattleId {
    if (this.index >= this.values.length) {
      throw new Error(
        `FixedBattleIdGenerator exhausted: all ${this.values.length} preset value(s) have been consumed`,
      );
    }
    const value = this.values[this.index]!;
    this.index++;
    return value;
  }
}
