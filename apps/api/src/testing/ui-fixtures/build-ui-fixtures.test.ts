import { describe, expect, it } from "vitest";
import { buildUiFixtures, UI_FIXTURE_FILENAMES } from "./build-ui-fixtures.js";

/**
 * REF-053 (Issue #598): `apps/ui/src/test/fixtures/*.json` は手作業で再現した
 * オブジェクトではなく、この生成器が実サーバー（`buildServer`）へ実際にPOST/GETした
 * レスポンス本文そのものである（`docs/ui-design/06_UIテスト戦略.md`§5）。
 * `success-unknown-event.json`と`malformed-success.json`だけは、実装が本来
 * 生成し得ない形（未知イベント種別・契約違反）を意図的に作るため、生成済みの
 * 成功レスポンスを元に決定的な改変を加える — その改変内容もここで固定する。
 */
describe("buildUiFixtures", () => {
  it("produces exactly the seven fixtures named by 06_UIテスト戦略.md §5", async () => {
    const fixtures = await buildUiFixtures();

    expect(Object.keys(fixtures).sort()).toEqual([...UI_FIXTURE_FILENAMES].sort());
  });

  it("m4.5-catalog.json is a genuine catalog response carrying an EXERCISE_ENEMY unit and the production gear-effect table", async () => {
    const fixtures = await buildUiFixtures();
    const catalog = fixtures["m4.5-catalog.json"] as Record<string, unknown>;

    expect(catalog["schemaVersion"]).toBe(1);
    expect(typeof catalog["catalogRevision"]).toBe("string");
    expect((catalog["catalogRevision"] as string).length).toBeGreaterThan(0);
    const units = catalog["units"] as Array<Record<string, unknown>>;
    expect(
      units.some(
        (unit) => unit["category"] === "EXERCISE_ENEMY" && unit["exerciseActive"] === true,
      ),
    ).toBe(true);
    const gearEffects = catalog["gearEffects"] as unknown[];
    expect(Array.isArray(gearEffects)).toBe(true);
    expect(gearEffects.length).toBeGreaterThan(0);
  });

  it("m4-success-minimal.json is a genuine engine-produced ally win against a 1v1 formation", async () => {
    const fixtures = await buildUiFixtures();
    const body = fixtures["m4-success-minimal.json"] as Record<string, unknown>;

    expect(body["schemaVersion"]).toBe(1);
    expect((body["result"] as Record<string, unknown>)["outcome"]).toBe("ALLY_WIN");
    expect(body["unitSummaries"]).toHaveLength(2);
    const events = body["events"] as Array<Record<string, unknown>>;
    expect(events.some((event) => event["type"] === "DAMAGE_APPLIED")).toBe(true);
  });

  it("m4-success-duplicate-definition.json keeps the same unitDefinitionId on two distinct battleUnitId roster rows (UI-UT-SUM-004)", async () => {
    const fixtures = await buildUiFixtures();
    const body = fixtures["m4-success-duplicate-definition.json"] as Record<string, unknown>;
    const initialState = body["initialState"] as Record<string, unknown>;
    const units = initialState["units"] as Array<Record<string, unknown>>;
    const allyUnits = units.filter((unit) => unit["side"] === "ALLY");

    expect(allyUnits).toHaveLength(2);
    expect(new Set(allyUnits.map((unit) => unit["unitDefinitionId"])).size).toBe(1);
    expect(new Set(allyUnits.map((unit) => unit["battleUnitId"])).size).toBe(2);
    expect(body["unitSummaries"]).toHaveLength(3);
  });

  it("success-unknown-event.json is the minimal success body plus exactly one appended, unrecognized event type", async () => {
    const fixtures = await buildUiFixtures();
    const base = fixtures["m4-success-minimal.json"] as Record<string, unknown>;
    const withUnknownEvent = fixtures["success-unknown-event.json"] as Record<string, unknown>;
    const baseEvents = base["events"] as Array<Record<string, unknown>>;
    const events = withUnknownEvent["events"] as Array<Record<string, unknown>>;

    expect(events.length).toBe(baseEvents.length + 1);
    expect(events.slice(0, baseEvents.length)).toEqual(baseEvents);
    const knownTypes = new Set(baseEvents.map((event) => event["type"]));
    expect(knownTypes.has(events[events.length - 1]!["type"])).toBe(false);
  });

  it("error-invalid-command.json carries the real HTTP 422 status alongside the out-of-range-turnLimit body (same scenario as build-server.test.ts's out-of-range turnLimit case)", async () => {
    const fixtures = await buildUiFixtures();
    const fixture = fixtures["error-invalid-command.json"] as {
      status: number;
      body: Record<string, unknown>;
    };

    expect(fixture.status).toBe(422);
    const error = fixture.body["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("INVALID_COMMAND");
    const violations = error["violations"] as Array<Record<string, unknown>>;
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]!["path"]).toBe("/turnLimit");
  });

  it("error-capacity.json carries the real HTTP 503 status alongside the capacity-exceeded body (same scenario as build-server.test.ts's capacity-exceeded case)", async () => {
    const fixtures = await buildUiFixtures();
    const fixture = fixtures["error-capacity.json"] as {
      status: number;
      body: Record<string, unknown>;
    };

    expect(fixture.status).toBe(503);
    const error = fixture.body["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("CAPACITY_EXCEEDED");
  });

  it("malformed-success.json is the minimal success body with unitSummaries deliberately removed, so it is otherwise intact but contract-invalid", async () => {
    const fixtures = await buildUiFixtures();
    const base = fixtures["m4-success-minimal.json"] as Record<string, unknown>;
    const malformed = fixtures["malformed-success.json"] as Record<string, unknown>;

    expect(malformed["schemaVersion"]).toBe(1);
    expect(malformed["battleId"]).toBe(base["battleId"]);
    expect("unitSummaries" in malformed).toBe(false);
  });
});
