import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  CatalogUnitSummary,
  FormationStatPreviewUnit,
} from "../../shared/api/api-contract.js";
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

describe("UnitSlot — ステータスプレビュー (UI-CT-038)", () => {
  const preview: FormationStatPreviewUnit = {
    side: "ALLY",
    unitDefinitionId: "UNIT_A",
    formationPosition: { column: 0, row: "FRONT" },
    maximumHp: 12345.6,
    combatStats: {
      attack: 1000,
      defense: 500,
      criticalRate: 12.5,
      actionSpeed: 120,
      affinityBonus: 25,
      criticalDamageBonus: 50,
    },
  };

  function renderSlot() {
    return render(
      <UnitSlot
        row="FRONT"
        column={0}
        unit={unit}
        aptitudeWarning={false}
        hasError={false}
        disabled={false}
        onOpen={vi.fn()}
        statPreviewStatus="ready"
        statPreview={preview}
      />,
    );
  }

  it("shows the starting stats on hover and hides them again on unhover", async () => {
    const user = userEvent.setup();
    renderSlot();

    expect(screen.queryByText("開始時ステータス")).not.toBeInTheDocument();

    await user.hover(screen.getByRole("button", { name: /アルファ/ }));

    expect(screen.getByText("開始時ステータス")).toBeInTheDocument();
    expect(screen.getByText("12,345.6")).toBeInTheDocument();
    expect(screen.getByText("12.5%")).toBeInTheDocument();

    await user.unhover(screen.getByRole("button", { name: /アルファ/ }));

    expect(screen.queryByText("開始時ステータス")).not.toBeInTheDocument();
  });

  it("shows the same stats on keyboard focus and links them to the slot with aria-describedby", async () => {
    const user = userEvent.setup();
    renderSlot();

    await user.tab();

    const slot = screen.getByRole("button", { name: /アルファ/ });
    expect(slot).toHaveFocus();
    const describedBy = slot.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy!)).toHaveTextContent("開始時ステータス");
  });

  it("reports a failed preview as text without an alert, so it does not read as a blocked execution", async () => {
    const user = userEvent.setup();
    render(
      <UnitSlot
        row="FRONT"
        column={0}
        unit={unit}
        aptitudeWarning={false}
        hasError={false}
        disabled={false}
        onOpen={vi.fn()}
        statPreviewStatus="failed"
      />,
    );

    await user.hover(screen.getByRole("button", { name: /アルファ/ }));

    expect(screen.getByText("ステータスを取得できませんでした")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows no preview for an empty slot, because there is nothing to compute stats for", async () => {
    const user = userEvent.setup();
    render(
      <UnitSlot
        row="FRONT"
        column={0}
        aptitudeWarning={false}
        hasError={false}
        disabled={false}
        onOpen={vi.fn()}
        statPreviewStatus="ready"
      />,
    );

    await user.hover(screen.getByRole("button"));

    expect(screen.queryByText("開始時ステータス")).not.toBeInTheDocument();
  });
});

describe("UnitSlot — ユニット移動 (UI-CT-050/051)", () => {
  // jsdomはDataTransferを実装しないため、drag系イベントへはスタブを渡す。
  function dataTransferStub() {
    return { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
  }

  function renderMovableSlot(
    overrides: Partial<Parameters<typeof UnitSlot>[0]> = {},
  ): ReturnType<typeof render> {
    return render(
      <UnitSlot
        row="FRONT"
        column={0}
        unit={unit}
        aptitudeWarning={false}
        hasError={false}
        disabled={false}
        onOpen={vi.fn()}
        onMoveStart={vi.fn()}
        onMoveCancel={vi.fn()}
        onMovePlace={vi.fn()}
        {...overrides}
      />,
    );
  }

  it("marks only a filled, enabled slot as draggable", () => {
    renderMovableSlot();
    expect(screen.getByRole("button", { name: "前衛1: アルファを変更" })).toHaveAttribute(
      "draggable",
      "true",
    );
  });

  it("does not mark an empty slot as draggable (drop target only)", () => {
    render(
      <UnitSlot
        row="FRONT"
        column={0}
        aptitudeWarning={false}
        hasError={false}
        disabled={false}
        onOpen={vi.fn()}
        onMoveStart={vi.fn()}
        onMoveCancel={vi.fn()}
        onMovePlace={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /前衛1/ })).toHaveAttribute("draggable", "false");
  });

  it("does not mark a disabled slot as draggable and disables the move button", () => {
    renderMovableSlot({ disabled: true });
    expect(screen.getByRole("button", { name: "前衛1: アルファを変更" })).toHaveAttribute(
      "draggable",
      "false",
    );
    expect(screen.getByRole("button", { name: "前衛1: アルファを移動" })).toBeDisabled();
  });

  it("starts a move on dragstart and hides a shown stat preview", () => {
    const onMoveStart = vi.fn();
    renderMovableSlot({
      onMoveStart,
      statPreviewStatus: "ready",
      statPreview: {
        side: "ALLY",
        unitDefinitionId: "UNIT_A",
        formationPosition: { column: 0, row: "FRONT" },
        maximumHp: 100,
        combatStats: {
          attack: 1,
          defense: 1,
          criticalRate: 1,
          actionSpeed: 1,
          affinityBonus: 1,
          criticalDamageBonus: 1,
        },
      },
    });
    const slot = screen.getByRole("button", { name: "前衛1: アルファを変更" });

    fireEvent.mouseEnter(slot);
    expect(screen.getByText("開始時ステータス")).toBeInTheDocument();

    const dataTransfer = dataTransferStub();
    fireEvent.dragStart(slot, { dataTransfer });

    expect(onMoveStart).toHaveBeenCalledTimes(1);
    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", expect.any(String));
    expect(screen.queryByText("開始時ステータス")).not.toBeInTheDocument();
  });

  it("cancels the move on dragend", () => {
    const onMoveCancel = vi.fn();
    renderMovableSlot({ onMoveCancel });
    const slot = screen.getByRole("button", { name: "前衛1: アルファを変更" });

    fireEvent.dragStart(slot, { dataTransfer: dataTransferStub() });
    fireEvent.dragEnd(slot, { dataTransfer: dataTransferStub() });

    expect(onMoveCancel).toHaveBeenCalledTimes(1);
  });

  it("accepts a drop while it is a valid move target", () => {
    const onMovePlace = vi.fn();
    renderMovableSlot({ moveTarget: true, onMovePlace });
    const slot = screen.getByRole("button", { name: "前衛1: アルファを変更" });

    const prevented = !fireEvent.dragOver(slot, { dataTransfer: dataTransferStub() });
    fireEvent.drop(slot, { dataTransfer: dataTransferStub() });

    expect(prevented).toBe(true);
    expect(onMovePlace).toHaveBeenCalledTimes(1);
  });

  it("rejects a drop while it is not a move target (cross-side or the source itself)", () => {
    const onMovePlace = vi.fn();
    renderMovableSlot({ moveTarget: false, onMovePlace });
    const slot = screen.getByRole("button", { name: "前衛1: アルファを変更" });

    const prevented = !fireEvent.dragOver(slot, { dataTransfer: dataTransferStub() });
    fireEvent.drop(slot, { dataTransfer: dataTransferStub() });

    expect(prevented).toBe(false);
    expect(onMovePlace).not.toHaveBeenCalled();
  });

  it("offers a move button only for a filled slot, toggling between start and cancel", async () => {
    const user = userEvent.setup();
    const onMoveStart = vi.fn();
    const { rerender } = renderMovableSlot({ onMoveStart });

    await user.click(screen.getByRole("button", { name: "前衛1: アルファを移動" }));
    expect(onMoveStart).toHaveBeenCalledTimes(1);

    const onMoveCancel = vi.fn();
    rerender(
      <UnitSlot
        row="FRONT"
        column={0}
        unit={unit}
        aptitudeWarning={false}
        hasError={false}
        disabled={false}
        onOpen={vi.fn()}
        moveSource
        onMoveStart={vi.fn()}
        onMoveCancel={onMoveCancel}
        onMovePlace={vi.fn()}
      />,
    );
    const cancelButton = screen.getByRole("button", {
      name: "前衛1: アルファの移動をキャンセル",
    });
    expect(cancelButton).toHaveAttribute("aria-pressed", "true");
    await user.click(cancelButton);
    expect(onMoveCancel).toHaveBeenCalledTimes(1);
  });

  it("does not offer a move button for an empty slot", () => {
    render(
      <UnitSlot
        row="FRONT"
        column={0}
        aptitudeWarning={false}
        hasError={false}
        disabled={false}
        onOpen={vi.fn()}
        onMoveStart={vi.fn()}
        onMoveCancel={vi.fn()}
        onMovePlace={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /を移動/ })).not.toBeInTheDocument();
  });
});
