import { ApplicationError } from "../contracts/application-error.js";
import { toDomainFormationInput } from "./formation-input-mapper.js";
import {
  validatePreviewFormationStatsCommandShape,
  type PreviewFormationStatsCommand,
} from "./preview-formation-stats-command.js";
import { runPreflight } from "./simulation-preflight-validator.js";
import type { FormationInput } from "./simulate-battle-command.js";
import { createBattleParty } from "../../domain/formation/formation-factory.js";
import type { CombatStats } from "../../domain/battle/model/starting-combat-stats.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import type { UnitDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import type { BattleCatalogDirectory } from "../../domain/ports/battle-catalog-directory.js";
import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import { DomainValidationError } from "../../domain/shared/errors.js";
import { createBattleUnitId } from "../../domain/shared/ids.js";
import type { Side } from "../../domain/shared/side.js";

/** `09_アプリケーション設計.md` の FormationStatPreviewResult の1枠ぶん。 */
export interface FormationStatPreviewUnit {
  readonly side: Side;
  readonly unitDefinitionId: UnitDefinitionId;
  readonly position: FormationPosition;
  /** R-STA-01適用後の開始時ステータス。最大HPを含み、R-NUM-01に従い丸めない。 */
  readonly combatStats: CombatStats;
}

export interface FormationStatPreviewResult {
  readonly catalogRevision: string;
  /** 味方、敵の順。各陣営内はCommandの`slots`と同じ順序。 */
  readonly units: readonly FormationStatPreviewUnit[];
}

export interface PreviewFormationStatsUseCaseDependencies {
  readonly battleCatalogDirectory: BattleCatalogDirectory;
}

const SIDES: readonly {
  readonly side: Side;
  readonly key: "allyFormation" | "enemyFormation";
}[] = [
  { side: "ALLY", key: "allyFormation" },
  { side: "ENEMY", key: "enemyFormation" },
];

/**
 * `FormationFactory`は参加枠ごとに一意な`BattleUnitId`を要求する（R-FRM-03）。
 * プレビューは戦闘を実行せず、このIDを外部へも公開しないため、`SimulateBattleUseCase`
 * と同じ規則で採番した使い捨ての値を渡すだけにする。
 */
function previewBattleUnitIds(prefix: "ally" | "enemy", count: number) {
  return Array.from({ length: count }, (_, index) => createBattleUnitId(`${prefix}:${index + 1}`));
}

function previewUnits(
  side: Side,
  formation: FormationInput,
  snapshot: BattleCatalogSnapshot,
  path: "allyFormation" | "enemyFormation",
): FormationStatPreviewUnit[] {
  const party = createBattleParty(
    side,
    toDomainFormationInput(formation),
    previewBattleUnitIds(side === "ALLY" ? "ally" : "enemy", formation.slots.length),
    snapshot.units,
    snapshot.memories,
    path,
  );
  return party.members.map((member) => ({
    side,
    unitDefinitionId: member.unitDefinitionId,
    position: member.position,
    combatStats: member.combatStats,
  }));
}

/**
 * `09_アプリケーション設計.md` の PreviewFormationStatsUseCase: 編成と強化指定から
 * 各参加枠の開始時ステータスだけを算出する読み取り専用ユースケース。
 *
 * 算出は`FormationFactory`（R-ENH-06の強化後基本ステータス→R-STA-01の編成補正・
 * 配置適性）へ完全に委譲し、この層では一切計算しない —— プレビューと実戦闘で
 * 別々の計算が並ぶと、両者がずれてもどちらも「仕様どおり」に見えてしまうため。
 * `Battle`集約もイベントも生成しないので、乱数・期限・実行保護を伴わない。
 */
export class PreviewFormationStatsUseCase {
  private readonly battleCatalogDirectory: BattleCatalogDirectory;

  constructor(dependencies: PreviewFormationStatsUseCaseDependencies) {
    this.battleCatalogDirectory = dependencies.battleCatalogDirectory;
  }

  execute(command: PreviewFormationStatsCommand): FormationStatPreviewResult {
    const shapeViolations = validatePreviewFormationStatsCommandShape(command);
    if (shapeViolations.length > 0) {
      throw new ApplicationError("INVALID_COMMAND", shapeViolations);
    }

    const snapshot = this.battleCatalogDirectory.loadSnapshot();
    runPreflight(command, snapshot);

    try {
      return {
        catalogRevision: snapshot.catalogRevision,
        units: SIDES.flatMap(({ side, key }) => previewUnits(side, command[key], snapshot, key)),
      };
    } catch (error) {
      if (error instanceof DomainValidationError) {
        // `SimulateBattleUseCase`と同じ防御的経路: 事前検証を通過済みのため通常は
        // 到達しないが、到達した場合はクライアント入力起因として返す。
        throw new ApplicationError("INVALID_COMMAND", [
          { path: error.path, reason: error.message },
        ]);
      }
      throw error;
    }
  }
}
