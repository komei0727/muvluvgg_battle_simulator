/**
 * `GET /api/v1/battle-simulation-catalog`のresponseから、smoke test用の
 * 最小`POST /api/v1/battle-simulations`リクエストを組み立てる。選択可能な
 * Unitが無い場合はrequestを作れないため例外を投げる——CI deployは
 * これをそのままjob失敗として扱う（simulation smoke testを黙ってskipしない）。
 */

export type CatalogPositionAptitude = "FRONT" | "BACK";

/** Catalog GET responseのUnitの一部（selectable判定とposition組み立てに必要な分だけ）。 */
export interface SmokeCatalogUnit {
  readonly unitDefinitionId: string;
  readonly selectable: boolean;
  readonly positionAptitudes: readonly CatalogPositionAptitude[];
}

export interface SmokeCatalog {
  readonly units: readonly SmokeCatalogUnit[];
}

export interface SmokeFormationUnit {
  readonly unitDefinitionId: string;
  readonly position: { readonly column: number; readonly row: "FRONT" | "REAR" };
}

export interface SmokeSimulationRequest {
  readonly allyFormation: {
    readonly units: readonly [SmokeFormationUnit];
    readonly memoryDefinitionIds: readonly [];
  };
  readonly enemyFormation: {
    readonly units: readonly [SmokeFormationUnit];
    readonly memoryDefinitionIds: readonly [];
  };
  readonly turnLimit: number;
}

// Catalogの`positionAptitudes`（"FRONT"|"BACK"）と、formation POSTの
// `position.row`（"FRONT"|"REAR"）はschemaが異なる（presentation/http/schemas.ts）。
const ROW_BY_APTITUDE: Record<CatalogPositionAptitude, "FRONT" | "REAR"> = {
  FRONT: "FRONT",
  BACK: "REAR",
};

export function buildSimulationSmokeRequest(catalog: SmokeCatalog): SmokeSimulationRequest {
  const unit = catalog.units.find((candidate) => candidate.selectable);
  if (unit === undefined) {
    throw new Error(
      "No selectable unit found in the Catalog; cannot build a minimal simulation smoke test request",
    );
  }
  const aptitude = unit.positionAptitudes[0];
  if (aptitude === undefined) {
    throw new Error(`Selectable unit "${unit.unitDefinitionId}" declares no positionAptitudes`);
  }

  const formationUnit: SmokeFormationUnit = {
    unitDefinitionId: unit.unitDefinitionId,
    position: { column: 0, row: ROW_BY_APTITUDE[aptitude] },
  };

  return {
    allyFormation: { units: [formationUnit], memoryDefinitionIds: [] },
    enemyFormation: { units: [formationUnit], memoryDefinitionIds: [] },
    turnLimit: 3,
  };
}
