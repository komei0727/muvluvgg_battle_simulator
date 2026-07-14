import { afterEach, describe, expect, it } from "vitest";
import { buildServer, type SimulateBattleUseCasePort } from "./build-server.js";
import type { BattleSimulationRequestBody } from "../../application/http-contract.js";
import { toSimulateBattleCommand } from "../../application/simulate-battle-request-mapper.js";
import { SimulateBattleUseCase } from "../../application/simulate-battle-use-case.js";
import type { SimulationExecutionContext } from "../../application/simulation-execution-context.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/catalog-ids.js";
import type { UnitDefinition } from "../../domain/catalog/unit-definition.js";
import type { BattleCatalog, BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import { ManualClock } from "../../testing/clock/manual-clock.js";
import { FixedBattleIdGenerator } from "../../testing/id/fixed-battle-id-generator.js";
import { SequenceRandomSourceFactory } from "../../testing/random/sequence-random-source-factory.js";

/**
 * レビュー指摘（PR #86, [P1]）: `onRequest`で`request.raw`（`IncomingMessage`）の
 * `close`を監視すると、切断していない通常のリクエストでもリクエスト本文を
 * 読み終えた時点でほぼ即座に`close`が発火し、`cancellationController`が
 * 誤って中断されてしまう。`app.inject()`（light-my-request）はこの`close`を
 * 自然発火させない（`simulate: { close: true }`で明示的に指示した場合だけ
 * 発火する）ため、既存の`build-server.test.ts`のようなinjectベースのテストでは
 * このバグを再現できない — 実際にlistenした実TCPサーバーへ実リクエストを
 * 送る結合テストでしか検出できない（レビューコメントの指摘どおり）。
 *
 * このファイルは実サーバーへ実`fetch`を送り、次の両方を検証する。
 * - 通常完了する処理時間のかかるリクエストが誤ってキャンセルされないこと（回帰）
 * - クライアントが実際に切断した場合は引き続き検知できること（既存挙動の維持）
 */
function unitDefinition(id: string): UnitDefinition {
  return {
    unitDefinitionId: createUnitDefinitionId(id),
    attribute: "AGGRESSIVE",
    unitType: "PHYSICAL",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT", "BACK"],
    baseStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
      actionSpeed: 10,
      maximumAp: 3,
      maximumPp: 3,
    },
    extraGaugeMaximum: 100,
    activeSkillDefinitionIds: [],
    passiveSkillDefinitionIds: [],
    extraSkillDefinitionId: createSkillDefinitionId("SKL_EX"),
    requiredCapabilities: [],
    metadata: { displayName: id, characterName: id, characterId: id, affiliations: [], tags: [] },
  };
}

class FakeBattleCatalog implements BattleCatalog {
  private readonly units: ReadonlyMap<ReturnType<typeof createUnitDefinitionId>, UnitDefinition>;

  constructor(units: ReadonlyMap<ReturnType<typeof createUnitDefinitionId>, UnitDefinition>) {
    this.units = units;
  }

  loadSnapshot(): BattleCatalogSnapshot {
    return {
      catalogRevision: "rev-1",
      units: this.units,
      skills: new Map(),
      effectActions: new Map(),
      memories: new Map(),
      capabilities: new Map(),
    };
  }
}

const UNITS = new Map([[createUnitDefinitionId("UNIT_001"), unitDefinition("UNIT_001")]]);

function minimalRequestBody(): BattleSimulationRequestBody {
  return {
    allyFormation: {
      units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
      memoryDefinitionIds: [],
    },
    enemyFormation: {
      units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
      memoryDefinitionIds: [],
    },
    turnLimit: 3,
  };
}

/**
 * `build-server.test.ts`と同様、Worker経由の実体を薄いdirect adapterで代替
 * しつつ、Workerの処理時間を模した`delayMs`だけ`execute`の解決を遅らせ、
 * その間に呼び出し側の`context.cancellationSignal`を観測できるようにする。
 */
function buildDelayedUseCase(
  delayMs: number,
  onContext: (context: SimulationExecutionContext) => void,
): SimulateBattleUseCasePort {
  const useCase = new SimulateBattleUseCase({
    battleCatalog: new FakeBattleCatalog(UNITS),
    battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
    randomSourceFactory: new SequenceRandomSourceFactory([]),
    clock: new ManualClock(Date.now()),
  });
  return {
    execute: async (request, context) => {
      onContext(context);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return useCase.execute(toSimulateBattleCommand(request), context);
    },
  };
}

describe("buildServer — real TCP disconnect detection (not app.inject())", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("INT-HTTP-DISCONNECT-001 (regression for PR #86 review [P1]): a normal client that stays connected through a slow (150ms) handler still receives 200, not a spurious EXECUTION_CANCELLED", async () => {
    let capturedSignal: AbortSignal | undefined;
    const app = await buildServer(
      buildDelayedUseCase(150, (context) => {
        capturedSignal = context.cancellationSignal;
      }),
    );
    close = () => app.close();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a bound TCP address");
    }
    const url = `http://127.0.0.1:${address.port}/api/v1/battle-simulations`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(minimalRequestBody()),
    });

    expect(response.status).toBe(200);
    expect(capturedSignal?.aborted).toBe(false);
  });

  it("INT-HTTP-DISCONNECT-002 (11_インフラストラクチャ設計.md「キャンセルと期限」段階2): a client that actually aborts mid-request still aborts the server-side cancellationSignal", async () => {
    let capturedSignal: AbortSignal | undefined;
    const app = await buildServer(
      buildDelayedUseCase(2_000, (context) => {
        capturedSignal = context.cancellationSignal;
      }),
    );
    close = () => app.close();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a bound TCP address");
    }
    const url = `http://127.0.0.1:${address.port}/api/v1/battle-simulations`;

    const controller = new AbortController();
    const fetchPromise = fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(minimalRequestBody()),
      signal: controller.signal,
    }).catch((error: unknown) => error);
    setTimeout(() => controller.abort(), 50);
    await fetchPromise;

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(capturedSignal?.aborted).toBe(true);
  });
});
