import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CatalogMemorySummary } from "../simulation/api-contract.js";
import { MemorySelectionDialog } from "./MemorySelectionDialog.js";

const memories: readonly CatalogMemorySummary[] = [
  {
    memoryDefinitionId: "MEM_ALPHA",
    displayName: "記憶アルファ",
    selectable: true,
    unavailableCapabilities: [],
  },
  {
    memoryDefinitionId: "MEM_BETA",
    displayName: "記憶ベータ",
    selectable: false,
    unavailableCapabilities: ["CAP_MEMORY_UNSUPPORTED"],
  },
];

describe("MemorySelectionDialog — search/select/remove (UI-CT-005)", () => {
  it("filters the list as the user types in the search input", async () => {
    const user = userEvent.setup();
    render(
      <MemorySelectionDialog
        memories={memories}
        onSelect={vi.fn()}
        onRemove={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText("メモリーを検索"), "アルファ");

    expect(screen.getByText("記憶アルファ")).toBeInTheDocument();
    expect(screen.queryByText("記憶ベータ")).not.toBeInTheDocument();
  });

  it("calls onSelect with the chosen memoryDefinitionId", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <MemorySelectionDialog
        memories={memories}
        onSelect={onSelect}
        onRemove={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "記憶アルファを選択" }));

    expect(onSelect).toHaveBeenCalledWith("MEM_ALPHA");
  });

  it("shows a remove control when the slot already has a selection", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <MemorySelectionDialog
        memories={memories}
        currentMemoryDefinitionId="MEM_ALPHA"
        onSelect={vi.fn()}
        onRemove={onRemove}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "この枠を空にする" }));

    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

describe("MemorySelectionDialog — unavailable definitions (UI-CT-006)", () => {
  it("disables selection for a non-selectable memory and shows its capability reason", () => {
    render(
      <MemorySelectionDialog
        memories={memories}
        onSelect={vi.fn()}
        onRemove={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "記憶ベータを選択" })).toBeDisabled();
    expect(screen.getByText(/CAP_MEMORY_UNSUPPORTED/)).toBeInTheDocument();
  });
});
