import { describe, expect, it } from "vitest";
import { parseGoldenEventTypesCliRequest } from "./golden-event-types-cli-request.js";

/**
 * `dump-golden-event-types-cli.ts`の引数解析（Issue #607 PR #628レビュー指摘）。
 * `pnpm run <script> -- <args>` は npm と異なり `--` を剥がさずそのまま転送するため、
 * `process.argv.slice(2)`の先頭に`--`が literal に残る（`["--", "unit", "..."]`）。
 * このケースを剥がし損ねるとデバッグ経路が常にUsageで終了する——実際に起きた回帰。
 */
describe("parseGoldenEventTypesCliRequest", () => {
  it("UT-TESTING-GOLDENCLI-001: parses a unit request", () => {
    expect(parseGoldenEventTypesCliRequest(["unit", "UNIT_X"])).toEqual({
      kind: "unit",
      unitDefinitionId: "UNIT_X",
    });
  });

  it("UT-TESTING-GOLDENCLI-002: strips a leading `--` (pnpm forwards it literally, unlike npm)", () => {
    expect(parseGoldenEventTypesCliRequest(["--", "unit", "UNIT_X"])).toEqual({
      kind: "unit",
      unitDefinitionId: "UNIT_X",
    });
  });

  it("UT-TESTING-GOLDENCLI-003: parses a party request, trimming ids and dropping empty entries", () => {
    expect(
      parseGoldenEventTypesCliRequest(["party", " UNIT_A ,UNIT_B,,UNIT_C", "UNIT_D,UNIT_E"]),
    ).toEqual({
      kind: "party",
      ally: ["UNIT_A", "UNIT_B", "UNIT_C"],
      enemy: ["UNIT_D", "UNIT_E"],
    });
  });

  it("UT-TESTING-GOLDENCLI-004: parses an exercise request", () => {
    expect(parseGoldenEventTypesCliRequest(["exercise", "UNIT_A,UNIT_B", "UNIT_TEX"])).toEqual({
      kind: "exercise",
      ally: ["UNIT_A", "UNIT_B"],
      enemyUnitDefinitionId: "UNIT_TEX",
    });
  });

  it("UT-TESTING-GOLDENCLI-005: falls back to usage for empty, unknown, or incomplete argv", () => {
    expect(parseGoldenEventTypesCliRequest([])).toEqual({ kind: "usage" });
    expect(parseGoldenEventTypesCliRequest(["unknown", "X"])).toEqual({ kind: "usage" });
    expect(parseGoldenEventTypesCliRequest(["unit"])).toEqual({ kind: "usage" });
    expect(parseGoldenEventTypesCliRequest(["party", "UNIT_A"])).toEqual({ kind: "usage" });
  });
});
