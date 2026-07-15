import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CatalogUnitSummary } from "../simulation/api-contract.js";
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
    selectable: true,
    unavailableCapabilities: [],
  },
  {
    unitDefinitionId: "UNIT_BETA",
    displayName: "ベータ",
    characterName: "Beta",
    attribute: "SMART",
    unitType: "GUARDIAN",
    role: "TANK",
    positionAptitudes: ["FRONT", "BACK"],
    selectable: false,
    unavailableCapabilities: ["CAP_UNSUPPORTED"],
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

describe("UnitSelectionDialog — unavailable definitions (UI-CT-006)", () => {
  it("disables selection for a non-selectable unit and shows its capability reason", () => {
    render(
      <UnitSelectionDialog
        units={units}
        atCapacity={false}
        onSelect={vi.fn()}
        onRemove={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "ベータを選択" })).toBeDisabled();
    expect(screen.getByText(/CAP_UNSUPPORTED/)).toBeInTheDocument();
  });
});

describe("UnitSelectionDialog — capacity guard (UI-CT-007)", () => {
  it("disables every selectable item and shows a limit notice when the side is at capacity for an empty slot", () => {
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
