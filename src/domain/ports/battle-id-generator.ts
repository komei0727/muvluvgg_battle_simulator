import type { BattleId } from "../shared/ids.js";

/**
 * `11_インフラストラクチャ設計.md` の BattleIdGenerator. Production adapters
 * generate collision-resistant, log-friendly IDs (e.g. UUID v7); tests
 * substitute a fixed/sequential generator.
 */
export interface BattleIdGenerator {
  next(): BattleId;
}
