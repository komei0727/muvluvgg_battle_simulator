import { describe, expect, it } from "vitest";
import capacityErrorFixture from "../../test/fixtures/error-capacity.json";
import invalidCommandErrorFixture from "../../test/fixtures/error-invalid-command.json";
import { normalizeHttpErrorResponse } from "./error-normalizer.js";

/**
 * Contract fixture tests (`docs/ui-design/06_UIテスト戦略.md`§5、REF-053・Issue #598)。
 * `error-invalid-command.json`/`error-capacity.json`は
 * `apps/api/src/testing/ui-fixtures/build-ui-fixtures.ts`が実サーバーへ実際に
 * POSTして得た422/503のerror bodyそのもの。
 */
describe("normalizeHttpErrorResponse contract fixtures", () => {
  // UI-UT-API-002
  it("normalizes error-invalid-command.json (422 INVALID_COMMAND) to a VALIDATION error with its violations", () => {
    const result = normalizeHttpErrorResponse({ status: 422, body: invalidCommandErrorFixture });

    expect(result.kind).toBe("VALIDATION");
    expect(result.code).toBe("INVALID_COMMAND");
    expect(result.violations).toHaveLength(1);
    expect(result.violations?.[0]?.path).toBe("/turnLimit");
  });

  it("normalizes error-capacity.json (503 CAPACITY_EXCEEDED) to a CAPACITY error", () => {
    const result = normalizeHttpErrorResponse({
      status: 503,
      body: capacityErrorFixture,
      retryAfterSeconds: 5,
    });

    expect(result.kind).toBe("CAPACITY");
    expect(result.code).toBe("CAPACITY_EXCEEDED");
    expect(result.retryAfterSeconds).toBe(5);
  });
});
