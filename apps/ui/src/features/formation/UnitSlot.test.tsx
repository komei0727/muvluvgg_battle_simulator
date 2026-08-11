import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CatalogUnitSummary } from "../simulation/api-contract.js";
import { UnitSlot } from "./UnitSlot.js";

const unit: CatalogUnitSummary = {
  unitDefinitionId: "UNIT_A",
  displayName: "アルファ",
  characterName: "Alpha",
  attribute: "CUTE",
  unitType: "ATTACKER",
  role: "PHYSICAL_ATTACKER",
  positionAptitudes: ["FRONT"],
};

describe("UnitSlot — empty (UI-CT-001)", () => {
  it("has a complete accessible name describing the position", () => {
    render(
      <UnitSlot
        row="FRONT"
        column={0}
        aptitudeWarning={false}
        hasError={false}
        disabled={false}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /前衛1/ })).toBeInTheDocument();
  });

  it("calls onOpen when activated", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <UnitSlot
        row="REAR"
        column={2}
        aptitudeWarning={false}
        hasError={false}
        disabled={false}
        onOpen={onOpen}
      />,
    );

    await user.click(screen.getByRole("button"));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("UnitSlot — filled (UI-CT-002)", () => {
  it("includes the unit's display name in the accessible name", () => {
    render(
      <UnitSlot
        row="FRONT"
        column={1}
        unit={unit}
        aptitudeWarning={false}
        hasError={false}
        disabled={false}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /アルファ/ })).toBeInTheDocument();
    expect(screen.getByText("PHYSICAL_ATTACKER")).toBeInTheDocument();
  });

  it("shows a text warning badge for an off-aptitude placement, not color alone", () => {
    render(
      <UnitSlot
        row="REAR"
        column={0}
        unit={unit}
        aptitudeWarning={true}
        hasError={false}
        disabled={false}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByText("適性外")).toBeInTheDocument();
  });

  it("includes an error indication in the accessible name when hasError is true", () => {
    render(
      <UnitSlot
        row="FRONT"
        column={0}
        unit={unit}
        aptitudeWarning={false}
        hasError={true}
        disabled={false}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /エラー/ })).toBeInTheDocument();
  });

  it("is disabled and non-interactive when disabled is true", () => {
    render(
      <UnitSlot
        row="FRONT"
        column={0}
        unit={unit}
        aptitudeWarning={false}
        hasError={false}
        disabled={true}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByRole("button")).toBeDisabled();
  });
});

describe("UnitSlot — ユニット強化の起動 (M11, UI-AC-025/026)", () => {
  it("offers an enhancement button only for a filled slot", () => {
    const { rerender } = render(
      <UnitSlot
        row="FRONT"
        column={0}
        aptitudeWarning={false}
        hasError={false}
        disabled={false}
        onOpen={vi.fn()}
        onOpenEnhancement={vi.fn()}
        enhancementEnabled
      />,
    );
    expect(screen.queryByRole("button", { name: /強化/ })).not.toBeInTheDocument();

    rerender(
      <UnitSlot
        row="FRONT"
        column={0}
        unit={unit}
        aptitudeWarning={false}
        hasError={false}
        disabled={false}
        onOpen={vi.fn()}
        onOpenEnhancement={vi.fn()}
        enhancementEnabled
      />,
    );
    expect(screen.getByRole("button", { name: "前衛1: アルファの強化を編集" })).toBeEnabled();
  });

  it("UI-AC-026: disables the enhancement button while its side's toggle is off", async () => {
    const user = userEvent.setup();
    const onOpenEnhancement = vi.fn();
    render(
      <UnitSlot
        row="FRONT"
        column={0}
        unit={unit}
        aptitudeWarning={false}
        hasError={false}
        disabled={false}
        onOpen={vi.fn()}
        onOpenEnhancement={onOpenEnhancement}
        enhancementEnabled={false}
      />,
    );

    const button = screen.getByRole("button", { name: /強化を編集/ });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(onOpenEnhancement).not.toHaveBeenCalled();
  });

  it("keeps opening the unit selection dialog from the slot itself", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <UnitSlot
        row="FRONT"
        column={0}
        unit={unit}
        aptitudeWarning={false}
        hasError={false}
        disabled={false}
        onOpen={onOpen}
        onOpenEnhancement={vi.fn()}
        enhancementEnabled
      />,
    );

    await user.click(screen.getByRole("button", { name: "前衛1: アルファを変更" }));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
