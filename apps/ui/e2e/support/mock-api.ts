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
    const body = route.request().postDataJSON() as EvaluationRequestRecord;
    records.push({ seed: body.seed, runsPerCandidate: body.runsPerCandidate });
    const runs = body.runsPerCandidate;
    const indices = Array.from({ length: runs }, (_value, index) => index);
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
            breakCounts: indices.map(() => 1),
            completedTurns: indices.map(() => 5),
            completionReasons: indices.map(() => "TURN_LIMIT_REACHED"),
            allyUnitDamageTotals: indices.map(() => [500]),
            allyUnitBreakCounts: indices.map(() => [1]),
          },
        ],
      }),
    });
  });
}
