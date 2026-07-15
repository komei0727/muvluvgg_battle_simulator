import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Tabs } from "./Tabs.js";

const items = [
  { id: "events", label: "時系列イベント" },
  { id: "transitions", label: "状態遷移" },
  { id: "json", label: "レスポンスJSON" },
];

describe("Tabs", () => {
  it("renders a tablist with the active tab marked aria-selected", () => {
    render(<Tabs label="戦闘詳細" items={items} activeId="events" onChange={vi.fn()} />);

    expect(screen.getByRole("tablist", { name: "戦闘詳細" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "時系列イベント" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "状態遷移" })).toHaveAttribute("aria-selected", "false");
  });

  it("calls onChange with the clicked tab's id", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Tabs label="戦闘詳細" items={items} activeId="events" onChange={onChange} />);

    await user.click(screen.getByRole("tab", { name: "状態遷移" }));

    expect(onChange).toHaveBeenCalledWith("transitions");
  });

  it("switches to the next/previous tab with ArrowRight/ArrowLeft, wrapping at the ends (UI-CT-013)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Tabs label="戦闘詳細" items={items} activeId="json" onChange={onChange} />);

    screen.getByRole("tab", { name: "レスポンスJSON" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledWith("events");

    onChange.mockClear();
    render(<Tabs label="戦闘詳細" items={items} activeId="events" onChange={onChange} />);
    screen.getAllByRole("tab", { name: "時系列イベント" })[0]?.focus();
    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenCalledWith("json");
  });

  it("only one tab is in the tab order at a time (roving tabindex)", () => {
    render(<Tabs label="戦闘詳細" items={items} activeId="transitions" onChange={vi.fn()} />);

    expect(screen.getByRole("tab", { name: "時系列イベント" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tab", { name: "状態遷移" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "レスポンスJSON" })).toHaveAttribute("tabindex", "-1");
  });
});
