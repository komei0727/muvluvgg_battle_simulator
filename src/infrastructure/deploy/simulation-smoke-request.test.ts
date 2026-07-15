/**
 * PRレビュー指摘（#112 review 2026-07-15、P1-3）: CI deployのsmoke testは
 * `SMOKE_SIMULATION_BODY_FILE`未設定のため最小simulationを常にskipしていた。
 * 有効なsimulation requestを構築できない場合はdeployを失敗させる必要があるため、
 * Catalog GETのresponseから選択可能なUnitを見つけてrequestを組み立てる、
 * 失敗時は例外を投げる純粋関数として実装する。
 */
import { describe, expect, it } from "vitest";
import { buildSimulationSmokeRequest } from "./simulation-smoke-request.js";

describe("buildSimulationSmokeRequest", () => {
  it("IT-INFRA-CICD-016: builds a minimal single-unit request from the first selectable unit", () => {
    const request = buildSimulationSmokeRequest({
      units: [
        { unitDefinitionId: "UNIT_000", selectable: false, positionAptitudes: ["FRONT"] },
        { unitDefinitionId: "UNIT_001", selectable: true, positionAptitudes: ["FRONT", "BACK"] },
      ],
    });
    expect(request).toEqual({
      allyFormation: {
        units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
        memoryDefinitionIds: [],
      },
      enemyFormation: {
        units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
        memoryDefinitionIds: [],
      },
      turnLimit: 3,
    });
  });

  it('IT-INFRA-CICD-017: maps the Catalog\'s "BACK" position aptitude to the request schema\'s "REAR" row', () => {
    const request = buildSimulationSmokeRequest({
      units: [{ unitDefinitionId: "UNIT_002", selectable: true, positionAptitudes: ["BACK"] }],
    });
    expect(request.allyFormation.units[0]?.position).toEqual({ column: 0, row: "REAR" });
  });

  it("IT-INFRA-CICD-018: throws when no unit in the Catalog is selectable", () => {
    expect(() =>
      buildSimulationSmokeRequest({
        units: [{ unitDefinitionId: "UNIT_000", selectable: false, positionAptitudes: ["FRONT"] }],
      }),
    ).toThrow(/no selectable unit/i);
  });

  it("IT-INFRA-CICD-019: throws when the selectable unit declares no positionAptitudes", () => {
    expect(() =>
      buildSimulationSmokeRequest({
        units: [{ unitDefinitionId: "UNIT_003", selectable: true, positionAptitudes: [] }],
      }),
    ).toThrow(/positionAptitudes/);
  });
});
