import { describe, expect, it } from "vitest";
import catalogFixture from "../../test/fixtures/m4.5-catalog.json";
import duplicateDefinitionSuccessFixture from "../../test/fixtures/m4-success-duplicate-definition.json";
import malformedSuccessFixture from "../../test/fixtures/malformed-success.json";
import minimalSuccessFixture from "../../test/fixtures/m4-success-minimal.json";
import unknownEventSuccessFixture from "../../test/fixtures/success-unknown-event.json";
import { validateCatalogResponse, validateSimulationResponse } from "./response-validator.js";

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
});
