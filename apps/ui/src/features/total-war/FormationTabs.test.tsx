import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FormationTabs } from "./FormationTabs.js";
import type { FormationTabsProps } from "./FormationTabs.js";

function renderTabs(overrides: Partial<FormationTabsProps> = {}) {
  const props: FormationTabsProps = {
    side: "ally",
    count: 2,
    active: 0,
    formationsWithErrors: [],
    disabled: false,
    onActivate: vi.fn(),
    onAdd: vi.fn(),
    onRemove: vi.fn(),
    children: <p>editor</p>,
    ...overrides,
  };
  render(<FormationTabs {...props} />);
  return props;
}

describe("FormationTabs", () => {
  it("names the tab list after the side and wraps the editor in the active tab's panel", () => {
    renderTabs({ side: "enemy", active: 1 });

    const tablist = screen.getByRole("tablist", { name: "敵の編成" });
    expect(tablist).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["編成1", "編成2"]);
    expect(screen.getByRole("tab", { name: "編成2" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "編成2" })).toHaveTextContent("editor");
  });

  it("activates the chosen formation by click and by keyboard", async () => {
    const user = userEvent.setup();
    const props = renderTabs({ count: 3 });

    await user.click(screen.getByRole("tab", { name: "編成3" }));
    expect(props.onActivate).toHaveBeenLastCalledWith(2);

    screen.getByRole("tab", { name: "編成1" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(props.onActivate).toHaveBeenLastCalledWith(1);
  });

  it("marks formations holding errors with text, not color alone", () => {
    renderTabs({ count: 3, formationsWithErrors: [2] });

    expect(screen.getByRole("tab", { name: "編成3 要修正" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "編成1" })).toBeInTheDocument();
  });

  it("offers adding below 3 formations and removing from 2 formations", async () => {
    const user = userEvent.setup();
    const props = renderTabs({ count: 2 });

    await user.click(screen.getByRole("button", { name: "編成を追加" }));
    await user.click(screen.getByRole("button", { name: "この編成を削除" }));

    expect(props.onAdd).toHaveBeenCalledTimes(1);
    expect(props.onRemove).toHaveBeenCalledTimes(1);
  });

  it("hides adding at 3 formations and removing at 1 formation", () => {
    renderTabs({ count: 3 });
    expect(screen.queryByRole("button", { name: "編成を追加" })).not.toBeInTheDocument();
  });

  it("hides removing when only one formation exists", () => {
    renderTabs({ count: 1 });
    expect(screen.queryByRole("button", { name: "この編成を削除" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "編成を追加" })).toBeInTheDocument();
  });

  it("disables the add and remove buttons while disabled", () => {
    renderTabs({ count: 2, disabled: true });
    expect(screen.getByRole("button", { name: "編成を追加" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "この編成を削除" })).toBeDisabled();
  });
});
