import type { Violation } from "../contracts/application-error.js";
import { validateFormationShape, type FormationPairCommand } from "./simulate-battle-command.js";

/**
 * `09_アプリケーション設計.md` の PreviewFormationStatsCommand。
 * `turnLimit`・`logLevel`を持たない——戦闘を実行しないため、どちらも
 * 開始時ステータスへ影響しない。
 */
export type PreviewFormationStatsCommand = FormationPairCommand;

/**
 * `09_アプリケーション設計.md`「Command検証」段階。編成の規則は
 * `SimulateBattleCommand`と完全に共有し、この経路だけの追加規則を持たない。
 */
export function validatePreviewFormationStatsCommandShape(
  command: PreviewFormationStatsCommand,
): Violation[] {
  return [
    ...validateFormationShape(command.allyFormation, "allyFormation"),
    ...validateFormationShape(command.enemyFormation, "enemyFormation"),
  ];
}
