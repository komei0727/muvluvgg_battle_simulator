import { toFormationInput } from "./simulate-battle-request-mapper.js";
import type { LogLevel } from "./simulate-battle-command.js";
import type { SimulateTacticalExerciseCommand } from "./simulate-tactical-exercise-command.js";
import type { TacticalExerciseRequestBody } from "../contracts/request.js";

/**
 * `10_API設計.md`「SimulationOptions」: `options.logLevel`の既定値。既定の用途は
 * 「編成を比べるための実行」であり、必要なのは勝敗とユニット別集計だけである
 * （`DETAILED`を既定にすると、指定しないクライアントが毎回数MBのレスポンスを
 * 受け取る）。
 */
const DEFAULT_LOG_LEVEL = "SUMMARY";

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
