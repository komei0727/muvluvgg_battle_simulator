import type { PreviewFormationStatsCommand } from "./preview-formation-stats-command.js";
import { toFormationInput } from "./simulate-battle-request-mapper.js";
import type { FormationStatPreviewRequestBody } from "../contracts/request.js";

/**
 * `10_API設計.md`「Inbound Adapterでの変換」: プレビューのDTOを
 * `PreviewFormationStatsCommand`へ変換する。編成の変換規則は戦闘リクエストと
 * 完全に共有し（`toFormationInput`）、この経路だけの解釈を持たない ——
 * 同じ編成JSONがプレビューと戦闘で違うCommandになると、プレビューの値が
 * 実戦闘と一致する保証が消えるため。
 */
export function toPreviewFormationStatsCommand(
  body: FormationStatPreviewRequestBody,
): PreviewFormationStatsCommand {
  return {
    allyFormation: toFormationInput(body.allyFormation),
    enemyFormation: toFormationInput(body.enemyFormation),
  };
}
