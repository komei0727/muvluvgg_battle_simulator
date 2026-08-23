import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModeTabs } from "./ModeTabs.js";
import type { BattleMode } from "../../entities/battle-mode.js";

// UI-CT-027 / UI-AC-018: モードタブをkeyboardで切り替えられ、`aria-selected`が
// 現在モードを示す。
describe("ModeTabs", () => {
  it("marks only the current mode as selected", () => {
    render(<ModeTabs mode="battle" onChange={vi.fn()} />);

    expect(screen.getByRole("tab", { name: "通常戦闘" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "戦術演習" })).toHaveAttribute("aria-selected", "false");
  });

  it("moves to the exercise mode with ArrowRight from the keyboard", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(mode: BattleMode) => void>();
    render(<ModeTabs mode="battle" onChange={onChange} />);

    await user.tab();
    expect(screen.getByRole("tab", { name: "通常戦闘" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");

    expect(onChange).toHaveBeenCalledWith("exercise");
  });

  it("moves back to the battle mode with ArrowLeft from the keyboard", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(mode: BattleMode) => void>();
    render(<ModeTabs mode="exercise" onChange={onChange} />);

    await user.tab();
    expect(screen.getByRole("tab", { name: "戦術演習" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");

    expect(onChange).toHaveBeenCalledWith("battle");
  });

  it("switches on click", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(mode: BattleMode) => void>();
    render(<ModeTabs mode="battle" onChange={onChange} />);

    await user.click(screen.getByRole("tab", { name: "戦術演習" }));

    expect(onChange).toHaveBeenCalledWith("exercise");
  });

  it("names the tab list so it is distinguishable from the details tabs", () => {
    render(<ModeTabs mode="battle" onChange={vi.fn()} />);

    expect(screen.getByRole("tablist", { name: "戦闘モード" })).toBeInTheDocument();
  });
});
