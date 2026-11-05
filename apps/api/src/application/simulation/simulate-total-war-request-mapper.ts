import { toFormationInput } from "./simulate-battle-request-mapper.js";
import type { LogLevel } from "./simulate-battle-command.js";
import type { SimulateTotalWarCommand } from "./simulate-total-war-command.js";
import type { TotalWarRequestBody } from "../contracts/request.js";

/** `10_API設計.md`「SimulationOptions」: 他のモードと同じく、省略時は`SUMMARY`。 */
const DEFAULT_LOG_LEVEL = "SUMMARY";

/**
 * `10_API設計.md`「Inbound Adapterでの変換」の総力戦版。編成の変換は戦闘リクエストと
 * 共有し（`toFormationInput`）、`turnLimit`は受け取らない（R-TWR-01 #5）。編成数と
 * 1編成内の重複の検証は`validateTotalWarCommandShape`（`422 INVALID_COMMAND`）へ委ねる。
 */
export function toSimulateTotalWarCommand(body: TotalWarRequestBody): SimulateTotalWarCommand {
  return {
    allyFormations: body.allyFormations.map(toFormationInput),
    enemyFormations: body.enemyFormations.map(toFormationInput),
    logLevel: (body.options?.logLevel ?? DEFAULT_LOG_LEVEL) as LogLevel,
  };
}
