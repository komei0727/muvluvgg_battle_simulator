import type { Page } from "@playwright/test";
import { CATALOG_REVISION } from "../fixtures/catalog.js";
import {
  API_BASE_URL,
  CATALOG_URL,
  SIMULATION_URL,
  TACTICAL_EXERCISE_EVALUATION_URL,
  TACTICAL_EXERCISE_URL,
  TOTAL_WAR_URL,
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

// 総力戦POST（`POST /api/v1/total-war-simulations`）を戦闘POSTと同じ方針でmockする。
export async function mockTotalWar(page: Page, response: MockResponse): Promise<void> {
  await page.route(TOTAL_WAR_URL, async (route) => {
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
  /** 送られた通し試行番号の区間。`[先頭, 件数]`で記録する。 */
  readonly runIndices: readonly [number, number];
}

interface EvaluationRequestBody {
  readonly seed: string;
  readonly cases: readonly {
    readonly caseId: string;
    readonly allyFormation: {
      readonly units: readonly { readonly unitDefinitionId: string }[];
    };
    readonly runIndices: readonly number[];
  }[];
}

/**
 * 大量試行POST（`POST /api/v1/tactical-exercise-evaluations`）をmockし、届いた
 * チャンクを記録する。統計実行は分割送信そのものが仕様なので、E2Eでも「何回・
 * どの試行番号を送ったか」を見る必要がある。観測値は試行番号だけから決める ——
 * 実サーバーと同じく、チャンクの切り方で同じ試行番号の値が変わらないようにする。
 */
export async function mockTacticalExerciseEvaluation(
  page: Page,
  records: EvaluationRequestRecord[],
): Promise<void> {
  await page.route(TACTICAL_EXERCISE_EVALUATION_URL, async (route) => {
    const body = route.request().postDataJSON() as EvaluationRequestBody;
    const caseBody = body.cases[0];
    const runIndices = caseBody?.runIndices ?? [];
    records.push({ seed: body.seed, runIndices: [runIndices[0] ?? -1, runIndices.length] });
    // 枠数はリクエストの味方編成から決める。固定長で返すと、2体編成のE2Eが
    // 「応答の枠が編成より少ない」契約違反の経路を通ってしまう。
    const allyIds = caseBody?.allyFormation.units.map((unit) => unit.unitDefinitionId) ?? [];
    // 1体目は1試行あたり18〜22回ブレイクし、以降の枠は0〜2回に留まる。実際の演習の
    // 桁（総ブレイク20〜30）と、枠ごとの偏りの両方を再現する。
    const unitBreaks = (runIndex: number, unitIndex: number): number =>
      unitIndex === 0 ? 18 + (runIndex % 5) : (runIndex + unitIndex) % 3;
    const unitRecord = (
      side: "ALLY" | "ENEMY",
      unitIndex: number,
      unitDefinitionId: string,
      damageDealt: number,
    ) => ({
      side,
      unitIndex,
      unitDefinitionId,
      damageDealt,
      damageTaken: 0,
      healingDone: 0,
      finalHp: 100,
      maximumHp: 100,
      combatStatus: "ACTIVE",
    });

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Expose-Headers": EXPOSED_HEADERS },
      body: JSON.stringify({
        schemaVersion: 1,
        seed: body.seed,
        seedDerivationVersion: "MULBERRY32_FNV1A_SPLITMIX32_V1",
        // 実サーバーと同じく、評価もCatalog GETと同じrevisionで返す。ずらすと
        // 「実行中にCatalogが切り替わった」扱いになり結果を出さない。
        catalogRevision: CATALOG_REVISION,
        engineRevision: "e2e-engine",
        requestedRuns: runIndices.length,
        completedRuns: runIndices.length,
        partial: false,
        cases: [
          {
            caseId: caseBody?.caseId ?? "exercise",
            runs: runIndices.map((runIndex) => ({
              runIndex,
              totalScore: 1000 + runIndex,
              // 味方の枠が起こした分に、発生源ユニットを持たないブレイク（R-MEM-04）
              // を2回足す。脚注の残差が0にならないようにする。
              breakCount: allyIds.reduce(
                (total, _id, unitIndex) => total + unitBreaks(runIndex, unitIndex),
                2,
              ),
              completionReason: "TURN_LIMIT_REACHED",
              completedTurn: 5,
              units: [
                ...allyIds.map((id, unitIndex) =>
                  unitRecord("ALLY", unitIndex, id, 500 + runIndex - unitIndex * 120),
                ),
                unitRecord("ENEMY", 0, "UNIT_ENEMY", 0),
              ],
              allyUnitBreaks: allyIds.map((unitDefinitionId, unitIndex) => ({
                unitIndex,
                unitDefinitionId,
                breakCount: unitBreaks(runIndex, unitIndex),
              })),
            })),
            incompleteRunIndices: [],
          },
        ],
      }),
    });
  });
}

/**
 * `API_ACCESS_KEYS`を設定した配備を再現する。`/api/v1/*`のうち`Authorization:
 * Bearer <accessKey>`を持たない要求へ401を返し、持つ要求は先に登録した
 * mock（`mockCatalog`等）へ委ねる。Playwrightは後から登録したrouteを先に評価する
 * ため、他のmockを登録し終えてから呼ぶこと。受け取ったヘッダーは`received`へ記録する。
 */
export async function requireAccessKey(
  page: Page,
  accessKey: string,
  received: (string | null)[],
): Promise<void> {
  await page.route(`${API_BASE_URL}/api/v1/**`, async (route) => {
    const authorization = route.request().headers()["authorization"] ?? null;
    received.push(authorization);
    if (authorization === `Bearer ${accessKey}`) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      headers: {
        "Access-Control-Expose-Headers": EXPOSED_HEADERS,
        "WWW-Authenticate": "Bearer",
      },
      body: JSON.stringify({
        schemaVersion: 1,
        error: { code: "UNAUTHORIZED", message: "A valid access key is required.", violations: [] },
      }),
    });
  });
}
