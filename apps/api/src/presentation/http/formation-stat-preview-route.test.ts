import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildServer,
  type PreviewFormationStatsUseCasePort,
  type SimulateBattleUseCasePort,
} from "./build-server.js";
import { ApplicationError } from "../../application/contracts/application-error.js";
import type { PreviewFormationStatsCommand } from "../../application/simulation/preview-formation-stats-command.js";
import type { FormationStatPreviewResult } from "../../application/simulation/preview-formation-stats-use-case.js";
import type { FormationStatPreviewResponseBody } from "../../application/contracts/response.js";
import { createUnitDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";

/**
 * 検証対象は`routes/formation-stat-preview-route.ts`だが、protocol header・
 * エラー変換は`buildServer`が組み立てた実サーバーを通さないと観測できないため、
 * `battle-simulation-catalog-route.test.ts`と同じくここへ置く。
 */
const PREVIEW_PATH = "/api/v1/formation-stat-previews";

/** このファイルのどのテストも`POST /api/v1/battle-simulations`を叩かない。 */
const UNUSED_BATTLE_USE_CASE: SimulateBattleUseCasePort = {
  execute: () => {
    throw new Error("not used in this test file");
  },
};

const REQUEST_BODY = {
  allyFormation: {
    units: [{ unitDefinitionId: "UNIT_ALLY", position: { column: 0, row: "FRONT" } }],
    memoryDefinitionIds: [],
  },
  enemyFormation: {
    units: [{ unitDefinitionId: "UNIT_ENEMY", position: { column: 0, row: "FRONT" } }],
    memoryDefinitionIds: [],
  },
};

const RESULT: FormationStatPreviewResult = {
  catalogRevision: "rev-1",
  units: [
    {
      side: "ALLY",
      unitDefinitionId: createUnitDefinitionId("UNIT_ALLY"),
      position: { column: "LEFT", row: "FRONT" },
      combatStats: {
        maximumHp: 1000.5,
        attack: 100,
        defense: 50,
        criticalRate: 0.125,
        actionSpeed: 12,
        affinityBonus: 0.25,
        criticalDamageBonus: 0.5,
      },
    },
  ],
};

function previewUseCase(
  execute: PreviewFormationStatsUseCasePort["execute"] = () => RESULT,
): PreviewFormationStatsUseCasePort {
  return { execute };
}

describe("POST /api/v1/formation-stat-previews", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("API-STAT-PREVIEW-001 (10_API設計.md「FormationStatPreviewResponse」): returns 200 with the mapped preview body", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, { previewUseCase: previewUseCase() });

    const response = await app.inject({ method: "POST", url: PREVIEW_PATH, payload: REQUEST_BODY });

    expect(response.statusCode).toBe(200);
    expect(response.json<FormationStatPreviewResponseBody>()).toEqual({
      schemaVersion: 1,
      catalogRevision: "rev-1",
      units: [
        {
          side: "ALLY",
          unitDefinitionId: "UNIT_ALLY",
          formationPosition: { column: 0, row: "FRONT" },
          maximumHp: 1000.5,
          combatStats: {
            attack: 100,
            defense: 50,
            criticalRate: 12.5,
            actionSpeed: 12,
            affinityBonus: 25,
            criticalDamageBonus: 50,
          },
        },
      ],
    });
  });

  it("API-STAT-PREVIEW-002 (10_API設計.md「FormationStatPreviewRequest」): rejects turnLimit and options with 400, instead of silently ignoring them", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, { previewUseCase: previewUseCase() });

    const response = await app.inject({
      method: "POST",
      url: PREVIEW_PATH,
      payload: { ...REQUEST_BODY, turnLimit: 10, options: { logLevel: "DETAILED" } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("MALFORMED_REQUEST");
  });

  it("API-STAT-PREVIEW-003 (10_API設計.md「ステータスコード対応」): maps INVALID_COMMAND to 422 with the violation translated to the wire path (slots → units)", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, {
      previewUseCase: previewUseCase(() => {
        throw new ApplicationError("INVALID_COMMAND", [
          { path: "allyFormation.slots", reason: "must contain between 1 and 5 units, got 0" },
        ]);
      }),
    });

    const response = await app.inject({ method: "POST", url: PREVIEW_PATH, payload: REQUEST_BODY });

    const body = response.json<{ error: { code: string; violations: { path?: string }[] } }>();
    expect(response.statusCode).toBe(422);
    expect(body.error.code).toBe("INVALID_COMMAND");
    expect(body.error.violations.map((violation) => violation.path)).toEqual([
      "/allyFormation/units",
    ]);
  });

  it("API-STAT-PREVIEW-004 (10_API設計.md「ステータスコード対応」): maps DEFINITION_NOT_FOUND to 422", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, {
      previewUseCase: previewUseCase(() => {
        throw new ApplicationError("DEFINITION_NOT_FOUND", [
          {
            path: "allyFormation.slots[0].unitDefinitionId",
            definitionId: "UNIT_MISSING",
            reason: 'references an unknown UnitDefinitionId: "UNIT_MISSING"',
          },
        ]);
      }),
    });

    const response = await app.inject({ method: "POST", url: PREVIEW_PATH, payload: REQUEST_BODY });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("DEFINITION_NOT_FOUND");
  });

  it("API-STAT-PREVIEW-007 (10_API設計.md「FormationStatPreviewRequest」): accepts a formation pair whose other side is still empty, which is the state the formation screen is in while it is being filled in", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, { previewUseCase: previewUseCase() });

    const response = await app.inject({
      method: "POST",
      url: PREVIEW_PATH,
      payload: { ...REQUEST_BODY, enemyFormation: { units: [], memoryDefinitionIds: [] } },
    });

    expect(response.statusCode).toBe(200);
  });

  it("API-STAT-PREVIEW-005 (10_API設計.md「Cache-Control」「X-Request-Id」): the preview response is no-store and echoes the request ID", async () => {
    app = await buildServer(UNUSED_BATTLE_USE_CASE, { previewUseCase: previewUseCase() });

    const response = await app.inject({
      method: "POST",
      url: PREVIEW_PATH,
      payload: REQUEST_BODY,
      headers: { "x-request-id": "ui-preview-1" },
    });

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toBe("ui-preview-1");
  });

  it("API-STAT-PREVIEW-006 (10_API設計.md「Inbound Adapterでの変換」): passes the request's enhancement through to the use case unchanged", async () => {
    const received: PreviewFormationStatsCommand[] = [];
    app = await buildServer(UNUSED_BATTLE_USE_CASE, {
      previewUseCase: previewUseCase((command) => {
        received.push(command);
        return RESULT;
      }),
    });

    await app.inject({
      method: "POST",
      url: PREVIEW_PATH,
      payload: {
        ...REQUEST_BODY,
        allyFormation: {
          ...REQUEST_BODY.allyFormation,
          units: [
            {
              unitDefinitionId: "UNIT_ALLY",
              position: { column: 0, row: "FRONT" },
              enhancement: { level: 220, gears: [{ stat: "ATTACK", tier: "III", grade: "S" }] },
            },
          ],
          enhancement: { academyLevels: { unitTypes: { PHYSICAL: 50 } } },
        },
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.allyFormation.enhancement).toEqual({
      academyLevels: { unitTypes: { PHYSICAL: 50 } },
    });
    expect(received[0]?.allyFormation.slots[0]?.enhancement).toEqual({
      level: 220,
      gears: [{ stat: "ATTACK", tier: "III", grade: "S" }],
    });
  });
});
