import { describe, expect, it } from "vitest";
import {
  buildTacticalExerciseEvaluationRequest,
  buildTacticalExerciseRequest,
  evaluationFormationSignature,
} from "./exercise-request-mapper.js";
import type { BattleDraft, Side, UiColumn, UiRow } from "../../entities/battle-draft.js";
import {
  createInitialDraft,
  createInitialUnitEnhancement,
  memorySlotKeyOf,
  slotKeyOf,
} from "../formation/types.js";

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

function exerciseDraft(): BattleDraft {
  let draft = createInitialDraft();
  draft = withUnit(draft, "ally", "FRONT", 0, "UNIT_ALLY");
  draft = withUnit(draft, "enemy", "FRONT", 0, "UNIT_ENEMY");
  return draft;
}

// UI-CT-029 / UI-API-014: 演習リクエストは`turnLimit`を持たず、敵1体・敵メモリー
// 0件のペイロードを生成する。
describe("buildTacticalExerciseRequest", () => {
  it("builds a payload with no turnLimit property at all", () => {
    const result = buildTacticalExerciseRequest(exerciseDraft());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request).not.toHaveProperty("turnLimit");
    expect(Object.keys(result.request).toSorted()).toEqual([
      "allyFormation",
      "enemyFormation",
      "options",
    ]);
  });

  it("sends exactly one enemy unit and an empty enemy memory array", () => {
    const result = buildTacticalExerciseRequest(exerciseDraft());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.enemyFormation).toEqual({
      units: [{ unitDefinitionId: "UNIT_ENEMY", position: { column: 0, row: "FRONT" } }],
      memoryDefinitionIds: [],
    });
  });

  // UI-CT-060: 敵の配置は前衛左上に固定されない。位置は`POSITION_ROW`条件や
  // 前後列優先の対象順が参照するため、敵1体でも座標をそのまま送る必要がある。
  it("sends the enemy position from the slot the unit sits in", () => {
    let draft = createInitialDraft();
    draft = withUnit(draft, "ally", "FRONT", 0, "UNIT_ALLY");
    draft = withUnit(draft, "enemy", "REAR", 2, "UNIT_ENEMY");

    const result = buildTacticalExerciseRequest(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.enemyFormation.units).toEqual([
      { unitDefinitionId: "UNIT_ENEMY", position: { column: 2, row: "REAR" } },
    ]);
    expect(result.enemyUnitSlotKeys).toEqual([slotKeyOf("enemy", "REAR", 2)]);
  });

  it("carries the ally formation and memories through unchanged", () => {
    let draft = exerciseDraft();
    draft = withUnit(draft, "ally", "REAR", 2, "UNIT_ALLY_2");
    draft = withMemory(draft, "ally", 1, "MEM_A");

    const result = buildTacticalExerciseRequest(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.allyFormation.units).toEqual([
      { unitDefinitionId: "UNIT_ALLY", position: { column: 0, row: "FRONT" } },
      { unitDefinitionId: "UNIT_ALLY_2", position: { column: 2, row: "REAR" } },
    ]);
    expect(result.request.allyFormation.memoryDefinitionIds).toEqual(["MEM_A"]);
    expect(result.allyMemorySlotKeys).toEqual([memorySlotKeyOf("ally", 1)]);
  });

  // UI-UT-REQ-013: 単一実行はログを読むための実行なので、draftに残っている
  // `logLevel`（演習では選べなくなった値）に依らず常に`DETAILED`で送る。
  it("UI-UT-REQ-013: always sends DETAILED regardless of the log level left in the draft", () => {
    for (const logLevel of ["SUMMARY", "DETAILED"] as const) {
      const result = buildTacticalExerciseRequest({ ...exerciseDraft(), logLevel });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.request.options).toEqual({ logLevel: "DETAILED" });
    }
  });

  it("ignores the draft turnLimit even when it is blank", () => {
    const result = buildTacticalExerciseRequest({ ...exerciseDraft(), turnLimit: "" });

    expect(result.ok).toBe(true);
  });

  it("refuses to build a payload with two enemy units", () => {
    const draft = withUnit(exerciseDraft(), "enemy", "FRONT", 1, "UNIT_ENEMY_2");

    expect(buildTacticalExerciseRequest(draft).ok).toBe(false);
  });

  it("refuses to build a payload with no enemy unit", () => {
    const draft = createInitialDraft();

    expect(buildTacticalExerciseRequest(withUnit(draft, "ally", "FRONT", 0, "UNIT_ALLY")).ok).toBe(
      false,
    );
  });

  it("refuses to build a payload carrying an enemy memory", () => {
    const draft = withMemory(exerciseDraft(), "enemy", 0, "MEM_E");

    expect(buildTacticalExerciseRequest(draft).ok).toBe(false);
  });

  // UI-AC-020: 敵の`enhancement`は送らない。画面に敵強化の入力が無いことへ依存させず、
  // リクエスト境界でも保証する（draftが強化有効のまま渡ってきても出力しない）。
  it("omits the enemy enhancement even when the draft has it enabled", () => {
    const base = exerciseDraft();
    const draft: BattleDraft = {
      ...base,
      enemyEnhancement: {
        ...base.enemyEnhancement,
        enabled: true,
        academyLevels: {
          unitTypes: { PHYSICAL: 50, ENERGY: 40, AGILE: 30 },
          attributes: {
            AGGRESSIVE: 9,
            SHY: 8,
            CUTE: 7,
            SMART: 6,
            COMICAL: 5,
            CLEVER: 4,
          },
        },
      },
      enemySlots: base.enemySlots.map((slot) =>
        slot.slotKey === slotKeyOf("enemy", "FRONT", 0)
          ? {
              ...slot,
              enhancement: {
                ...createInitialUnitEnhancement(),
                level: 250,
                gears: [
                  { stat: "ATTACK", tier: "III", grade: "S" },
                  ...createInitialUnitEnhancement().gears.slice(1),
                ],
              },
            }
          : slot,
      ),
    };

    const result = buildTacticalExerciseRequest(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.enemyFormation).not.toHaveProperty("enhancement");
    expect(result.request.enemyFormation.units[0]).not.toHaveProperty("enhancement");
    expect(JSON.stringify(result.request.enemyFormation)).not.toContain("enhancement");
    expect(result.enemyGearSlotIndices).toEqual([[]]);
  });

  it("still sends the ally enhancement when the ally side has it enabled", () => {
    const base = exerciseDraft();
    const draft: BattleDraft = {
      ...base,
      allyEnhancement: { ...base.allyEnhancement, enabled: true },
    };

    const result = buildTacticalExerciseRequest(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.allyFormation.enhancement).toBeDefined();
  });
});

// UI-UT-REQ-014: 大量試行リクエストは単一実行と同じ編成部分を使い、`options`を持たず、
// ケースを常に1件だけ載せる（`10_API設計.md`「TacticalExerciseEvaluationRequest」）。
describe("buildTacticalExerciseEvaluationRequest", () => {
  it("wraps both formations in a single case with the given seed and run indices", () => {
    const single = buildTacticalExerciseRequest(exerciseDraft());
    const result = buildTacticalExerciseEvaluationRequest(exerciseDraft(), {
      seed: "abc",
      runIndices: [300, 301],
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !single.ok) return;
    expect(Object.keys(result.request).toSorted()).toEqual(["cases", "seed"]);
    expect(result.request.seed).toBe("abc");
    expect(result.request.cases).toEqual([
      {
        caseId: "exercise",
        allyFormation: single.request.allyFormation,
        enemyFormation: single.request.enemyFormation,
        runIndices: [300, 301],
      },
    ]);
  });

  // `options.logLevel`・`turnLimit`が載ると`additionalProperties: false`で400になる。
  it("sends neither options nor turnLimit", () => {
    const result = buildTacticalExerciseEvaluationRequest(exerciseDraft(), {
      seed: "s",
      runIndices: [0],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request).not.toHaveProperty("options");
    expect(result.request.cases[0]).not.toHaveProperty("turnLimit");
  });

  it("keeps the enemy-exactly-one and no-enemy-memory constraints of the single run", () => {
    const twoEnemies = withUnit(exerciseDraft(), "enemy", "FRONT", 1, "UNIT_ENEMY_2");
    const enemyMemory = withMemory(exerciseDraft(), "enemy", 0, "MEM_X");
    const options = { seed: "s", runIndices: [0] };

    expect(buildTacticalExerciseEvaluationRequest(twoEnemies, options).ok).toBe(false);
    expect(buildTacticalExerciseEvaluationRequest(enemyMemory, options).ok).toBe(false);
  });

  // 422のJSON Pointerはケースindexを含む（`/cases/0/allyFormation/...`）。slot対応表は
  // 単一実行と同じものを返し、違反の対応づけを共通の経路で扱えるようにする。
  it("returns the same slot key mapping as the single run", () => {
    const single = buildTacticalExerciseRequest(exerciseDraft());
    const result = buildTacticalExerciseEvaluationRequest(exerciseDraft(), {
      seed: "s",
      runIndices: [0],
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !single.ok) return;
    expect(result.allyUnitSlotKeys).toEqual(single.allyUnitSlotKeys);
    expect(result.enemyUnitSlotKeys).toEqual(single.enemyUnitSlotKeys);
  });
});

// UI-UT-REQ-015: 実行時の編成と現在の編成を突き合わせる署名。試行番号とシードは含めず、
// 画面から読み取れない編成の変化だけを見る。
describe("evaluationFormationSignature", () => {
  function signatureOf(
    draft: BattleDraft,
    runIndices: readonly number[] = [0],
    seed = "-",
  ): string | undefined {
    const build = buildTacticalExerciseEvaluationRequest(draft, { seed, runIndices });
    return build.ok ? evaluationFormationSignature(build.request) : undefined;
  }

  it("is stable for the same formation and ignores the run indices and seed", () => {
    expect(signatureOf(exerciseDraft(), [300, 301], "abc")).toBe(signatureOf(exerciseDraft()));
  });

  it("changes when the formation changes", () => {
    const moved = withUnit(exerciseDraft(), "ally", "REAR", 2, "UNIT_ALLY_2");

    expect(signatureOf(moved)).not.toBe(signatureOf(exerciseDraft()));
  });

  it("changes when only the enemy changes", () => {
    let other = createInitialDraft();
    other = withUnit(other, "ally", "FRONT", 0, "UNIT_ALLY");
    other = withUnit(other, "enemy", "FRONT", 0, "UNIT_ENEMY_2");

    expect(signatureOf(other)).not.toBe(signatureOf(exerciseDraft()));
  });
});
