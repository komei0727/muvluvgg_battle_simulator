import { describe, expect, expectTypeOf, it } from "vitest";
import type { paths } from "./generated/v1.js";
import type { TotalWarRequest, TotalWarResponse } from "./api-contract.js";
import { validateTotalWarResponse } from "./response-validator.js";

type Overrides = Partial<Record<string, unknown>>;

const ALLY_1 = "ALLY-1-0";
const ENEMY_1 = "ENEMY-1-0";
const ENEMY_2 = "ENEMY-2-0";
const ENEMY_3 = "ENEMY-3-0";

function stateUnit(battleUnitId: string, side: string, formationNumber: number) {
  return {
    battleUnitId,
    unitDefinitionId: `UNIT_${battleUnitId}`,
    side,
    formationNumber,
    combatStatus: "ACTIVE",
    hp: { current: 100, maximum: 100 },
  };
}

function rosterEntry(
  battleUnitId: string,
  side: string,
  formationNumber: number,
  overrides: Overrides = {},
) {
  return {
    battleUnitId,
    unitDefinitionId: `UNIT_${battleUnitId}`,
    side,
    formationNumber,
    formationPosition: { column: 0, row: "FRONT" },
    coordinate: { x: 0, y: 0 },
    reappearance: false,
    deployed: true,
    ...overrides,
  };
}

function summary(battleUnitId: string, side: string, formationNumber: number, deployed = true) {
  return {
    battleUnitId,
    side,
    formationNumber,
    deployed,
    damageDealt: 0,
    damageTaken: 0,
    healingDone: 0,
    finalHp: 100,
    maximumHp: 100,
    combatStatus: "ACTIVE",
  };
}

function stage(stageNumber: number, overrides: Overrides = {}) {
  return {
    stageNumber,
    allyFormationNumber: 1,
    enemyFormationNumber: stageNumber,
    startTurn: stageNumber,
    endTurn: stageNumber,
    defeatedSides: ["ENEMY"],
    ...overrides,
  };
}

function validResult(overrides: Overrides = {}) {
  return {
    outcome: "ALLY_WIN",
    completionReason: "ENEMY_DEFEATED",
    completedTurn: 2,
    stages: [stage(1), stage(2)],
    defeatedFormationCounts: { ally: 0, enemy: 2 },
    ...overrides,
  };
}

/**
 * 味方1編成・敵3編成。敵の編成2は途中出撃（`initialState`に居ない）、編成3は控えのまま
 * 終わる（`deployed: false`。`finalState`にも居ない）。
 */
function validResponse(overrides: Overrides = {}) {
  return {
    schemaVersion: 1,
    battleId: "B_TOTAL_WAR",
    catalogRevision: "rev-1",
    result: validResult(),
    initialState: {
      units: [stateUnit(ALLY_1, "ALLY", 1), stateUnit(ENEMY_1, "ENEMY", 1)],
      formations: {
        ally: { formationCount: 1, activeFormationNumber: 1, defeatedCount: 0 },
        enemy: { formationCount: 3, activeFormationNumber: 1, defeatedCount: 0 },
      },
    },
    finalState: {
      units: [
        stateUnit(ALLY_1, "ALLY", 1),
        stateUnit(ENEMY_1, "ENEMY", 1),
        stateUnit(ENEMY_2, "ENEMY", 2),
      ],
    },
    unitRoster: [
      rosterEntry(ALLY_1, "ALLY", 1),
      rosterEntry(ENEMY_1, "ENEMY", 1),
      rosterEntry(ENEMY_2, "ENEMY", 2, { reappearance: true }),
      rosterEntry(ENEMY_3, "ENEMY", 3, { deployed: false }),
    ],
    unitSummaries: [
      summary(ALLY_1, "ALLY", 1),
      summary(ENEMY_1, "ENEMY", 1),
      summary(ENEMY_2, "ENEMY", 2),
      summary(ENEMY_3, "ENEMY", 3, false),
    ],
    events: [{ type: "FORMATION_DEPLOYED" }],
    stateTransitions: [{ delta: { addedUnits: [stateUnit(ENEMY_2, "ENEMY", 2)] } }],
    ...overrides,
  };
}

function expectMismatch(body: unknown): void {
  const result = validateTotalWarResponse(body);

  expect(result.ok).toBe(false);
  expect(result.ok ? undefined : result.error.kind).toBe("RESPONSE_CONTRACT_MISMATCH");
}

type GeneratedTotalWarResponse =
  paths["/api/v1/total-war-simulations"]["post"]["responses"][200]["content"]["application/json"];
type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;
// 送信本文の型は不変（readonly）で公開しているため、生成型の配列も不変として比べる。
type GeneratedTotalWarRequest = DeepReadonly<
  paths["/api/v1/total-war-simulations"]["post"]["requestBody"]["content"]["application/json"]
>;

describe("TotalWar wire types", () => {
  // 手書きmirrorが、サーバーの公開契約に無い必須項目を要求したり型を食い違えたりしないこと。
  it("accepts every response the generated OpenAPI type allows", () => {
    expectTypeOf<GeneratedTotalWarResponse>().toExtend<TotalWarResponse>();
  });

  // 送信本文はOpenAPIのリクエスト型へそのまま代入できなければならない。
  it("sends a body the generated OpenAPI request type accepts", () => {
    expectTypeOf<TotalWarRequest>().toExtend<GeneratedTotalWarRequest>();
  });
});

// UI-UT-TWR-014 / UI-API-049（03_API・データ連携設計.md §9.2）。
describe("validateTotalWarResponse", () => {
  it("accepts a well-formed response with mid-battle deployment, a reappearance and an undeployed formation", () => {
    const body = validResponse();

    expect(validateTotalWarResponse(body)).toEqual({ ok: true, response: body });
  });

  it.each([
    ["DRAW", "SIMULTANEOUS_DEFEAT"],
    ["DRAW", "TURN_LIMIT_REACHED"],
    ["ALLY_LOSE", "ALLY_DEFEATED"],
    ["FUTURE_OUTCOME", "FUTURE_REASON"],
  ])("accepts outcome %s with completionReason %s", (outcome, completionReason) => {
    const body = validResponse({ result: validResult({ outcome, completionReason }) });

    expect(validateTotalWarResponse(body).ok).toBe(true);
  });

  it("accepts a SUMMARY response without finalState", () => {
    const { finalState: _omitted, ...body } = validResponse();

    expect(validateTotalWarResponse(body).ok).toBe(true);
  });

  it("accepts completedTurn at both ends of 1..15", () => {
    expect(
      validateTotalWarResponse(validResponse({ result: validResult({ completedTurn: 1 }) })).ok,
    ).toBe(true);
    expect(
      validateTotalWarResponse(validResponse({ result: validResult({ completedTurn: 15 }) })).ok,
    ).toBe(true);
  });

  it("accepts a stage that ended with no side defeated", () => {
    const body = validResponse({
      result: validResult({ stages: [stage(1, { defeatedSides: [] })] }),
    });

    expect(validateTotalWarResponse(body).ok).toBe(true);
  });

  it.each([null, "body", []])("rejects a non-object body %j", (body) => {
    expectMismatch(body);
  });

  it.each([
    ["schemaVersion", "1"],
    ["battleId", ""],
    ["catalogRevision", undefined],
    ["events", {}],
    ["stateTransitions", null],
  ])("rejects a malformed %s", (key, value) => {
    expectMismatch(validResponse({ [key]: value }));
  });

  it.each([0, 16, 2.5, "2"])(
    "rejects completedTurn %j outside the integer range 1..15",
    (completedTurn) => {
      expectMismatch(validResponse({ result: validResult({ completedTurn }) }));
    },
  );

  it.each([
    ["outcome", ""],
    ["completionReason", 1],
  ])("rejects a result with a malformed %s", (key, value) => {
    expectMismatch(validResponse({ result: validResult({ [key]: value }) }));
  });

  it("rejects an empty stage list", () => {
    expectMismatch(validResponse({ result: validResult({ stages: [] }) }));
  });

  it.each([
    ["starting at 2", [stage(2)]],
    ["skipping a number", [stage(1), stage(3)]],
    ["repeating a number", [stage(1), stage(1)]],
  ])("rejects stage numbers not sequential from 1 (%s)", (_label, stages) => {
    expectMismatch(validResponse({ result: validResult({ stages }) }));
  });

  it.each([
    ["allyFormationNumber", "1"],
    ["startTurn", 1.5],
    ["endTurn", undefined],
    ["defeatedSides", ["ENEMY", 1]],
  ])("rejects a stage with a malformed %s", (key, value) => {
    expectMismatch(
      validResponse({ result: validResult({ stages: [stage(1, { [key]: value })] }) }),
    );
  });

  it.each([undefined, { ally: 0 }, { ally: -1, enemy: 0 }, { ally: 0, enemy: 1.5 }])(
    "rejects defeatedFormationCounts %j",
    (defeatedFormationCounts) => {
      expectMismatch(validResponse({ result: validResult({ defeatedFormationCounts }) }));
    },
  );

  it("rejects a missing unitRoster", () => {
    expectMismatch(validResponse({ unitRoster: undefined }));
  });

  it.each([
    ["formationNumber", 0],
    ["formationNumber", 4],
    ["reappearance", "false"],
    ["deployed", undefined],
    ["formationPosition", { column: "0", row: "FRONT" }],
    ["unitDefinitionId", ""],
  ])("rejects a roster entry with %s %j", (key, value) => {
    const body = validResponse();
    expectMismatch({
      ...body,
      unitRoster: [rosterEntry(ALLY_1, "ALLY", 1, { [key]: value }), ...body.unitRoster.slice(1)],
    });
  });

  it("rejects a roster that repeats a battleUnitId", () => {
    const body = validResponse();
    expectMismatch({ ...body, unitRoster: [...body.unitRoster, rosterEntry(ALLY_1, "ALLY", 1)] });
  });

  describe("unitSummaries correspond one-to-one with unitRoster, not initialState", () => {
    it("rejects a summary list missing a roster unit (even one never deployed)", () => {
      const body = validResponse();
      expectMismatch({ ...body, unitSummaries: body.unitSummaries.slice(0, 3) });
    });

    it("rejects a duplicated summary row", () => {
      const body = validResponse();
      expectMismatch({
        ...body,
        unitSummaries: [...body.unitSummaries.slice(0, 3), summary(ENEMY_2, "ENEMY", 2)],
      });
    });

    it("rejects a summary row for a unit that is not in the roster", () => {
      const body = validResponse();
      expectMismatch({
        ...body,
        unitSummaries: [...body.unitSummaries, summary("GHOST", "ENEMY", 1)],
      });
    });
  });

  describe("battle states only hold deployed roster units", () => {
    it("rejects an initialState unit missing from the roster", () => {
      const body = validResponse();
      expectMismatch({
        ...body,
        initialState: { units: [...body.initialState.units, stateUnit("GHOST", "ENEMY", 1)] },
      });
    });

    it("rejects an initialState unit whose roster entry was never deployed", () => {
      const body = validResponse();
      expectMismatch({
        ...body,
        initialState: { units: [...body.initialState.units, stateUnit(ENEMY_3, "ENEMY", 3)] },
      });
    });

    it("rejects a finalState unit whose roster entry was never deployed", () => {
      const body = validResponse();
      expectMismatch({
        ...body,
        finalState: { units: [...body.finalState.units, stateUnit(ENEMY_3, "ENEMY", 3)] },
      });
    });

    it("rejects a finalState that lacks a deployed roster unit", () => {
      const body = validResponse();
      expectMismatch({ ...body, finalState: { units: body.finalState.units.slice(0, 2) } });
    });

    it("rejects a malformed initialState", () => {
      expectMismatch(validResponse({ initialState: { units: [{ battleUnitId: ALLY_1 }] } }));
    });
  });
});
