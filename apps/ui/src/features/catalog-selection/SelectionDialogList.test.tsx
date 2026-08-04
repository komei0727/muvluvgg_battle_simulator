import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SelectionDialogList } from "./SelectionDialogList.js";
import type { SelectionDialogItem } from "./SelectionDialogList.js";

const items: readonly SelectionDialogItem[] = [
  {
    definitionId: "DEF_ALPHA",
    displayName: "アルファ",
    selectable: true,
    disabled: false,
    unavailableCapabilities: [],
    tags: ["攻撃", "前衛"],
  },
  {
    definitionId: "DEF_BETA",
    displayName: "ベータ",
    selectable: false,
    disabled: true,
    unavailableCapabilities: ["CAP_UNSUPPORTED"],
  },
];

describe("SelectionDialogList", () => {
  it("renders each item with its display name, definition id, and tags", () => {
    render(<SelectionDialogList items={items} kind="unit" onSelect={vi.fn()} onRemove={vi.fn()} />);

    expect(screen.getByText("アルファ")).toBeInTheDocument();
    expect(screen.getByText("DEF_ALPHA")).toBeInTheDocument();
    expect(screen.getByText("攻撃")).toBeInTheDocument();
    expect(screen.getByText("前衛")).toBeInTheDocument();
  });

  it("calls onSelect with the clicked definitionId", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <SelectionDialogList items={items} kind="unit" onSelect={onSelect} onRemove={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: "アルファを選択" }));

    expect(onSelect).toHaveBeenCalledWith("DEF_ALPHA");
  });

  it("labels the current selection as 選択中 and keeps its button enabled", () => {
    render(
      <SelectionDialogList
        items={items}
        kind="unit"
        currentDefinitionId="DEF_ALPHA"
        onSelect={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "アルファ選択中" })).toBeEnabled();
  });

  it("disables an item the caller marked disabled and shows its capability reason", () => {
    render(<SelectionDialogList items={items} kind="unit" onSelect={vi.fn()} onRemove={vi.fn()} />);

    expect(screen.getByRole("button", { name: "ベータを選択" })).toBeDisabled();
    expect(screen.getByText(/CAP_UNSUPPORTED/)).toBeInTheDocument();
  });

  it("hides the remove control while the slot is empty", () => {
    render(<SelectionDialogList items={items} kind="unit" onSelect={vi.fn()} onRemove={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "この枠を空にする" })).not.toBeInTheDocument();
  });

  it("calls onRemove from the remove control when the slot has a selection", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <SelectionDialogList
        items={items}
        kind="unit"
        currentDefinitionId="DEF_ALPHA"
        onSelect={vi.fn()}
        onRemove={onRemove}
      />,
    );

    await user.click(screen.getByRole("button", { name: "この枠を空にする" }));

    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
