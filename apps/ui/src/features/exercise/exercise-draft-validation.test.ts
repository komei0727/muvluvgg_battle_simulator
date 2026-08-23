import { describe, expect, it } from "vitest";
import { validateExerciseDraft } from "./exercise-draft-validation.js";
import type { BattleDraft, Side, UiColumn, UiRow } from "../../entities/battle-draft.js";
import type { BattleSimulationCatalogResponse } from "../../shared/api/api-contract.js";
import { selectCanSubmit } from "../formation/draft-validation.js";
import { MAX_EXERCISE_RUN_COUNT, createInitialDraft, slotKeyOf } from "../formation/types.js";

const catalog: BattleSimulationCatalogResponse = {
  schemaVersion: 1,
  catalogRevision: "rev-1",
  units: [
    {
      unitDefinitionId: "UNIT_ALLY",
      displayName: "味方",
      characterName: "Ally",
      attribute: "CUTE",
      unitType: "ATTACKER",
      role: "PHYSICAL_ATTACKER",
      positionAptitudes: ["FRONT"],
    },
    {
      unitDefinitionId: "UNIT_ENEMY",
      displayName: "敵",
      characterName: "Enemy",
      category: "EXERCISE_ENEMY",
      exerciseActive: true,
      attribute: "SMART",
      unitType: "ATTACKER",
      role: "TANK",
      positionAptitudes: ["FRONT"],
    },
    {
      unitDefinitionId: "UNIT_ENEMY_CLOSED",
      displayName: "開催終了の敵",
      characterName: "Closed Enemy",
      category: "EXERCISE_ENEMY",
      exerciseActive: false,
      attribute: "SMART",
      unitType: "ATTACKER",
      role: "TANK",
      positionAptitudes: ["FRONT"],
    },
  ],
  memories: [{ memoryDefinitionId: "MEM_A", displayName: "メモリーA" }],
};

function withUnit(
  draft: BattleDraft,
  side: Side,
  row: UiRow,
  column: UiColumn,
  unitDefinitionId: string,
): BattleDraft {
  const slotKey = slotKeyOf(side, row, column);
  const map = (slots: BattleDraft["allySlots"]) =>
    slots.map((slot) => (slot.slotKey === slotKey ? { ...slot, unitDefinitionId } : slot));
  return side === "ally"
    ? { ...draft, allySlots: map(draft.allySlots) }
    : { ...draft, enemySlots: map(draft.enemySlots) };
}

function withMemory(draft: BattleDraft, side: Side, index: number, id: string): BattleDraft {
  const replace = (ids: readonly (string | undefined)[]) =>
    ids.map((current, position) => (position === index ? id : current));
  return side === "ally"
    ? { ...draft, allyMemoryDefinitionIds: replace(draft.allyMemoryDefinitionIds) }
    : { ...draft, enemyMemoryDefinitionIds: replace(draft.enemyMemoryDefinitionIds) };
}

function validExerciseDraft(): BattleDraft {
  let draft = createInitialDraft();
  draft = withUnit(draft, "ally", "FRONT", 0, "UNIT_ALLY");
  draft = withUnit(draft, "enemy", "FRONT", 0, "UNIT_ENEMY");
  return draft;
}

function codes(violations: readonly { readonly code: string }[]): readonly string[] {
  return violations.map((violation) => violation.code);
}

// UI-AC-020 / UI-API-014: 送信前検証で敵1体・敵メモリー0件を強制する。
describe("validateExerciseDraft", () => {
  it("accepts one ally and exactly one enemy", () => {
    const violations = validateExerciseDraft(validExerciseDraft(), catalog);

    expect(selectCanSubmit(violations)).toBe(true);
  });

  it("accepts five allies with six ally memories", () => {
    let draft = validExerciseDraft();
    draft = withUnit(draft, "ally", "FRONT", 1, "UNIT_ALLY");
    draft = withUnit(draft, "ally", "FRONT", 2, "UNIT_ALLY");
    draft = withUnit(draft, "ally", "REAR", 0, "UNIT_ALLY");
    draft = withUnit(draft, "ally", "REAR", 1, "UNIT_ALLY");
    for (let index = 0; index < 6; index += 1) {
      draft = withMemory(draft, "ally", index, "MEM_A");
    }

    expect(selectCanSubmit(validateExerciseDraft(draft, catalog))).toBe(true);
  });

  it("rejects a second enemy unit", () => {
    const draft = withUnit(validExerciseDraft(), "enemy", "FRONT", 1, "UNIT_ENEMY");

    const violations = validateExerciseDraft(draft, catalog);

    expect(codes(violations)).toContain("UNIT_COUNT_OUT_OF_RANGE");
    expect(selectCanSubmit(violations)).toBe(false);
  });

  it("rejects an empty enemy formation", () => {
    const draft = withUnit(createInitialDraft(), "ally", "FRONT", 0, "UNIT_ALLY");

    expect(selectCanSubmit(validateExerciseDraft(draft, catalog))).toBe(false);
  });

  it("rejects any enemy memory", () => {
    const draft = withMemory(validExerciseDraft(), "enemy", 0, "MEM_A");

    const violations = validateExerciseDraft(draft, catalog);

    expect(codes(violations)).toContain("MEMORY_COUNT_OUT_OF_RANGE");
    expect(selectCanSubmit(violations)).toBe(false);
  });

  // R-TEX-11 #2: 味方は`PLAYABLE`のみ、敵は`EXERCISE_ENEMY`のみ。
  it("rejects an exercise enemy placed in an ally slot", () => {
    const draft = withUnit(validExerciseDraft(), "ally", "FRONT", 1, "UNIT_ENEMY");

    const violations = validateExerciseDraft(draft, catalog);

    expect(violations).toContainEqual(
      expect.objectContaining({
        code: "UNIT_POOL_MISMATCH",
        severity: "error",
        slotKey: slotKeyOf("ally", "FRONT", 1),
      }),
    );
    expect(selectCanSubmit(violations)).toBe(false);
  });

  it("rejects a playable unit placed in the exercise enemy slot", () => {
    let draft = createInitialDraft();
    draft = withUnit(draft, "ally", "FRONT", 0, "UNIT_ALLY");
    draft = withUnit(draft, "enemy", "FRONT", 0, "UNIT_ALLY");

    const violations = validateExerciseDraft(draft, catalog);

    expect(codes(violations)).toContain("UNIT_POOL_MISMATCH");
    expect(selectCanSubmit(violations)).toBe(false);
  });

  // R-TEX-11 #4: `exerciseActive`は表示専用で、受理条件に影響しない。
  it("accepts an exercise enemy whose event has already closed", () => {
    let draft = createInitialDraft();
    draft = withUnit(draft, "ally", "FRONT", 0, "UNIT_ALLY");
    draft = withUnit(draft, "enemy", "FRONT", 0, "UNIT_ENEMY_CLOSED");

    const violations = validateExerciseDraft(draft, catalog);

    expect(codes(violations)).not.toContain("UNIT_POOL_MISMATCH");
    expect(selectCanSubmit(violations)).toBe(true);
  });

  // UI-AC-019: ターン上限は5固定で入力が存在しないため、draftの値を検証しない。
  it("does not validate the turn limit at all", () => {
    const draft = { ...validExerciseDraft(), turnLimit: "" as const };

    const violations = validateExerciseDraft(draft, catalog);

    expect(codes(violations)).not.toContain("TURN_LIMIT_INVALID");
    expect(selectCanSubmit(violations)).toBe(true);
  });

  it("keeps the shared rules: unknown definitions stay errors and off-aptitude stays a warning", () => {
    let draft = validExerciseDraft();
    draft = withUnit(draft, "ally", "REAR", 0, "UNIT_ALLY");
    draft = withUnit(draft, "ally", "REAR", 1, "UNIT_GONE");

    const violations = validateExerciseDraft(draft, catalog);

    expect(codes(violations)).toContain("UNKNOWN_DEFINITION");
    expect(violations.filter((v) => v.code === "APTITUDE_MISMATCH")[0]?.severity).toBe("warning");
  });
});

// UI-UT-VAL-012: 実行回数は統計実行のときだけ意味を持つ。単一実行で入力途中の
// 値が送信を止めると、統計実行を一度も選んでいない利用者が実行できなくなる。
describe("統計実行の実行回数の検証 (UI-UT-VAL-012)", () => {
  function withExecution(
    mode: "SINGLE" | "STATISTICS",
    runCount: number | "",
    seed = "",
  ): BattleDraft {
    return { ...validExerciseDraft(), exerciseExecution: { mode, runCount, seed } };
  }

  it.each([1, 100, MAX_EXERCISE_RUN_COUNT])("accepts %s runs", (runCount) => {
    expect(
      selectCanSubmit(validateExerciseDraft(withExecution("STATISTICS", runCount), catalog)),
    ).toBe(true);
  });

  it.each([0, -1, 1.5, MAX_EXERCISE_RUN_COUNT + 1, "" as const])(
    "rejects %s runs in the statistics mode",
    (runCount) => {
      const violations = validateExerciseDraft(withExecution("STATISTICS", runCount), catalog);

      expect(codes(violations)).toContain("RUN_COUNT_OUT_OF_RANGE");
      expect(
        violations.find((violation) => violation.code === "RUN_COUNT_OUT_OF_RANGE")?.path,
      ).toBe("/runsPerCandidate");
      expect(selectCanSubmit(violations)).toBe(false);
    },
  );

  it("does not validate the run count in the single-run mode", () => {
    const violations = validateExerciseDraft(withExecution("SINGLE", ""), catalog);

    expect(codes(violations)).not.toContain("RUN_COUNT_OUT_OF_RANGE");
    expect(selectCanSubmit(violations)).toBe(true);
  });

  // シードは任意文字列で、空は「自動生成に任せる」を表す（送信時の扱いは
  // 統計実行基盤が決める）。送信前検証は形を問わない。
  it("does not constrain the seed", () => {
    expect(
      selectCanSubmit(validateExerciseDraft(withExecution("STATISTICS", 100, "abc123"), catalog)),
    ).toBe(true);
    expect(
      selectCanSubmit(validateExerciseDraft(withExecution("STATISTICS", 100, ""), catalog)),
    ).toBe(true);
  });

  // 上限は1リクエストの上限ではなく画面が許す総試行数（チャンク分割は統計実行基盤
  // が担う）。値そのものを台帳として固定する。
  it("caps the run count at 2,000", () => {
    expect(MAX_EXERCISE_RUN_COUNT).toBe(2000);
  });
});
