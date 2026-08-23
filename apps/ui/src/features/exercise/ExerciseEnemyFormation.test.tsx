import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ExerciseEnemyFormation } from "./ExerciseEnemyFormation.js";
import { createInitialDraft, slotKeyOf, slotsForSide } from "../formation/types.js";
import type { FormationSlotInput } from "../../entities/battle-draft.js";
import type { BattleSimulationCatalogResponse } from "../../shared/api/api-contract.js";

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
const REAR_RIGHT = slotKeyOf("enemy", "REAR", 2);

function slotsWithUnitAt(slotKey: string): readonly FormationSlotInput[] {
  return slotsForSide(draft, "enemy").map((slot) =>
    slot.slotKey === slotKey ? { ...slot, unitDefinitionId: "UNIT_ENEMY" } : slot,
  );
}

function renderFormation(overrides: Partial<Parameters<typeof ExerciseEnemyFormation>[0]> = {}) {
  return render(
    <ExerciseEnemyFormation
      slots={slotsForSide(draft, "enemy")}
      catalog={catalog}
      violations={[]}
      disabled={false}
      onOpenUnitSelection={vi.fn()}
      onMoveUnit={vi.fn()}
      {...overrides}
    />,
  );
}

// UI-CT-028 / UI-AC-019 / UI-CMP-011: 敵は前衛3・後衛3の盤面から配置枠を選べ、
// メモリー枠・ターン上限入力・強化は出さない。
describe("ExerciseEnemyFormation", () => {
  it("exposes the same six unit slots as a regular formation", () => {
    renderFormation();

    expect(screen.getAllByRole("button", { name: /にユニットを追加/ })).toHaveLength(6);
    expect(screen.getByRole("button", { name: "後衛3にユニットを追加" })).toBeInTheDocument();
  });

  it("renders no enemy memory slots", () => {
    renderFormation();

    expect(screen.queryAllByRole("button", { name: /メモリー/ })).toHaveLength(0);
  });

  it("renders no turn limit input and says the exercise is fixed at five turns", () => {
    renderFormation();

    expect(screen.queryByLabelText("ターン上限")).not.toBeInTheDocument();
    expect(screen.getByText(/5ターン固定/)).toBeInTheDocument();
  });

  // 演習の敵は定義どおりの1体（R-TEX-01 #1）。学園レベルは利用者自身の育成情報
  // であり、敵陣営には設定させない。
  it("renders no enemy enhancement panel: no toggle and no academy level inputs", () => {
    renderFormation();

    expect(screen.queryByRole("checkbox", { name: /強化/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/ENEMY ENHANCEMENT/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("物理")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("キュート")).not.toBeInTheDocument();
  });

  it("offers no unit enhancement action on the enemy slot", () => {
    renderFormation({ slots: slotsWithUnitAt(REAR_RIGHT) });

    expect(screen.queryByRole("button", { name: /の強化を編集/ })).not.toBeInTheDocument();
  });

  it("opens the unit selection for the chosen slot, not only for the front left one", async () => {
    const user = userEvent.setup();
    const onOpenUnitSelection = vi.fn<(slotKey: string) => void>();
    renderFormation({ onOpenUnitSelection });

    await user.click(screen.getByRole("button", { name: "後衛3にユニットを追加" }));

    expect(onOpenUnitSelection).toHaveBeenCalledWith(REAR_RIGHT);
  });

  it("shows the selected enemy unit in the slot it was placed in", () => {
    renderFormation({ slots: slotsWithUnitAt(REAR_RIGHT) });

    expect(screen.getByRole("button", { name: "後衛3: エネミーを変更" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /にユニットを追加/ })).toHaveLength(5);
  });

  // UI-AC-032: 配置し直しは味方と同じ移動操作でも行える。
  it("moves the enemy unit to another slot from the keyboard move mode", async () => {
    const user = userEvent.setup();
    const onMoveUnit = vi.fn<(fromSlotKey: string, toSlotKey: string) => void>();
    renderFormation({ slots: slotsWithUnitAt(slotKeyOf("enemy", "FRONT", 0)), onMoveUnit });

    await user.click(screen.getByRole("button", { name: "前衛1: エネミーを移動" }));
    await user.click(screen.getByRole("button", { name: "後衛3にユニットを追加" }));

    expect(onMoveUnit).toHaveBeenCalledWith(slotKeyOf("enemy", "FRONT", 0), REAR_RIGHT);
  });
});
