import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ExerciseEnemySlot } from "./ExerciseEnemySlot.js";
import { EXERCISE_ENEMY_SLOT_KEY } from "./exercise-enemy-slot-key.js";
import { createInitialDraft, slotsForSide, enhancementForSide } from "../formation/types.js";
import type { BattleSimulationCatalogResponse } from "../simulation/api-contract.js";

const catalog: BattleSimulationCatalogResponse = {
  schemaVersion: 1,
  catalogRevision: "rev-1",
  units: [
    {
      unitDefinitionId: "UNIT_ENEMY",
      displayName: "エネミー",
      characterName: "Enemy",
      attribute: "SMART",
      unitType: "ATTACKER",
      role: "TANK",
      positionAptitudes: ["FRONT"],
    },
  ],
  memories: [{ memoryDefinitionId: "MEM_A", displayName: "メモリーA" }],
};

const draft = createInitialDraft();

function renderSlot(overrides: Partial<Parameters<typeof ExerciseEnemySlot>[0]> = {}) {
  return render(
    <ExerciseEnemySlot
      slots={slotsForSide(draft, "enemy")}
      catalog={catalog}
      violations={[]}
      disabled={false}
      enhancement={enhancementForSide(draft, "enemy")}
      onOpenUnitSelection={vi.fn()}
      onOpenUnitEnhancement={vi.fn()}
      onEnhancementToggle={vi.fn()}
      onAcademyLevelChange={vi.fn()}
      {...overrides}
    />,
  );
}

// UI-CT-028 / UI-AC-019 / UI-CMP-011: 敵は1枠だけを受け付け、メモリー枠と
// ターン上限入力を出さない。
describe("ExerciseEnemySlot", () => {
  it("exposes exactly one enemy unit slot", () => {
    renderSlot();

    expect(screen.getAllByRole("button", { name: /にユニットを追加/ })).toHaveLength(1);
  });

  it("renders no enemy memory slots", () => {
    renderSlot();

    expect(screen.queryAllByRole("button", { name: /メモリー/ })).toHaveLength(0);
  });

  it("renders no turn limit input and says the exercise is fixed at five turns", () => {
    renderSlot();

    expect(screen.queryByLabelText("ターン上限")).not.toBeInTheDocument();
    expect(screen.getByText(/5ターン固定/)).toBeInTheDocument();
  });

  it("opens the unit selection for the single enemy slot", async () => {
    const user = userEvent.setup();
    const onOpenUnitSelection = vi.fn<(slotKey: string) => void>();
    renderSlot({ onOpenUnitSelection });

    await user.click(screen.getByRole("button", { name: /にユニットを追加/ }));

    expect(onOpenUnitSelection).toHaveBeenCalledWith(EXERCISE_ENEMY_SLOT_KEY);
  });

  it("shows the selected enemy unit in that slot", () => {
    const slots = slotsForSide(draft, "enemy").map((slot) =>
      slot.slotKey === EXERCISE_ENEMY_SLOT_KEY ? { ...slot, unitDefinitionId: "UNIT_ENEMY" } : slot,
    );
    renderSlot({ slots });

    expect(screen.getByRole("button", { name: /エネミーを変更/ })).toBeInTheDocument();
  });
});
