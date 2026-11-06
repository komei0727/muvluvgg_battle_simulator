import { describe, expect, it } from "vitest";
import { mapTotalWarServerViolations } from "./total-war-violation-mapper.js";
import type { TotalWarFormationSlotMaps } from "./total-war-request-mapper.js";
import { memorySlotKeyOf, slotKeyOf } from "../formation/types.js";
import type { ViolationResponseBody } from "../../shared/api/api-contract.js";
import totalWarInvalidCommandFixture from "../../test/fixtures/total-war-error-invalid-command.json";

/** 味方2編成・敵2編成の送信時点の対応表。編成ごとに中身を変えて取り違えを検出する。 */
const SLOT_MAPS: TotalWarFormationSlotMaps = {
  ally: [
    {
      unitSlotKeys: [slotKeyOf("ally", "FRONT", 0)],
      memorySlotKeys: [memorySlotKeyOf("ally", 0)],
      gearSlotIndices: [[]],
    },
    {
      unitSlotKeys: [slotKeyOf("ally", "FRONT", 1), slotKeyOf("ally", "REAR", 2)],
      memorySlotKeys: [memorySlotKeyOf("ally", 2), memorySlotKeyOf("ally", 5)],
      gearSlotIndices: [[], [3, 8]],
    },
  ],
  enemy: [
    { unitSlotKeys: [slotKeyOf("enemy", "FRONT", 0)], memorySlotKeys: [], gearSlotIndices: [[]] },
    {
      unitSlotKeys: [slotKeyOf("enemy", "FRONT", 0), slotKeyOf("enemy", "REAR", 1)],
      memorySlotKeys: [],
      gearSlotIndices: [[], []],
    },
  ],
};

function violation(path: string | undefined, ruleId = "R-TWR-01"): ViolationResponseBody {
  return { message: "invalid", ruleId, ...(path === undefined ? {} : { path }) };
}

describe("mapTotalWarServerViolations (UI-UT-TWR-011)", () => {
  it("maps units[n] through the i-th formation's table and adds the formation index", () => {
    const [mapped] = mapTotalWarServerViolations(
      [violation("/allyFormations/1/units/1/position")],
      SLOT_MAPS,
    );
    expect(mapped).toEqual({
      path: "/allyFormations/1/units/1/position",
      slotKey: slotKeyOf("ally", "REAR", 2),
      formationIndex: 1,
      code: "R-TWR-01",
      message: "invalid",
      severity: "error",
    });
  });

  it("maps memoryDefinitionIds[n] and gears[m] through the i-th formation's table", () => {
    const mapped = mapTotalWarServerViolations(
      [
        violation("/allyFormations/1/memoryDefinitionIds/1"),
        violation("/allyFormations/1/units/1/enhancement/gears/1/stat"),
        violation("/allyFormations/0/memoryDefinitionIds/0"),
      ],
      SLOT_MAPS,
    );
    expect(mapped[0]).toMatchObject({ slotKey: memorySlotKeyOf("ally", 5), formationIndex: 1 });
    expect(mapped[1]).toMatchObject({
      slotKey: slotKeyOf("ally", "REAR", 2),
      gearIndex: 8,
      formationIndex: 1,
    });
    expect(mapped[2]).toMatchObject({ slotKey: memorySlotKeyOf("ally", 0), formationIndex: 0 });
  });

  it("maps the real HTTP 422 fixture to the enemy formation 2 slot", () => {
    const mapped = mapTotalWarServerViolations(
      totalWarInvalidCommandFixture.body.error.violations,
      SLOT_MAPS,
    );
    expect(mapped).toEqual([
      expect.objectContaining({
        path: "/enemyFormations/1/units/1/unitDefinitionId",
        slotKey: slotKeyOf("enemy", "REAR", 1),
        formationIndex: 1,
      }),
    ]);
  });

  it("keeps the formation index on side enhancement violations without a slot", () => {
    const [mapped] = mapTotalWarServerViolations(
      [violation("/enemyFormations/1/enhancement/academyLevels/unitTypes/AGILE", "R-ENH-02")],
      SLOT_MAPS,
    );
    expect(mapped).toEqual({
      path: "/enemyFormations/1/enhancement/academyLevels/unitTypes/AGILE",
      formationIndex: 1,
      code: "R-ENH-02",
      message: "invalid",
      severity: "error",
    });
  });

  it("does not attach slots to the formation array, log level or missing paths", () => {
    const mapped = mapTotalWarServerViolations(
      [violation("/allyFormations"), violation("/options/logLevel"), violation(undefined)],
      SLOT_MAPS,
    );
    expect(mapped).toEqual([
      { path: "/allyFormations", code: "R-TWR-01", message: "invalid", severity: "error" },
      { path: "/options/logLevel", code: "R-TWR-01", message: "invalid", severity: "error" },
      { path: "", code: "R-TWR-01", message: "invalid", severity: "error" },
    ]);
  });

  it("leaves indices outside the submitted formations unmapped", () => {
    const [mapped] = mapTotalWarServerViolations(
      [violation("/allyFormations/2/units/0/unitDefinitionId")],
      SLOT_MAPS,
    );
    expect(mapped).toEqual({
      path: "/allyFormations/2/units/0/unitDefinitionId",
      code: "R-TWR-01",
      message: "invalid",
      severity: "error",
    });
  });
});
