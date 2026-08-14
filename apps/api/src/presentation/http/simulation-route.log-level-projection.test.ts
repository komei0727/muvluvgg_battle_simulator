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
 * Issue #463でログレベルは実質2段階になった — `DETAILED`は`EffectStepSkipped`・
 * `ExtraGaugeOverflowDiscarded`を含む全イベントを返し、`DIAGNOSTIC`はその非推奨の
 * 別名である。レベルの差が「`events`だけに現れ、`stateTransitions`にも
 * `unitSummaries`にも一切現れない」ことを実データで押さえる。
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

type LogLevel = "SUMMARY" | "DETAILED";

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

  beforeAll(async () => {
    [summary, detailed] = await Promise.all([
      runBattleOverHttp("SUMMARY"),
      runBattleOverHttp("DETAILED"),
    ]);
  });

  it("IT-REL-004-LOG-LEVEL-001 (10_API設計.md「公開レベル」): SUMMARY returns no events, no stateTransitions and no finalState at all, while keeping result/initialState/unitSummaries complete", () => {
    expect(summary.events).toEqual([]);
    expect(summary.stateTransitions).toEqual([]);
    // キーごと省略する（`null`でも空オブジェクトでもない）。
    expect(summary).not.toHaveProperty("finalState");

    // 大量実行の用途が必要とするものは全部揃っている。
    expect(summary.result).toEqual(detailed.result);
    expect(summary.initialState).toEqual(detailed.initialState);
    expect(summary.unitSummaries).toEqual(detailed.unitSummaries);
    expect(summary.battleId).toBe(detailed.battleId);
    expect(summary.catalogRevision).toBe(detailed.catalogRevision);
    // ロースター解決に使うため`initialState`だけは落とさない。
    expect(summary.initialState.units.length).toBeGreaterThan(0);
  });

  it("IT-REL-004-LOG-LEVEL-002 (10_API設計.md「公開レベル」): DETAILED publishes every event — skill/hit/damage/effect together with the two formerly DIAGNOSTIC-only ones", () => {
    const types = new Set(detailed.events.map((event) => event.type));
    for (const required of [
      "SKILL_USE_STARTED",
      "HIT_CONFIRMED",
      "DAMAGE_APPLIED",
      "EFFECT_APPLIED",
    ]) {
      expect(types.has(required), `DETAILED is missing ${required}`).toBe(true);
    }

    // 「効果が発動しなかった理由」が既定より詳しいレベルで必ず読めること。
    for (const diagnosticType of DIAGNOSTIC_EVENT_TYPES) {
      expect(types.has(diagnosticType), `DETAILED is missing ${diagnosticType}`).toBe(true);
    }
    expect(
      detailed.events.filter((event) => event.category === "DIAGNOSTIC").length,
    ).toBeGreaterThan(0);
  });

  it("IT-REL-004-LOG-LEVEL-003 (12_テスト戦略.md「独立Reducerで復元できる」): DETAILED returns the complete state history and finalState, so initialState + stateTransitions still reconstructs it", () => {
    expect(detailed.stateTransitions.length).toBeGreaterThan(0);
    expect(detailed.finalState).toBeDefined();

    // 状態履歴は間引かれていない: 連番が0から1ずつ繋がる。
    let expectedBefore = 0;
    for (const transition of detailed.stateTransitions) {
      expect(transition.stateVersionBefore).toBe(expectedBefore);
      expect(transition.stateVersionAfter).toBe(expectedBefore + 1);
      expectedBefore = transition.stateVersionAfter;
    }
    expect(detailed.finalState!.stateVersion).toBe(expectedBefore);

    // 状態変更を持つイベントは、その差分を指すindexを持つ。
    for (const event of detailed.events) {
      if (event.stateTransitionIndex !== undefined) {
        expect(detailed.stateTransitions[event.stateTransitionIndex]).toBeDefined();
      }
    }

    // 「DIAGNOSTICでもスタックトレース、ファイルパス、秘密情報を含めない」。
    const serialized = JSON.stringify(
      detailed.events.filter((event) => event.category === "DIAGNOSTIC"),
    );
    expect(serialized).not.toMatch(/\/Users\/|\/home\/|node_modules|\.ts:\d+|at Object\./);
    expect(serialized).not.toMatch(/randomState|seed|stack/i);
  });

  it("IT-REL-004-LOG-LEVEL-005 (10_API設計.md「UnitBattleSummaryResponse」): both levels return the same unitSummaries, so lowering the level never silently zeroes the per-unit aggregates", () => {
    expect(summary.unitSummaries).toEqual(detailed.unitSummaries);

    // 行はinitialStateのユニットと1対1で対応する（SUMMARYはfinalStateを返さない
    // ため、この対応こそがサマリー表示の唯一の土台になる）。
    expect(summary.unitSummaries.map((entry) => entry.battleUnitId)).toEqual(
      summary.initialState.units.map((unit) => unit.battleUnitId),
    );
    for (const entry of detailed.unitSummaries) {
      const unit = detailed.finalState!.units.find(
        (candidate) => candidate.battleUnitId === entry.battleUnitId,
      )!;
      expect(entry.side).toBe(unit.side);
      expect(entry.finalHp).toBe(unit.hp.current);
      expect(entry.maximumHp).toBe(unit.hp.maximum);
      expect(entry.combatStatus).toBe(unit.combatStatus);
    }

    // この編成は実際にダメージが入る。全行0なら集計経路が繋がっていない。
    expect(detailed.unitSummaries.some((entry) => entry.damageDealt > 0)).toBe(true);
    const dealt = detailed.unitSummaries.reduce((sum, entry) => sum + entry.damageDealt, 0);
    const taken = detailed.unitSummaries.reduce((sum, entry) => sum + entry.damageTaken, 0);
    expect(dealt).toBe(taken);
  });

  it("IT-REL-004-LOG-LEVEL-006 (10_API設計.md「公開レベル」): the SUMMARY body does not grow with the event log, which is the whole point of the level", () => {
    const summarySize = JSON.stringify(summary).length;
    const detailedSize = JSON.stringify(detailed).length;

    // 具体的な削減率は戦闘の長さで決まる（長い戦闘ほど大きくなる）ため、
    // ここで固定するのは「桁が違う」ことだけにする。5対5演習での実サイズ目標は
    // 手動確認の範囲（Issue #465 完了条件）。
    expect(summarySize).toBeLessThan(detailedSize / 10);

    // SUMMARYの大きさは`initialState`と`unitSummaries`でほぼ説明が付く
    // ——つまりイベント数に比例する部分を持たない。
    const fixedPart =
      JSON.stringify(summary.initialState).length + JSON.stringify(summary.unitSummaries).length;
    expect(summarySize - fixedPart).toBeLessThan(500);
  });

  it("IT-REL-004-LOG-LEVEL-004 (12_テスト戦略.md「実際の代表レスポンスが生成Schemaへ適合する」): both levels serialize into bodies that satisfy the published v1 doc schema, including the per-event-type details oneOf", () => {
    const validate = new Ajv({ strict: false }).compile(battleSimulationResponseDocSchema);

    for (const [level, body] of [
      ["SUMMARY", summary],
      ["DETAILED", detailed],
    ] as const) {
      expect(validate(body), `${level}: ${JSON.stringify(validate.errors)}`).toBe(true);
      expect(body.schemaVersion).toBe(1);
    }
  });
});
