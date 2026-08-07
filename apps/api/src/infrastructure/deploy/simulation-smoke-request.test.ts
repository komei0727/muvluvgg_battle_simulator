/**
 * CI deployのsmoke testは`SMOKE_SIMULATION_BODY_FILE`が未設定だと最小simulationを
 * 黙ってskipしてしまう。有効なsimulation requestを構築できない場合はdeployを
 * 失敗させる必要があるため、
 * Catalog GETのresponseから選択可能なUnitを見つけてrequestを組み立てる、
 * 失敗時は例外を投げる純粋関数として実装する。
 */
import { describe, expect, it } from "vitest";
import { buildSimulationSmokeRequest } from "./simulation-smoke-request.js";

describe("buildSimulationSmokeRequest", () => {
  it("IT-INFRA-CICD-016: builds a minimal single-unit request from the first unit", () => {
    const request = buildSimulationSmokeRequest({
      units: [
        { unitDefinitionId: "UNIT_000", positionAptitudes: ["FRONT"] },
        { unitDefinitionId: "UNIT_001", positionAptitudes: ["FRONT", "BACK"] },
      ],
    });
    expect(request).toEqual({
      allyFormation: {
        units: [{ unitDefinitionId: "UNIT_000", position: { column: 0, row: "FRONT" } }],
        memoryDefinitionIds: [],
      },
      enemyFormation: {
        units: [{ unitDefinitionId: "UNIT_000", position: { column: 0, row: "FRONT" } }],
        memoryDefinitionIds: [],
      },
      turnLimit: 3,
    });
  });

  it('IT-INFRA-CICD-017: maps the Catalog\'s "BACK" position aptitude to the request schema\'s "REAR" row', () => {
    const request = buildSimulationSmokeRequest({
      units: [{ unitDefinitionId: "UNIT_002", positionAptitudes: ["BACK"] }],
    });
    expect(request.allyFormation.units[0]?.position).toEqual({ column: 0, row: "REAR" });
  });

  it("IT-INFRA-CICD-018: throws when the Catalog has no unit at all", () => {
    expect(() => buildSimulationSmokeRequest({ units: [] })).toThrow(/no unit found/i);
  });

  it("IT-INFRA-CICD-019: throws when the first unit declares no positionAptitudes", () => {
    expect(() =>
      buildSimulationSmokeRequest({
        units: [{ unitDefinitionId: "UNIT_003", positionAptitudes: [] }],
      }),
    ).toThrow(/positionAptitudes/);
  });
});
