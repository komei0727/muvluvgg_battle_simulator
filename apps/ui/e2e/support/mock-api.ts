import type { Page } from "@playwright/test";
import { CATALOG_REVISION } from "../fixtures/catalog.js";
import {
  CATALOG_URL,
  SIMULATION_URL,
  TACTICAL_EXERCISE_EVALUATION_URL,
  TACTICAL_EXERCISE_URL,
} from "./constants.js";

export interface MockResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

// A cross-origin fetch() only exposes CORS-safelisted response headers to
// JavaScript unless Access-Control-Expose-Headers names the rest — the same
// origin-page-vs-Cloud-Run-API split this app runs under in production. The
// real API exposes exactly these three
// (「X-Request-Id、Retry-After、
// ETagをexposeする」), so the mock must too, or api-client.ts's
// response.headers.get("Retry-After"/"X-Request-Id"/"ETag") reads null here
// even though route.fulfill sent the header — a failure mode that would
// never surface against same-origin dev tooling.
const EXPOSED_HEADERS = "X-Request-Id, Retry-After, ETag";

// Serves a single fixed response for every GET to the Catalog endpoint —
// sufficient for these specs, none of which reload the Catalog mid-test.
export async function mockCatalog(page: Page, response: MockResponse): Promise<void> {
  await page.route(CATALOG_URL, async (route) => {
    await route.fulfill({
      status: response.status,
      contentType: "application/json",
      headers: { "Access-Control-Expose-Headers": EXPOSED_HEADERS, ...response.headers },
      body: JSON.stringify(response.body),
    });
  });
}

// Serves `responses` in order across successive POSTs (submit, then rerun,
// ...), repeating the last entry once exhausted. This lets a single spec
// cover "succeeds, then a rerun fails" (UI-E2E-004) without re-registering
// the route mid-test.
export async function mockSimulationSequence(
  page: Page,
  responses: readonly MockResponse[],
): Promise<void> {
  let callIndex = 0;
  await page.route(SIMULATION_URL, async (route) => {
    const response = responses[Math.min(callIndex, responses.length - 1)];
    callIndex += 1;
    if (response === undefined) {
      throw new Error("mockSimulationSequence requires at least one response.");
    }
    await route.fulfill({
      status: response.status,
      contentType: "application/json",
      headers: { "Access-Control-Expose-Headers": EXPOSED_HEADERS, ...response.headers },
      body: JSON.stringify(response.body),
    });
  });
}

// 戦術演習POST（`POST /api/v1/tactical-exercises`）を戦闘POSTと同じ方針でmockする。
export async function mockTacticalExercise(page: Page, response: MockResponse): Promise<void> {
  await page.route(TACTICAL_EXERCISE_URL, async (route) => {
    await route.fulfill({
      status: response.status,
      contentType: "application/json",
      headers: { "Access-Control-Expose-Headers": EXPOSED_HEADERS, ...response.headers },
      body: JSON.stringify(response.body),
    });
  });
}

export interface EvaluationRequestRecord {
  readonly seed: string;
  readonly runsPerCandidate: number;
}

interface EvaluationRequestBody extends EvaluationRequestRecord {
  readonly candidates: readonly {
    readonly allyFormation: { readonly units: readonly unknown[] };
  }[];
}

/**
 * 一括評価POST（`POST /api/v1/tactical-exercise-evaluations`）をmockし、届いた
 * チャンクを記録する。統計実行は分割送信そのものが仕様なので、E2Eでも「何回・
 * どのseedで送ったか」を見る必要がある。
 */
export async function mockTacticalExerciseEvaluation(
  page: Page,
  records: EvaluationRequestRecord[],
): Promise<void> {
  await page.route(TACTICAL_EXERCISE_EVALUATION_URL, async (route) => {
    const body = route.request().postDataJSON() as EvaluationRequestBody;
    records.push({ seed: body.seed, runsPerCandidate: body.runsPerCandidate });
    const runs = body.runsPerCandidate;
    const indices = Array.from({ length: runs }, (_value, index) => index);
    // 列数はリクエストの味方編成から決める。固定長で返すと、2体編成のE2Eが
    // 「応答の列が編成より少ない」契約違反の経路を通ってしまう。
    const unitCount = Math.max(1, body.candidates[0]?.allyFormation.units.length ?? 1);
    const unitIndices = Array.from({ length: unitCount }, (_value, index) => index);
    // 1体目は1試行あたり18〜22回ブレイクし、以降の枠は0〜2回に留まる。実際の演習の
    // 桁（総ブレイク20〜30）と、枠ごとの偏りの両方を再現する。
    const unitBreaks = (runIndex: number, unitIndex: number): number =>
      unitIndex === 0 ? 18 + (runIndex % 5) : (runIndex + unitIndex) % 3;

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Expose-Headers": EXPOSED_HEADERS },
      body: JSON.stringify({
        schemaVersion: 1,
        // 実サーバーと同じく、評価もCatalog GETと同じrevisionで返す。ずらすと
        // 「実行中にCatalogが切り替わった」扱いになり結果を出さない。
        catalogRevision: CATALOG_REVISION,
        seed: body.seed,
        runsPerCandidate: runs,
        candidates: [
          {
            completedRuns: runs,
            scores: indices.map((index) => 1000 + index),
            breakCounts: indices.map((index) =>
              // 味方の枠が起こした分に、発生源ユニットを持たないブレイク（R-MEM-04）
              // を2回足す。脚注の残差が0にならないようにする。
              unitIndices.reduce((total, unitIndex) => total + unitBreaks(index, unitIndex), 2),
            ),
            completedTurns: indices.map(() => 5),
            completionReasons: indices.map(() => "TURN_LIMIT_REACHED"),
            allyUnitDamageTotals: indices.map((index) =>
              unitIndices.map((unitIndex) => 500 + index - unitIndex * 120),
            ),
            allyUnitBreakCounts: indices.map((index) =>
              unitIndices.map((unitIndex) => unitBreaks(index, unitIndex)),
            ),
          },
        ],
      }),
    });
  });
}
