import type { Violation } from "../contracts/application-error.js";
import {
  validateFormationShape,
  validateLogLevel,
  type FormationInput,
  type FormationPairCommand,
  type LogLevel,
} from "./simulate-battle-command.js";
import { EXERCISE_TURN_LIMIT } from "../../domain/battle/model/exercise-runtime.js";

/**
 * R-TEX-01 #4 / `09_アプリケーション設計.md`「SimulateTacticalExerciseCommand」:
 * 演習の規定ターン数はリクエストで指定できず、常にこの定数を使う。値の正本は
 * 集約の生成時不変条件（`createBattle`）が参照するDomain側に置き、アプリケーション層
 * からはここを通して参照する（同じ5をもう1か所へ書いてdriftさせない）。
 */
export { EXERCISE_TURN_LIMIT };

/**
 * `09_アプリケーション設計.md`「SimulateTacticalExerciseCommand」。編成入力は
 * `SimulateBattleCommand`と同形で、`turnLimit`だけを持たない。
 */
export interface SimulateTacticalExerciseCommand extends FormationPairCommand {
  readonly logLevel: LogLevel;
}

const EXERCISE_ENEMY_SLOTS = 1;

/**
 * `09_アプリケーション設計.md`「SimulateTacticalExerciseCommand」のCommand検証:
 * `SimulateBattleCommand`と同じ編成検証（R-FRM-01～05、R-ENH-01）へ、R-TEX-01 #3の
 * 「敵ちょうど1体・敵メモリーなし」を加える。違反はいずれも`INVALID_COMMAND`（422）
 * としてまとめて返し、Catalogへは一切アクセスしない。
 */
export function validateTacticalExerciseCommandShape(
  command: SimulateTacticalExerciseCommand,
): Violation[] {
  const violations: Violation[] = [
    ...validateFormationShape(command.allyFormation, "allyFormation"),
    ...validateExerciseEnemyFormationShape(command.enemyFormation, "enemyFormation"),
  ];

  validateLogLevel(command.logLevel, violations);

  return violations;
}

/**
 * R-TEX-01 #3（敵ちょうど1体・敵メモリーなし）の検証。単発の演習と一括評価の双方が
 * 同じ敵編成規則を受理するため、規則の実体はここ1か所に置く。
 */
export function validateExerciseEnemyFormationShape(
  enemyFormation: FormationInput,
  path: string,
): Violation[] {
  // 敵編成の件数はR-TEX-01 #3が「ちょうど1体」に狭めるため、共通の1～5体検証
  // （`validateFormationShape`）は通さず、専用の違反だけを返す（同じ入力に対して
  // 「1～5体」と「ちょうど1体」の二重の違反を返さない）。配置・強化指定の検証は
  // 共通規則のまま必要なので、最小人数0で通したうえで件数だけ別途判定する。
  const violations: Violation[] = validateFormationShape(enemyFormation, path, {
    minimumSlots: 0,
  });

  if (enemyFormation.slots.length !== EXERCISE_ENEMY_SLOTS) {
    violations.push({
      path: `${path}.slots`,
      reason: `must contain exactly ${EXERCISE_ENEMY_SLOTS} unit in a tactical exercise, got ${enemyFormation.slots.length}`,
    });
  }

  if (enemyFormation.memoryDefinitionIds.length > 0) {
    violations.push({
      path: `${path}.memoryDefinitionIds`,
      reason: `must be empty in a tactical exercise, got ${enemyFormation.memoryDefinitionIds.length}`,
    });
  }

  return violations;
}
