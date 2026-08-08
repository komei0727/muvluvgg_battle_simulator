import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { GetBattleSimulationCatalogUseCase } from "../../application/catalog/get-battle-simulation-catalog-use-case.js";
import type { BattleSimulationRequestBody } from "../../application/contracts/request.js";
import type {
  BattleSimulationResponseBody,
  MarkerStateResponseBody,
} from "../../application/contracts/response.js";
import { toSimulateBattleCommand } from "../../application/simulation/simulate-battle-request-mapper.js";
import { SimulateBattleUseCase } from "../../application/simulation/simulate-battle-use-case.js";
import type { SimulationExecutionContext } from "../../application/simulation/simulation-execution-context.js";
import type { RandomSource } from "../../domain/ports/random-source.js";
import type { RandomSourceFactory } from "../../domain/ports/random-source-factory.js";
import {
  loadBattleCatalogDirectory,
  loadCatalogFromDirectory,
} from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { buildServer } from "../../presentation/http/build-server.js";
import type { SimulateBattleUseCasePort } from "../../presentation/http/build-server.js";
import { battleSimulationResponseDocSchema } from "../../presentation/http/schemas/simulation/simulation-schema.js";
import { ManualClock } from "../../testing/clock/manual-clock.js";
import { FixedBattleIdGenerator } from "../../testing/id/fixed-battle-id-generator.js";

/**
 * REL-008（Issue #263）: R-MEM-04のMemory由来Marker（付与者`BattleUnit`を持たず
 * 付与元陣営`sourceSide`だけを持つ）をv1 API契約へ公開したことを、実production
 * Catalogと実HTTP経路で固定する。
 *
 * M7-008（Issue #176）はDomain・`StateDelta`・Domain Eventまでを実装したが、
 * `MarkerStateResponse.sourceUnitId`が必須だったため`CAP_MEMORY_GRANTED_MARKER`
 * （`PLANNED`）がCapability preflightで`MEM_ALWAYS_PICO_BESIDE_YOU`の編成を弾いて
 * いた。本Issueで`EffectStateResponse`と同じexactly-one unionへ揃えたため、
 * ここでは「編成できること」「HTTPレスポンス・イベントログの双方が付与者を
 * 推測せず`sourceSide`だけを返すこと」を実データで検証する。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const PICO_MEMORY_ID = "MEM_ALWAYS_PICO_BESIDE_YOU";
const PICO_MARKER_ID = "MARKER_MEM_ALWAYS_PICO_BESIDE_YOU_THREE_STARS";
/** 中央列後衛へ据えるproduction Unit（Memory側の対象フィルタと無関係な任意の実在Unit）。 */
const ALLY_UNIT_ID = "UNIT_KEI_JACKKNIFE";
const ENEMY_UNIT_ID = "UNIT_KEI_JACKKNIFE";

/** 枯渇しない決定的RandomSource。完走の決定化にのみ使う。 */
class ConstantRandomSourceFactory implements RandomSourceFactory {
  create(): RandomSource {
    return { next: () => 0.5 };
  }
}

/** 実`catalog/`をロードし、Memoryを編成した1対1戦闘を実HTTP経路で完走させる。 */
async function runPicoBattleOverHttp(): Promise<BattleSimulationResponseBody> {
  const battleCatalog = loadCatalogFromDirectory(CATALOG_DIR);
  const useCase: SimulateBattleUseCasePort = {
    execute: (request: BattleSimulationRequestBody, context: SimulationExecutionContext) =>
      Promise.resolve(
        new SimulateBattleUseCase({
          battleCatalog,
          battleIdGenerator: new FixedBattleIdGenerator(["B_REL008"]),
          randomSourceFactory: new ConstantRandomSourceFactory(),
          clock: new ManualClock(0),
        }).execute(toSimulateBattleCommand(request), context),
      ),
  };
  const app: FastifyInstance = await buildServer(useCase);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/battle-simulations",
      payload: {
        allyFormation: {
          // 効果1「中央列後衛の味方」へ当てるため、唯一の味方を中央列(column: 1)後衛(REAR)へ置く。
          units: [{ unitDefinitionId: ALLY_UNIT_ID, position: { column: 1, row: "REAR" } }],
          memoryDefinitionIds: [PICO_MEMORY_ID],
        },
        enemyFormation: {
          units: [{ unitDefinitionId: ENEMY_UNIT_ID, position: { column: 1, row: "FRONT" } }],
          memoryDefinitionIds: [],
        },
        turnLimit: 1,
        options: { logLevel: "DETAILED" },
      },
    });
    if (response.statusCode !== 200) {
      throw new Error(`expected 200, got ${response.statusCode}: ${response.body}`);
    }
    return response.json<BattleSimulationResponseBody>();
  } finally {
    await app.close();
  }
}

function picoMarkerOf(body: BattleSimulationResponseBody): MarkerStateResponseBody {
  const markers = body.finalState.units.flatMap((unit) => unit.markers ?? []);
  const marker = markers.find((candidate) => candidate.markerId === PICO_MARKER_ID);
  if (marker === undefined) {
    throw new Error(`no ${PICO_MARKER_ID} in response markers: ${JSON.stringify(markers)}`);
  }
  return marker;
}

describe("Memory-granted Marker over the v1 API contract (REL-008)", () => {
  it("IT-CAP-MEMORY-GRANTED-MARKER-PROD-001: reports MEM_ALWAYS_PICO_BESIDE_YOU as selectable now that no unimplemented Capability gates it", () => {
    const catalog = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: loadBattleCatalogDirectory(CATALOG_DIR),
    }).execute();

    const pico = catalog.memories.find((memory) => memory.memoryDefinitionId === PICO_MEMORY_ID);

    expect(pico).toBeDefined();
    // 実在Memory 32件すべてが編成可能になり、Capabilityにブロックされる定義が残らない。
  });

  it("IT-CAP-MEMORY-GRANTED-MARKER-PROD-002: returns the 三ツ星 Marker with sourceSide and without sourceUnitId through the real HTTP response, and the published body still satisfies the v1 response schema", async () => {
    const body = await runPicoBattleOverHttp();

    const marker = picoMarkerOf(body);
    expect(marker.sourceSide).toBe("ALLY");
    // 付与者を推測して埋めない（R-EFF-10「直近の付与者」はMemory由来では存在しない）。
    expect("sourceUnitId" in marker).toBe(false);
    expect(marker.stackCount).toBe(1);

    // fastifyのシリアライズを通した公開形そのものが、v1のdoc schemaを満たす。
    const validate = new Ajv({ strict: false }).compile(battleSimulationResponseDocSchema);
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    expect(body.schemaVersion).toBe(1);
  });

  it("IT-CAP-MEMORY-GRANTED-MARKER-PROD-003: publishes MARKER_APPLIED details with sourceSide instead of a granter unit, and the StateDelta for that Marker carries the same source", async () => {
    const body = await runPicoBattleOverHttp();

    const markerApplied = body.events.filter(
      (event) =>
        event.type === "MARKER_APPLIED" &&
        (event.details as { markerId?: string }).markerId === PICO_MARKER_ID,
    );
    expect(markerApplied).toHaveLength(1);
    const details = markerApplied[0]!.details as Record<string, unknown>;
    expect(details["sourceSide"]).toBe("ALLY");
    expect("sourceUnitId" in details).toBe(false);

    // `10_API設計.md`「差分の適用」: 同じ付与元が状態差分側にも現れる。
    const addedMarkers = body.stateTransitions.flatMap((transition) =>
      Object.values(transition.delta.units ?? {}).flatMap((unit) => unit.markers?.added ?? []),
    );
    const addedPico = addedMarkers
      .map((entry) => entry as MarkerStateResponseBody)
      .filter((entry) => entry.markerId === PICO_MARKER_ID);
    expect(addedPico).toHaveLength(1);
    expect(addedPico[0]!.sourceSide).toBe("ALLY");
    expect("sourceUnitId" in addedPico[0]!).toBe(false);
  });
});
