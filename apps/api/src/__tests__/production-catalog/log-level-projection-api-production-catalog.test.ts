import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { BattleSimulationRequestBody } from "../../application/contracts/request.js";
import type { BattleSimulationResponseBody } from "../../application/contracts/response.js";
import { toSimulateBattleCommand } from "../../application/simulation/simulate-battle-request-mapper.js";
import { SimulateBattleUseCase } from "../../application/simulation/simulate-battle-use-case.js";
import type { SimulationExecutionContext } from "../../application/simulation/simulation-execution-context.js";
import type { RandomSource } from "../../domain/ports/random-source.js";
import type { RandomSourceFactory } from "../../domain/ports/random-source-factory.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { buildServer } from "../../presentation/http/build-server.js";
import type { SimulateBattleUseCasePort } from "../../presentation/http/build-server.js";
import { battleSimulationResponseDocSchema } from "../../presentation/http/schemas/simulation/simulation-schema.js";
import { ManualClock } from "../../testing/clock/manual-clock.js";
import { FixedBattleIdGenerator } from "../../testing/id/fixed-battle-id-generator.js";

/**
 * REL-004（Issue #203）: `10_API設計.md`「API契約テスト」「ログレベルと障害」の
 * 1〜3を、実`catalog/`と実HTTP経路で固定する。
 *
 * ここまでDETAILEDとDIAGNOSTICは同じ全件イベント列を返しており
 * （`battle-log-projection.ts`のM3時点の実装）、`EffectStepSkipped`・
 * `ExtraGaugeOverflowDiscarded`という実在のDIAGNOSTICカテゴリイベントが
 * 既定のDETAILEDレスポンスへ漏れていた。3レベルの差が
 * 「eventsだけに現れ、stateTransitionsには一切現れない」ことを実データで押さえる。
 */
const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

/**
 * `EffectStepSkipped`（step条件がfalse）を実際に発行するproduction Unit。
 * `ExtraGaugeOverflowDiscarded`（R-ACT-03、EX上限超過分の破棄）を発行するUnitとは
 * 別なので、両方を1つの戦闘へ出すために敵味方へ分けて据える。
 * どちらが欠けても`IT-REL-004-LOG-LEVEL-003`が気づく。
 */
const EFFECT_STEP_SKIPPED_UNIT_ID = "UNIT_TARISA_TROUBLEMAKER";
const EXTRA_GAUGE_OVERFLOW_UNIT_ID = "UNIT_DOROTHEA_GRACE";

const DIAGNOSTIC_EVENT_TYPES = ["EFFECT_STEP_SKIPPED", "EXTRA_GAUGE_OVERFLOW_DISCARDED"] as const;

/** 枯渇しない決定的RandomSource。完走の決定化にのみ使う。 */
class ConstantRandomSourceFactory implements RandomSourceFactory {
  create(): RandomSource {
    return { next: () => 0.5 };
  }
}

type LogLevel = "SUMMARY" | "DETAILED" | "DIAGNOSTIC";

/**
 * 実`catalog/`をロードし、同じ編成・同じ乱数・同じBattle IDの戦闘を
 * 指定ログレベルで実HTTP経路へ通す。ログレベル以外を完全に固定するので、
 * レスポンス差分はprojectionだけに由来する。
 */
async function runBattleOverHttp(logLevel: LogLevel): Promise<BattleSimulationResponseBody> {
  const battleCatalog = loadCatalogFromDirectory(CATALOG_DIR);
  const useCase: SimulateBattleUseCasePort = {
    execute: (request: BattleSimulationRequestBody, context: SimulationExecutionContext) =>
      Promise.resolve(
        new SimulateBattleUseCase({
          battleCatalog,
          battleIdGenerator: new FixedBattleIdGenerator(["B_REL004"]),
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
          units: [
            {
              unitDefinitionId: EFFECT_STEP_SKIPPED_UNIT_ID,
              position: { column: 0, row: "FRONT" },
            },
            {
              unitDefinitionId: EXTRA_GAUGE_OVERFLOW_UNIT_ID,
              position: { column: 1, row: "REAR" },
            },
          ],
          memoryDefinitionIds: [],
        },
        enemyFormation: {
          units: [
            {
              unitDefinitionId: EFFECT_STEP_SKIPPED_UNIT_ID,
              position: { column: 0, row: "FRONT" },
            },
            {
              unitDefinitionId: EXTRA_GAUGE_OVERFLOW_UNIT_ID,
              position: { column: 1, row: "REAR" },
            },
          ],
          memoryDefinitionIds: [],
        },
        turnLimit: 5,
        options: { logLevel },
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

describe("log level projection over the v1 API contract (REL-004)", () => {
  let summary: BattleSimulationResponseBody;
  let detailed: BattleSimulationResponseBody;
  let diagnostic: BattleSimulationResponseBody;

  beforeAll(async () => {
    [summary, detailed, diagnostic] = await Promise.all([
      runBattleOverHttp("SUMMARY"),
      runBattleOverHttp("DETAILED"),
      runBattleOverHttp("DIAGNOSTIC"),
    ]);
  });

  it("IT-REL-004-LOG-LEVEL-001 (10_API設計.md「SUMMARYでも全状態差分を返す」): SUMMARY thins events down to the five headline types yet returns byte-identical stateTransitions, and its causedBySequence still names events SUMMARY does not publish", () => {
    // 「戦闘開始、行動結果、戦闘不能、ターン終了、戦闘終了」。この編成は
    // ターン途中で決着するため`TURN_COMPLETED`は現れないが、集合として
    // この5種を出ないことと、全件からの絞り込み結果と一致することを押さえる。
    const headlineTypes = new Set([
      "BATTLE_STARTED",
      "UNIT_DEFEATED",
      "ACTION_COMPLETED",
      "TURN_COMPLETED",
      "BATTLE_COMPLETED",
    ]);
    expect(summary.events.length).toBeGreaterThan(0);
    expect(summary.events.filter((event) => !headlineTypes.has(event.type))).toEqual([]);
    expect(summary.events).toEqual(
      diagnostic.events.filter((event) => headlineTypes.has(event.type)),
    );
    expect(summary.events.length).toBeLessThan(detailed.events.length);

    // 「公開レベルに関係なく、状態変更は`stateTransitions`へすべて含める」。
    expect(summary.stateTransitions).toEqual(detailed.stateTransitions);
    expect(summary.finalState).toEqual(detailed.finalState);

    // 「SUMMARYで原因イベントが非公開でも、`causedBySequence`は元のイベント連番を保持する」。
    const publishedSequences = new Set(summary.events.map((event) => event.sequence));
    const causesHiddenFromSummary = summary.stateTransitions.filter(
      (transition) => !publishedSequences.has(transition.causedBySequence),
    );
    expect(causesHiddenFromSummary.length).toBeGreaterThan(0);
    const allSequences = new Set(diagnostic.events.map((event) => event.sequence));
    for (const transition of causesHiddenFromSummary) {
      expect(allSequences.has(transition.causedBySequence)).toBe(true);
    }
  });

  it("IT-REL-004-LOG-LEVEL-002 (10_API設計.md「DETAILEDで各スキル、PS、ダメージ、効果を返す」): DETAILED publishes the skill/hit/damage/effect events and no DIAGNOSTIC-category event at all", () => {
    const types = new Set(detailed.events.map((event) => event.type));
    for (const required of [
      "SKILL_USE_STARTED",
      "HIT_CONFIRMED",
      "DAMAGE_APPLIED",
      "EFFECT_APPLIED",
    ]) {
      expect(types.has(required), `DETAILED is missing ${required}`).toBe(true);
    }

    expect(detailed.events.filter((event) => event.category === "DIAGNOSTIC")).toEqual([]);
    for (const diagnosticType of DIAGNOSTIC_EVENT_TYPES) {
      expect(types.has(diagnosticType), `${diagnosticType} leaked into DETAILED`).toBe(false);
    }
  });

  it("IT-REL-004-LOG-LEVEL-003 (10_API設計.md「DIAGNOSTICで候補除外理由を返し、内部秘密情報は返さない」/12_テスト戦略.md「DETAILEDからDIAGNOSTICを除いても状態履歴が変わらない」): DIAGNOSTIC adds exactly the DIAGNOSTIC-category events on top of DETAILED, changes no state history, and leaks no server internals", () => {
    const diagnosticOnly = diagnostic.events.filter((event) => event.category === "DIAGNOSTIC");
    expect(new Set(diagnosticOnly.map((event) => event.type))).toEqual(
      new Set(DIAGNOSTIC_EVENT_TYPES),
    );

    // DIAGNOSTIC = DETAILED + 診断イベント。DETAILED側の列は一字一句変わらない。
    expect(diagnostic.events.filter((event) => event.category !== "DIAGNOSTIC")).toEqual(
      detailed.events,
    );
    expect(diagnostic.stateTransitions).toEqual(detailed.stateTransitions);
    expect(diagnostic.finalState).toEqual(detailed.finalState);

    // 診断イベントは状態変更を所有しない。所有していれば、DETAILEDで
    // 間引いた瞬間に「stateTransitionを持つ唯一のイベント」が消えることになる。
    expect(diagnosticOnly.filter((event) => event.stateTransitionIndex !== undefined)).toEqual([]);

    // 「DIAGNOSTICでもスタックトレース、ファイルパス、秘密情報を含めない」。
    const serialized = JSON.stringify(diagnosticOnly);
    expect(serialized).not.toMatch(/\/Users\/|\/home\/|node_modules|\.ts:\d+|at Object\./);
    expect(serialized).not.toMatch(/randomState|seed|stack/i);
  });

  it("IT-REL-004-LOG-LEVEL-004 (12_テスト戦略.md「実際の代表レスポンスが生成Schemaへ適合する」): all three levels serialize into bodies that satisfy the published v1 doc schema, including the per-event-type details oneOf", () => {
    const validate = new Ajv({ strict: false }).compile(battleSimulationResponseDocSchema);

    for (const [level, body] of [
      ["SUMMARY", summary],
      ["DETAILED", detailed],
      ["DIAGNOSTIC", diagnostic],
    ] as const) {
      expect(validate(body), `${level}: ${JSON.stringify(validate.errors)}`).toBe(true);
      expect(body.schemaVersion).toBe(1);
    }
  });
});
