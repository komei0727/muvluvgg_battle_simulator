import { describe, expect, it } from "vitest";
import catalogFixture from "../../test/fixtures/m4.5-catalog.json";
import duplicateDefinitionSuccessFixture from "../../test/fixtures/m4-success-duplicate-definition.json";
import malformedSuccessFixture from "../../test/fixtures/malformed-success.json";
import minimalSuccessFixture from "../../test/fixtures/m4-success-minimal.json";
import totalWarSuccessFixture from "../../test/fixtures/total-war-success.json";
import unknownEventSuccessFixture from "../../test/fixtures/success-unknown-event.json";
import {
  validateCatalogResponse,
  validateSimulationResponse,
  validateTotalWarResponse,
} from "./response-validator.js";

/**
 * Contract fixture tests (`docs/ui-design/06_UIテスト戦略.md`§5、REF-053・Issue #598)。
 * `apps/ui/src/test/fixtures/*.json`は手作業で再現したオブジェクトではなく、
 * `apps/api/src/testing/ui-fixtures/build-ui-fixtures.ts`が実サーバーへ実際に
 * POST/GETしたレスポンス本文そのもの——ここではその実body自体を検証対象にする。
 * 個々の構造規則のテストは`response-validator.test.ts`/
 * `response-validator.simulation.test.ts`の手書きbuilderベースのテストが持つ。
 */
describe("response-validator contract fixtures", () => {
  it("accepts m4.5-catalog.json, the real catalog response", () => {
    const result = validateCatalogResponse(catalogFixture);

    expect(result.ok).toBe(true);
  });

  it("accepts m4-success-minimal.json, the real engine-produced ally win", () => {
    const result = validateSimulationResponse(minimalSuccessFixture);

    expect(result.ok).toBe(true);
  });

  // UI-UT-SUM-004: 同じunitDefinitionIdの異なるbattleUnitIdを別行として保つ。
  it("accepts m4-success-duplicate-definition.json and keeps two roster rows for the same unitDefinitionId", () => {
    const result = validateSimulationResponse(duplicateDefinitionSuccessFixture);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const allyUnits = result.response.initialState.units.filter((unit) => unit.side === "ALLY");
    expect(allyUnits).toHaveLength(2);
    expect(new Set(allyUnits.map((unit) => unit.unitDefinitionId)).size).toBe(1);
    expect(new Set(allyUnits.map((unit) => unit.battleUnitId)).size).toBe(2);
  });

  // UI-TEST-003: unknown event fixtureが正常表示される。
  it("accepts success-unknown-event.json, ignoring its one unrecognized event type", () => {
    const result = validateSimulationResponse(unknownEventSuccessFixture);

    expect(result.ok).toBe(true);
  });

  it("rejects malformed-success.json, which is otherwise real but is missing unitSummaries", () => {
    const result = validateSimulationResponse(malformedSuccessFixture);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("RESPONSE_CONTRACT_MISMATCH");
  });

  // UI-API-049: 実サーバーの総力戦（2編成・途中出撃・再登場・未出撃）を受理する。
  it("accepts total-war-success.json, the real engine-produced total war", () => {
    const result = validateTotalWarResponse(totalWarSuccessFixture);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { unitRoster, initialState } = result.response;
    expect(unitRoster.length).toBeGreaterThan(initialState.units.length);
    expect(unitRoster.some((entry) => !entry.deployed)).toBe(true);
    expect(unitRoster.some((entry) => entry.reappearance && entry.deployed)).toBe(true);
  });

  // 総力戦の結果は通常戦闘の契約では受理できない`initialState`とRosterの関係を持つ。
  it("rejects total-war-success.json as a regular battle response, whose roster is initialState", () => {
    expect(validateSimulationResponse(totalWarSuccessFixture).ok).toBe(false);
  });

  it("rejects a regular battle response as a total war response (no unitRoster)", () => {
    expect(validateTotalWarResponse(minimalSuccessFixture).ok).toBe(false);
  });
});
