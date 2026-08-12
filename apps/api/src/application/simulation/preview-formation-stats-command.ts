import type { Violation } from "../contracts/application-error.js";
import { validateFormationShape, type FormationPairCommand } from "./simulate-battle-command.js";
import { BATTLE_MODES, type BattleMode } from "../../domain/battle/model/exercise-runtime.js";

/**
 * `09_アプリケーション設計.md` の PreviewFormationStatsCommand。
 * `turnLimit`・`logLevel`を持たない——戦闘を実行しないため、どちらも
 * 開始時ステータスへ影響しない。
 *
 * `mode`はR-TEX-11 #5の編成プール検証にだけ使う（省略時`NORMAL`）。開始時
 * ステータスの計算自体はモードへ依存しない。
 */
export interface PreviewFormationStatsCommand extends FormationPairCommand {
  readonly mode?: BattleMode;
}

/**
 * 開始時ステータスは陣営ごとに独立して決まる（編成ボーナスも配置適性も自陣営の
 * 情報だけで求まる）ため、プレビューは0体の陣営を受け付ける。編成画面は味方から
 * 順に置いていくので、両陣営が埋まるまでプレビューを出せないと、強化指定の効果を
 * 確認したい場面のほとんどで使えない。
 */
const PREVIEW_MINIMUM_SLOTS = 0;

/**
 * `09_アプリケーション設計.md`「Command検証」段階。最小人数だけを緩め、上限5体・
 * 配置重複・メモリー件数・強化指定の規則は`SimulateBattleCommand`と共有する。
 */
export function validatePreviewFormationStatsCommandShape(
  command: PreviewFormationStatsCommand,
): Violation[] {
  const options = { minimumSlots: PREVIEW_MINIMUM_SLOTS };
  const violations = [
    ...validateFormationShape(command.allyFormation, "allyFormation", options),
    ...validateFormationShape(command.enemyFormation, "enemyFormation", options),
  ];

  if (command.mode !== undefined && !BATTLE_MODES.includes(command.mode)) {
    violations.push({
      path: "mode",
      reason: `must be one of ${BATTLE_MODES.join(", ")}, got "${String(command.mode)}"`,
    });
  }

  return violations;
}
