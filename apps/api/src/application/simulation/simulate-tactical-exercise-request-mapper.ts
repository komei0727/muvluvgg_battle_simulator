import { toFormationInput } from "./simulate-battle-request-mapper.js";
import type { LogLevel } from "./simulate-battle-command.js";
import type { SimulateTacticalExerciseCommand } from "./simulate-tactical-exercise-command.js";
import type { TacticalExerciseRequestBody } from "../contracts/request.js";

const DEFAULT_LOG_LEVEL = "DETAILED";

/**
 * `10_API設計.md`「Inbound Adapterでの変換」の戦術演習版。編成の変換は戦闘リクエストと
 * 共有し（`toFormationInput`）、`turnLimit`は受け取らない（R-TEX-01 #4）。
 * 敵編成の件数・メモリー制約（R-TEX-01 #3）の検証は
 * `validateTacticalExerciseCommandShape`（`422 INVALID_COMMAND`）へ委ねる。
 */
export function toSimulateTacticalExerciseCommand(
  body: TacticalExerciseRequestBody,
): SimulateTacticalExerciseCommand {
  return {
    allyFormation: toFormationInput(body.allyFormation),
    enemyFormation: toFormationInput(body.enemyFormation),
    logLevel: (body.options?.logLevel ?? DEFAULT_LOG_LEVEL) as LogLevel,
  };
}
