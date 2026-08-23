import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CatalogUnitSummary } from "../../shared/api/api-contract.js";
import { UnitSelectionDialog } from "./UnitSelectionDialog.js";

const units: readonly CatalogUnitSummary[] = [
  {
    unitDefinitionId: "UNIT_ALPHA",
    displayName: "アルファ",
    characterName: "Alpha",
    attribute: "CUTE",
    unitType: "ATTACKER",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT"],
  },
  {
    unitDefinitionId: "UNIT_BETA",
    displayName: "ベータ",
    characterName: "Beta",
    attribute: "SMART",
    unitType: "GUARDIAN",
    role: "TANK",
    positionAptitudes: ["FRONT", "BACK"],
  },
];

describe("UnitSelectionDialog — search/filter/select/remove (UI-CT-005)", () => {
  it("filters the list as the user types in the search input", async () => {
    const user = userEvent.setup();
    render(
      <UnitSelectionDialog
        units={units}
        atCapacity={false}
        onSelect={vi.fn()}
        onRemove={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("アルファ")).toBeInTheDocument();
    expect(screen.getByText("ベータ")).toBeInTheDocument();

    await user.type(screen.getByLabelText("ユニットを検索"), "アルファ");

    expect(screen.getByText("アルファ")).toBeInTheDocument();
    expect(screen.queryByText("ベータ")).not.toBeInTheDocument();
  });

  it("calls onSelect with the chosen unitDefinitionId", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <UnitSelectionDialog
        units={units}
        atCapacity={false}
        onSelect={onSelect}
        onRemove={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "アルファを選択" }));

    expect(onSelect).toHaveBeenCalledWith("UNIT_ALPHA");
  });

  it("shows a remove control when a slot already has a selection", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <UnitSelectionDialog
        units={units}
        currentUnitDefinitionId="UNIT_ALPHA"
        atCapacity={false}
        onSelect={vi.fn()}
        onRemove={onRemove}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "この枠を空にする" }));

    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("identifies the currently selected unit", () => {
    render(
      <UnitSelectionDialog
        units={units}
        currentUnitDefinitionId="UNIT_ALPHA"
        atCapacity={false}
        onSelect={vi.fn()}
        onRemove={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "アルファ選択中" })).toBeInTheDocument();
  });
});

describe("UnitSelectionDialog — capacity guard (UI-CT-007)", () => {
  it("disables every item and shows a limit notice when the side is at capacity for an empty slot", () => {
    render(
      <UnitSelectionDialog
        units={units}
        atCapacity={true}
        onSelect={vi.fn()}
        onRemove={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "アルファを選択" })).toBeDisabled();
    expect(screen.getByText("1陣営に設定できるユニットは5体までです。")).toBeInTheDocument();
  });

  it("still allows swapping an already-filled slot even when the side is at capacity", () => {
    render(
      <UnitSelectionDialog
        units={units}
        currentUnitDefinitionId="UNIT_ALPHA"
        atCapacity={true}
        onSelect={vi.fn()}
        onRemove={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText("1陣営に設定できるユニットは5体までです。")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "アルファ選択中" })).toBeEnabled();
  });
});

// UI-CT-053 / UI-CT-055: R-TEX-11 #4の開催中フラグをバッジで示す。開催終了も
// 選択できる（受理条件ではなく表示専用の情報であるため）。
describe("UnitSelectionDialog — exercise enemy badges", () => {
  const exerciseUnits: readonly CatalogUnitSummary[] = [
    {
      unitDefinitionId: "UNIT_EX_ACTIVE",
      displayName: "開催中の敵",
      characterName: "Active",
      category: "EXERCISE_ENEMY",
      exerciseActive: true,
      attribute: "COOL",
      unitType: "ATTACKER",
      role: "TANK",
      positionAptitudes: ["FRONT"],
    },
    {
      unitDefinitionId: "UNIT_EX_CLOSED",
      displayName: "開催終了の敵",
      characterName: "Closed",
      category: "EXERCISE_ENEMY",
      exerciseActive: false,
      attribute: "COOL",
      unitType: "ATTACKER",
      role: "TANK",
      positionAptitudes: ["FRONT"],
    },
  ];

  it("tags a running exercise enemy as 開催中 and a closed one as 開催終了", () => {
    render(
      <UnitSelectionDialog
        units={exerciseUnits}
        atCapacity={false}
        onSelect={vi.fn()}
        onRemove={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("開催中")).toBeInTheDocument();
    expect(screen.getByText("開催終了")).toBeInTheDocument();
  });

  it("keeps a closed exercise enemy selectable", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <UnitSelectionDialog
        units={exerciseUnits}
        atCapacity={false}
        onSelect={onSelect}
        onRemove={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const selectButton = screen.getByRole("button", { name: "開催終了の敵を選択" });
    expect(selectButton).toBeEnabled();
    await user.click(selectButton);

    expect(onSelect).toHaveBeenCalledWith("UNIT_EX_CLOSED");
  });

  it("does not tag playable units with an exercise badge", () => {
    render(
      <UnitSelectionDialog
        units={units}
        atCapacity={false}
        onSelect={vi.fn()}
        onRemove={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText("開催中")).not.toBeInTheDocument();
    expect(screen.queryByText("開催終了")).not.toBeInTheDocument();
  });
});
