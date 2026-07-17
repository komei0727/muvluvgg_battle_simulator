import { afterEach, describe, expect, it } from "vitest";
import { buildServer, type SimulateBattleUseCasePort } from "./build-server.js";
import { ApplicationError } from "../../application/contracts/application-error.js";
import type { BattleSimulationRequestBody } from "../../application/contracts/http-contract.js";
import { toSimulateBattleCommand } from "../../application/simulation/simulate-battle-request-mapper.js";
import { SimulateBattleUseCase } from "../../application/simulation/simulate-battle-use-case.js";
import type { SimulationExecutionContext } from "../../application/simulation/simulation-execution-context.js";
import type { SimulateBattleResult } from "../../application/simulation/simulation-result-assembler.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import type { BattleCatalog, BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import { ManualClock } from "../../testing/clock/manual-clock.js";
import { FixedBattleIdGenerator } from "../../testing/id/fixed-battle-id-generator.js";
import { SequenceRandomSourceFactory } from "../../testing/random/sequence-random-source-factory.js";

/**
 * レビュー指摘（PR #86, [P1]/[P2]）:
 *
 * - [P1] `onRequest`で`request.raw`（`IncomingMessage`）の`close`を監視すると、
 *   切断していない通常のリクエストでもリクエスト本文を読み終えた時点で
 *   ほぼ即座に`close`が発火し、`cancellationController`が誤って中断される。
 * - [P2] 実際のクライアント切断で`AbortSignal`が発火した場合、エラーハンドラーが
 *   既に破棄済みの接続へ無条件に`reply.send()`（内部的に`reply.raw.end()`）を
 *   呼ぼうとしてはならない（`11_インフラストラクチャ設計.md`「クライアント切断時
 *   は応答送信を試みない」）。
 *
 * `app.inject()`（light-my-request）はこれらを実TCPどおりに再現しない
 * （`request.raw`の`close`は`simulate.close`を明示指定しない限り自然発火せず、
 * `reply.raw`も実ソケットのように`destroyed`にならない）ため、実際に`listen()`
 * して実`fetch`を送る結合テストでしか検出できない。
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

/** `unitDefinition`の`extraSkillDefinitionId`（"SKL_EX"）が参照するEXスキル。EXゲージは満タンにならないため実際には使用されない。 */
function exSkillDefinition(id: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "EX",
    cost: { resource: "EX_GAUGE", amount: 100 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    requiredCapabilities: [],
    metadata: { displayName: id, tags: [] },
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
      skills: new Map([[createSkillDefinitionId("SKL_EX"), exSkillDefinition("SKL_EX")]]),
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
 * `onStarted`は`execute`が実際に呼ばれた瞬間（＝Fastify側の切断検知配線が
 * 完了した瞬間）に発火するため、テスト側はこれを待ってからabortでき、
 * 固定sleepに依存しない。
 */
function buildDelayedUseCase(
  delayMs: number,
  onStarted: (context: SimulationExecutionContext) => void,
): SimulateBattleUseCasePort {
  const useCase = new SimulateBattleUseCase({
    battleCatalog: new FakeBattleCatalog(UNITS),
    battleIdGenerator: new FixedBattleIdGenerator(["B_1"]),
    randomSourceFactory: new SequenceRandomSourceFactory([]),
    clock: new ManualClock(Date.now()),
  });
  return {
    execute: async (request, context) => {
      onStarted(context);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return useCase.execute(toSimulateBattleCommand(request), context);
    },
  };
}

/**
 * `SimulationWorkerPool.execute`の実挙動（`cancellationSignal`のabortを
 * `ApplicationError("EXECUTION_CANCELLED")`へ変換する）を模したスタブ。
 * `onStarted`は`execute`呼び出し直後に発火するため、テスト側はこれを待って
 * からabortできる。
 */
function buildCancellableUseCase(
  onStarted: (context: SimulationExecutionContext) => void,
): SimulateBattleUseCasePort {
  return {
    execute: (_request, context) =>
      new Promise<SimulateBattleResult>((resolve, reject) => {
        onStarted(context);
        if (context.cancellationSignal?.aborted === true) {
          reject(new ApplicationError("EXECUTION_CANCELLED", [{ reason: "client disconnected" }]));
          return;
        }
        context.cancellationSignal?.addEventListener("abort", () => {
          reject(new ApplicationError("EXECUTION_CANCELLED", [{ reason: "client disconnected" }]));
        });
      }),
  };
}

/** `context.cancellationSignal`のabortイベントを固定sleepなしで待つ。 */
function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal === undefined || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

interface ListeningServer {
  readonly url: string;
  readonly close: () => Promise<void>;
}

async function listenOnEphemeralPort(
  useCase: SimulateBattleUseCasePort,
): Promise<ListeningServer & { spyOnReplyEnd: () => { calls: number } }> {
  const app = await buildServer(useCase);
  // `reply.raw.end`（`http.ServerResponse#end`）へのspy。[P2]「クライアント切断時
  // は応答送信を試みない」の検証には、クライアントが既に居ないため応答の
  // 到達をHTTP経由で観測できない — サーバー側が実際に書き込みを試みたか
  // どうかを直接見るしかない。`buildServer`が内部で登録する`onRequest`
  // フックより後に評価されても、両方とも実際のルートハンドラーより前に
  // 完了するため、`reply.raw.end`の差し替えはハンドラー実行前に間に合う。
  const spyState = { calls: 0 };
  app.addHook("onRequest", (_request, reply, done) => {
    const originalEnd = reply.raw.end.bind(reply.raw);
    reply.raw.end = ((...args: Parameters<typeof originalEnd>) => {
      spyState.calls += 1;
      return originalEnd(...args);
    }) as typeof reply.raw.end;
    done();
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return {
    url: `http://127.0.0.1:${address.port}/api/v1/battle-simulations`,
    close: () => app.close(),
    spyOnReplyEnd: () => spyState,
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
    const server = await listenOnEphemeralPort(
      buildDelayedUseCase(150, (context) => {
        capturedSignal = context.cancellationSignal;
      }),
    );
    close = server.close;

    const response = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(minimalRequestBody()),
    });

    expect(response.status).toBe(200);
    expect(capturedSignal?.aborted).toBe(false);
  });

  it("INT-HTTP-DISCONNECT-002 (11_インフラストラクチャ設計.md「キャンセルと期限」段階2): a client that actually aborts mid-request still aborts the server-side cancellationSignal", async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolveStarted: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const server = await listenOnEphemeralPort(
      buildCancellableUseCase((context) => {
        capturedSignal = context.cancellationSignal;
        resolveStarted();
      }),
    );
    close = server.close;

    const controller = new AbortController();
    const fetchPromise = fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(minimalRequestBody()),
      signal: controller.signal,
    }).catch((error: unknown) => error);

    // Only abort once the server has actually reached execute() — i.e. once
    // the disconnect-detection wiring for *this* request is guaranteed to be
    // in place — rather than a fixed delay that could race under CI load.
    await started;
    controller.abort();
    await waitForAbort(capturedSignal);
    await fetchPromise;

    expect(capturedSignal?.aborted).toBe(true);
  });

  it("INT-HTTP-DISCONNECT-003 (11_インフラストラクチャ設計.md「クライアント切断時は応答送信を試みない」, PR #86 review [P2]): does not attempt to write a response once the client has actually disconnected", async () => {
    let resolveStarted: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let capturedSignal: AbortSignal | undefined;
    const server = await listenOnEphemeralPort(
      buildCancellableUseCase((context) => {
        capturedSignal = context.cancellationSignal;
        resolveStarted();
      }),
    );
    close = server.close;

    const controller = new AbortController();
    const fetchPromise = fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(minimalRequestBody()),
      signal: controller.signal,
    }).catch((error: unknown) => error);

    await started;
    controller.abort();
    await waitForAbort(capturedSignal);
    await fetchPromise;
    // Give the error handler a turn to run to completion after the
    // ApplicationError("EXECUTION_CANCELLED") rejection settles.
    await new Promise((resolve) => setImmediate(resolve));

    expect(server.spyOnReplyEnd().calls).toBe(0);
  });
});
