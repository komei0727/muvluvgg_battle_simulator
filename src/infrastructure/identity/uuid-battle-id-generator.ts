import { randomUUID } from "node:crypto";
import { createBattleId } from "../../domain/shared/ids.js";
import type { BattleId } from "../../domain/shared/ids.js";
import type { BattleIdGenerator } from "../../domain/ports/battle-id-generator.js";

/**
 * `11_インフラストラクチャ設計.md`「BattleIdGenerator」: 衝突しにくくログで扱える
 * 文字列IDを生成する。IDからドメイン上の意味は導出しない。
 */
export class UuidBattleIdGenerator implements BattleIdGenerator {
  next(): BattleId {
    return createBattleId(randomUUID());
  }
}
