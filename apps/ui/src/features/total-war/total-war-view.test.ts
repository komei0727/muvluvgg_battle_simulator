import { describe, expect, it } from "vitest";
import {
  composeDisplayedDraft,
  formationHasErrors,
  labelTotalWarViolations,
  violationsForFormation,
} from "./total-war-view.js";
import { createInitialTotalWarDraft } from "./total-war-draft.js";
import type { TotalWarFormations } from "./total-war-draft.js";
import { formationReducer } from "../formation/formation-reducer.js";
import type { FormationAction } from "../formation/formation-reducer.js";
import type { BattleDraft } from "../../entities/battle-draft.js";
import type { UiViolation } from "../../entities/violation.js";

function apply(draft: BattleDraft, ...actions: readonly FormationAction[]): BattleDraft {
  return actions.reduce(
    (current, action) => formationReducer({ draft: current }, action).draft,
    draft,
  );
}

function violation(overrides: Partial<UiViolation>): UiViolation {
  return {
    path: "/allyFormations/0/units",
    code: "UNIT_COUNT_OUT_OF_RANGE",
    message: "味方ユニットを1～5体設定してください。",
    severity: "error",
    ...overrides,
  };
}

describe("composeDisplayedDraft", () => {
  it("UI-UT-TWR-021: takes the ally side from the ally's displayed formation and the enemy side from the enemy's", () => {
    const [first, second, third] = createInitialTotalWarDraft().formations;
    const formations: TotalWarFormations = [
      apply(
        first,
        { type: "unitSelected", slotKey: "ally:FRONT:0", unitDefinitionId: "ALLY_1" },
        { type: "unitSelected", slotKey: "enemy:FRONT:0", unitDefinitionId: "ENEMY_1" },
      ),
      apply(
        second,
        { type: "unitSelected", slotKey: "ally:FRONT:0", unitDefinitionId: "ALLY_2" },
        { type: "memorySelected", side: "ally", index: 0, memoryDefinitionId: "MEM_2" },
      ),
      apply(
        third,
        { type: "unitSelected", slotKey: "enemy:REAR:1", unitDefinitionId: "ENEMY_3" },
        { type: "memorySelected", side: "enemy", index: 2, memoryDefinitionId: "MEM_E3" },
        { type: "enhancementToggled", side: "enemy", enabled: true },
      ),
    ];

    const composed = composeDisplayedDraft(formations, { ally: 1, enemy: 2 });

    expect(composed.allySlots).toBe(formations[1].allySlots);
    expect(composed.allyMemoryDefinitionIds).toEqual(formations[1].allyMemoryDefinitionIds);
    expect(composed.enemySlots).toBe(formations[2].enemySlots);
    expect(composed.enemyMemoryDefinitionIds).toEqual(formations[2].enemyMemoryDefinitionIds);
    expect(composed.enemyEnhancement).toBe(formations[2].enemyEnhancement);
  });
});

describe("violationsForFormation", () => {
  it("UI-UT-TWR-022: keeps only the side's violations of that formation, with the path back in the single-formation form", () => {
    const violations = [
      violation({ formationIndex: 0, path: "/allyFormations/0/units", slotKey: "ally:FRONT:0" }),
      violation({
        formationIndex: 1,
        path: "/allyFormations/1/enhancement/academyLevels/unitTypes/ATTACKER",
        code: "ACADEMY_LEVEL_INVALID",
      }),
      violation({ formationIndex: 1, path: "/enemyFormations/1/units", slotKey: "enemy:FRONT:0" }),
      violation({ path: "/options/logLevel", code: "LOG_LEVEL_INVALID" }),
    ];

    expect(violationsForFormation(violations, "ally", 1)).toEqual([
      violation({
        formationIndex: 1,
        path: "/allyFormation/enhancement/academyLevels/unitTypes/ATTACKER",
        code: "ACADEMY_LEVEL_INVALID",
      }),
      violation({ path: "/options/logLevel", code: "LOG_LEVEL_INVALID" }),
    ]);
    expect(violationsForFormation(violations, "enemy", 1)).toEqual([
      violation({ formationIndex: 1, path: "/enemyFormation/units", slotKey: "enemy:FRONT:0" }),
      violation({ path: "/options/logLevel", code: "LOG_LEVEL_INVALID" }),
    ]);
  });
});

describe("formationHasErrors", () => {
  it("UI-UT-TWR-023: is true only for a formation of that side holding an error, not for warnings or the other side", () => {
    const violations = [
      violation({ formationIndex: 1, path: "/allyFormations/1/units", slotKey: "ally:FRONT:0" }),
      violation({
        formationIndex: 2,
        path: "/allyFormations/2/units",
        code: "APTITUDE_MISMATCH",
        severity: "warning",
      }),
      violation({ formationIndex: 0, path: "/enemyFormations/0/units" }),
    ];

    expect(formationHasErrors(violations, "ally", 0)).toBe(false);
    expect(formationHasErrors(violations, "ally", 1)).toBe(true);
    expect(formationHasErrors(violations, "ally", 2)).toBe(false);
    expect(formationHasErrors(violations, "enemy", 0)).toBe(true);
  });
});

describe("labelTotalWarViolations", () => {
  it("UI-UT-TWR-024: prefixes the side and formation number, but folds side enhancement violations shared by every formation", () => {
    const academy = {
      code: "ACADEMY_LEVEL_INVALID",
      message: "学園レベルは1以上の整数で入力してください。",
    };
    const labelled = labelTotalWarViolations([
      violation({ formationIndex: 1, path: "/allyFormations/1/units" }),
      violation({
        formationIndex: 0,
        path: "/enemyFormations/0/memoryDefinitionIds",
        message: "1つの編成に同じメモリーは1件までです。",
      }),
      violation({
        ...academy,
        formationIndex: 0,
        path: "/enemyFormations/0/enhancement/academyLevels/unitTypes/ATTACKER",
      }),
      violation({
        ...academy,
        formationIndex: 1,
        path: "/enemyFormations/1/enhancement/academyLevels/unitTypes/ATTACKER",
      }),
      violation({ path: "/options/logLevel", message: "ログレベルが不正です。" }),
    ]);

    expect(labelled.map((entry) => entry.message)).toEqual([
      "味方の編成2: 味方ユニットを1～5体設定してください。",
      "敵の編成1: 1つの編成に同じメモリーは1件までです。",
      "敵: 学園レベルは1以上の整数で入力してください。",
      "敵: 学園レベルは1以上の整数で入力してください。",
      "ログレベルが不正です。",
    ]);
  });

  it("keeps per-unit enhancement violations tied to their formation", () => {
    const [labelled] = labelTotalWarViolations([
      violation({
        formationIndex: 2,
        path: "/enemyFormations/2/units/enhancement/level",
        slotKey: "enemy:FRONT:0",
        message: "レベルは1以上の整数で入力してください。",
      }),
    ]);

    expect(labelled?.message).toBe("敵の編成3: レベルは1以上の整数で入力してください。");
  });
});
